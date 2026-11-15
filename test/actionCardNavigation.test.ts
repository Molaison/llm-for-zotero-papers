import { assert } from "chai";
import {
  attachActionCardNavigation,
  canNavigate,
  navigateToLibraryObject,
  type NavigationHost,
} from "../src/modules/contextPanel/agentTrace/actionCardNavigation";
import { renderTargetChip } from "../src/modules/contextPanel/agentTrace/actionCardChips";
import { fakeDocument, type FakeElement } from "./helpers/fakeDom";

const el = (node: HTMLElement) => node as unknown as FakeElement;

/**
 * A stand-in for the live Zotero pane, recording what the card asked it to do.
 *
 * Every call the navigator can make is journaled in order, so a test states
 * the whole visit — what was selected and that the library window was raised —
 * rather than a single flag.
 */
function host(
  overrides: Partial<NavigationHost> & { pane?: NavigationHost["pane"] } = {},
): NavigationHost & { calls: string[] } {
  const calls: string[] = [];
  const pane = {
    selectItems: async (ids: number[]) => {
      calls.push(`items:${ids.join(",")}`);
      return true;
    },
    collectionsView: {
      selectByID: (id: string) => {
        calls.push(`select:${id}`);
      },
    },
    tagSelector: {
      handleTagSelected: (tag: string) => {
        calls.push(`tag:${tag}`);
      },
    },
  };
  return {
    calls,
    pane: () => pane,
    openNote: async (source) => {
      calls.push(`note:${source.itemKey}`);
      return true;
    },
    revealFile: async (path) => {
      calls.push(`file:${path}`);
      return true;
    },
    focusMainWindow: () => calls.push("focus"),
    ...overrides,
  };
}

describe("action card navigation", function () {
  it("selects a paper", async function () {
    const h = host();
    assert.isTrue(
      await navigateToLibraryObject(
        { kind: "item", itemId: 11, label: "Smith, 2021" },
        h,
      ),
    );
    assert.deepEqual(h.calls, ["items:11", "focus"]);
  });

  it("opens a note through the plan-document navigator", async function () {
    const h = host();
    assert.isTrue(
      await navigateToLibraryObject(
        {
          kind: "note",
          label: "Summary",
          noteId: 99,
          libraryID: 1,
          itemKey: "N99",
        },
        h,
      ),
    );
    assert.deepEqual(h.calls, ["note:N99", "focus"]);
  });

  it("selects a collection by tree id and the trash by library", async function () {
    const h = host();
    await navigateToLibraryObject(
      { kind: "collection", label: "Reviews", collectionId: 7 },
      h,
    );
    await navigateToLibraryObject({ kind: "trash", libraryID: 1 }, h);
    assert.deepEqual(h.calls, ["select:C7", "focus", "select:T1", "focus"]);
  });

  it("filters by tag only when the live tag selector offers it", async function () {
    assert.isTrue(canNavigate({ kind: "tag", label: "to-read" }, host()));
    const bare = host({
      pane: () => ({ selectItems: async () => true, tagSelector: null }),
    });
    assert.isFalse(canNavigate({ kind: "tag", label: "to-read" }, bare));
    assert.isFalse(
      await navigateToLibraryObject({ kind: "tag", label: "to-read" }, bare),
    );
  });

  it("reveals a file without raising Zotero over it, and reports a missing pane as failure", async function () {
    const h = host();
    assert.isTrue(
      await navigateToLibraryObject(
        { kind: "file", label: "a.md", path: "/x/a.md" },
        h,
      ),
    );
    assert.deepEqual(
      h.calls,
      ["file:/x/a.md"],
      "the desktop's file window is what the reader asked to see",
    );
    assert.isFalse(
      await navigateToLibraryObject(
        { kind: "item", itemId: 1, label: "x" },
        host({ pane: () => null }),
      ),
    );
  });

  it("reports a collection the tree no longer has, and takes the reader nowhere", async function () {
    const missing = host({
      pane: () => ({ collectionsView: { selectByID: async () => false } }),
    });
    assert.isFalse(
      await navigateToLibraryObject(
        { kind: "collection", label: "Reviews", collectionId: 7 },
        missing,
      ),
    );
    assert.isFalse(
      await navigateToLibraryObject({ kind: "trash", libraryID: 1 }, missing),
    );
    assert.deepEqual(missing.calls, [], "a refused selection raises nothing");

    const refusedFallback = host({
      pane: () => ({
        collectionsView: { selectCollection: async () => false },
      }),
    });
    assert.isFalse(
      await navigateToLibraryObject(
        { kind: "collection", label: "Reviews", collectionId: 7 },
        refusedFallback,
      ),
    );
    assert.deepEqual(refusedFallback.calls, []);
  });

  it("asks for the selection in the form the pane still accepts", async function () {
    const seen: unknown[] = [];
    await navigateToLibraryObject(
      { kind: "item", itemId: 11, label: "Smith, 2021" },
      host({
        pane: () => ({
          selectItems: async (_ids: number[], options?: unknown) => {
            seen.push(options);
            return true;
          },
        }),
      }),
    );
    await navigateToLibraryObject(
      { kind: "item", itemId: 11, label: "Smith, 2021" },
      host({
        pane: () => ({
          selectItem: (_id: number, options?: unknown) => {
            seen.push(options);
            return true;
          },
        }),
      }),
    );

    assert.deepEqual(
      seen,
      [{ inLibraryRoot: false }, { inLibraryRoot: false }],
      "the boolean argument the pane used to take is deprecated, and forcing " +
        "the library root would throw the reader out of the collection they " +
        "are looking at",
    );
  });

  it("offers no link for a library, and none for a collection the receipt never identified", function () {
    const h = host();
    assert.isFalse(
      canNavigate({ kind: "library", libraryID: 1, label: "My Library" }, h),
    );
    assert.isFalse(canNavigate({ kind: "collection", label: "Reviews" }, h));
    assert.isFalse(canNavigate({ kind: "note", label: "Summary" }, h));
    assert.isTrue(
      canNavigate({ kind: "item", itemId: 11, label: "Smith, 2021" }, h),
    );
    assert.isTrue(
      canNavigate({ kind: "file", label: "a.md", path: "/x/a.md" }, h),
    );
    assert.isTrue(canNavigate({ kind: "trash" }, h));
  });
});

/** A card the way the renderer builds it: a pill, and a chip inside a row. */
function actionCard(): {
  root: FakeElement;
  status: FakeElement;
  chip: FakeElement;
  text: FakeElement;
} {
  const root = el(fakeDocument.createElement("section"));
  root.className = "llm-plan-container llm-agent-action-summary-card";
  const status = el(fakeDocument.createElement("span"));
  status.className = "llm-plan-status";
  status.dataset.status = "completed";
  status.textContent = "1 action";
  root.appendChild(status);
  // The chip sits inside a `<summary>`, the way a row with a body draws it.
  const summary = el(fakeDocument.createElement("summary"));
  const chip = el(
    renderTargetChip(fakeDocument, {
      kind: "item",
      itemId: 11,
      label: "Smith, 2021",
    }),
  );
  summary.appendChild(chip);
  root.appendChild(summary);
  return {
    root,
    status,
    chip,
    text: chip.findByClass("llm-paper-context-chip-text")!,
  };
}

describe("action card navigation binding", function () {
  it("opens what a clicked chip names, without toggling the row it sits in", async function () {
    const { root, status, text } = actionCard();
    const h = host();
    attachActionCardNavigation(
      root as unknown as HTMLElement,
      status as unknown as HTMLElement,
      h,
    );

    const event = await root.dispatchFakeEventAsync("click", { target: text });

    assert.deepEqual(h.calls, ["items:11", "focus"]);
    assert.isTrue(event.defaultPrevented, "the chip is not a document link");
    assert.isTrue(
      event.propagationStopped,
      "the disclosure the chip sits in stays as the reader left it",
    );
    assert.equal(status.textContent, "1 action", "the pill is untouched");
    assert.equal(status.dataset.status, "completed");
  });

  it("opens the focused chip on Enter and ignores every other key", async function () {
    const { root, status, chip } = actionCard();
    const h = host();
    attachActionCardNavigation(
      root as unknown as HTMLElement,
      status as unknown as HTMLElement,
      h,
    );

    const ignored = await root.dispatchFakeEventAsync("keydown", {
      target: chip,
      key: "a",
    });
    assert.deepEqual(h.calls, []);
    assert.isFalse(ignored.defaultPrevented);

    const entered = await root.dispatchFakeEventAsync("keydown", {
      target: chip,
      key: "Enter",
    });
    assert.deepEqual(h.calls, ["items:11", "focus"]);
    assert.isTrue(entered.defaultPrevented);
  });

  it("listens once for the whole card, not once per chip", async function () {
    const { root, status, chip } = actionCard();
    const second = el(
      renderTargetChip(fakeDocument, {
        kind: "item",
        itemId: 12,
        label: "Jones, 2019",
      }),
    );
    root.appendChild(second);
    const h = host();
    attachActionCardNavigation(
      root as unknown as HTMLElement,
      status as unknown as HTMLElement,
      h,
    );

    await chip.dispatchFakeEventAsync("click", { target: chip });
    assert.deepEqual(h.calls, [], "no chip carries a listener of its own");

    await root.dispatchFakeEventAsync("click", { target: second });
    assert.deepEqual(
      h.calls,
      ["items:12", "focus"],
      "a chip added to the card is served by the card's own listener",
    );
  });

  it("does nothing when the click landed outside a chip", async function () {
    const { root, status } = actionCard();
    const h = host();
    attachActionCardNavigation(
      root as unknown as HTMLElement,
      status as unknown as HTMLElement,
      h,
    );

    const event = await root.dispatchFakeEventAsync("click", {
      target: status,
    });

    assert.deepEqual(h.calls, []);
    assert.isFalse(event.defaultPrevented);
    assert.equal(status.dataset.status, "completed");
  });

  it("names what it could not open in the card's pill", async function () {
    const { root, status, chip } = actionCard();
    attachActionCardNavigation(
      root as unknown as HTMLElement,
      status as unknown as HTMLElement,
      host({ pane: () => null }),
    );

    await root.dispatchFakeEventAsync("click", { target: chip });

    assert.equal(status.textContent, "Smith, 2021 is unavailable");
    assert.equal(status.dataset.status, "error");
  });

  it("reports a navigation that threw the same way", async function () {
    const { root, status, chip } = actionCard();
    attachActionCardNavigation(
      root as unknown as HTMLElement,
      status as unknown as HTMLElement,
      host({
        pane: () => ({
          selectItems: async () => {
            throw new Error("the pane went away");
          },
        }),
      }),
    );

    await root.dispatchFakeEventAsync("click", { target: chip });

    assert.equal(status.textContent, "Smith, 2021 is unavailable");
    assert.equal(status.dataset.status, "error");
  });
});
