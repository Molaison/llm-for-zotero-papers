import { assert } from "chai";
import { summarizeAgentFlight } from "../src/agent/flightMetrics";
import type { AgentActionReceipt } from "../src/agent/contracts/types";
import type { AgentEvent, AgentStage } from "../src/agent/types";

/**
 * The flight summarizer, on synthetic event streams.
 *
 * Every number it reports has to come from a declared contract -- the stage a
 * tool announced, the `written` flag a batch row carries, the facts a receipt
 * proved -- and never from a tool's name, which the product renames freely.
 */

const MATERIAL_REF = {
  documentId: "doc-1",
  documentVersion: 1,
  contentHash: "hash-1",
};

function stageEvent(params: {
  stage: AgentStage;
  status?: "started" | "completed" | "failed";
  callId?: string;
  toolName?: string;
  itemKey?: string;
  batchId?: string;
}): AgentEvent {
  return {
    type: "agent_stage",
    stage: params.stage,
    status: params.status ?? "started",
    callId: params.callId,
    toolName: params.toolName,
    itemKey: params.itemKey,
    batchId: params.batchId,
  };
}

function toolCall(params: {
  callId: string;
  name: string;
  workCategory?: AgentStage;
  args?: Record<string, unknown>;
}): AgentEvent {
  return {
    type: "tool_call",
    callId: params.callId,
    name: params.name,
    args: params.args ?? {},
    workCategory: params.workCategory,
  };
}

function receipt(verifiedFacts: string[]): AgentActionReceipt {
  return {
    version: 2,
    id: `receipt-${verifiedFacts.join("|")}`,
    proposalId: "proposal-1",
    proofDomain: "library_mutation",
    capability: "library.write",
    operation: "note_create",
    verification: "verified",
    status: "applied",
    requestedTargets: [],
    appliedTargets: [],
    alreadySatisfiedTargets: [],
    rejectedTargets: [],
    reasons: [],
    verifiedFacts,
    createdAt: 1,
  } as unknown as AgentActionReceipt;
}

function toolResult(params: {
  callId: string;
  name: string;
  receipts?: AgentActionReceipt[];
}): AgentEvent {
  return {
    type: "tool_result",
    callId: params.callId,
    name: params.name,
    ok: true,
    actionReceipts: params.receipts ?? [],
    content: {},
  };
}

function batchItem(params: {
  itemKey: string;
  status: "pending" | "saved" | "failed";
  written: boolean;
  noteId?: number;
  batchId?: string;
  callId?: string;
}): AgentEvent {
  return {
    type: "batch_item_outcome",
    batchId: params.batchId ?? "batch-1",
    itemKey: params.itemKey,
    status: params.status,
    written: params.written,
    noteId: params.noteId,
    callId: params.callId ?? "call-batch",
  };
}

describe("agent flight metrics", function () {
  it("counts model calls per turn and reports no per-item cost without a batch", function () {
    const summary = summarizeAgentFlight(
      [
        stageEvent({
          stage: "generation",
          callId: "call-1",
          toolName: "submit_document",
        }),
        toolCall({ callId: "call-1", name: "submit_document" }),
        { type: "material_finalized", materialRef: MATERIAL_REF },
      ],
      { modelCalls: [1, 2, 1], nativeSaves: 0 },
    );
    assert.deepEqual(summary.modelCallsPerTurn, [1, 2, 1]);
    assert.equal(summary.modelCallsTotal, 4);
    assert.isNull(
      summary.modelCallsPerBatchItem,
      "a flight with no batch has no per-item cost to report",
    );
    assert.equal(summary.materialFinalized, 1);
    assert.deepEqual(summary.batchItems, {
      written: 0,
      announcedNotWritten: 0,
      failed: 0,
    });
  });

  it("keys tool calls on the stage the call declared, never on its name", function () {
    const summary = summarizeAgentFlight(
      [
        stageEvent({
          stage: "generation",
          callId: "call-1",
          toolName: "note_write",
        }),
        toolCall({ callId: "call-1", name: "note_write" }),
        stageEvent({
          stage: "zotero_action",
          callId: "call-2",
          toolName: "note_write",
        }),
        toolCall({ callId: "call-2", name: "note_write" }),
        // No stage event: the call's own declared category still answers.
        toolCall({
          callId: "call-3",
          name: "note_write",
          workCategory: "retrieval",
        }),
        // Neither: the summary says so rather than guessing from the name.
        toolCall({ callId: "call-4", name: "note_write" }),
      ],
      { modelCalls: [1], nativeSaves: 0 },
    );
    assert.deepEqual(summary.toolCallsByStage, {
      generation: 1,
      zotero_action: 1,
      retrieval: 1,
      unattributed: 1,
    });
  });

  it("separates a resumed batch's untouched rows from the ones that failed", function () {
    const summary = summarizeAgentFlight(
      [
        batchItem({ itemKey: "item:1", status: "saved", written: true }),
        batchItem({ itemKey: "item:2", status: "failed", written: false }),
        batchItem({ itemKey: "item:3", status: "saved", written: true }),
        // The resume announces every row it holds and names the one it wrote.
        batchItem({ itemKey: "item:1", status: "saved", written: false }),
        batchItem({ itemKey: "item:2", status: "saved", written: true }),
        batchItem({ itemKey: "item:3", status: "saved", written: false }),
      ],
      { modelCalls: [2, 2], nativeSaves: 3 },
    );
    assert.deepEqual(summary.batchItems, {
      written: 3,
      announcedNotWritten: 2,
      failed: 1,
    });
    assert.equal(
      summary.modelCallsPerBatchItem,
      1.33,
      "with no turn split, every model call of the flight is charged to the batch",
    );
  });

  it("charges the batch only for the turns that carried batch work", function () {
    const batchTurn = [
      batchItem({ itemKey: "item:1", status: "saved", written: true }),
      batchItem({ itemKey: "item:2", status: "failed", written: false }),
      batchItem({ itemKey: "item:3", status: "saved", written: true }),
    ];
    const resumeTurn = [
      batchItem({ itemKey: "item:2", status: "saved", written: true }),
    ];
    // The last turn undoes the batch: real work, but not the batch's cost.
    const undoTurn = [
      stageEvent({
        stage: "zotero_action",
        callId: "call-undo",
        toolName: "undo",
      }),
      toolCall({ callId: "call-undo", name: "undo" }),
    ];
    const turnEvents = [batchTurn, resumeTurn, undoTurn];
    const summary = summarizeAgentFlight(turnEvents.flat(), {
      modelCalls: [2, 2, 2],
      nativeSaves: 3,
      turnEvents,
    });
    assert.equal(
      summary.modelCallsTotal,
      6,
      "the flight still reports every model call it made",
    );
    assert.equal(
      summary.modelCallsPerBatchItem,
      1.33,
      "four calls over three items: the undo turn is not the batch's cost",
    );
  });

  it("counts a native write from the receipt facts that prove it", function () {
    const summary = summarizeAgentFlight(
      [
        toolResult({
          callId: "call-1",
          name: "note_write",
          receipts: [
            receipt([
              "created_note:item:500",
              "native_note:500:html_sha256:abc",
            ]),
          ],
        }),
        // The same note, verified again: one note, not two.
        toolResult({
          callId: "call-2",
          name: "note_write",
          receipts: [receipt(["native_note:500:text_match"])],
        }),
        toolResult({
          callId: "call-3",
          name: "note_write",
          receipts: [receipt(["created_note:item:501"])],
        }),
      ],
      { modelCalls: [1], nativeSaves: 2 },
    );
    assert.equal(summary.nativeWrites, 2, "two distinct notes were proved");
    assert.equal(summary.nativeSaves, 2);
    assert.equal(summary.duplicateNativeWrites, 0);
  });

  it("surfaces a physical write no receipt accounts for", function () {
    const summary = summarizeAgentFlight(
      [toolResult({ callId: "call-1", name: "note_write_batch" })],
      { modelCalls: [2], nativeSaves: 3 },
    );
    assert.equal(
      summary.nativeWrites,
      0,
      "a write with no receipt fact proves nothing",
    );
    assert.equal(summary.duplicateNativeWrites, 3);
  });

  it("never reports a negative duplicate count", function () {
    const summary = summarizeAgentFlight(
      [
        toolResult({
          callId: "call-1",
          name: "note_write",
          receipts: [receipt(["native_note:500:text_match"])],
        }),
      ],
      { modelCalls: [1], nativeSaves: 0 },
    );
    assert.equal(summary.nativeWrites, 1);
    assert.equal(summary.duplicateNativeWrites, 0);
  });

  it("counts a retrieval repeat from the item ids the calls named, not their names", function () {
    const summary = summarizeAgentFlight(
      [
        // Three differently named tools, all declaring the retrieval stage:
        // the summary must read the stage and the ids, never the name.
        stageEvent({
          stage: "retrieval",
          callId: "call-1",
          toolName: "search_paper",
        }),
        toolCall({
          callId: "call-1",
          name: "search_paper",
          args: { target: { itemId: 40, contextItemId: 41 } },
        }),
        stageEvent({
          stage: "retrieval",
          callId: "call-2",
          toolName: "paper_read",
        }),
        toolCall({
          callId: "call-2",
          name: "paper_read",
          args: { target: { itemId: 40, contextItemId: 41 } },
        }),
        stageEvent({
          stage: "retrieval",
          callId: "call-3",
          toolName: "read_paper",
        }),
        toolCall({
          callId: "call-3",
          name: "read_paper",
          args: { target: { itemId: 50, contextItemId: 51 } },
        }),
      ],
      {
        modelCalls: [4],
        nativeSaves: 0,
        retrievalCounters: { candidateBuilds: 2, paperContextEnsures: 6 },
      },
    );
    assert.deepEqual(summary.retrieval, {
      toolCalls: 3,
      candidateBuilds: 2,
      paperContextEnsures: 6,
      repeatedCallsForSameItem: 1,
      cacheHitRate: 0.33,
    });
    assert.equal(
      summary.retrieval.toolCalls,
      summary.toolCallsByStage.retrieval,
      "the retrieval block and the stage histogram must count the same calls",
    );
  });

  it("reports no retrieval cache hit rate for a flight that retrieved nothing", function () {
    const summary = summarizeAgentFlight(
      [
        stageEvent({
          stage: "zotero_action",
          callId: "call-1",
          toolName: "note_write",
        }),
        toolCall({ callId: "call-1", name: "note_write" }),
      ],
      { modelCalls: [2], nativeSaves: 1 },
    );
    assert.deepEqual(summary.retrieval, {
      toolCalls: 0,
      candidateBuilds: 0,
      paperContextEnsures: 0,
      repeatedCallsForSameItem: 0,
      cacheHitRate: null,
    });
  });

  it("treats an empty item id as naming no item, not as naming item zero", function () {
    const summary = summarizeAgentFlight(
      [
        // Models do emit nulls for optional identity fields. Coercing one to a
        // number would mint a synthetic item "0" that two such calls share,
        // and the second would be reported as a repeat of the first.
        stageEvent({
          stage: "retrieval",
          callId: "call-1",
          toolName: "search_paper",
        }),
        toolCall({
          callId: "call-1",
          name: "search_paper",
          args: { target: { itemId: null, contextItemId: "" } },
        }),
        stageEvent({
          stage: "retrieval",
          callId: "call-2",
          toolName: "search_paper",
        }),
        toolCall({
          callId: "call-2",
          name: "search_paper",
          args: { target: { itemId: [], contextItemId: undefined } },
        }),
      ],
      {
        modelCalls: [3],
        nativeSaves: 0,
        retrievalCounters: { candidateBuilds: 2, paperContextEnsures: 2 },
      },
    );
    assert.equal(summary.retrieval.toolCalls, 2);
    assert.equal(
      summary.retrieval.repeatedCallsForSameItem,
      0,
      "an absent id names no item, so two calls that both omit one share nothing",
    );
  });

  it("counts a retrieval call that names no item without calling it a repeat", function () {
    const summary = summarizeAgentFlight(
      [
        stageEvent({
          stage: "retrieval",
          callId: "call-1",
          toolName: "search_paper",
        }),
        toolCall({ callId: "call-1", name: "search_paper", args: {} }),
        stageEvent({
          stage: "retrieval",
          callId: "call-2",
          toolName: "search_paper",
        }),
        toolCall({ callId: "call-2", name: "search_paper", args: {} }),
      ],
      {
        modelCalls: [3],
        nativeSaves: 0,
        retrievalCounters: { candidateBuilds: 2, paperContextEnsures: 2 },
      },
    );
    assert.equal(summary.retrieval.toolCalls, 2);
    assert.equal(
      summary.retrieval.repeatedCallsForSameItem,
      0,
      "a call whose arguments name no item cannot be shown to repeat one",
    );
    assert.equal(summary.retrieval.cacheHitRate, 0);
  });
});
