import type { OriginalAgentPermissionMode } from "../../shared/originalAgentPermissionMode";

export type ActionDomain =
  | "zotero_library"
  | "filesystem"
  | "local_execution"
  | "network"
  | "privileged_zotero";

export type ActionEffect =
  | "read"
  | "create"
  | "modify"
  | "delete"
  | "execute"
  | "egress";

export type ActionMechanism = "none" | "shell" | "zotero_script";

export type ActionConstraint = Readonly<
  | {
      kind: "deny_effects";
      effects: ActionEffect[];
      domains: ActionDomain[];
      /** Narrow native operations explicitly permitted by a qualified prohibition. */
      exceptOperations?: string[];
      /** Restrict this denial to named native operations; opaque effects remain denied. */
      operations?: string[];
      description: string;
    }
  | {
      kind: "deny_mechanisms";
      mechanisms: Exclude<ActionMechanism, "none">[];
      description: string;
    }
>;

export type ActionRiskSignal =
  | "ambiguous_target"
  | "scope_expansion"
  | "exclusive_replacement"
  | "sensitive_egress"
  | "broad_delete"
  | "protected_target"
  | "privilege_escalation"
  | "package_system_modification"
  | "download_to_shell"
  | "authorization_tampering"
  | "raw_database";

export type ActionProposal = {
  version: 2;
  runtime: "original" | "claude" | "codex" | "external";
  toolName: string;
  operation: string;
  capabilities: string[];
  domains: ActionDomain[];
  effects: ActionEffect[];
  targets: string[];
  /** Native libraries resolved by the host for the concrete targets. */
  targetLibraryIDs?: number[];
  summary: string;
  reversibility: "full" | "partial" | "none";
  riskSignals: ActionRiskSignal[];
  invocationPlan: import("../types").AgentInvocationPlan;
  intentBinding: {
    conversationKey?: number;
    conversationGeneration?: number;
    actionContractId?: string;
    userIntentDigest?: string;
  };
  payloadDigest: string;
};

export type AuthorizationDecision =
  | {
      kind: "execute";
      authority:
        | "safe_read"
        | "external_runtime"
        | "auto_policy"
        | "yolo"
        | "yolo_judgment";
    }
  | { kind: "confirm"; reason: string }
  | { kind: "block"; reason: string };

/** Only the shared authorization service resolves this intermediate decision. */
export type AuthorizationAssessment =
  | AuthorizationDecision
  | { kind: "model_review"; reason: string };

export type ActionReviewInput = Readonly<{
  proposal: ActionProposal;
  input: unknown;
  userRequest: string;
  clarifications: unknown;
  conversation: ReadonlyArray<{ role: "user" | "assistant"; text: string }>;
  /** Completed host-observed actions supply context, never user authority. */
  currentTurnActions?: ReadonlyArray<{
    name: string;
    ok: boolean;
    input?: unknown;
    content?: unknown;
  }>;
  userInstructions?: string;
  workspace: unknown;
  constraints: readonly ActionConstraint[];
}>;

export type ActionReviewVerdict = Readonly<{
  decision: "execute" | "confirm";
  reason: string;
  unavailable?: boolean;
}>;

export type ActionReviewer = (
  input: ActionReviewInput,
  signal?: AbortSignal,
) => Promise<ActionReviewVerdict>;

export type ActionReviewRecord = ActionReviewVerdict & {
  proposalDigest: string;
  elapsedMs: number;
};

export type ActionInteraction = Readonly<{
  entryPoint: "action_ui" | "conversation";
  reviewPreference: "default" | "review" | "direct";
}>;

export type OriginalAuthorizationContext = {
  /** Resolved by the host from the entry point and concrete proposal. */
  interaction?: ActionInteraction;
  mode: OriginalAgentPermissionMode;
  constraints?: readonly ActionConstraint[];
  /** Legacy capture accepted by stored research flows; direct policy ignores it. */
  semantic?: import("../model/semanticDecisions").SemanticIntent;
  /** Host-created turn facts; never accepted from model tool arguments. */
  executionContext?: import("../types").AgentExecutionContext;
  /** Legacy compatibility input. Direct-agent policy does not use this as authority. */
  hasMatchingActionIntent?: boolean;
};
