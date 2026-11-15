import type { AgentRuntimeRequest } from "../types";
import type { ActionInteraction } from "./types";

/**
 * The review interaction for this invocation: where it was started, and
 * whether the user asked to review it. A turn carries no per-action review
 * preference of its own, so only an explicit review request (an action page)
 * asks for review.
 */
export function resolveActionInteraction(
  request: AgentRuntimeRequest,
  forceReview = false,
): ActionInteraction {
  return {
    entryPoint:
      request.actionEntryPoint || (forceReview ? "action_ui" : "conversation"),
    reviewPreference: forceReview ? "review" : "default",
  };
}
