import type { AgentActionReceipt } from "./types";

/** What a receipt proved about the state it claims to have changed. */
export type AgentActionVerification = AgentActionReceipt["verification"];

/**
 * One vocabulary for every place a receipt's verification reaches a person.
 *
 * The value is the whole point of the receipt, so the trace chip on the row
 * that produced it and the action-status block appended to the final answer
 * must not describe it in two different ways. The wording says what was proved
 * rather than repeating the internal token:
 * - `verified` — the state was read back and matched.
 * - `execution_only` — the action ran, and nothing about it can be re-read.
 * - `unverified` — a read-back was possible and did not confirm the claim.
 * - `not_applicable` — nothing was attempted (a cancelled action), which the
 *   trace already reports as a cancellation, so no chip repeats it.
 */
export const AGENT_ACTION_VERIFICATION_LABELS: Record<
  AgentActionVerification,
  string
> = {
  verified: "Verified",
  execution_only: "Ran (no state proof)",
  unverified: "Unverified",
  not_applicable: "Not applicable",
};

/**
 * How much of the reader's attention each value deserves.
 *
 * One result can carry several receipts, and a row can show only one verdict.
 * The weakest proof is the one worth showing: a verified receipt beside an
 * unverified one does not make the turn verified. A cancelled action ranks
 * lowest because it claims nothing at all, so it never hides a worse value.
 */
const AGENT_ACTION_VERIFICATION_SEVERITY: Record<
  AgentActionVerification,
  number
> = {
  not_applicable: 0,
  verified: 1,
  execution_only: 2,
  unverified: 3,
};

/**
 * The verification a receipt carries, or `null` when it carries none.
 *
 * Receipts are journaled and replayed, so a run recorded before this field
 * existed still reaches the trace. Such a receipt states nothing about proof
 * and must not be presented as if it did.
 */
export function readAgentActionVerification(
  value: unknown,
): AgentActionVerification | null {
  return typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(
      AGENT_ACTION_VERIFICATION_LABELS,
      value,
    )
    ? (value as AgentActionVerification)
    : null;
}

/** The weakest proof among a result's receipts, or `null` when none states one. */
export function worstAgentActionVerification(
  receipts: readonly Pick<AgentActionReceipt, "verification">[] | undefined,
): AgentActionVerification | null {
  let worst: AgentActionVerification | null = null;
  for (const receipt of receipts || []) {
    const value = readAgentActionVerification(receipt?.verification);
    if (!value) continue;
    if (
      !worst ||
      AGENT_ACTION_VERIFICATION_SEVERITY[value] >
        AGENT_ACTION_VERIFICATION_SEVERITY[worst]
    )
      worst = value;
  }
  return worst;
}
