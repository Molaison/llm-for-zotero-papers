import { assert } from "chai";
import { DatabaseSync } from "node:sqlite";
import { AgentRuntime } from "../src/agent/runtime";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import type { AgentModelStep } from "../src/agent/types";
import type { AgentStepParams } from "../src/agent/model/adapter";
import { UPSTREAM_GLOBAL_CONVERSATION_KEY_BASE } from "../src/shared/conversationKeySpace";
import {
  loadUsageEventsForConversation,
  resetUsageStoreForTests,
} from "../src/utils/usageStore";
import { installMockDb } from "./helpers/agentRuntimeMockDb";

const CONVERSATION_KEY = UPSTREAM_GLOBAL_CONVERSATION_KEY_BASE + 21;

/**
 * Route the usage-ledger statements to a real in-memory sqlite database while
 * every other agent-runtime statement stays on the hand-written mock.
 */
function installUsageSqlite(): () => void {
  const zotero = globalThis as typeof globalThis & { Zotero: typeof Zotero };
  const base = zotero.Zotero.DB;
  const db = new DatabaseSync(":memory:");
  zotero.Zotero.DB = {
    ...base,
    queryAsync: async (sql: string, params: unknown[] = []) => {
      if (!sql.includes("llm_for_zotero_usage_events"))
        return base.queryAsync(sql, params);
      const statement = db.prepare(sql);
      const values = params.map((value) =>
        value === undefined ? null : value,
      ) as never[];
      if (/^\s*(SELECT|PRAGMA|WITH)/i.test(sql))
        return statement.all(...values);
      statement.run(...values);
      return [];
    },
  } as unknown as typeof Zotero.DB;
  return () => {
    zotero.Zotero.DB = base;
    db.close();
  };
}

/** The turn flushes its usage row without being awaited, by design. */
async function waitForUsageRows(
  conversationKey: number,
  expected: number,
): Promise<Awaited<ReturnType<typeof loadUsageEventsForConversation>>> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const rows = await loadUsageEventsForConversation(conversationKey);
    if (rows.length >= expected) return rows;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  return await loadUsageEventsForConversation(conversationKey);
}

function createRuntimeEmitting(
  samples: Array<{
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  }>,
): AgentRuntime {
  return new AgentRuntime({
    registry: new AgentToolRegistry(),
    adapterFactory: () => ({
      getCapabilities: () => ({
        streaming: false,
        toolCalls: true,
        multimodal: false,
      }),
      supportsTools: () => true,
      async runStep(params: AgentStepParams): Promise<AgentModelStep> {
        for (const sample of samples) await params.onUsage?.(sample);
        return {
          kind: "final",
          text: "Attention changes sensory gain.",
          assistantMessage: {
            role: "assistant",
            content: "Attention changes sensory gain.",
          },
        };
      },
    }),
  });
}

const request = {
  conversationKey: CONVERSATION_KEY,
  mode: "agent" as const,
  userText: "What is the main claim?",
  libraryID: 1,
  model: "test-model",
  apiKey: "test",
  apiBase: "https://example.invalid",
};

describe("agent runtime usage recording", function () {
  let restoreMock: () => void;
  let restoreSqlite: () => void;

  beforeEach(function () {
    resetUsageStoreForTests();
    restoreMock = installMockDb();
    restoreSqlite = installUsageSqlite();
  });

  afterEach(function () {
    restoreSqlite();
    restoreMock();
    resetUsageStoreForTests();
  });

  it("writes one row per turn from a cumulative reporter", async function () {
    const runtime = createRuntimeEmitting([
      { promptTokens: 1500, completionTokens: 4, totalTokens: 1504 },
      { promptTokens: 1500, completionTokens: 90, totalTokens: 1590 },
      { promptTokens: 1500, completionTokens: 260, totalTokens: 1760 },
    ]);
    const outcome = await runtime.runTurn({ request });
    assert.equal(outcome.kind, "completed");

    const rows = await waitForUsageRows(CONVERSATION_KEY, 1);
    assert.lengthOf(rows, 1, "one agent turn is one usage row");
    assert.strictEqual(rows[0]!.promptTokens, 1500);
    assert.strictEqual(rows[0]!.completionTokens, 260);
    assert.strictEqual(rows[0]!.totalTokens, 1760);
    assert.strictEqual(rows[0]!.mode, "library");
    assert.strictEqual(rows[0]!.runtime, "agent");
    assert.strictEqual(rows[0]!.model, "test-model");
    assert.isTrue(rows[0]!.countsAsQuestion);
  });

  it("records a retried turn's tokens without counting a second question", async function () {
    const runtime = createRuntimeEmitting([
      { promptTokens: 900, completionTokens: 120, totalTokens: 1020 },
    ]);
    await runtime.runTurn({ request });
    await waitForUsageRows(CONVERSATION_KEY, 1);
    await runtime.runTurn({ request, usageCountsAsQuestion: false });

    const rows = await waitForUsageRows(CONVERSATION_KEY, 2);
    assert.lengthOf(rows, 2);
    assert.deepStrictEqual(
      rows.map((row) => row.countsAsQuestion),
      [true, false],
    );
    assert.strictEqual(
      rows.reduce((sum, row) => sum + row.totalTokens, 0),
      2040,
    );
  });
});
