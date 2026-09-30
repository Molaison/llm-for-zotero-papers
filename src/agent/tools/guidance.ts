import type { AgentToolGuidance } from "../types";

type GuidanceRequest = Parameters<AgentToolGuidance["matches"]>[0];

type UserTextSignals = NonNullable<GuidanceRequest["userTextSignals"]>;

/**
 * Plan turns match on classified operations or capabilities; ordinary chat
 * turns carry no classified intent, so they match on a cheap user-text signal.
 */
export function intentOrSignal(
  request: GuidanceRequest,
  operations: readonly string[],
  signal: (signals: UserTextSignals) => boolean,
): boolean {
  if (
    request.classifiedIntent?.actionIntents.some(
      (action) =>
        operations.includes(action.operation) ||
        operations.includes(action.capability),
    )
  ) {
    return true;
  }
  return Boolean(request.userTextSignals && signal(request.userTextSignals));
}
