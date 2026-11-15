import { assert } from "chai";
import {
  createAppLogger,
  getAppLogLevel,
  getMaintenanceQueryOptions,
  setAppLogSinkForTests,
  type AppLogLevel,
} from "../src/core/logging";
import { getNextConversationCleanupJobDueAt } from "../src/core/conversations/conversationCleanupJobs";
import { collectAndDeleteUnreferencedBlobs } from "../src/utils/attachmentRefStore";
import { sweepOrphanedAgentTraceExports } from "../src/agent/store/traceStore";
import {
  recordUsageEvent,
  resetUsageStoreForTests,
} from "../src/utils/usageStore";
import { installAppLogging } from "../src/utils/ztoolkit";

const scope = globalThis as typeof globalThis & {
  Zotero?: {
    Prefs?: { get?: (key: string, global?: boolean) => unknown };
    debug?: (...args: unknown[]) => void;
    DB?: Record<string, unknown>;
    DataDirectory?: { dir?: string };
    Profile?: { dir?: string };
  };
  IOUtils?: Record<string, unknown>;
};
const originalZotero = scope.Zotero;
const originalIOUtils = scope.IOUtils;

describe("application logging", function () {
  let preference: unknown;
  let emitted: Array<{ level: AppLogLevel; args: unknown[] }>;

  beforeEach(function () {
    preference = undefined;
    emitted = [];
    scope.Zotero = {
      Prefs: {
        get: () => preference,
      },
      debug: () => {},
    };
    setAppLogSinkForTests((level, args) => emitted.push({ level, args }));
  });

  afterEach(function () {
    setAppLogSinkForTests(null);
    scope.Zotero = originalZotero;
    scope.IOUtils = originalIOUtils;
  });

  it("falls back to warn for missing and invalid preference values", function () {
    assert.equal(getAppLogLevel(), "warn");
    preference = "verbose";
    assert.equal(getAppLogLevel(), "warn");
    preference = 3;
    assert.equal(getAppLogLevel(), "warn");
  });

  for (const scenario of [
    { configured: "warn", visible: ["error", "warn"] },
    { configured: "info", visible: ["error", "warn", "info"] },
    {
      configured: "debug",
      visible: ["error", "warn", "info", "debug"],
    },
    {
      configured: "trace",
      visible: ["error", "warn", "info", "debug", "trace"],
    },
  ] as const) {
    it(`emits the ${scenario.configured} severity threshold`, function () {
      preference = scenario.configured;
      const logger = createAppLogger("threshold");
      logger.error("error");
      logger.warn("warn");
      logger.info("info");
      logger.debug("debug");
      logger.trace("trace");
      assert.deepEqual(
        emitted.map((entry) => entry.level),
        scenario.visible,
      );
    });
  }

  it("applies live preference changes to an existing logger", function () {
    const logger = createAppLogger("live");
    preference = "warn";
    logger.debug("suppressed");
    preference = "debug";
    logger.debug("visible");
    preference = "warn";
    logger.debug("suppressed again");
    assert.deepEqual(emitted, [{ level: "debug", args: ["live: visible"] }]);
  });

  it("preserves warnings and errors at the default level", function () {
    const logger = createAppLogger();
    logger.warn("actionable warning", { id: 1 });
    logger.error("actionable error", new Error("boom"));
    assert.deepEqual(
      emitted.map((entry) => entry.level),
      ["warn", "error"],
    );
    assert.equal(emitted[0].args[0], "actionable warning");
    assert.instanceOf(emitted[1].args[1], Error);
  });

  it("keeps an actual usage-ledger failure visible at the default level", async function () {
    resetUsageStoreForTests();
    scope.Zotero = {
      ...scope.Zotero,
      DB: {
        queryAsync: async () => {
          throw new Error("usage database unavailable");
        },
        executeTransaction: async (task: () => Promise<unknown>) => task(),
      },
    };

    assert.isFalse(
      await recordUsageEvent({
        mode: "library",
        conversationKey: 1,
        totalTokens: 1,
      }),
    );
    assert.deepEqual(
      emitted.map((entry) => entry.level),
      ["warn"],
    );
    assert.include(
      String(emitted[0]?.args[0]),
      "Failed to record a usage event",
    );
    assert.instanceOf(emitted[0]?.args[1], Error);
  });

  it("toggles routine SQL diagnostics only at trace", function () {
    preference = "debug";
    assert.deepEqual(getMaintenanceQueryOptions(), { debug: false });
    preference = "trace";
    assert.deepEqual(getMaintenanceQueryOptions(), { debug: true });
    preference = "invalid";
    assert.deepEqual(getMaintenanceQueryOptions(), { debug: false });
  });

  it("does not replace or invoke unrelated Zotero debug logging", function () {
    let unrelatedCalls = 0;
    const unrelatedDebug = () => {
      unrelatedCalls += 1;
    };
    scope.Zotero!.debug = unrelatedDebug;
    const logger = createAppLogger("isolated");
    logger.warn("ours");
    assert.strictEqual(scope.Zotero!.debug, unrelatedDebug);
    assert.equal(unrelatedCalls, 0);
  });

  it("uses the Zotero debug signature and preserves fallback context", function () {
    const calls: Array<{ message: string; level: number | undefined }> = [];
    scope.Zotero!.debug = (message: unknown, level?: unknown) => {
      calls.push({
        message: String(message),
        level: typeof level === "number" ? level : undefined,
      });
    };
    setAppLogSinkForTests(null);

    const logger = createAppLogger("fallback");
    logger.warn("could not finish", { id: 7 }, new Error("boom"));

    assert.lengthOf(calls, 1);
    assert.include(calls[0].message, "[llm-for-zotero] [warn]");
    assert.include(calls[0].message, "fallback: could not finish");
    assert.include(calls[0].message, '"id":7');
    assert.include(calls[0].message, "Error: boom");
    assert.isUndefined(calls[0].level);
  });

  it("keeps an Error message when Gecko-style stack text omits it", function () {
    const messages: string[] = [];
    scope.Zotero!.debug = (message: unknown) => messages.push(String(message));
    setAppLogSinkForTests(null);
    const error = new Error("native marker message");
    error.stack = "fallback@resource://llm-for-zotero/logging.js:42:7";

    createAppLogger().warn("native warning", error);

    assert.lengthOf(messages, 1);
    assert.include(messages[0], "Error: native marker message");
    assert.include(messages[0], error.stack);
  });

  it("keeps logging best-effort when a configured sink fails", function () {
    setAppLogSinkForTests(() => {
      throw new Error("sink unavailable");
    });
    assert.doesNotThrow(() => createAppLogger().warn("keep running"));
  });

  it("routes the toolkit compatibility logger without losing Error context", function () {
    preference = "debug";
    const written: unknown[][] = [];
    const toolkit = {
      log: (...args: unknown[]) => written.push(args),
    };
    installAppLogging(toolkit);
    const error = new Error("toolkit marker message");
    error.stack = "toolkit@resource://llm-for-zotero/logging.js:7:3";

    toolkit.log("toolkit marker", error);

    assert.lengthOf(written, 1);
    assert.equal(written[0][0], "toolkit marker");
    assert.include(String(written[0][1]), "Error: toolkit marker message");
    assert.include(String(written[0][1]), error.stack);
  });

  it("passes the live trace decision to each routine maintenance query owner", async function () {
    const observations: Array<{
      sql: string;
      options: { debug?: boolean } | undefined;
    }> = [];
    scope.Zotero = {
      ...scope.Zotero,
      Prefs: { get: () => preference },
      DataDirectory: { dir: "/tmp/zotero-data" },
      Profile: { dir: "/tmp/zotero-profile" },
      DB: {
        queryAsync: async (
          sql: string,
          _params?: unknown[],
          options?: { debug?: boolean },
        ) => {
          observations.push({ sql, options });
          if (sql.includes("MIN(next_attempt_at)")) {
            return [{ next_attempt_at: null }];
          }
          return [];
        },
        executeTransaction: async (task: () => Promise<unknown>) => task(),
      },
    };
    scope.IOUtils = {
      getChildren: async () => [],
      remove: async () => {},
    };

    const runMaintenanceReads = async () => {
      await getNextConversationCleanupJobDueAt({
        includeAttentionRequired: true,
      });
      await collectAndDeleteUnreferencedBlobs(0);
      await sweepOrphanedAgentTraceExports();
    };
    const selectMaintenanceReads = () =>
      observations.filter(
        ({ sql }) =>
          sql.includes("MIN(next_attempt_at)") ||
          sql.includes("SELECT b.hash AS hash") ||
          sql.includes("SELECT run_id AS runId FROM") ||
          sql.includes("SELECT run_id AS runId, export_path AS exportPath"),
      );

    preference = "debug";
    await runMaintenanceReads();
    assert.isAtLeast(selectMaintenanceReads().length, 4);
    assert.isTrue(
      selectMaintenanceReads().every(({ options }) => options?.debug === false),
    );

    observations.length = 0;
    preference = "trace";
    await runMaintenanceReads();
    assert.isAtLeast(selectMaintenanceReads().length, 4);
    assert.isTrue(
      selectMaintenanceReads().every(({ options }) => options?.debug === true),
    );
  });
});
