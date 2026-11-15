import { assert } from "chai";
import {
  configurePendingDeletionMaintenanceEnvForTests,
  configurePendingDeletionSubsystem,
  disposePendingDeletionSubsystem,
  flushPendingDeletionMaintenanceForTests,
  resetPendingDeletionSubsystemForTests,
} from "../src/modules/contextPanel/pendingDeletionWiring";
import {
  pendingDeletionStore,
  configurePendingDeletionStoreEnv,
  resetPendingDeletionStoreForTests,
} from "../src/core/conversations/pendingDeletionStore";
import { chatHistory } from "../src/modules/contextPanel/state";
import {
  getNextConversationCleanupJobDueAt,
  notifyConversationCleanupJobsChanged,
  onConversationCleanupJobsChanged,
  performConversationCleanupJobAttempt,
  scheduleConversationCleanupJobsChangedNotification,
  type ConversationCleanupJob,
} from "../src/core/conversations/conversationCleanupJobs";
import { notifyBackgroundCleanupNeeded } from "../src/core/maintenance/backgroundCleanupSignals";
import { processPendingConversationCleanupJobs } from "../src/modules/contextPanel/conversationDeletion";
import { withConversationWriteLock } from "../src/shared/conversationWriteFence";
import { sweepOrphanedAgentTraceExports } from "../src/agent/store/traceStore";

const globalScope = globalThis as typeof globalThis & {
  Zotero?: Record<string, unknown>;
  IOUtils?: Record<string, unknown>;
};
const originalZotero = globalScope.Zotero;
const originalIOUtils = globalScope.IOUtils;

type FakeTimer = {
  callback: () => void;
  delayMs: number;
  cleared: boolean;
};

function createFakeTimers() {
  const timers: FakeTimer[] = [];
  return {
    timers,
    setTimer(callback: () => void, delayMs: number) {
      const timer = { callback, delayMs, cleared: false };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer(timer: ReturnType<typeof setTimeout>) {
      (timer as unknown as FakeTimer).cleared = true;
    },
    fire(delayMs: number) {
      const timer = timers.find(
        (candidate) => !candidate.cleared && candidate.delayMs === delayMs,
      );
      assert.exists(timer, `expected active ${delayMs}ms timer`);
      timer!.cleared = true;
      timer!.callback();
    },
    activeDelays() {
      return timers
        .filter((timer) => !timer.cleared)
        .map((timer) => timer.delayMs);
    },
  };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.isTrue(predicate(), "condition did not become true");
}

describe("pendingDeletionWiring", function () {
  afterEach(function () {
    resetPendingDeletionStoreForTests();
    resetPendingDeletionSubsystemForTests();
    chatHistory.clear();
    globalScope.Zotero = originalZotero;
    globalScope.IOUtils = originalIOUtils;
  });

  it("registers finalizers so a swept turn row deletes for real", async function () {
    const queries: string[] = [];
    globalScope.Zotero = {
      ...(originalZotero || {}),
      DB: {
        queryAsync: async (sql: string) => {
          queries.push(sql);
          if (
            sql.trimStart().toUpperCase().startsWith("SELECT") &&
            sql.includes("llm_for_zotero_pending_deletions")
          ) {
            return [
              {
                id: "pd-x",
                kind: "turn",
                conversation_id: null,
                conversation_key: 5,
                system: "upstream",
                payload: JSON.stringify({
                  userTimestamp: 100,
                  assistantTimestamp: 200,
                }),
                queued_at: 1,
                expires_at: 2,
                attempts: 0,
              },
            ];
          }
          return [];
        },
        executeTransaction: async (fn: () => Promise<unknown>) => fn(),
      },
      Prefs: { get: () => undefined, set: () => {} },
    };
    configurePendingDeletionStoreEnv({
      now: () => 10,
      setTimer: () => null,
      clearTimer: () => {},
      log: () => {},
    });
    configurePendingDeletionSubsystem();
    await pendingDeletionStore.sweepAllPersisted("startup");
    assert.isTrue(
      queries.some(
        (sql) => sql.includes("DELETE") && sql.includes("chat_messages"),
      ),
      `expected a chat_messages delete, got: ${queries.join(" | ")}`,
    );
    assert.isTrue(
      queries.some((sql) =>
        sql.includes("DELETE FROM llm_for_zotero_pending_deletions"),
      ),
    );
  });

  it("does not start a five-second maintenance poll while idle", async function () {
    const fakeTimers = createFakeTimers();
    let providerDiscoveryCount = 0;
    configurePendingDeletionMaintenanceEnvForTests({
      setTimer: fakeTimers.setTimer,
      clearTimer: fakeTimers.clearTimer,
      getNextProviderCleanupAt: async () => {
        providerDiscoveryCount += 1;
        return null;
      },
    });

    configurePendingDeletionSubsystem();
    await flushPendingDeletionMaintenanceForTests();

    assert.equal(providerDiscoveryCount, 1);
    assert.deepEqual(fakeTimers.activeDelays(), [30 * 60 * 1000]);
  });

  it("wakes at the nearest durable provider deadline and goes idle when empty", async function () {
    const fakeTimers = createFakeTimers();
    let now = 1_000;
    let nextAttemptAt: number | null = 1_250;
    let processCount = 0;
    configurePendingDeletionMaintenanceEnvForTests({
      now: () => now,
      setTimer: fakeTimers.setTimer,
      clearTimer: fakeTimers.clearTimer,
      getNextProviderCleanupAt: async () => nextAttemptAt,
      processProviderCleanup: async () => {
        processCount += 1;
        nextAttemptAt = null;
      },
    });

    configurePendingDeletionSubsystem();
    await flushPendingDeletionMaintenanceForTests();
    assert.include(fakeTimers.activeDelays(), 250);

    now = 1_250;
    fakeTimers.fire(250);
    await flushPendingDeletionMaintenanceForTests();
    assert.equal(processCount, 1);
    assert.deepEqual(fakeTimers.activeDelays(), [30 * 60 * 1000]);
  });

  it("replaces a later provider timer when an earlier job is enqueued", async function () {
    const fakeTimers = createFakeTimers();
    let nextAttemptAt: number | null = 50_000;
    configurePendingDeletionMaintenanceEnvForTests({
      now: () => 1_000,
      setTimer: fakeTimers.setTimer,
      clearTimer: fakeTimers.clearTimer,
      getNextProviderCleanupAt: async () => nextAttemptAt,
    });

    configurePendingDeletionSubsystem();
    await flushPendingDeletionMaintenanceForTests();
    assert.include(fakeTimers.activeDelays(), 49_000);

    nextAttemptAt = 2_000;
    notifyConversationCleanupJobsChanged();
    await flushPendingDeletionMaintenanceForTests();
    assert.notInclude(fakeTimers.activeDelays(), 49_000);
    assert.include(fakeTimers.activeDelays(), 1_000);
  });

  it("retries startup discovery failures without creating an idle poll", async function () {
    const fakeTimers = createFakeTimers();
    let shouldFail = true;
    configurePendingDeletionMaintenanceEnvForTests({
      setTimer: fakeTimers.setTimer,
      clearTimer: fakeTimers.clearTimer,
      getNextProviderCleanupAt: async () => {
        if (shouldFail) throw new Error("db unavailable");
        return null;
      },
    });

    configurePendingDeletionSubsystem();
    await flushPendingDeletionMaintenanceForTests();
    assert.include(fakeTimers.activeDelays(), 5_000);

    shouldFail = false;
    fakeTimers.fire(5_000);
    await flushPendingDeletionMaintenanceForTests();
    assert.deepEqual(fakeTimers.activeDelays(), [30 * 60 * 1000]);
  });

  it("bounds a due provider row that makes no progress", async function () {
    const fakeTimers = createFakeTimers();
    let processCount = 0;
    configurePendingDeletionMaintenanceEnvForTests({
      setTimer: fakeTimers.setTimer,
      clearTimer: fakeTimers.clearTimer,
      getNextProviderCleanupAt: async () => 0,
      processProviderCleanup: async () => {
        processCount += 1;
      },
    });

    configurePendingDeletionSubsystem();
    await flushPendingDeletionMaintenanceForTests();

    assert.equal(processCount, 1);
    assert.include(fakeTimers.activeDelays(), 5_000);
  });

  it("does not overlap slow sweeps and coalesces a cleanup signal received in flight", async function () {
    const fakeTimers = createFakeTimers();
    let releaseCollection!: () => void;
    let collectionCount = 0;
    let traceCount = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    configurePendingDeletionMaintenanceEnvForTests({
      setTimer: fakeTimers.setTimer,
      clearTimer: fakeTimers.clearTimer,
      getNextProviderCleanupAt: async () => null,
      collectAttachments: async () => {
        collectionCount += 1;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>((resolve) => {
          releaseCollection = () => {
            inFlight -= 1;
            resolve();
          };
        });
      },
      sweepTraces: async () => {
        traceCount += 1;
      },
    });

    configurePendingDeletionSubsystem();
    await flushPendingDeletionMaintenanceForTests();
    notifyBackgroundCleanupNeeded();
    fakeTimers.fire(5_000);
    await until(() => collectionCount === 1);

    notifyBackgroundCleanupNeeded();
    assert.equal(collectionCount, 1);
    releaseCollection();
    await flushPendingDeletionMaintenanceForTests();
    assert.equal(traceCount, 1);
    assert.include(fakeTimers.activeDelays(), 5_000);

    fakeTimers.fire(5_000);
    await until(() => collectionCount === 2);
    assert.equal(maxInFlight, 1);
    releaseCollection();
    await flushPendingDeletionMaintenanceForTests();
  });

  it("disposal fences late completions and duplicate configuration", async function () {
    const fakeTimers = createFakeTimers();
    let releaseProvider!: () => void;
    let processCount = 0;
    configurePendingDeletionMaintenanceEnvForTests({
      setTimer: fakeTimers.setTimer,
      clearTimer: fakeTimers.clearTimer,
      getNextProviderCleanupAt: async () => 0,
      processProviderCleanup: async () => {
        processCount += 1;
        await new Promise<void>((resolve) => {
          releaseProvider = resolve;
        });
      },
    });

    configurePendingDeletionSubsystem();
    configurePendingDeletionSubsystem();
    await until(() => processCount === 1);
    disposePendingDeletionSubsystem();
    releaseProvider();
    await flushPendingDeletionMaintenanceForTests();
    assert.deepEqual(fakeTimers.activeDelays(), []);
  });

  it("carries a new generation wake across an old in-flight provider loop", async function () {
    const fakeTimers = createFakeTimers();
    let releaseOldProvider!: () => void;
    let oldProcessCount = 0;
    let newDiscoveryCount = 0;
    configurePendingDeletionMaintenanceEnvForTests({
      setTimer: fakeTimers.setTimer,
      clearTimer: fakeTimers.clearTimer,
      getNextProviderCleanupAt: async () => 0,
      processProviderCleanup: async () => {
        oldProcessCount += 1;
        await new Promise<void>((resolve) => {
          releaseOldProvider = resolve;
        });
      },
    });
    configurePendingDeletionSubsystem();
    await until(() => oldProcessCount === 1);

    disposePendingDeletionSubsystem();
    configurePendingDeletionMaintenanceEnvForTests({
      setTimer: fakeTimers.setTimer,
      clearTimer: fakeTimers.clearTimer,
      getNextProviderCleanupAt: async () => {
        newDiscoveryCount += 1;
        return null;
      },
      processProviderCleanup: async () => {
        assert.fail("new generation had no due provider work");
      },
    });
    configurePendingDeletionSubsystem();
    assert.equal(newDiscoveryCount, 0, "new loop waits for the old loop owner");

    releaseOldProvider();
    await flushPendingDeletionMaintenanceForTests();
    assert.equal(newDiscoveryCount, 1);
    assert.deepEqual(fakeTimers.activeDelays(), [30 * 60 * 1000]);
  });

  it("queues a new generation slow sweep behind the disposed in-flight sweep", async function () {
    const fakeTimers = createFakeTimers();
    let releaseOldSweep!: () => void;
    let oldCollectionCount = 0;
    let newCollectionCount = 0;
    configurePendingDeletionMaintenanceEnvForTests({
      setTimer: fakeTimers.setTimer,
      clearTimer: fakeTimers.clearTimer,
      getNextProviderCleanupAt: async () => null,
      collectAttachments: async () => {
        oldCollectionCount += 1;
        await new Promise<void>((resolve) => {
          releaseOldSweep = resolve;
        });
      },
      sweepTraces: async () => {},
    });
    configurePendingDeletionSubsystem();
    await flushPendingDeletionMaintenanceForTests();
    notifyBackgroundCleanupNeeded();
    fakeTimers.fire(5_000);
    await until(() => oldCollectionCount === 1);

    disposePendingDeletionSubsystem();
    configurePendingDeletionMaintenanceEnvForTests({
      setTimer: fakeTimers.setTimer,
      clearTimer: fakeTimers.clearTimer,
      getNextProviderCleanupAt: async () => null,
      collectAttachments: async () => {
        newCollectionCount += 1;
      },
      sweepTraces: async () => {},
    });
    configurePendingDeletionSubsystem();
    notifyBackgroundCleanupNeeded();
    assert.equal(newCollectionCount, 0);

    releaseOldSweep();
    await flushPendingDeletionMaintenanceForTests();
    assert.include(fakeTimers.activeDelays(), 5_000);
    fakeTimers.fire(5_000);
    await flushPendingDeletionMaintenanceForTests();
    assert.equal(newCollectionCount, 1);
  });

  it("treats SQLite MIN null as an empty provider queue", async function () {
    globalScope.Zotero = {
      ...(originalZotero || {}),
      DB: {
        queryAsync: async (sql: string) =>
          sql.includes("MIN(next_attempt_at)")
            ? [{ next_attempt_at: null }]
            : [],
      },
    };

    assert.isNull(
      await getNextConversationCleanupJobDueAt({
        includeAttentionRequired: true,
      }),
    );
  });

  it("coalesces inline and background provider attempts and honors the persisted retry deadline", async function () {
    const job: ConversationCleanupJob = {
      id: "cleanup-coalesced",
      operation: "codex_archive",
      system: "codex",
      conversationKey: 41,
      instanceID: "instance-41",
      conversationKind: "global",
      libraryID: 1,
      providerSessionId: "thread-41",
      attempts: 0,
      nextAttemptAt: 0,
      providerCleanupState: "pending",
    };
    let storedJob: ConversationCleanupJob | null = { ...job };
    let operationCount = 0;
    let releaseOperation!: () => void;
    globalScope.Zotero = {
      ...(originalZotero || {}),
      DB: {
        queryAsync: async (sql: string, params?: unknown[]) => {
          if (
            sql.includes("WHERE id = ?") &&
            sql.trimStart().startsWith("SELECT")
          ) {
            if (!storedJob) return [];
            return [
              {
                id: storedJob.id,
                operation: storedJob.operation,
                system: storedJob.system,
                conversation_key: storedJob.conversationKey,
                instance_id: storedJob.instanceID,
                conversation_kind: storedJob.conversationKind,
                library_id: storedJob.libraryID,
                provider_session_id: storedJob.providerSessionId,
                attempts: storedJob.attempts,
                next_attempt_at: storedJob.nextAttemptAt,
                provider_cleanup_state: storedJob.providerCleanupState,
              },
            ];
          }
          if (
            sql.trimStart().startsWith("DELETE") &&
            sql.includes("WHERE id = ?")
          ) {
            storedJob = null;
            return [];
          }
          if (
            sql.trimStart().startsWith("UPDATE") &&
            sql.includes("next_attempt_at")
          ) {
            if (storedJob) {
              storedJob = {
                ...storedJob,
                attempts: Number(params?.[0]),
                nextAttemptAt: Number(params?.[1]),
                lastError: String(params?.[2] || ""),
                providerCleanupState: String(params?.[3]) as
                  | "pending"
                  | "attention_required",
              };
            }
            return [];
          }
          return [];
        },
      },
    };

    const first = performConversationCleanupJobAttempt(job, async () => {
      operationCount += 1;
      await new Promise<void>((resolve) => {
        releaseOperation = resolve;
      });
      throw new Error("provider unavailable");
    });
    const joined = performConversationCleanupJobAttempt(job, async () => {
      operationCount += 1;
    });
    await until(() => operationCount === 1);
    releaseOperation();
    const [firstResult, joinedResult] = await Promise.all([first, joined]);

    assert.isFalse(firstResult.ok);
    assert.deepEqual(joinedResult, firstResult);
    assert.equal(operationCount, 1);
    assert.isAbove(storedJob?.nextAttemptAt || 0, Date.now());

    const stale = await performConversationCleanupJobAttempt(job, async () => {
      operationCount += 1;
    });
    assert.isFalse(stale.ok);
    if (!stale.ok) assert.isTrue(stale.deferred);
    assert.equal(operationCount, 1);
  });

  it("defers an enqueue wake so a write-locked foreground attempt can claim the job first", async function () {
    const job: ConversationCleanupJob = {
      id: "cleanup-write-locked",
      operation: "claude_invalidate",
      system: "claude_code",
      conversationKey: 42,
      instanceID: "instance-42",
      conversationKind: "global",
      libraryID: 1,
      providerSessionId: "session-42",
      attempts: 0,
      nextAttemptAt: 0,
      providerCleanupState: "pending",
    };
    let stored = true;
    let notifications = 0;
    let foregroundClaimed = false;
    globalScope.Zotero = {
      ...(originalZotero || {}),
      DB: {
        queryAsync: async (sql: string) => {
          if (
            sql.trimStart().startsWith("SELECT") &&
            sql.includes("WHERE id = ?")
          ) {
            return stored
              ? [
                  {
                    id: job.id,
                    operation: job.operation,
                    system: job.system,
                    conversation_key: job.conversationKey,
                    instance_id: job.instanceID,
                    conversation_kind: job.conversationKind,
                    library_id: job.libraryID,
                    provider_session_id: job.providerSessionId,
                    attempts: job.attempts,
                    next_attempt_at: job.nextAttemptAt,
                    provider_cleanup_state: job.providerCleanupState,
                  },
                ]
              : [];
          }
          if (
            sql.trimStart().startsWith("DELETE") &&
            sql.includes("WHERE id = ?")
          ) {
            stored = false;
          }
          return [];
        },
      },
    };
    const unsubscribe = onConversationCleanupJobsChanged(() => {
      notifications += 1;
      assert.isTrue(
        foregroundClaimed,
        "background wake must not precede the foreground attempt claim",
      );
    });
    try {
      scheduleConversationCleanupJobsChangedNotification();
      assert.equal(notifications, 0);
      const result = await performConversationCleanupJobAttempt(
        job,
        async () => {
          foregroundClaimed = true;
        },
      );
      assert.isTrue(result.ok);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      assert.isAtLeast(notifications, 2);
    } finally {
      unsubscribe();
    }
  });

  it("takes the conversation lock before a background attempt can claim an existing job", async function () {
    const job: ConversationCleanupJob = {
      id: "cleanup-existing-locked",
      operation: "codex_archive",
      system: "codex",
      conversationKey: 43,
      instanceID: "instance-43",
      conversationKind: "global",
      libraryID: 1,
      providerSessionId: "thread-43",
      attempts: 0,
      nextAttemptAt: 0,
      providerCleanupState: "pending",
    };
    let stored = true;
    let dueListRead = false;
    let foregroundOperations = 0;
    let backgroundOperations = 0;
    globalScope.Zotero = {
      ...(originalZotero || {}),
      DB: {
        queryAsync: async (sql: string) => {
          if (sql.includes("WHERE next_attempt_at <= ?")) {
            dueListRead = true;
            return stored
              ? [
                  {
                    id: job.id,
                    operation: job.operation,
                    system: job.system,
                    conversation_key: job.conversationKey,
                    instance_id: job.instanceID,
                    conversation_kind: job.conversationKind,
                    library_id: job.libraryID,
                    provider_session_id: job.providerSessionId,
                    attempts: job.attempts,
                    next_attempt_at: job.nextAttemptAt,
                    provider_cleanup_state: job.providerCleanupState,
                  },
                ]
              : [];
          }
          if (
            sql.trimStart().startsWith("SELECT") &&
            sql.includes("WHERE id = ?")
          ) {
            return stored
              ? [
                  {
                    id: job.id,
                    operation: job.operation,
                    system: job.system,
                    conversation_key: job.conversationKey,
                    instance_id: job.instanceID,
                    conversation_kind: job.conversationKind,
                    library_id: job.libraryID,
                    provider_session_id: job.providerSessionId,
                    attempts: job.attempts,
                    next_attempt_at: job.nextAttemptAt,
                    provider_cleanup_state: job.providerCleanupState,
                  },
                ]
              : [];
          }
          if (
            sql.trimStart().startsWith("DELETE") &&
            sql.includes("WHERE id = ?")
          ) {
            stored = false;
          }
          return [];
        },
      },
    };

    let background!: Promise<void>;
    await withConversationWriteLock(job.conversationKey, async () => {
      background = processPendingConversationCleanupJobs({
        operations: {
          archiveCodexThread: async () => {
            backgroundOperations += 1;
          },
        },
      });
      await until(() => dueListRead);
      const foreground = await performConversationCleanupJobAttempt(
        job,
        async () => {
          foregroundOperations += 1;
        },
      );
      assert.isTrue(foreground.ok);
    });
    await background;

    assert.equal(foregroundOperations, 1);
    assert.equal(
      backgroundOperations,
      0,
      "the late background list must observe the completed durable job",
    );
  });

  it("coalesces trace reconciliation across startup and scheduled callers", async function () {
    let queryCount = 0;
    let directoryCount = 0;
    let releaseDirectory!: () => void;
    globalScope.Zotero = {
      ...(originalZotero || {}),
      DataDirectory: { dir: "/tmp/zotero-data" },
      Profile: { dir: "/tmp/zotero-profile" },
      DB: {
        queryAsync: async () => {
          queryCount += 1;
          return [];
        },
      },
    };
    globalScope.IOUtils = {
      getChildren: async () => {
        directoryCount += 1;
        await new Promise<void>((resolve) => {
          releaseDirectory = resolve;
        });
        return [];
      },
      remove: async () => {},
    };

    const startup = sweepOrphanedAgentTraceExports();
    const scheduled = sweepOrphanedAgentTraceExports();
    assert.strictEqual(scheduled, startup);
    await until(() => directoryCount === 1);
    assert.equal(queryCount, 2);
    releaseDirectory();
    await Promise.all([startup, scheduled]);
    assert.equal(directoryCount, 1);
  });
});
