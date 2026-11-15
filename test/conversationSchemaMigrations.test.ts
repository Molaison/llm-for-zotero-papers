import { assert } from "chai";
import {
  CONVERSATION_ID_TRANSITION_MIGRATION_ID,
  CONVERSATION_SCHEMA_MIGRATIONS_TABLE,
  hasConversationSchemaMigration,
  initConversationSchemaMigrationLedger,
  markConversationIDTransitionMigrationApplied,
  markConversationSchemaMigrationApplied,
  runConversationSchemaMigrationOnce,
} from "../src/shared/conversationSchemaMigrations";

describe("conversation schema migrations", function () {
  const globalScope = globalThis as typeof globalThis & {
    Zotero?: Record<string, unknown>;
  };
  const originalZotero = globalScope.Zotero;

  afterEach(function () {
    globalScope.Zotero = originalZotero;
  });

  function installMigrationDb() {
    const applied = new Map<
      string,
      { appliedAt: number; description: string | null }
    >();
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    globalScope.Zotero = {
      DB: {
        queryAsync: async (sql: string, params?: unknown[]) => {
          queries.push({ sql, params });
          if (
            sql.includes(`SELECT id`) &&
            sql.includes(`FROM ${CONVERSATION_SCHEMA_MIGRATIONS_TABLE}`)
          ) {
            const id = String(params?.[0] || "");
            return applied.has(id) ? [{ id }] : [];
          }
          if (
            sql.includes(`INSERT INTO ${CONVERSATION_SCHEMA_MIGRATIONS_TABLE}`)
          ) {
            const id = String(params?.[0] || "");
            applied.set(id, {
              appliedAt: Number(params?.[1] || 0),
              description: typeof params?.[2] === "string" ? params[2] : null,
            });
          }
          return [];
        },
      },
    };
    return { applied, queries };
  }

  it("initializes the DB-backed migration ledger", async function () {
    const { queries } = installMigrationDb();

    assert.equal(await initConversationSchemaMigrationLedger(), true);

    assert.isTrue(
      queries.some(
        ({ sql }) =>
          sql.includes("CREATE TABLE IF NOT EXISTS") &&
          sql.includes(CONVERSATION_SCHEMA_MIGRATIONS_TABLE) &&
          sql.includes("id TEXT PRIMARY KEY") &&
          sql.includes("applied_at INTEGER NOT NULL"),
      ),
    );
  });

  it("runs a schema migration once and records it", async function () {
    const { applied } = installMigrationDb();
    let runs = 0;

    const firstRun = await runConversationSchemaMigrationOnce(
      "chat-history-search-v1",
      "Build chat history search index.",
      () => {
        runs += 1;
      },
    );
    const secondRun = await runConversationSchemaMigrationOnce(
      "chat-history-search-v1",
      "Build chat history search index.",
      () => {
        runs += 1;
      },
    );

    assert.equal(firstRun, true);
    assert.equal(secondRun, false);
    assert.equal(runs, 1);
    assert.equal(
      applied.get("chat-history-search-v1")?.description,
      "Build chat history search index.",
    );
    assert.equal(
      await hasConversationSchemaMigration("chat-history-search-v1"),
      true,
    );
  });

  it("marks the current conversation-id transition milestone", async function () {
    const { applied } = installMigrationDb();

    assert.equal(await markConversationIDTransitionMigrationApplied(), true);

    assert.isTrue(applied.has(CONVERSATION_ID_TRANSITION_MIGRATION_ID));
  });

  it("does not claim migration state without Zotero DB", async function () {
    globalScope.Zotero = {};

    assert.equal(await initConversationSchemaMigrationLedger(), false);
    assert.equal(
      await markConversationSchemaMigrationApplied("missing-db", "Missing DB"),
      false,
    );
    assert.equal(await hasConversationSchemaMigration("missing-db"), false);
  });
});
