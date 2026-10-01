import {
  evaluatePreparedActionContract,
  formatReceiptStatus,
  receiptReportsEffect,
} from "./actionEvaluation";
import type { AgentActionReceipt } from "./types";

export type ActionContractFinalDecision =
  | { kind: "accept" }
  | { kind: "fail"; failure: string };

/**
 * The receipts one turn's tools produced, and what they prove at the end of
 * the turn. A turn has no contract of obligations: its receipts are the whole
 * record of what it did.
 */
export class ActionContractRunSession {
  private readonly receipts: AgentActionReceipt[] = [];

  recordToolReceipts(receipts: readonly AgentActionReceipt[]): void {
    this.receipts.push(...receipts);
  }

  evaluateFinal(): ActionContractFinalDecision {
    const evaluation = evaluatePreparedActionContract(this.receipts);
    if (evaluation.state === "satisfied" || evaluation.state === "cancelled") {
      return { kind: "accept" };
    }
    return {
      kind: "fail",
      failure:
        evaluation.failure ||
        "I could not verify completion of the requested action.",
    };
  }

  /** The status block of every receipt that reports an effect. */
  receiptStatus(): string {
    return formatReceiptStatus(this.receipts.filter(receiptReportsEffect));
  }
}
