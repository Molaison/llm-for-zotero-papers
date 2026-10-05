import { assert } from "chai";
import {
  createCprPaperHistoryController,
  formatCprHistoryTimestamp,
  shouldOfferCprPaperHistory,
  showCprPaperHistoryDialog,
  type CprPaperHistoryAttempt,
  type CprPaperHistoryControllerDeps,
} from "../src/modules/contextPanel/cprPaperHistoryDialog";
import type { CprPaperHistory } from "../src/utils/cprPapers";
import { FakeElement } from "./helpers/fakeDom";

const PAPER_ID = 4242;
const history: CprPaperHistory = {
  paper_id: "doi:10.1000/xyz",
  thread_id: "thread-a",
  conversation_url: "https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef/c/abc",
  title: "Remote paper chat",
  messages: [
    { id: "m1", role: "user", text: "what is <img src=x onerror=alert(1)>?", created_at: 1_700_000_000_000 },
    { id: "m2", role: "assistant", text: "plain answer", created_at: null },
  ],
};

function createFakeDoc() {
  const body = new FakeElement("div");
  const doc = {
    body,
    documentElement: body,
    defaultView: null,
    createElement: (tagName: string) => new FakeElement(tagName),
    createElementNS: (_namespace: string, tagName: string) =>
      new FakeElement(tagName),
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as Document;
  return { doc, body };
}

type Harness = {
  deps: CprPaperHistoryControllerDeps;
  loads: Array<{ itemId: number; apiBase: string; apiKey: string; model: string }>;
  shown: CprPaperHistory[];
  statuses: Array<{ message: string; level: string }>;
  finished: () => number;
  setNext: (value: CprPaperHistory | Error | Promise<CprPaperHistory>) => void;
};

function createHarness(
  attemptOverrides: Partial<CprPaperHistoryAttempt> = {},
): Harness {
  let finishCount = 0;
  let resolveLoad: ((value: CprPaperHistory) => void) | null = null;
  let rejectLoad: ((error: unknown) => void) | null = null;
  let next: CprPaperHistory | Error | Promise<CprPaperHistory> | null = null;
  const loads: Harness["loads"] = [];
  const shown: CprPaperHistory[] = [];
  const statuses: Harness["statuses"] = [];
  const deps: CprPaperHistoryControllerDeps = {
    begin: () => ({
      request: {
        itemId: PAPER_ID,
        apiBase: "https://cpr.example/v1",
        apiKey: "key-a",
        model: "papers/gpt-5.6-pro",
      },
      signal: new AbortController().signal,
      isCurrent: () => true,
      finish: () => {
        finishCount += 1;
      },
      ...attemptOverrides,
    }),
    loadHistory: (params) => {
      loads.push({
        itemId: params.itemId,
        apiBase: params.apiBase,
        apiKey: params.apiKey,
        model: params.model,
      });
      if (next instanceof Error) return Promise.reject(next);
      if (next) return Promise.resolve(next);
      return new Promise<CprPaperHistory>((resolve, reject) => {
        resolveLoad = resolve;
        rejectLoad = reject;
      });
    },
    showHistory: (value) => {
      shown.push(value);
    },
    setBusy: () => {},
    setStatusMessage: (message, level) => {
      statuses.push({ message, level });
    },
    logError: () => {},
  };
  return {
    deps,
    loads,
    shown,
    statuses,
    finished: () => finishCount,
    setNext: (value) => {
      next = value;
      if (resolveLoad && value && !(value instanceof Error) && !(value instanceof Promise)) {
        resolveLoad(value);
        resolveLoad = null;
      }
      if (rejectLoad && value instanceof Error) {
        rejectLoad(value);
        rejectLoad = null;
      }
    },
  };
}

describe("CPR remote paper history button visibility", function () {
  it("offers the button only for an upstream papers chat bound to one paper", function () {
    assert.isTrue(
      shouldOfferCprPaperHistory({
        conversationSystem: "upstream",
        model: "papers/gpt-5.6-pro",
        paperItemId: PAPER_ID,
      }),
    );
    assert.isFalse(
      shouldOfferCprPaperHistory({
        conversationSystem: "claude_code",
        model: "papers/gpt-5.6-pro",
        paperItemId: PAPER_ID,
      }),
    );
    assert.isFalse(
      shouldOfferCprPaperHistory({
        conversationSystem: "codex",
        model: "papers/gpt-5.6-pro",
        paperItemId: PAPER_ID,
      }),
    );
    assert.isFalse(
      shouldOfferCprPaperHistory({
        conversationSystem: "upstream",
        model: "gpt-5.6-pro",
        paperItemId: PAPER_ID,
      }),
    );
    assert.isFalse(
      shouldOfferCprPaperHistory({
        conversationSystem: "upstream",
        model: "papers/unknown-alias",
        paperItemId: PAPER_ID,
      }),
    );
    assert.isFalse(
      shouldOfferCprPaperHistory({
        conversationSystem: "upstream",
        model: "papers/gpt-5.6-pro",
        paperItemId: null,
      }),
    );
  });

  it("shows a time only when the server sent a usable timestamp", function () {
    assert.equal(formatCprHistoryTimestamp(null), "");
    assert.equal(formatCprHistoryTimestamp(undefined), "");
    assert.equal(formatCprHistoryTimestamp(0), "");
    assert.equal(formatCprHistoryTimestamp(-5), "");
    assert.notEqual(formatCprHistoryTimestamp(1_700_000_000), "");
    assert.equal(
      formatCprHistoryTimestamp(1_700_000_000_000),
      new Date(1_700_000_000_000).toLocaleString(),
    );
  });
});

describe("CPR remote paper history dialog", function () {
  it("renders remote text as text and keeps the original conversation link", function () {
    const { doc, body } = createFakeDoc();
    showCprPaperHistoryDialog(doc, history);

    const dialog = body.findByClass("llm-remote-history-dialog");
    assert.isNotNull(dialog);
    assert.equal(dialog!.findByClass("llm-modal-title")?.textContent, history.title);
    const link = dialog!.findAllByTag("a")[0];
    assert.equal(link.getAttribute("href"), history.conversation_url);
    assert.equal(link.getAttribute("target"), "_blank");

    const rows = dialog!.findAllByClass("llm-remote-history-message");
    assert.equal(rows.length, 2);
    assert.equal(rows[0].dataset.role, "user");
    assert.equal(rows[1].dataset.role, "assistant");
    // Untrusted remote text never becomes markup.
    assert.equal(
      rows[0].findByClass("llm-remote-history-message-text")?.textContent,
      history.messages[0].text,
    );
    assert.equal(
      rows[0].findByClass("llm-remote-history-message-text")?.innerHTML,
      "",
    );

    dialog!.findByClass("llm-modal-cancel")!.dispatchFakeEvent("click");
    assert.equal(body.findAllByClass("llm-remote-history-overlay").length, 0);
  });

  it("replaces the open dialog instead of stacking a second one", function () {
    const { doc, body } = createFakeDoc();
    showCprPaperHistoryDialog(doc, history);
    showCprPaperHistoryDialog(doc, { ...history, title: "Second" });
    const overlays = body.findAllByClass("llm-remote-history-overlay");
    assert.equal(overlays.length, 1);
    assert.equal(
      overlays[0].findByClass("llm-modal-title")?.textContent,
      "Second",
    );
  });
});

describe("CPR remote paper history flow", function () {
  it("sends the conversation's own transport settings and ignores a repeat click", async function () {
    const harness = createHarness();
    const controller = createCprPaperHistoryController(harness.deps);
    const first = controller.open();
    const second = controller.open();
    assert.equal(harness.loads.length, 1);
    assert.deepEqual(harness.loads[0], {
      itemId: PAPER_ID,
      apiBase: "https://cpr.example/v1",
      apiKey: "key-a",
      model: "papers/gpt-5.6-pro",
    });
    assert.isTrue(controller.isBusy());

    harness.setNext(history);
    await Promise.all([first, second]);
    assert.isFalse(controller.isBusy());
    assert.equal(harness.shown.length, 1);
    assert.equal(harness.finished(), 1);
  });

  it("drops the answer of a paper the panel has left", async function () {
    const harness = createHarness({ isCurrent: () => false });
    const controller = createCprPaperHistoryController(harness.deps);
    const run = controller.open();
    harness.setNext(history);
    await run;
    assert.equal(harness.shown.length, 0);
    assert.deepEqual(harness.statuses, []);
    assert.equal(harness.finished(), 1);
    assert.isFalse(controller.isBusy());
  });

  it("shows the server's own error, keeps the local conversation untouched, and retries later", async function () {
    const localConversation = [{ role: "user", text: "local turn" }];
    const snapshot = JSON.parse(JSON.stringify(localConversation));
    const harness = createHarness();
    const controller = createCprPaperHistoryController(harness.deps);
    harness.setNext(new Error("读取远端记录 HTTP 500: boom"));
    await controller.open();

    assert.equal(harness.shown.length, 0);
    assert.deepEqual(harness.statuses, [
      { message: "读取远端记录 HTTP 500: boom", level: "error" },
    ]);
    assert.deepEqual(localConversation, snapshot);
    assert.isFalse(controller.isBusy());
    assert.equal(harness.finished(), 1);

    harness.setNext(history);
    await controller.open();
    assert.equal(harness.shown.length, 1);
    assert.equal(harness.finished(), 2);
  });

  it("starts no request when the conversation slot is not claimable", async function () {
    const harness = createHarness();
    harness.deps.begin = () => null;
    const controller = createCprPaperHistoryController(harness.deps);
    await controller.open();
    assert.equal(harness.loads.length, 0);
    assert.isFalse(controller.isBusy());
  });
  it("releases the request slot before re-enabling the button", async function () {
    let pending = true;
    const harness = createHarness({finish: () => {pending = false;}});
    harness.deps.setBusy = busy => {if (!busy) assert.isFalse(pending);};
    harness.setNext(history);
    await createCprPaperHistoryController(harness.deps).open();
    assert.equal(harness.statuses.at(-1)?.level, "ready");
  });
  it("drops a response that completed after cancellation", async function () {
    const abort = new AbortController();
    const harness = createHarness({signal: abort.signal});
    const run = createCprPaperHistoryController(harness.deps).open();
    abort.abort();
    harness.setNext(history);
    await run;
    assert.isEmpty(harness.shown);
    assert.isEmpty(harness.statuses);
    assert.equal(harness.finished(), 1);
  });
});
