import { assert } from "chai";
import { DatabaseSync } from "node:sqlite";
import {
  UPSTREAM_GLOBAL_CONVERSATION_KEY_BASE,
  UPSTREAM_PAPER_CONVERSATION_KEY_BASE,
} from "../src/shared/conversationKeySpace";
import { resetConversationWriteFenceForTests } from "../src/shared/conversationWriteFence";
import {
  USAGE_EVENTS_TABLE,
  USAGE_UNREPORTED_HEAL_INDEX,
  USAGE_UNREPORTED_HEAL_SQL,
  initUsageStore,
  loadUsageEventsForConversation,
  recordUsageEvent,
  resetUsageStoreForTests,
} from "../src/utils/usageStore";
import { createTurnUsageRecorder } from "../src/utils/usageTurnRecorder";
import { loadUsageModelBreakdown } from "../src/utils/usageStats";
import {
  describeUsageTokensCard,
  serializeUsageEventsCsv,
} from "../src/utils/usageView";

/**
 * WHY THIS EXISTS: a turn whose provider never reported usage used to be
 * written as prompt/completion/total = 0, which is indistinguishable from a
 * genuinely free turn. `token_source` says where the numbers came from, so the
 * read layer and the cost card can call unreported tokens UNKNOWN rather than
 * zero.
 */

const globalScope = globalThis as typeof globalThis & {
  Zotero?: Record<string, unknown>;
};
const originalZotero = globalScope.Zotero;

function installSqliteZotero(): {
  db: DatabaseSync;
  all: (sql: string, params?: unknown[]) => Record<string, unknown>[];
} {
  const db = new DatabaseSync(":memory:");
  const bindable = (params: unknown[] | undefined) =>
    (Array.isArray(params) ? params : params === undefined ? [] : [params]).map(
      (value) => (value === undefined ? null : value),
    ) as never[];
  const toZoteroRow = (row: Record<string, unknown>) =>
    new Proxy(row, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && !(prop in target)) {
          throw new Error(`Column '${prop}' not present in this row`);
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  const queryAsync = async (sql: string, params?: unknown[]) => {
    const head = sql.trimStart().slice(0, 8).toUpperCase();
    const isRead =
      head.startsWith("SELECT") ||
      head.startsWith("PRAGMA") ||
      head.startsWith("WITH");
    const stmt = db.prepare(sql);
    if (isRead) {
      return (stmt.all(...bindable(params)) as Record<string, unknown>[]).map(
        toZoteroRow,
      );
    }
    stmt.run(...bindable(params));
    return [];
  };
  globalScope.Zotero = {
    ...(originalZotero || {}),
    Libraries: { userLibraryID: 1 },
    debug: () => undefined,
    DB: {
      queryAsync,
      executeTransaction: async (task: () => Promise<unknown>) => await task(),
    },
  };
  return {
    db,
    all: (sql, params) =>
      db.prepare(sql).all(...((params || []) as never[])) as Record<
        string,
        unknown
      >[],
  };
}

const LIBRARY_KEY = UPSTREAM_GLOBAL_CONVERSATION_KEY_BASE + 31;
const PAPER_KEY = UPSTREAM_PAPER_CONVERSATION_KEY_BASE + 17;

describe("usage token provenance", function () {
  let harness: ReturnType<typeof installSqliteZotero>;

  beforeEach(function () {
    resetUsageStoreForTests();
    resetConversationWriteFenceForTests();
    harness = installSqliteZotero();
  });

  afterEach(function () {
    harness.db.close();
    resetUsageStoreForTests();
    resetConversationWriteFenceForTests();
    globalScope.Zotero = originalZotero;
  });

  it("defaults a recorded row to provider-measured tokens", async function () {
    await recordUsageEvent({
      mode: "library",
      conversationKey: LIBRARY_KEY,
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
    });
    const rows = await loadUsageEventsForConversation(LIBRARY_KEY);
    assert.lengthOf(rows, 1);
    assert.strictEqual(rows[0]!.tokenSource, "provider");
  });

  it("marks a turn the provider never reported as unreported", async function () {
    const recorder = createTurnUsageRecorder({
      conversationKey: PAPER_KEY,
      runtime: "agent",
      model: "deepseek-flash",
      provider: "DeepSeek",
    });
    recorder.markDispatched();
    // Exactly what the agent runtime emits for context-only telemetry.
    recorder.record({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
    assert.isTrue(await recorder.flush("complete"));
    const rows = await loadUsageEventsForConversation(PAPER_KEY);
    assert.lengthOf(rows, 1);
    assert.strictEqual(rows[0]!.totalTokens, 0);
    assert.strictEqual(rows[0]!.tokenSource, "unreported");
  });

  it("marks a turn with provider numbers as provider-measured", async function () {
    const recorder = createTurnUsageRecorder({
      conversationKey: PAPER_KEY,
      runtime: "agent",
    });
    recorder.markDispatched();
    recorder.record({
      promptTokens: 32208,
      completionTokens: 517,
      totalTokens: 32725,
    });
    assert.isTrue(await recorder.flush("complete"));
    const rows = await loadUsageEventsForConversation(PAPER_KEY);
    assert.strictEqual(rows[0]!.tokenSource, "provider");
  });

  it("accepts a history-estimate provenance without widening the column", async function () {
    await recordUsageEvent({
      mode: "library",
      conversationKey: LIBRARY_KEY,
      totalTokens: 900,
      tokenSource: "history-estimate",
    });
    const rows = await loadUsageEventsForConversation(LIBRARY_KEY);
    assert.strictEqual(rows[0]!.tokenSource, "history-estimate");
  });

  it("backfills zero-token rows written before the column existed", async function () {
    // A ledger built by the older schema: no token_source column at all.
    harness.db.exec(
      `CREATE TABLE ${USAGE_EVENTS_TABLE} (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         timestamp INTEGER NOT NULL,
         local_date TEXT NOT NULL,
         mode TEXT NOT NULL,
         conversation_key INTEGER NOT NULL,
         conversation_instance_id TEXT,
         library_id INTEGER,
         paper_item_id INTEGER,
         model TEXT,
         provider TEXT,
         runtime TEXT,
         prompt_tokens INTEGER NOT NULL DEFAULT 0,
         completion_tokens INTEGER NOT NULL DEFAULT 0,
         total_tokens INTEGER NOT NULL DEFAULT 0,
         cache_read_tokens INTEGER NOT NULL DEFAULT 0,
         cache_write_tokens INTEGER NOT NULL DEFAULT 0,
         counts_as_question INTEGER NOT NULL DEFAULT 1
       )`,
    );
    harness.db.exec(
      `INSERT INTO ${USAGE_EVENTS_TABLE}
        (timestamp, local_date, mode, conversation_key, total_tokens)
       VALUES (1, '2026-09-19', 'paper', ${PAPER_KEY}, 0),
              (2, '2026-09-19', 'paper', ${PAPER_KEY}, 1200)`,
    );
    await initUsageStore();
    const rows = await loadUsageEventsForConversation(PAPER_KEY);
    assert.lengthOf(rows, 2);
    assert.strictEqual(rows[0]!.tokenSource, "unreported");
    assert.strictEqual(rows[1]!.tokenSource, "provider");
  });

  it("heals a zero-token row an older build wrote after the column existed", async function () {
    // A downgrade/upgrade cycle: the column is there, but the build that
    // wrote this row knew nothing about it and took the DEFAULT.
    await initUsageStore();
    harness.db.exec(
      `INSERT INTO ${USAGE_EVENTS_TABLE}
        (timestamp, local_date, mode, conversation_key, total_tokens)
       VALUES (3, '2026-09-19', 'paper', ${PAPER_KEY}, 0)`,
    );
    assert.strictEqual(
      String(
        harness.all(
          `SELECT token_source AS s FROM ${USAGE_EVENTS_TABLE} WHERE timestamp = 3`,
        )[0]!.s,
      ),
      "provider",
    );

    resetUsageStoreForTests();
    await initUsageStore();

    const rows = await loadUsageEventsForConversation(PAPER_KEY);
    assert.lengthOf(rows, 1);
    assert.strictEqual(rows[0]!.tokenSource, "unreported");
  });

  it("finds the rows to heal through an index instead of scanning the ledger", async function () {
    // The healing pass runs on EVERY startup, so at a year's worth of rows a
    // full scan would be a measurable part of every launch. The partial index
    // holds only the rows that still need healing -- usually none at all.
    await initUsageStore();
    const plan = harness
      .all(`EXPLAIN QUERY PLAN ${USAGE_UNREPORTED_HEAL_SQL}`)
      .map((row) => String(row.detail))
      .join(" | ");
    assert.include(plan, `USING INDEX ${USAGE_UNREPORTED_HEAL_INDEX}`);
    assert.notInclude(plan, `SCAN ${USAGE_EVENTS_TABLE}`);
  });

  it("counts unreported turns in the model breakdown", async function () {
    await recordUsageEvent({
      mode: "paper",
      conversationKey: PAPER_KEY,
      model: "deepseek-flash",
      provider: "DeepSeek",
      runtime: "agent",
      tokenSource: "unreported",
    });
    await recordUsageEvent({
      mode: "paper",
      conversationKey: PAPER_KEY,
      model: "deepseek-flash",
      provider: "DeepSeek",
      runtime: "agent",
      promptTokens: 1000,
      completionTokens: 100,
      totalTokens: 1100,
    });
    const models = await loadUsageModelBreakdown({ range: "all" });
    assert.lengthOf(models, 1);
    assert.strictEqual(models[0]!.unreportedTurns, 1);
    assert.strictEqual(models[0]!.questions, 2);
    assert.strictEqual(models[0]!.totalTokens, 1100);
  });

  it("exports the provenance column in the CSV", function () {
    const csv = serializeUsageEventsCsv([
      {
        id: 1,
        timestamp: 0,
        localDate: "2026-09-19",
        mode: "paper",
        conversationKey: PAPER_KEY,
        conversationInstanceID: null,
        libraryID: null,
        paperItemID: null,
        model: "deepseek-flash",
        provider: "DeepSeek",
        runtime: "agent",
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        countsAsQuestion: true,
        tokenSource: "unreported",
      },
    ]);
    assert.include(csv.split("\r\n")[0]!, "token_source");
    assert.include(csv.split("\r\n")[1]!, "unreported");
  });
});

describe("unreported tokens in the Tokens card", function () {
  it("calls an unreported turn unknown rather than free", function () {
    assert.deepEqual(
      describeUsageTokensCard({
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        unreportedTurns: 1,
        questions: 1,
      }),
      { value: "—", sub: "not reported by the provider" },
    );
  });

  it("never prints a bare zero for a range that holds turns", function () {
    for (const card of [
      describeUsageTokensCard({
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        unreportedTurns: 2,
        questions: 2,
      }),
      describeUsageTokensCard({
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        questions: 2,
      }),
    ]) {
      assert.strictEqual(card.value, "—");
    }
  });
});
