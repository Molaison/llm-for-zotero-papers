import { assert } from "chai";
import {
  getAgentApi,
  getCoreAgentRuntime,
  initAgentSubsystem,
  shutdownAgentSubsystem,
} from "../src/agent/index";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function captureRejection(task: Promise<unknown>): Promise<unknown> {
  try {
    await task;
    return null;
  } catch (error) {
    return error;
  }
}

function installAgentLifecycleTestZotero() {
  const gates: Array<Deferred<unknown[]>> = [];
  let gatedAgentRunTableCreates = 0;
  const endpoints: Record<string, unknown> = {};
  const globalScope = globalThis as typeof globalThis & { Zotero?: any };
  const originalZotero = globalScope.Zotero;
  globalScope.Zotero = {
    DB: {
      executeTransaction: async (callback: () => Promise<unknown>) =>
        await callback(),
      queryAsync: async (sql: string) => {
        if (
          sql.includes(
            "CREATE TABLE IF NOT EXISTS llm_for_zotero_agent_runs",
          ) &&
          gates.length
        ) {
          gatedAgentRunTableCreates += 1;
          return await gates.shift()!.promise;
        }
        return [];
      },
    },
    Server: {
      Endpoints: endpoints,
    },
    Profile: {
      dir: "/tmp/llm-for-zotero-agent-lifecycle-test",
    },
    debug: () => undefined,
  };
  return {
    endpoints,
    gates,
    getGatedAgentRunTableCreates: () => gatedAgentRunTableCreates,
    restore: () => {
      globalScope.Zotero = originalZotero;
    },
  };
}

describe("agent subsystem lifecycle", function () {
  let restoreZotero: (() => void) | null = null;

  afterEach(function () {
    try {
      shutdownAgentSubsystem();
    } catch {
      // Ignore cleanup errors if the fake Zotero object has already been removed.
    }
    restoreZotero?.();
    restoreZotero = null;
  });

  it("does not publish an init that finishes after shutdown", async function () {
    const fixture = installAgentLifecycleTestZotero();
    restoreZotero = fixture.restore;
    const gate = createDeferred<unknown[]>();
    fixture.gates.push(gate);

    const initTask = initAgentSubsystem();
    await flushMicrotasks();
    assert.equal(fixture.getGatedAgentRunTableCreates(), 1);

    shutdownAgentSubsystem();
    gate.resolve([]);
    const error = await captureRejection(initTask);

    assert.instanceOf(error, Error);
    assert.match(String((error as Error).message), /cancelled/);
    assert.throws(() => getCoreAgentRuntime(), /not initialized/);
    assert.deepEqual(Object.keys(fixture.endpoints), []);
  });

  it("does not let a stale init finalizer clear a newer init task", async function () {
    const fixture = installAgentLifecycleTestZotero();
    restoreZotero = fixture.restore;
    const staleGate = createDeferred<unknown[]>();
    fixture.gates.push(staleGate);

    const staleTask = initAgentSubsystem();
    await flushMicrotasks();
    assert.equal(fixture.getGatedAgentRunTableCreates(), 1);

    shutdownAgentSubsystem();

    const currentGate = createDeferred<unknown[]>();
    fixture.gates.push(currentGate);
    const currentTask = initAgentSubsystem();
    await flushMicrotasks();
    assert.equal(fixture.getGatedAgentRunTableCreates(), 2);

    staleGate.resolve([]);
    const staleError = await captureRejection(staleTask);
    assert.instanceOf(staleError, Error);
    assert.match(String((staleError as Error).message), /cancelled/);

    const unexpectedThirdGate = createDeferred<unknown[]>();
    fixture.gates.push(unexpectedThirdGate);
    const sameCurrentTask = initAgentSubsystem();
    await flushMicrotasks();
    const gatedCount = fixture.getGatedAgentRunTableCreates();
    if (gatedCount > 2) {
      unexpectedThirdGate.resolve([]);
    }
    assert.equal(gatedCount, 2);

    currentGate.resolve([]);
    const [currentRuntime, sameCurrentRuntime] = await Promise.all([
      currentTask,
      sameCurrentTask,
    ]);
    assert.strictEqual(currentRuntime, sameCurrentRuntime);
    assert.strictEqual(getCoreAgentRuntime(), currentRuntime);
  });

  it("passes the caller's Stop signal from the public runTurn to the runtime, and none by default", async function () {
    const fixture = installAgentLifecycleTestZotero();
    restoreZotero = fixture.restore;
    const runtime = await initAgentSubsystem();
    const received: Array<{ signal?: AbortSignal }> = [];
    runtime.runTurn = (async (params: { signal?: AbortSignal }) => {
      received.push(params);
      return { kind: "completed", runId: "run-1", text: "" };
    }) as never;
    const request = {
      conversationKey: 7,
      conversationGeneration: 0,
      mode: "agent" as const,
      userText: "continue",
    };
    const stop = new AbortController();
    await getAgentApi().runTurn(request, undefined, { signal: stop.signal });
    await getAgentApi().runTurn(request);
    assert.strictEqual(received[0].signal, stop.signal);
    assert.notProperty(received[1], "signal");
  });
});
