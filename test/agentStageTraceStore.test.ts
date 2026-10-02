/**
 * Stage events through the real trace store: a stage event survives a write
 * and a read with every field intact, and a material the host announces after
 * the run brackets itself with its own generation stage.
 *
 * Moved from test/planTaskTransitionTransaction.test.ts when the plan engine
 * it shared a fixture with was deleted; neither case needs a plan.
 */
import { assert } from "chai";
import { DatabaseSync } from "node:sqlite";
import { announceFinalizedMaterialForRunForTests } from "../src/modules/contextPanel/chat";
import {
  appendAgentRunEvent,
  createAgentRun,
  getAgentRunTrace,
  initAgentTraceStore,
} from "../src/agent/store/traceStore";
import type { AgentEvent } from "../src/agent/types";
import { ensureConversationKeyLedgerEntry } from "../src/shared/conversationKeyLedger";

const globalScope = globalThis as typeof globalThis & { Zotero?: unknown };

describe("stage events in the trace store", function () {
  let originalZotero: unknown;
  let db: DatabaseSync;

  beforeEach(async function () {
    originalZotero = globalScope.Zotero;
    db = new DatabaseSync(":memory:");
    const bindable = (params: unknown[] | undefined) =>
      (params || []).map((value) => (value === undefined ? null : value));
    globalScope.Zotero = {
      DB: {
        queryAsync: async (sql: string, params?: unknown[]) => {
          const statement = db.prepare(sql);
          const normalized = sql.trimStart().toUpperCase();
          if (
            normalized.startsWith("SELECT") ||
            normalized.startsWith("PRAGMA") ||
            normalized.startsWith("WITH")
          ) {
            return statement.all(...(bindable(params) as never[]));
          }
          statement.run(...(bindable(params) as never[]));
          return [];
        },
        executeTransaction: async (task: () => Promise<unknown>) => {
          db.exec("BEGIN");
          try {
            const result = await task();
            db.exec("COMMIT");
            return result;
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
        },
      },
    } as unknown as typeof Zotero;
    await initAgentTraceStore();
  });

  afterEach(function () {
    db.close();
    globalScope.Zotero = originalZotero;
  });

  it("round-trips a stage event through the real trace store", async function () {
    // The store has no event-type whitelist by design, so a stage event must
    // survive a real write and read with every field intact.
    const runId = "stage-round-trip";
    await ensureConversationKeyLedgerEntry({
      conversationKey: 41,
      instanceID: "stage-instance",
      conversationID: "stage-conversation",
      system: "upstream",
      kind: "paper",
      profileSignature: "stage-profile",
      libraryID: 1,
      paperItemID: 41,
      issuedAt: 1,
    });
    await createAgentRun({
      runId,
      conversationKey: 41,
      mode: "agent",
      status: "running",
      createdAt: 1,
    });
    const stage: AgentEvent = {
      type: "agent_stage",
      stage: "zotero_action",
      status: "completed",
      callId: "call-1",
      toolName: "note_write",
      toolLabel: "Write note",
      receiptIds: ["receipt-1", "receipt-2"],
      materialRef: {
        documentId: "run:document:1",
        documentVersion: 1,
        contentHash: "sha256:note",
      },
      batchId: "batch-1",
      itemKey: "item:1",
    };
    await appendAgentRunEvent(runId, 1, stage);
    const trace = await getAgentRunTrace(runId);
    assert.deepEqual(
      trace.events.map((entry) => entry.eventType),
      ["agent_stage"],
    );
    assert.deepEqual(trace.events[0].payload, stage);
  });

  it("brackets a host-announced material with its own generation stage", async function () {
    // A native run's only material is the one the host announces after the
    // document is delivered. The run already carries stages the bridge
    // emitted, so the compatibility projection will not touch it -- this
    // append has to bracket itself, exactly as the runtime does.
    const runId = "material-stage-append";
    await ensureConversationKeyLedgerEntry({
      conversationKey: 41,
      instanceID: "material-instance",
      conversationID: "material-conversation",
      system: "upstream",
      kind: "paper",
      profileSignature: "material-profile",
      libraryID: 1,
      paperItemID: 41,
      issuedAt: 1,
    });
    await createAgentRun({
      runId,
      conversationKey: 41,
      mode: "agent",
      status: "running",
      createdAt: 1,
    });
    await appendAgentRunEvent(runId, 1, {
      type: "agent_stage",
      stage: "retrieval",
      status: "completed",
    });
    await announceFinalizedMaterialForRunForTests(runId, {
      documentId: "run:document:9",
      documentVersion: 3,
      contentHash: "sha256:report",
      title: "The report",
      version: 2,
      documentKind: "report",
    } as never);
    const trace = await getAgentRunTrace(runId);
    assert.deepEqual(
      trace.events.map((entry) => entry.eventType),
      ["agent_stage", "agent_stage", "material_finalized"],
    );
    assert.deepEqual(trace.events[1].payload, {
      type: "agent_stage",
      stage: "generation",
      status: "completed",
      materialRef: {
        documentId: "run:document:9",
        documentVersion: 3,
        contentHash: "sha256:report",
      },
    });
  });
});
