import { assert } from "chai";
import {
  createCprLocalHistoryRecoveryController,
  shouldOfferCprLocalHistoryRecovery,
  type CprLocalHistoryRecoveryAttempt,
  type CprLocalHistoryRecoveryDeps,
} from "../src/modules/contextPanel/cprLocalHistoryRecovery";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function harness(overrides: Partial<CprLocalHistoryRecoveryAttempt> = {}) {
  const events: string[] = [];
  const statuses: Array<{ message: string; level: string }> = [];
  const abort = new AbortController();
  let current = true;
  const deps: CprLocalHistoryRecoveryDeps = {
    begin: () => {
      events.push("begin");
      return {
        signal: abort.signal,
        isCurrent: () => current,
        hasRestorePoint: async () => {
          events.push("lookup");
          return true;
        },
        restoreHistory: async () => {
          events.push("restore");
        },
        finish: () => {
          events.push("finish");
        },
        ...overrides,
      };
    },
    confirmRestore: () => {
      events.push("confirm");
      return true;
    },
    setBusy: (busy) => {
      events.push(`busy:${busy}`);
    },
    setStatusMessage: (message, level) => {
      statuses.push({ message, level });
    },
    logError: () => {
      events.push("error");
    },
  };
  return {
    deps,
    events,
    statuses,
    abort,
    leave: () => {
      current = false;
    },
  };
}

describe("CPR local history recovery availability", function () {
  it("offers local recovery for an upstream paper without a model or transport", function () {
    assert.isTrue(
      shouldOfferCprLocalHistoryRecovery({
        conversationSystem: "upstream",
        paperItemId: 42,
        isNoteSession: false,
      }),
    );
    for (const conversationSystem of ["codex", "claude_code"] as const) {
      assert.isFalse(
        shouldOfferCprLocalHistoryRecovery({
          conversationSystem,
          paperItemId: 42,
          isNoteSession: false,
        }),
      );
    }
    assert.isFalse(
      shouldOfferCprLocalHistoryRecovery({
        conversationSystem: "upstream",
        paperItemId: null,
        isNoteSession: false,
      }),
    );
    assert.isFalse(
      shouldOfferCprLocalHistoryRecovery({
        conversationSystem: "upstream",
        paperItemId: 42,
        isNoteSession: true,
      }),
    );
  });
});

describe("CPR local history recovery controller", function () {
  it("confirms before replacing history and releases the request slot before enabling actions", async function () {
    const state = harness();
    await createCprLocalHistoryRecoveryController(state.deps).open();
    assert.deepEqual(state.events, [
      "begin",
      "busy:true",
      "lookup",
      "confirm",
      "restore",
      "finish",
      "busy:false",
    ]);
    assert.deepEqual(state.statuses, [
      { message: "Local history restored", level: "ready" },
    ]);
  });

  it("reports an absent restore point without asking to replace messages", async function () {
    const state = harness({ hasRestorePoint: async () => false });
    await createCprLocalHistoryRecoveryController(state.deps).open();
    assert.notInclude(state.events, "confirm");
    assert.notInclude(state.events, "restore");
    assert.deepEqual(state.statuses, [
      {
        message: "No local history restore point is available",
        level: "warning",
      },
    ]);
    assert.include(state.events, "finish");
  });

  it("does nothing if a send or synchronization already owns the request slot", async function () {
    const state = harness();
    state.deps.begin = () => null;
    const controller = createCprLocalHistoryRecoveryController(state.deps);
    await controller.open();
    assert.isEmpty(state.events);
    assert.isEmpty(state.statuses);
    assert.isFalse(controller.isBusy());
  });

  it("leaves messages untouched when the confirmation is cancelled", async function () {
    const state = harness();
    state.deps.confirmRestore = () => false;
    await createCprLocalHistoryRecoveryController(state.deps).open();
    assert.notInclude(state.events, "restore");
    assert.deepEqual(state.statuses, [
      { message: "Local history restore cancelled", level: "ready" },
    ]);
    assert.include(state.events, "finish");
  });

  it("ignores repeat clicks throughout confirmation and persistence", async function () {
    const confirmation = deferred<boolean>();
    const persistence = deferred<void>();
    const state = harness({ restoreHistory: () => persistence.promise });
    state.deps.confirmRestore = () => confirmation.promise;
    const controller = createCprLocalHistoryRecoveryController(state.deps);
    const pending = controller.open();
    await Promise.resolve();
    await controller.open();
    assert.isTrue(controller.isBusy());
    assert.equal(state.events.filter((event) => event === "begin").length, 1);
    confirmation.resolve(true);
    await Promise.resolve();
    await controller.open();
    assert.notInclude(state.events, "finish");
    assert.isEmpty(state.statuses);
    persistence.resolve();
    await pending;
    assert.isFalse(controller.isBusy());
    assert.equal(state.events.filter((event) => event === "finish").length, 1);
    assert.equal(state.statuses.at(-1)?.level, "ready");
  });

  it("ignores a late backup lookup after navigating to another paper", async function () {
    const lookup = deferred<boolean>();
    const state = harness({ hasRestorePoint: () => lookup.promise });
    const pending = createCprLocalHistoryRecoveryController(state.deps).open();
    state.leave();
    lookup.resolve(true);
    await pending;
    assert.notInclude(state.events, "confirm");
    assert.notInclude(state.events, "restore");
    assert.isEmpty(state.statuses);
    assert.include(state.events, "finish");
  });

  it("does not restore if the panel changes while confirmation is open", async function () {
    const confirmation = deferred<boolean>();
    const state = harness();
    state.deps.confirmRestore = () => confirmation.promise;
    const pending = createCprLocalHistoryRecoveryController(state.deps).open();
    await Promise.resolve();
    state.leave();
    confirmation.resolve(true);
    await pending;
    assert.notInclude(state.events, "restore");
    assert.isEmpty(state.statuses);
  });

  it("does not restore after cancellation while the backup is being checked", async function () {
    const lookup = deferred<boolean>();
    const state = harness({ hasRestorePoint: () => lookup.promise });
    const pending = createCprLocalHistoryRecoveryController(state.deps).open();
    state.abort.abort();
    lookup.resolve(true);
    await pending;
    assert.notInclude(state.events, "confirm");
    assert.notInclude(state.events, "restore");
    assert.isEmpty(state.statuses);
  });

  it("keeps errors recoverable and never reports a failed transaction as restored", async function () {
    let fail = true;
    const state = harness({
      restoreHistory: async () => {
        if (fail) throw new Error("Restore transaction failed");
      },
    });
    const controller = createCprLocalHistoryRecoveryController(state.deps);
    await controller.open();
    assert.deepEqual(state.statuses, [
      { message: "Restore transaction failed", level: "error" },
    ]);
    assert.isFalse(controller.isBusy());
    fail = false;
    await controller.open();
    assert.equal(state.statuses.at(-1)?.level, "ready");
  });

  it("does not report completion on a panel that changed during persistence", async function () {
    const persistence = deferred<void>();
    const state = harness({ restoreHistory: () => persistence.promise });
    const pending = createCprLocalHistoryRecoveryController(state.deps).open();
    await Promise.resolve();
    await Promise.resolve();
    state.leave();
    persistence.resolve();
    await pending;
    assert.isEmpty(state.statuses);
    assert.include(state.events, "finish");
  });
});
