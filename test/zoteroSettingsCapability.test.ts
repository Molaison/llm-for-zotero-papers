import { assert } from "chai";
import {
  SettingsCapability,
  type SettingsCapabilityDeps,
} from "../src/agent/services/zotero/settingsCapability";

/**
 * Preferences, sync state, export translators and CSL formatting used to live
 * on `ZoteroGateway` and reached the item lookup through `this`. They now take
 * that lookup as a dependency, so this file drives the capability on its own —
 * the same behaviour `citeExportSettings.test.ts` pins through the facade,
 * asserted here against the seam the facade fills in.
 */
describe("settings capability", function () {
  type FakeItem = {
    id: number;
    title: string;
    isNote: () => boolean;
    getField: (name: string) => string;
  };

  let items: Map<number, FakeItem>;
  let prefs: Map<string, unknown>;
  let cleared: string[];

  const globalScope = globalThis as typeof globalThis & { Zotero?: unknown };
  const originalZotero = globalScope.Zotero;

  function makeItem(seed: { id: number; title: string; note?: boolean }) {
    const item: FakeItem = {
      id: seed.id,
      title: seed.title,
      isNote: () => seed.note === true,
      getField: (name: string) => (name === "title" ? seed.title : ""),
    };
    items.set(seed.id, item);
    return item;
  }

  function installZotero(extra: Record<string, unknown> = {}) {
    globalScope.Zotero = {
      Items: { get: (id: number) => items.get(id) || null },
      Prefs: {
        get: (key: string) => prefs.get(key),
        set: (key: string, value: unknown) => {
          prefs.set(key, value);
        },
        clear: (key: string) => {
          cleared.push(key);
          prefs.delete(key);
        },
      },
      debug: () => undefined,
      ...extra,
    };
  }

  beforeEach(function () {
    items = new Map();
    prefs = new Map();
    cleared = [];
  });

  afterEach(function () {
    globalScope.Zotero = originalZotero;
  });

  /** The capability under test, with its one dependency answered explicitly. */
  function capability(deps: Partial<SettingsCapabilityDeps> = {}) {
    return new SettingsCapability({
      getItem: (itemId) =>
        (items.get(Number(itemId)) as unknown as Zotero.Item) || null,
      ...deps,
    });
  }

  describe("reading preferences", function () {
    it("lists the allowlist with each pref's current value and type", function () {
      prefs.set("recursiveCollections", true);
      prefs.set("fontSize", 14);
      installZotero();

      const listed = capability().listSettings();
      const recursive = listed.find(
        (entry) => entry.key === "recursiveCollections",
      );
      const fontSize = listed.find((entry) => entry.key === "fontSize");

      assert.isAbove(listed.length, 5);
      assert.deepEqual(recursive, {
        key: "recursiveCollections",
        value: true,
        type: "boolean",
        description: "Show items from subcollections in a collection",
      });
      assert.equal(fontSize?.value, 14);
      assert.isUndefined(
        listed.find((entry) => entry.key === "extensions.zotero.dataDir"),
        "nothing outside the allowlist is even listed",
      );
    });

    it("reads an unset pref as undefined rather than failing the whole listing", function () {
      installZotero({
        Prefs: {
          get: (key: string) => {
            if (key === "fontSize") throw new Error("unset");
            return prefs.get(key);
          },
        },
      });

      const listed = capability().listSettings();

      assert.isUndefined(
        listed.find((entry) => entry.key === "fontSize")?.value,
      );
      assert.isAbove(listed.length, 5);
    });

    it("reports whether a pref exists so a write receipt can be verified", function () {
      prefs.set("fontSize", 14);
      installZotero();

      assert.deepEqual(capability().getSettingNativeState("fontSize"), {
        exists: true,
        value: 14,
      });
      assert.deepEqual(capability().getSettingNativeState("dataDir"), {
        exists: false,
        value: undefined,
      });
    });
  });

  describe("writing preferences", function () {
    it("coerces to the declared type and reports the previous value", async function () {
      prefs.set("fontSize", 14);
      installZotero();

      const result = await capability().updateSetting({
        key: "fontSize",
        value: "18",
      });

      assert.deepEqual(result, {
        key: "fontSize",
        previousValue: 14,
        value: 18,
        status: "updated",
      });
      assert.equal(prefs.get("fontSize"), 18);
    });

    it("reports an unchanged write without touching the pref", async function () {
      prefs.set("recursiveCollections", true);
      installZotero();

      const result = await capability().updateSetting({
        key: "recursiveCollections",
        value: 1,
      });

      assert.equal(result.status, "unchanged");
      assert.equal(result.previousValue, true);
    });

    it("refuses a key outside the allowlist by name", async function () {
      installZotero();

      const result = await capability().updateSetting({
        key: "extensions.zotero.dataDir",
        value: "/tmp",
      });

      assert.equal(result.status, "refused");
      assert.include(result.reason || "", "is not a preference the agent may");
      assert.isFalse(prefs.has("extensions.zotero.dataDir"));
    });

    it("refuses a value that is not the declared number", async function () {
      installZotero();

      const result = await capability().updateSetting({
        key: "trashAutoEmptyDays",
        value: "soon",
      });

      assert.equal(result.status, "refused");
      assert.include(result.reason || "", "expects a number");
    });
  });

  describe("restoring a preference", function () {
    it("puts back the exact prior value without coercing it", function () {
      installZotero();

      capability().restoreSetting({
        key: "fontSize",
        existed: true,
        value: "14",
      });

      assert.equal(
        prefs.get("fontSize"),
        "14",
        "a restore replays the stored value verbatim",
      );
    });

    it("clears a pref that was never set rather than writing a default", function () {
      prefs.set("fontSize", 18);
      installZotero();

      capability().restoreSetting({ key: "fontSize", existed: false });

      assert.deepEqual(cleared, ["fontSize"]);
      assert.isFalse(prefs.has("fontSize"));
    });

    it("refuses to restore anything outside the allowlist", function () {
      installZotero();
      let message = "";
      try {
        capability().restoreSetting({
          key: "extensions.zotero.dataDir",
          existed: true,
          value: "/tmp",
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      assert.include(message, "is not agent-writable");
    });

    it("refuses rather than guessing when Prefs.clear is unavailable", function () {
      installZotero({ Prefs: { get: () => undefined, set: () => undefined } });
      let message = "";
      try {
        capability().restoreSetting({ key: "fontSize", existed: false });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      assert.include(message, "Zotero.Prefs.clear is unavailable");
    });
  });

  describe("sync state", function () {
    it("reports a configured account and an in-progress sync", function () {
      installZotero({
        Users: { getCurrentUsername: () => "ylw" },
        Sync: { Runner: { syncInProgress: true } },
      });

      assert.deepEqual(capability().getSyncStatus(), {
        configured: true,
        username: "ylw",
        inProgress: true,
      });
    });

    it("reports an unconfigured account when the username lookup throws", function () {
      installZotero({
        Users: {
          getCurrentUsername: () => {
            throw new Error("no account");
          },
        },
      });

      assert.deepEqual(capability().getSyncStatus(), {
        configured: false,
        username: undefined,
        inProgress: false,
      });
    });
  });

  describe("exporting", function () {
    it("names the formats a caller may ask for", function () {
      installZotero();

      const formats = capability().listExportFormats();

      assert.includeMembers(
        formats.map((format) => format.label),
        ["BibTeX", "RIS", "CSL JSON"],
      );
      assert.isTrue(formats.every((format) => Boolean(format.id)));
    });

    it("resolves the ids through the injected lookup and returns the output", async function () {
      makeItem({ id: 1, title: "One" });
      makeItem({ id: 2, title: "Two" });
      const seen: { items?: unknown[]; translatorId?: string } = {};
      installZotero({
        Translate: {
          Export: class {
            string = "@article{one}";
            private handler?: (obj: unknown, worked: unknown) => void;
            setItems(list: unknown[]) {
              seen.items = list;
            }
            setTranslator(id: string) {
              seen.translatorId = id;
            }
            setHandler(
              _event: string,
              handler: (obj: unknown, worked: unknown) => void,
            ) {
              this.handler = handler;
            }
            translate() {
              this.handler?.(this, true);
            }
          },
        },
      });

      const result = await capability().exportItems({
        itemIds: [1, 2, 404],
        translatorId: "bibtex",
      });

      assert.deepEqual(result, { output: "@article{one}", itemCount: 2 });
      assert.equal(seen.translatorId, "bibtex");
      assert.lengthOf(seen.items || [], 2);
    });

    it("refuses when none of the ids resolve", async function () {
      installZotero({ Translate: { Export: class {} } });
      let message = "";
      try {
        await capability().exportItems({
          itemIds: [404],
          translatorId: "bibtex",
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      assert.include(message, "None of those item IDs resolved");
    });

    it("reports a translator that failed instead of returning empty output", async function () {
      makeItem({ id: 1, title: "One" });
      installZotero({
        Translate: {
          Export: class {
            private handler?: (obj: unknown, worked: unknown) => void;
            setItems() {}
            setTranslator() {}
            setHandler(
              _event: string,
              handler: (obj: unknown, worked: unknown) => void,
            ) {
              this.handler = handler;
            }
            translate() {
              this.handler?.(this, false);
            }
          },
        },
      });

      let message = "";
      try {
        await capability().exportItems({ itemIds: [1], translatorId: "bogus" });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      assert.include(message, "could not export with translator bogus");
    });
  });

  describe("formatting citations", function () {
    /** A CSL engine stand-in that records what it was asked to render. */
    function installCiteProc(options: { visible?: boolean } = {}) {
      const freed: number[] = [];
      const style = {
        title: "American Psychological Association",
        getCiteProc: (locale: string, format: string) => ({
          free: () => freed.push(1),
          updateItems: () => undefined,
          previewCitationCluster: () => `(cluster ${format}/${locale})`,
        }),
      };
      installZotero({
        Styles: {
          get: (id: string) =>
            id === "http://www.zotero.org/styles/apa" ? style : null,
          ...(options.visible === false
            ? {}
            : {
                getVisible: () => [
                  {
                    styleID: "http://www.zotero.org/styles/apa",
                    title: "  American Psychological Association  ",
                  },
                ],
              }),
        },
        Cite: {
          makeFormattedBibliographyOrCitationList: (
            _engine: unknown,
            list: unknown[],
            format: string,
          ) => `bibliography of ${list.length} in ${format}`,
        },
        Prefs: { get: () => "" },
      });
      return { freed };
    }

    it("lists the installed styles with tidied titles", function () {
      installCiteProc();

      assert.deepEqual(capability().listCitationStyles(), [
        {
          id: "http://www.zotero.org/styles/apa",
          title: "American Psychological Association",
        },
      ]);
    });

    it("formats a bibliography from the items the lookup resolves", function () {
      makeItem({ id: 1, title: "One" });
      makeItem({ id: 2, title: "A note", note: true });
      const { freed } = installCiteProc();

      const result = capability().formatBibliography({ itemIds: [1, 2, 404] });

      assert.equal(result.styleId, "http://www.zotero.org/styles/apa");
      assert.equal(result.styleTitle, "American Psychological Association");
      assert.equal(result.itemCount, 1, "a note is not a citable item");
      assert.equal(result.output, "bibliography of 1 in text");
      assert.equal(result.format, "text");
      assert.lengthOf(freed, 1, "the CSL engine is released");
    });

    it("produces an in-text citation when asked for one", function () {
      makeItem({ id: 1, title: "One" });
      installCiteProc();

      const result = capability().formatBibliography({
        itemIds: [1],
        mode: "citation",
        format: "html",
      });

      assert.equal(result.output, "(cluster html/en-US)");
      assert.equal(result.format, "html");
    });

    it("refuses rather than inventing a citation when the engine is missing", function () {
      makeItem({ id: 1, title: "One" });
      installZotero();

      let message = "";
      try {
        capability().formatBibliography({ itemIds: [1] });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      assert.include(message, "citation engine is not available");
      assert.include(message, "Do not write one from memory");
    });

    it("names the uninstalled style instead of falling back to another", function () {
      makeItem({ id: 1, title: "One" });
      installCiteProc();

      let message = "";
      try {
        capability().formatBibliography({ itemIds: [1], styleId: "chicago" });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      assert.include(message, 'Citation style "chicago" is not installed');
    });

    it("pairs structured bibliography entries with their items in both surfaces", function () {
      makeItem({ id: 1, title: "One" });
      makeItem({ id: 2, title: "Two" });
      installZotero({
        Styles: {
          get: () => ({
            title: "APA",
            getCiteProc: (_locale: string, format: string) => ({
              free: () => undefined,
              updateItems: () => undefined,
              previewCitationCluster: (citation: {
                citationID: string;
                citationItems: Array<{ locator?: string }>;
              }) =>
                `${citation.citationID}:${format}:${citation.citationItems[0]?.locator ?? "-"}`,
              makeBibliography: () => [
                { entry_ids: [[1], [2]] },
                [`one-${format}`, `two-${format}`],
              ],
            }),
          }),
        },
        Prefs: { get: () => "" },
      });

      const result = capability().formatStructuredCitations({
        clusters: [
          { citationId: "c1", items: [{ itemId: 1, pageIndex: 4 }] },
          { citationId: "c2", items: [{ itemId: 2 }] },
        ],
      });

      assert.equal(result.styleId, "http://www.zotero.org/styles/apa");
      assert.equal(result.locale, "en-US");
      assert.deepEqual(result.clusters, [
        { citationId: "c1", text: "c1:text:5", html: "c1:html:5" },
        { citationId: "c2", text: "c2:text:-", html: "c2:html:-" },
      ]);
      assert.deepEqual(result.bibliographyEntries, [
        { itemId: 1, text: "one-text", html: "one-html" },
        { itemId: 2, text: "two-text", html: "two-html" },
      ]);
    });

    it("refuses a structured bundle with no citable items", function () {
      installZotero({
        Styles: { get: () => ({ getCiteProc: () => ({}) }) },
        Prefs: { get: () => "" },
      });

      let message = "";
      try {
        capability().formatStructuredCitations({
          clusters: [{ citationId: "c1", items: [{ itemId: 0 }] }],
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      assert.include(message, "requires citable items");
    });
  });
});
