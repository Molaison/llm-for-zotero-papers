import { assert } from "chai";
import {
  createCprPaperHistoryController,
  shouldOfferCprPaperHistory,
  type CprPaperHistoryAttempt,
  type CprPaperHistoryControllerDeps,
} from "../src/modules/contextPanel/cprPaperHistoryDialog";
import type { CprPaperHistory } from "../src/utils/cprPapers";

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
      applyHistory: async (value) => { shown.push(value); },
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

describe("CPR remote snapshot apply lifecycle", function () {
  it("keeps the request slot busy until asynchronous persistence finishes", async function () {
    let complete!: () => void;
    const applying = new Promise<void>(resolve => { complete = resolve; });
    const harness = createHarness({ applyHistory: () => applying });
    harness.setNext(history);
    const controller = createCprPaperHistoryController(harness.deps);
    const pending = controller.open();
    await Promise.resolve();
    assert.isTrue(controller.isBusy());
    assert.equal(harness.finished(), 0);
    assert.isEmpty(harness.statuses);
    complete();
    await pending;
    assert.equal(harness.finished(), 1);
    assert.equal(harness.statuses.at(-1)?.level, "ready");
  });

  it("reports a persistence failure without reporting synchronization success", async function () {
    const harness = createHarness({ applyHistory: async () => { throw new Error("Snapshot transaction failed"); } });
    harness.setNext(history);
    await createCprPaperHistoryController(harness.deps).open();
    assert.deepEqual(harness.statuses, [{ message: "Snapshot transaction failed", level: "error" }]);
    assert.equal(harness.finished(), 1);
  });

  it("does not update status on a panel or model superseded during apply", async function () {
    let current = true;
    const harness = createHarness({
      isCurrent: () => current,
      applyHistory: async () => { current = false; },
    });
    harness.setNext(history);
    await createCprPaperHistoryController(harness.deps).open();
    assert.isEmpty(harness.statuses);
    assert.equal(harness.finished(), 1);
  });
});
