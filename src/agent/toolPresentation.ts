import type { AgentToolDefinition } from "./types";

/**
 * The name a tool gives itself for the trace.
 *
 * Readers must never Title-Case a tool identifier to get a verb: the registry
 * holds the live tools, so a trace replayed after a tool was renamed or
 * removed would silently change what it says happened. Every producer stamps
 * this label onto the event it emits, and the panel reads the event.
 */
export function resolveAgentToolPresentationLabel(
  tool: Pick<AgentToolDefinition<any, any>, "presentation"> | undefined | null,
): string | undefined {
  const label = tool?.presentation?.label;
  if (typeof label !== "string") return undefined;
  return label.trim() || undefined;
}
