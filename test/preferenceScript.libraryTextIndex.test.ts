import { assert } from "chai";
import { readFileSync } from "fs";
import { config } from "../package.json";
import {
  bindLibraryTextIndexSettings,
  formatLibraryTextIndexStatus,
  type LibraryTextIndexSettingsDeps,
} from "../src/modules/preferenceScript";
import type { LibraryTextIndexOverview } from "../src/services/libraryTextIndex";
import { initI18n, t } from "../src/utils/i18n";
import { FakePrefDocument, flushAsync } from "./helpers/fakePreferencesDom";

const MB = 1024 * 1024;
const PREFIX = `${config.addonRef}-library-text-index`;

function overview(
  patch: Partial<LibraryTextIndexOverview> = {},
): LibraryTextIndexOverview {
  return {
    enabled: true,
    vectorsEnabled: false,
    semanticAvailable: true,
    indexed: 587,
    eligible: 600,
    queued: 13,
    failed: 2,
    building: false,
    usedBytes: 41 * MB,
    budgetBytes: 500 * MB,
    dbBytes: 45 * MB,
    vectorBytes: 0,
    vectorNamespace: null,
    ...patch,
  };
}

/** The block's controls, as preferences.xhtml declares them. */
function buildBlock() {
  const doc = new FakePrefDocument();
  const add = (tag: string, suffix: string, type = "") => {
    const element = doc.createElement(tag);
    element.setAttribute("id", `${PREFIX}${suffix}`);
    element.type = type;
    doc.body.appendChild(element);
    return element;
  };
  return {
    doc,
    enabled: add("input", "-enabled", "checkbox"),
    label: add("span", "-label"),
    hint: add("span", "-hint"),
    budget: add("input", "-budget", "number"),
    budgetLabel: add("span", "-budget-label"),
    budgetHint: add("span", "-budget-hint"),
    status: add("span", "-status"),
    rebuild: add("button", "-rebuild"),
    clear: add("button", "-clear"),
  };
}

type Harness = ReturnType<typeof buildBlock> & {
  prefs: Record<string, unknown>;
  writes: Array<[string, unknown]>;
  calls: string[];
  confirms: Array<[string, string]>;
  intervals: Array<{ cb: () => void; ms: number; cleared: boolean }>;
  visible: { on: boolean };
  answer: { confirm: boolean };
  current: { overview: LibraryTextIndexOverview };
  release: () => void;
  deps: LibraryTextIndexSettingsDeps;
};

function harness(prefs: Record<string, unknown> = {}): Harness {
  const block = buildBlock();
  const state = {
    prefs: {
      libraryTextIndexEnabled: true,
      libraryTextIndexVectors: false,
      libraryTextIndexBudgetMB: 500,
      ...prefs,
    } as Record<string, unknown>,
    writes: [] as Array<[string, unknown]>,
    calls: [] as string[],
    confirms: [] as Array<[string, string]>,
    intervals: [] as Array<{ cb: () => void; ms: number; cleared: boolean }>,
    visible: { on: true },
    answer: { confirm: true },
    current: { overview: overview() },
  };
  let releaseAction: () => void = () => undefined;
  const pendingAction = () =>
    new Promise<void>((resolve) => {
      releaseAction = resolve;
    });
  const deps: LibraryTextIndexSettingsDeps = {
    doc: block.doc as unknown as Document,
    addonRef: config.addonRef,
    t: (en) => en,
    getPref: (key) => state.prefs[key],
    setPref: (key, value) => {
      state.prefs[key] = value;
      state.writes.push([key, value]);
    },
    getOverview: async () => {
      state.calls.push("overview");
      return state.current.overview;
    },
    rebuild: async () => {
      state.calls.push("rebuild");
      await pendingAction();
    },
    clear: async () => {
      state.calls.push("clear");
      await pendingAction();
    },
    confirm: (title, text) => {
      state.confirms.push([title, text]);
      return state.answer.confirm;
    },
    setInterval: (cb, ms) => {
      const entry = { cb, ms, cleared: false };
      state.intervals.push(entry);
      return entry;
    },
    clearInterval: (handle) => {
      (handle as { cleared: boolean }).cleared = true;
    },
    isVisible: () => state.visible.on,
  };
  return {
    ...block,
    ...state,
    release: () => releaseAction(),
    deps,
  };
}

describe("preferences: library text index section", function () {
  it("reflects the three prefs", async function () {
    const h = harness({ libraryTextIndexBudgetMB: 300 });
    bindLibraryTextIndexSettings(h.deps);
    await flushAsync();
    assert.isTrue(h.enabled.checked);
    assert.equal(h.budget.value, "300");
    assert.equal(h.label.textContent, "Library index");
    assert.equal(h.budgetLabel.textContent, "Index size limit (MB)");
    assert.equal(h.rebuild.textContent, "Rebuild index");
    assert.equal(h.clear.textContent, "Clear index");
  });

  it("reflects an index that is off", async function () {
    const h = harness({ libraryTextIndexEnabled: false });
    h.current.overview = overview({ enabled: false });
    bindLibraryTextIndexSettings(h.deps);
    await flushAsync();
    assert.isFalse(h.enabled.checked);
    assert.equal(h.status.textContent, "Index is off");
  });

  it("offers no embeddings control (embeddings are deferred)", function () {
    const markup = readFileSync("addon/content/preferences.xhtml", "utf8");
    assert.include(markup, "__addonRef__-library-text-index-enabled");
    assert.notInclude(markup, "library-text-index-vectors");
  });

  it("writes each pref on change", async function () {
    const h = harness();
    bindLibraryTextIndexSettings(h.deps);
    await flushAsync();
    h.budget.value = "750";
    h.budget.dispatch("change");
    h.enabled.checked = false;
    h.enabled.dispatch("change");
    assert.deepEqual(h.writes, [
      ["libraryTextIndexBudgetMB", 750],
      ["libraryTextIndexEnabled", false],
    ]);
  });

  it("rejects a budget below 50 MB or not a number and keeps the stored value", async function () {
    const h = harness();
    bindLibraryTextIndexSettings(h.deps);
    await flushAsync();
    h.budget.value = "10";
    h.budget.dispatch("change");
    assert.equal(h.budget.value, "500");
    h.budget.value = "abc";
    h.budget.dispatch("change");
    assert.equal(h.budget.value, "500");
    assert.deepEqual(h.writes, []);
    assert.equal(h.prefs.libraryTextIndexBudgetMB, 500);
  });

  it("shows the formatted status on bind and refreshes every 5 s only while visible", async function () {
    const h = harness();
    const binding = bindLibraryTextIndexSettings(h.deps);
    await flushAsync();
    assert.equal(
      h.status.textContent,
      formatLibraryTextIndexStatus(h.current.overview, (en) => en),
    );
    assert.lengthOf(h.intervals, 1);
    assert.equal(h.intervals[0].ms, 5000);
    h.current.overview = overview({ indexed: 590, queued: 10 });
    h.visible.on = false;
    h.intervals[0].cb();
    await flushAsync();
    assert.include(h.status.textContent, "Indexed 587 of 600 papers");
    h.visible.on = true;
    h.intervals[0].cb();
    await flushAsync();
    assert.include(h.status.textContent, "Indexed 590 of 600 papers");
    binding.dispose();
    assert.isTrue(h.intervals[0].cleared, "unload clears the interval");
  });

  it("Rebuild runs once without confirming, shows Working… and disables both buttons until it finishes", async function () {
    const h = harness();
    bindLibraryTextIndexSettings(h.deps);
    await flushAsync();
    h.calls.length = 0;
    h.rebuild.click();
    await flushAsync();
    assert.deepEqual(h.calls, ["rebuild"]);
    assert.deepEqual(h.confirms, []);
    assert.equal(h.status.textContent, "Working…");
    assert.isTrue(h.rebuild.disabled);
    assert.isTrue(h.clear.disabled);
    h.rebuild.click();
    h.clear.click();
    await flushAsync();
    assert.deepEqual(h.calls, ["rebuild"], "no second action while one runs");
    h.current.overview = overview({ indexed: 0, queued: 600, building: true });
    h.release();
    await flushAsync();
    assert.isFalse(h.rebuild.disabled);
    assert.isFalse(h.clear.disabled);
    assert.deepEqual(h.calls, ["rebuild", "overview"], "refreshed afterwards");
    assert.match(h.status.textContent, /^Building…/);
  });

  it("Clear asks for confirmation and clears only when the user agrees", async function () {
    const h = harness();
    bindLibraryTextIndexSettings(h.deps);
    await flushAsync();
    h.calls.length = 0;
    h.answer.confirm = false;
    h.clear.click();
    await flushAsync();
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.confirms, [
      [
        "Clear library index",
        "This deletes the local index database and all embedding files. Your library and PDFs are not touched. Library questions will be slower until the index refills.",
      ],
    ]);
    h.answer.confirm = true;
    h.clear.click();
    await flushAsync();
    assert.deepEqual(h.calls, ["clear"]);
    assert.isTrue(h.clear.disabled);
    assert.equal(h.status.textContent, "Working…");
    h.release();
    await flushAsync();
    assert.isFalse(h.clear.disabled);
    assert.deepEqual(h.calls, ["clear", "overview"]);
  });

  it("a failed action re-enables the buttons and refreshes the status", async function () {
    const h = harness();
    h.deps.rebuild = async () => {
      throw new Error("disk full");
    };
    bindLibraryTextIndexSettings(h.deps);
    await flushAsync();
    h.rebuild.click();
    await flushAsync();
    assert.isFalse(h.rebuild.disabled);
    assert.include(h.status.textContent, "Indexed 587 of 600 papers");
  });
});

describe("formatLibraryTextIndexStatus", function () {
  const en = (value: string) => value;

  it("summarises coverage, queue, failures and size", function () {
    assert.equal(
      formatLibraryTextIndexStatus(overview(), en),
      "Indexed 587 of 600 papers · 13 queued · 2 could not be indexed · 41 MB of 500 MB",
    );
  });

  it("omits zero queue and failure counts", function () {
    assert.equal(
      formatLibraryTextIndexStatus(
        overview({ queued: 0, failed: 0, usedBytes: 0 }),
        en,
      ),
      "Indexed 587 of 600 papers · 0 MB of 500 MB",
    );
  });

  it("says the index is off", function () {
    assert.equal(
      formatLibraryTextIndexStatus(overview({ enabled: false }), en),
      "Index is off",
    );
  });

  it("prefixes Building… while building", function () {
    assert.equal(
      formatLibraryTextIndexStatus(overview({ building: true, failed: 0 }), en),
      "Building… · Indexed 587 of 600 papers · 13 queued · 41 MB of 500 MB",
    );
  });

  it("never shows embeddings, even when vector files exist", function () {
    assert.notInclude(
      formatLibraryTextIndexStatus(
        overview({
          vectorsEnabled: true,
          vectorNamespace: "openai:small:1536",
          vectorBytes: 12 * MB,
        }),
        en,
      ),
      "embeddings",
    );
  });

  it("shows sizes under 10 MB with one decimal", function () {
    assert.include(
      formatLibraryTextIndexStatus(overview({ usedBytes: 1.5 * MB }), en),
      "1.5 MB of 500 MB",
    );
  });

  describe("in Chinese", function () {
    const scope = globalThis as unknown as Record<string, unknown>;
    const previous = scope.Zotero;
    before(function () {
      scope.Zotero = {
        ...((previous as object) || {}),
        Prefs: { get: () => "zh-CN" },
      };
      initI18n();
    });
    after(function () {
      scope.Zotero = previous;
      initI18n();
    });

    it("translates every variant", function () {
      assert.equal(
        formatLibraryTextIndexStatus(overview({ building: true }), t),
        "正在构建… · 已索引 587/600 篇论文 · 13 篇待处理 · 2 篇无法索引 · 41 MB / 500 MB",
      );
      assert.equal(
        formatLibraryTextIndexStatus(overview({ enabled: false }), t),
        "索引已关闭",
      );
    });

    it("has a translation for every string the section shows", function () {
      const asked: string[] = [];
      const h = harness();
      h.deps.t = (en: string) => {
        asked.push(en);
        return t(en);
      };
      h.deps.confirm = () => false;
      bindLibraryTextIndexSettings(h.deps);
      h.clear.click();
      h.rebuild.click();
      const recording = (en: string) => {
        asked.push(en);
        return t(en);
      };
      formatLibraryTextIndexStatus(overview({ building: true }), recording);
      formatLibraryTextIndexStatus(overview({ enabled: false }), recording);
      assert.include(asked, "Working…");
      assert.include(asked, "Index is off");
      h.release();
      const missing = [...new Set(asked)].filter((key) => t(key) === key);
      assert.deepEqual(missing, []);
      assert.isAtLeast(new Set(asked).size, 10);
    });
  });
});
