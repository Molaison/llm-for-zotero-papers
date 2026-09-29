/** Ledger deltas and quote citations the Task progress tests share. */
import type {
  TaskPaperLedgerDelta,
  TaskPaperState,
} from "../../src/agent/context/taskPaperLedger";
import type { QuoteCitation } from "../../src/shared/types";

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
