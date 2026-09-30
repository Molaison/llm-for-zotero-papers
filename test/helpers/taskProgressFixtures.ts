/** Ledger deltas, quote citations and outcome ledgers the Task progress tests share. */
import type {
  TaskPaperLedgerDelta,
  TaskPaperState,
} from "../../src/agent/context/taskPaperLedger";
import type {
  ExecutionCheckpoint,
  ExecutionCheckpointTask,
  RunEndState,
} from "../../src/agent/execution/types";
import type { QuoteCitation } from "../../src/shared/types";

/** One outcome of a run's ledger, as the host records it. */
export function outcomeTask(
  local: string,
  overrides: Partial<ExecutionCheckpointTask> = {},
): ExecutionCheckpointTask {
  return {
    taskId: `execution-1:task:${local}`,
    description: local,
    dependencies: [],
    status: "pending",
    journalActionIds: [],
    verifiedReceiptIds: [],
    readEvidenceIds: [],
    materialRefs: [],
    createdAt: 1,
    updatedAt: 1,
    effect: "mutation",
    origin: "model",
    ...overrides,
  };
}

/** A run's outcome ledger: its outcomes and, once it settled, how it ended. */
export function outcomeCheckpoint(
  tasks: ExecutionCheckpointTask[],
  end?: RunEndState,
  updatedAt = 2,
): ExecutionCheckpoint {
  return {
    version: 1,
    executionId: "execution-1",
    conversationKey: 42,
    conversationGeneration: 0,
    tasks,
    createdAt: 1,
    updatedAt,
    ...(end ? { end: { state: end } } : {}),
  };
}

export function ledgerDelta(
  callId: string,
  papers: Array<[number, TaskPaperState, string?]>,
  runId?: string,
): TaskPaperLedgerDelta {
  return {
    version: 1,
    callId,
    runId,
    toolName: "library_retrieve",
    papers: papers.map(([itemId, state]) => ({
      key: `1:${itemId}`,
      libraryID: 1,
      itemId,
      title: `Paper ${itemId}`,
      state,
    })),
    reads: papers
      .filter(([, , snippet]) => snippet)
      .map(([itemId, , snippet]) => ({
        key: `1:${itemId}`,
        callId,
        toolName: "library_retrieve",
        granularity: "passage" as const,
        method: "bm25",
        label: "Results",
        snippet,
      })),
  };
}

export function quoteCitation(id: string, itemId: number): QuoteCitation {
  return {
    id,
    quoteText: `Quoted evidence ${id}`,
    citationLabel: "(Smith, 2021)",
    itemId,
  };
}
