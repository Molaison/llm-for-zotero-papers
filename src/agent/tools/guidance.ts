import type { AgentToolGuidance } from "../types";

type GuidanceRequest = Parameters<AgentToolGuidance["matches"]>[0];

type UserTextSignals = NonNullable<GuidanceRequest["userTextSignals"]>;

/** A turn selects this guidance by a cheap signal in the user's own text. */
export function userTextSignal(
  request: GuidanceRequest,
  signal: (signals: UserTextSignals) => boolean,
): boolean {
  return Boolean(request.userTextSignals && signal(request.userTextSignals));
}

/**
 * Selects nothing. Guidance the classifier's intent used to select keeps its
 * text with this matcher: that intent is gone, so no turn selects it until it
 * is given a trigger of its own or removed.
 */
export function neverSelected(): boolean {
  return false;
}
