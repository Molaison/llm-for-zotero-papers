import type { AgentEvent } from "./types";

/** The run event that opens or closes one stage of a turn's work. */
export type AgentStageEvent = Extract<AgentEvent, { type: "agent_stage" }>;

/** Everything a stage event says, apart from that it is one. */
export type AgentStageEventFields = Omit<AgentStageEvent, "type">;

/**
 * A stage event carrying only the fields it actually knows.
 *
 * A key whose value is `undefined` survives in memory but is dropped by the
 * JSON the trace store persists, so a live event and the same event replayed
 * from storage would not compare equal. Nothing downstream should have to
 * care which side of the store it is reading.
 *
 * Three producers emit stage events -- the runtime for its own turns, the
 * Codex bridge for a connected runtime's work, and the compatibility
 * projection for traces recorded before stages existed -- and a reader may
 * see events from any of them in one trace. They therefore build the event
 * here rather than each repeating the rule, so "the same stage" is the same
 * object whichever produced it.
 *
 * This module imports only types, so every layer that emits a stage can
 * reach it.
 */
export function buildAgentStageEvent(
  fields: AgentStageEventFields,
): AgentStageEvent {
  const event: Record<string, unknown> = { type: "agent_stage", ...fields };
  for (const key of Object.keys(event)) {
    if (event[key] === undefined) delete event[key];
  }
  return event as AgentStageEvent;
}
