import type { OriginalAgentPermissionMode } from "../../shared/originalAgentPermissionMode";
import type { ScopeValidationFailure } from "../contracts/actionContract";

/**
 * What the host does with a write that falls outside the turn's authorized
 * scope: run it on the agent's judgment (YOLO only), or block it.
 */
export type ScopeJudgmentDecision =
  | Readonly<{ kind: "execute"; authority: "yolo_judgment" }>
  | Readonly<{ kind: "block" }>;

const JUDGMENT_AMENDABLE_CODES: ReadonlySet<ScopeValidationFailure["code"]> =
  new Set([
    "different_operation",
    "different_parameters",
    "scope_mismatch",
    "fixed_selection",
    "added_target",
    "incomplete_batch",
  ]);

const RAIL_RISK_SIGNALS: ReadonlySet<string> = new Set([
  "protected_target",
  "authorization_tampering",
  "privilege_escalation",
]);

/**
 * Yolo judgment: the user delegated decisions. Violating proposals were
 * already blocked by authorizeOriginalAction; here only the impact and
 * integrity signals remain as rails.
 */
export function decideScopeJudgment(params: {
  originalMode: OriginalAgentPermissionMode;
  failure: ScopeValidationFailure;
  actionImpact: "read_only" | "state_change" | "ambiguous" | "prohibited";
  riskSignals: readonly string[];
}): ScopeJudgmentDecision {
  const railSignal = params.riskSignals.some((signal) =>
    RAIL_RISK_SIGNALS.has(signal),
  );
  if (
    params.originalMode === "yolo" &&
    params.actionImpact !== "prohibited" &&
    !railSignal &&
    JUDGMENT_AMENDABLE_CODES.has(params.failure.code)
  ) {
    return { kind: "execute", authority: "yolo_judgment" };
  }
  return { kind: "block" };
}
