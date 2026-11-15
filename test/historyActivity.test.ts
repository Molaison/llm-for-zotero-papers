import { assert } from "chai";
import { afterEach, describe, it } from "mocha";
import {
  createHistoryActivityIndicator,
  observeHistoryActivity,
} from "../src/modules/contextPanel/historyActivity";
import {
  clearAllState,
  clearConversationOwnedRuntimeState,
  finishRequest,
  setPendingRequestId,
  transferRequest,
  tryBeginRequest,
} from "../src/modules/contextPanel/state";

class Indicator {
  className = "";
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  hidden = false;
  title = "";
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
}

const doc = {
  createElementNS: () => new Indicator(),
} as unknown as Document;

function historyView(keys: number[]) {
  const indicators = keys.map((key) =>
    createHistoryActivityIndicator(doc, key, "Working"),
  );
  const root = {
    querySelectorAll: (selector: string) =>
      indicators.filter((indicator) =>
        selector.includes(`"${indicator.dataset.conversationKey}"`),
      ),
  } as unknown as Element;
  return { indicators, dispose: observeHistoryActivity(root) };
}

describe("history conversation activity", function () {
  afterEach(() => clearAllState());

  it("updates only the running row in both open history views without replacing rows", function () {
    const sidebar = historyView([101, 202]);
    const dropdown = historyView([202, 101]);
    const originalSidebarRows = [...sidebar.indicators];

    // Paper 202 is selected; library 101 starts working in the background.
    assert.isTrue(tryBeginRequest(101, 7, new AbortController()));
    assert.deepEqual(
      sidebar.indicators.map((row) => row.hidden),
      [false, true],
    );
    assert.deepEqual(
      dropdown.indicators.map((row) => row.hidden),
      [true, false],
    );
    assert.equal(sidebar.indicators[0].getAttribute?.("aria-label"), "Working");
    assert.deepEqual(sidebar.indicators, originalSidebarRows);

    assert.isTrue(finishRequest(101, 7));
    assert.isTrue(sidebar.indicators.every((row) => row.hidden));
    assert.isTrue(dropdown.indicators.every((row) => row.hidden));
    sidebar.dispose();
    dropdown.dispose();
  });

  it("reads current activity on reopen and ignores stale completion of an earlier run", function () {
    tryBeginRequest(101, 7, new AbortController());
    const view = historyView([101]);
    assert.isFalse(view.indicators[0].hidden);
    finishRequest(101, 7);
    tryBeginRequest(101, 8, new AbortController());
    assert.isFalse(finishRequest(101, 7));
    assert.isFalse(view.indicators[0].hidden);
    view.dispose();
  });

  it("follows request transfer, legacy completion, and conversation removal", function () {
    const view = historyView([101, 202]);
    tryBeginRequest(101, 7, new AbortController());
    assert.isTrue(transferRequest(101, 202, 7));
    assert.deepEqual(
      view.indicators.map((row) => row.hidden),
      [true, false],
    );
    setPendingRequestId(202, 0, 6);
    assert.isFalse(view.indicators[1].hidden);
    setPendingRequestId(202, 0, 7);
    assert.isTrue(view.indicators[1].hidden);
    setPendingRequestId(101, 9);
    assert.isFalse(view.indicators[0].hidden);
    clearConversationOwnedRuntimeState(101);
    assert.isTrue(view.indicators[0].hidden);
    view.dispose();
  });

  it("stops touching a disposed view", function () {
    const view = historyView([101]);
    view.dispose();
    tryBeginRequest(101, 7, new AbortController());
    assert.isTrue(view.indicators[0].hidden);
  });
});
