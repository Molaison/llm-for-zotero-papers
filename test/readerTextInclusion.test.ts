import { assert } from "chai";
import {
  appendSelectedTextContextForItem,
  getSelectedTextContextEntries,
} from "../src/modules/contextPanel/contextResolution";
import {
  includeReaderSelectedText,
  type ReaderTextInclusionDependencies,
} from "../src/modules/contextPanel/readerTextInclusion";
import {
  activeContextPanels,
  activeContextPanelRawItems,
  activeContextPanelStateSync,
  chatHistory,
  clearAllState,
} from "../src/modules/contextPanel/state";

type FakeStatus = {
  textContent: string;
  className: string;
};

type FakeInput = {
  focused: boolean;
  focus: (options?: FocusOptions) => void;
};

function fakePanelBody(
  conversationKey: number,
  connected: boolean = true,
): {
  body: Element;
  status: FakeStatus;
  input: FakeInput;
} {
  const root = {
    dataset: { itemId: `${conversationKey}` },
  };
  const status: FakeStatus = { textContent: "", className: "" };
  const input: FakeInput = {
    focused: false,
    focus: () => {
      input.focused = true;
    },
  };
  const body = {
    isConnected: connected,
    querySelector: (selector: string) => {
      if (selector === "#llm-main") return root;
      if (selector === "#llm-status") return status;
      if (selector === "#llm-input") return input;
      return null;
    },
  } as unknown as Element;
  return { body, status, input };
}

function noLocationDependencies(
  resolveLocation: ReaderTextInclusionDependencies["resolveLocation"],
): ReaderTextInclusionDependencies {
  return {
    getCurrentLocation: () => null,
    resolveLocation,
  };
}

describe("reader text inclusion", function () {
  afterEach(function () {
    clearAllState();
  });

  it("commits text immediately and enriches its page in the background", async function () {
    const conversationKey = 8101;
    const panel = fakePanelBody(conversationKey);
    let syncCount = 0;
    activeContextPanelStateSync.set(panel.body, () => {
      syncCount += 1;
    });

    let resolveLocation!: (
      value: Awaited<
        ReturnType<ReaderTextInclusionDependencies["resolveLocation"]>
      >,
    ) => void;
    const locationPromise = new Promise<
      Awaited<ReturnType<ReaderTextInclusionDependencies["resolveLocation"]>>
    >((resolve) => {
      resolveLocation = resolve;
    });
    const command = includeReaderSelectedText(
      {
        body: panel.body,
        conversationKey,
        selectedText: "deferred page location",
        reader: { itemID: 42 },
      },
      noLocationDependencies(() => locationPromise),
    );

    assert.lengthOf(getSelectedTextContextEntries(conversationKey), 1);
    assert.deepInclude(getSelectedTextContextEntries(conversationKey)[0], {
      text: "deferred page location",
      source: "pdf",
      contextItemId: 42,
    });
    assert.equal(syncCount, 1);
    assert.equal(panel.status.textContent, "Selected text included");
    assert.isTrue(panel.input.focused);

    resolveLocation({
      contextItemId: 42,
      pageIndex: 3,
      pageLabel: "431",
      pagesScanned: 8,
    });
    const result = await command;

    assert.equal(result.outcome, "added");
    assert.isTrue(result.locationEnriched);
    assert.equal(syncCount, 2);
    assert.deepInclude(getSelectedTextContextEntries(conversationKey)[0], {
      contextItemId: 42,
      pageIndex: 3,
      pageLabel: "431",
    });
  });

  it("uses a prefetched location without running either locator", async function () {
    const conversationKey = 8102;
    const panel = fakePanelBody(conversationKey);
    activeContextPanelStateSync.set(panel.body, () => undefined);

    const result = await includeReaderSelectedText(
      {
        body: panel.body,
        conversationKey,
        selectedText: "cached pointer-down selection",
        reader: { itemID: 43 },
        initialLocation: {
          contextItemId: 43,
          pageIndex: 2,
          pageLabel: "17",
        },
      },
      {
        getCurrentLocation: () => {
          throw new Error("direct locator should not run");
        },
        resolveLocation: async () => {
          throw new Error("async locator should not run");
        },
      },
    );

    assert.equal(result.outcome, "added");
    assert.equal(result.selectedText, "cached pointer-down selection");
    assert.deepInclude(getSelectedTextContextEntries(conversationKey)[0], {
      contextItemId: 43,
      pageIndex: 2,
      pageLabel: "17",
    });
  });

  it("keeps captured text when asynchronous page lookup fails", async function () {
    const conversationKey = 8103;
    const panel = fakePanelBody(conversationKey);
    const logs: string[] = [];
    activeContextPanelStateSync.set(panel.body, () => undefined);

    const result = await includeReaderSelectedText(
      {
        body: panel.body,
        conversationKey,
        selectedText: "text survives locator failure",
        reader: { itemID: 44 },
        log: (message) => logs.push(message),
      },
      noLocationDependencies(async () => {
        throw new Error("locator unavailable");
      }),
    );

    assert.equal(result.outcome, "added");
    assert.isFalse(result.locationEnriched);
    assert.deepInclude(getSelectedTextContextEntries(conversationKey)[0], {
      text: "text survives locator failure",
      contextItemId: 44,
    });
    assert.include(logs, "LLM addText: page-location enrichment failed");
  });

  it("refreshes matching live panels and removes disconnected registrations", async function () {
    const conversationKey = 8104;
    const primary = fakePanelBody(conversationKey);
    const matching = fakePanelBody(conversationKey);
    const unrelated = fakePanelBody(9999);
    const disconnected = fakePanelBody(conversationKey, false);
    const history = [
      { role: "assistant" as const, text: "Saved answer", timestamp: 1 },
    ];
    chatHistory.set(conversationKey, history);
    activeContextPanelRawItems.set(primary.body, null);
    const refreshed: string[] = [];
    activeContextPanelStateSync.set(primary.body, () =>
      refreshed.push("primary"),
    );
    activeContextPanelStateSync.set(matching.body, () =>
      refreshed.push("matching"),
    );
    activeContextPanelStateSync.set(unrelated.body, () =>
      refreshed.push("unrelated"),
    );
    activeContextPanelStateSync.set(disconnected.body, () =>
      refreshed.push("disconnected"),
    );
    activeContextPanels.set(disconnected.body, () => null);
    activeContextPanelRawItems.set(disconnected.body, null);

    await includeReaderSelectedText({
      body: primary.body,
      conversationKey,
      selectedText: "shared panel refresh",
      initialLocation: { contextItemId: 45, pageIndex: 0 },
    });

    assert.deepEqual(refreshed, ["primary", "matching"]);
    assert.isFalse(activeContextPanels.has(disconnected.body));
    assert.isFalse(activeContextPanelRawItems.has(disconnected.body));
    assert.isFalse(activeContextPanelStateSync.has(disconnected.body));
    assert.isTrue(
      activeContextPanelRawItems.has(primary.body),
      "live panel identity survives cleanup of its sibling",
    );
    assert.strictEqual(
      chatHistory.get(conversationKey),
      history,
      "panel cleanup must preserve conversation history",
    );
  });

  it("reports no selection and invalid targets without mutating context", async function () {
    const panel = fakePanelBody(8105);

    const noSelection = await includeReaderSelectedText({
      body: panel.body,
      conversationKey: 8105,
      selectedText: "  ",
    });
    const invalidTarget = await includeReaderSelectedText({
      body: panel.body,
      conversationKey: 0,
      selectedText: "valid text",
    });

    assert.equal(noSelection.outcome, "no-selection");
    assert.equal(panel.status.textContent, "Select text in the reader first");
    assert.equal(invalidTarget.outcome, "invalid-target");
    assert.deepEqual(getSelectedTextContextEntries(8105), []);
  });

  it("reports a duplicate selection apart from a full list", async function () {
    const conversationKey = 8106;
    const panel = fakePanelBody(conversationKey);
    activeContextPanelStateSync.set(panel.body, () => undefined);
    appendSelectedTextContextForItem(
      conversationKey,
      "duplicate selection",
      "pdf",
      null,
      { contextItemId: 46, pageIndex: 0 },
    );

    const duplicate = await includeReaderSelectedText({
      body: panel.body,
      conversationKey,
      selectedText: "  duplicate\n selection ",
      initialLocation: { contextItemId: 46, pageIndex: 0 },
    });
    assert.equal(duplicate.outcome, "duplicate");
    assert.isFalse(duplicate.added);
    assert.equal(duplicate.selectedText, "duplicate selection");
    assert.equal(panel.status.textContent, "Selected text already included");
    assert.include(panel.status.className, "llm-status-ready");
    assert.lengthOf(getSelectedTextContextEntries(conversationKey), 1);

    for (let index = 1; index < 5; index++) {
      appendSelectedTextContextForItem(
        conversationKey,
        `selection ${index}`,
        "pdf",
        null,
        { contextItemId: 46, pageIndex: index },
      );
    }
    const overLimit = await includeReaderSelectedText({
      body: panel.body,
      conversationKey,
      selectedText: "sixth selection",
      initialLocation: { contextItemId: 46, pageIndex: 5 },
    });

    assert.equal(overLimit.outcome, "not-added");
    assert.equal(overLimit.selectedText, "sixth selection");
    assert.equal(panel.status.textContent, "Text Context up to 5");
    assert.lengthOf(getSelectedTextContextEntries(conversationKey), 5);
  });
});
