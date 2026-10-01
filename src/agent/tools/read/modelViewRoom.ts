import type { AgentRuntimeRequest } from "../../types";
import { resolveAgentPromptBudgetLimits } from "../../context/promptBudget";

/**
 * The share of the model's input budget one sized tool view may take: a
 * turn also carries its prompt, its history and further reads, and a
 * library question often makes two or three such calls.
 */
export const MODEL_VIEW_ROOM_SHARE = 0.25;

/** The largest sized view, in tokens, the request's model makes room for. */
export function modelViewRoomTokens(request: AgentRuntimeRequest): number {
  const limits = resolveAgentPromptBudgetLimits({
    ...request,
    inputTokenCap: request.advanced?.inputTokenCap,
    profileOverride: request.advanced?.profileOverride,
    outputTokenLimit: request.advanced?.outputTokenLimit,
  });
  return Math.max(
    1,
    Math.floor(limits.softLimitTokens * MODEL_VIEW_ROOM_SHARE),
  );
}
