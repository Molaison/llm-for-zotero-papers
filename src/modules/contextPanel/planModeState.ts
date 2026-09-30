import type {
  PlanExecutionLedger,
  PlanProvider,
  PlanRuntimeContext,
} from "../../agent/plans/types";
import { loadLatestResumablePlanExecutionForConversation } from "../../agent/plans/store";

export const PLAN_APPROVED_EVENT = "llm-plan-approved";
export const PLAN_REVISE_EVENT = "llm-plan-revise";
export const PLAN_CANCEL_EVENT = "llm-plan-cancel";

type ComposePlanState = {
  enabled: boolean;
  planId: string;
  revision: number;
  provider: PlanProvider;
  submitted: boolean;
};

const composeStates = new Map<number, ComposePlanState>();
const pendingExecutions = new Map<number, PlanRuntimeContext>();
/** Contexts staged by an approval or Resume click, not read back from the store. */
const stagedContexts = new WeakSet<PlanRuntimeContext>();

const CONTINUE_COMMANDS = new Set([
  "continue",
  "resume",
  "go on",
  "keep going",
  "proceed",
  "continue the plan",
  "resume the plan",
  "继续",
  "继续执行",
  "繼續",
  "繼續執行",
]);

/**
 * Whether a whole message asks for a stored plan execution to continue.
 *
 * Case, surrounding space and trailing punctuation are ignored; nothing else
 * is: "continue with a different question" is a new request, and resuming
 * the plan with it would swallow the question.
 */
export function isExplicitContinueCommand(text: string): boolean {
  const command = text
    .trim()
    .replace(/[\s\p{P}]+$/u, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
  return CONTINUE_COMMANDS.has(command);
}

function createPlanId(conversationKey: number): string {
  return `plan-${conversationKey}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function getComposePlanState(
  conversationKey: number,
): Readonly<ComposePlanState> | null {
  return composeStates.get(conversationKey) || null;
}

export function enableComposePlanMode(params: {
  conversationKey: number;
  provider: PlanProvider;
  planId?: string;
  revision?: number;
}): Readonly<ComposePlanState> {
  const existing = composeStates.get(params.conversationKey);
  const state: ComposePlanState = {
    enabled: true,
    planId:
      params.planId || existing?.planId || createPlanId(params.conversationKey),
    revision: params.revision || existing?.revision || 1,
    provider: params.provider,
    submitted: false,
  };
  composeStates.set(params.conversationKey, state);
  return state;
}

export function disableComposePlanMode(conversationKey: number): void {
  composeStates.delete(conversationKey);
}

export function toggleComposePlanMode(params: {
  conversationKey: number;
  provider: PlanProvider;
}): boolean {
  if (composeStates.get(params.conversationKey)?.enabled) {
    disableComposePlanMode(params.conversationKey);
    return false;
  }
  enableComposePlanMode(params);
  return true;
}

export function getPlanningRuntimeContext(
  conversationKey: number,
): PlanRuntimeContext | undefined {
  const state = composeStates.get(conversationKey);
  if (!state?.enabled) return undefined;
  state.submitted = true;
  return {
    phase: "planning",
    planId: state.planId,
    revision: state.revision,
    provider: state.provider,
  };
}

export function beginPlanRevision(params: {
  conversationKey: number;
  planId: string;
  revision: number;
  provider: PlanProvider;
}): void {
  enableComposePlanMode({
    conversationKey: params.conversationKey,
    planId: params.planId,
    revision: params.revision,
    provider: params.provider,
  });
}

export function stageApprovedPlanExecution(ledger: PlanExecutionLedger): void {
  const context: PlanRuntimeContext = {
    phase: "executing",
    planId: ledger.planId,
    revision: ledger.revision,
    executionId: ledger.executionId,
    approvedDigest: ledger.planDigest,
    activeTaskId: ledger.activeTaskId,
    provider: ledger.provider,
  };
  stagedContexts.add(context);
  pendingExecutions.set(ledger.conversationKey, context);
  disableComposePlanMode(ledger.conversationKey);
}

export async function takePendingPlanExecution(
  conversationKey: number,
  userText: string,
): Promise<PlanRuntimeContext | undefined> {
  const context = pendingExecutions.get(conversationKey);
  if (context) pendingExecutions.delete(conversationKey);
  if (context) return context;
  const ledger =
    await loadLatestResumablePlanExecutionForConversation(conversationKey);
  if (!ledger) return undefined;
  // A stored execution resumes only when this message answers its question
  // or asks, as a whole, to continue it. Anything else is a new request; the
  // Original Agent names the unfinished plan in that turn's prompt instead.
  if (
    ledger.status !== "waiting_for_user" &&
    !isExplicitContinueCommand(userText)
  )
    return undefined;
  return {
    phase: "executing",
    planId: ledger.planId,
    revision: ledger.revision,
    executionId: ledger.executionId,
    approvedDigest: ledger.planDigest,
    activeTaskId: ledger.activeTaskId,
    provider: ledger.provider,
  };
}

export function restorePendingPlanExecution(
  conversationKey: number,
  context: PlanRuntimeContext | undefined,
): void {
  // A stored execution is still in the store; staging it here would let the
  // next message resume it without passing the resume rule again.
  if (context?.phase === "executing" && stagedContexts.has(context))
    pendingExecutions.set(conversationKey, context);
}

export function clearPlanModeState(conversationKey: number): void {
  composeStates.delete(conversationKey);
  pendingExecutions.delete(conversationKey);
}
