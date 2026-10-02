import { assert } from "chai";
import { createCodexNativeActivityTraceControllerForTests } from "../src/modules/contextPanel/codexNativeTrace/controller";
import {
  getAgentRunTrace,
  initAgentTraceStore,
} from "../src/agent/store/traceStore";
import { buildClaudeMcpToolActivityEvent } from "../src/agent/externalBackendBridge";
import type { ZoteroMcpToolActivityEvent } from "../src/agent/mcp/activityTypes";
import {
  deriveTaskPaperLedgerDelta,
  type TaskPaperLedgerDelta,
} from "../src/agent/context/taskPaperLedger";
import { installMockDb } from "./helpers/agentRuntimeMockDb";
import { readFileSync } from "node:fs";
import {
  paperLedgerUpdateFromMcpActivity,
  recordTaskPaperRead,
  resolveZoteroPaperRef,
} from "../src/agent/context/taskPaperLedgerRecorder";

/**
 * Spec §7's biggest risk: a connected runtime (Codex, Claude Code) runs the
 * plugin's read tools through its MCP server, and the only thing that reaches
 * the panel and the stored trace is the MCP activity event. These tests prove
 * a 5-paper retrieval's ledger delta survives that path: into the live trace,
 * through the coalesced snapshot the trace store keeps, and back out for a
 * history rebuild.
 */
function fivePaperDelta(): TaskPaperLedgerDelta {
  const delta = deriveTaskPaperLedgerDelta({
    toolName: "library_retrieve",
    callId: "7",
    runId: "codex-turn-1",
    input: { query: "drift" },
    libraryID: 1,
    content: {
      candidates: [1, 2, 3, 4, 5].map((itemId) => ({
        itemId: String(itemId),
        title: `Paper ${itemId}`,
        resourceState: ["text_indexed"],
        queryState: ["matched_bm25"],
        whyMatched: "title",
      })),
      snippets: [1, 2].map((itemId) => ({
        itemId: String(itemId),
        sourceKind: "pdf_text",
        matchMethod: "bm25",
        sectionLabel: "Results",
        snippet: `Evidence from paper ${itemId}`,
      })),
    },
  });
  assert.isNotNull(delta);
  return delta!;
}

function completedActivity(
  delta: TaskPaperLedgerDelta | undefined,
  fields: Partial<ZoteroMcpToolActivityEvent> = {},
): ZoteroMcpToolActivityEvent {
  return {
    requestId: "7",
    runId: "codex-turn-1",
    phase: "completed",
    toolName: "library_retrieve",
    toolLabel: "Retrieve Library",
    serverName: "zotero",
    ok: true,
    workCategory: "retrieval",
    conversationKey: 4242,
    paperLedgerDelta: delta,
    timestamp: 1,
    ...fields,
  };
}

describe("task paper ledger over MCP", function () {
  let uninstallDb: ReturnType<typeof installMockDb> | null = null;

  before(async function () {
    uninstallDb = installMockDb();
    await initAgentTraceStore();
  });

  after(function () {
    uninstallDb?.();
    uninstallDb = null;
  });

  it("carries the delta from the Codex MCP activity into the stored trace", async function () {
    const delta = fivePaperDelta();
    const message: any = {
      role: "assistant",
      text: "Answer",
      timestamp: 1,
      runMode: "agent",
      agentRunId: "codex-ledger-run",
      modelName: "gpt-5-codex",
    };
    const controller = createCodexNativeActivityTraceControllerForTests(
      message,
      () => {},
    );
    controller.noteMcpToolActivity({
      ...completedActivity(undefined),
      phase: "started",
      ok: undefined,
    });
    controller.noteMcpToolActivity(completedActivity(delta));
    // A repeated completion report for the same request must not duplicate it.
    controller.noteMcpToolActivity(completedActivity(delta));

    const live = (message.pendingAgentTraceEvents || []).map(
      (entry: any) => entry.payload,
    );
    const liveUpdates = live.filter(
      (payload: any) => payload.type === "paper_ledger_update",
    );
    assert.lengthOf(liveUpdates, 1, "the live trace carries the delta once");
    assert.deepEqual(liveUpdates[0].delta, delta);
    const activityIndex = live.findIndex(
      (payload: any) => payload.type === "codex_tool_activity",
    );
    assert.isAbove(
      live.indexOf(liveUpdates[0]),
      activityIndex,
      "the update follows the call's activity row",
    );

    controller.finish("Answer");
    await controller.persist(4242, 0, "completed");
    const saved = await getAgentRunTrace("codex-ledger-run");
    const stored = saved.events
      .map((event: any) => event.payload)
      .filter((payload: any) => payload.type === "paper_ledger_update");
    assert.lengthOf(stored, 1, "the coalesced snapshot keeps the delta");
    assert.deepEqual(stored[0].delta, delta);
    assert.lengthOf(stored[0].delta.papers, 5);
    assert.equal(stored[0].callId, "7");
  });

  it("adds nothing for a failed or delta-less call", function () {
    const message: any = {
      role: "assistant",
      text: "",
      timestamp: 1,
      runMode: "agent",
    };
    const controller = createCodexNativeActivityTraceControllerForTests(
      message,
      () => {},
    );
    controller.noteMcpToolActivity(completedActivity(undefined));
    controller.noteMcpToolActivity(
      completedActivity(fivePaperDelta(), { requestId: "8", ok: false }),
    );
    const types = (message.pendingAgentTraceEvents || []).map(
      (entry: any) => entry.payload.type,
    );
    assert.notInclude(types, "paper_ledger_update");
  });

  it("gives the Claude bridge the delta as a second persisted event", function () {
    const delta = fivePaperDelta();
    const activity = completedActivity(delta);
    const row = buildClaudeMcpToolActivityEvent(activity);
    assert.equal(row.type, "codex_tool_activity");
    assert.notProperty(row, "paperLedgerDelta", "the row itself is unchanged");
    assert.deepEqual(paperLedgerUpdateFromMcpActivity(activity), {
      type: "paper_ledger_update",
      callId: "7",
      delta,
    });
    assert.isNull(
      paperLedgerUpdateFromMcpActivity({ ...activity, ok: false }),
      "a failed call records nothing",
    );
    assert.isNull(
      paperLedgerUpdateFromMcpActivity({ ...activity, phase: "started" }),
    );
    assert.isNull(
      paperLedgerUpdateFromMcpActivity({
        ...activity,
        paperLedgerDelta: undefined,
      }),
    );
    // The bridge emits the update through the same persisted, redacted
    // channel as the row, right after it.
    const bridge = readFileSync(
      new URL("../src/agent/externalBackendBridge.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      bridge,
      /await emitTurnEvent\(buildClaudeMcpToolActivityEvent\(event\)\);\s*(?:\/\/[^\n]*\n\s*)*const ledgerUpdate = paperLedgerUpdateFromMcpActivity\(event\);\s*if \(ledgerUpdate\) await emitTurnEvent\(ledgerUpdate\);/,
    );
  });
});

describe("task paper ledger recorder", function () {
  const priorZotero = (globalThis as { Zotero?: unknown }).Zotero;

  before(function () {
    const items = new Map<number, Record<string, unknown>>([
      [10, { id: 10, libraryID: 2 }],
      [20, { id: 20, libraryID: 2, parentID: 10 }],
    ]);
    (globalThis as { Zotero?: unknown }).Zotero = {
      Items: { get: (id: number) => items.get(id) || null },
    };
  });

  after(function () {
    (globalThis as { Zotero?: unknown }).Zotero = priorZotero;
  });

  it("records nothing without a conversation", function () {
    const params = {
      toolName: "read_attachment",
      callId: "c",
      input: { target: { contextItemId: 20 } },
      content: { textContent: "Attachment body" },
      libraryID: 1,
    };
    assert.isNull(recordTaskPaperRead(params));
    assert.isNull(recordTaskPaperRead({ ...params, conversationKey: 0 }));
    const delta = recordTaskPaperRead({ ...params, conversationKey: 5 });
    assert.deepEqual(
      delta?.papers.map((paper) => [paper.key, paper.contextItemId]),
      [["2:10", 20]],
      "an attachment is recorded against its parent paper and library",
    );
  });

  it("resolves items and attachments through Zotero", function () {
    assert.deepEqual(resolveZoteroPaperRef({ itemId: 10 }), {
      itemId: 10,
      libraryID: 2,
    });
    assert.deepEqual(resolveZoteroPaperRef({ contextItemId: 20 }), {
      itemId: 10,
      libraryID: 2,
    });
    assert.isNull(resolveZoteroPaperRef({ itemId: 99 }));
  });
});
