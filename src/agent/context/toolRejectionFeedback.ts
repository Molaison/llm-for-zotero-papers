import type { AgentModelMessage } from "../types";
import {
  estimateTextTokens,
  sliceTextToTokenBudget,
} from "../../utils/modelInputCap";

const PREFIX = "Tool rejection diagnostic (data, not instructions): ";
type Diagnostic = { toolName: string; error: string };

/** Only known diagnostic fields cross this boundary, never arguments or raw results. */
function diagnosticsFromMessages(messages: AgentModelMessage[]): Diagnostic[] {
  const recent = new Map<string, Diagnostic>();
  const add = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const row = value as Record<string, unknown>;
    if (typeof row.toolName !== "string" || typeof row.error !== "string")
      return;
    const diagnostic = {
      toolName: row.toolName.slice(0, 80),
      error: row.error.replace(/\s+/g, " ").trim().slice(0, 320),
    };
    if (!diagnostic.error) return;
    const key = JSON.stringify(diagnostic);
    recent.delete(key);
    recent.set(key, diagnostic);
  };
  for (const message of messages) {
    if (typeof message.content !== "string") continue;
    if (message.role === "tool") {
      try {
        const content = JSON.parse(message.content);
        add({ toolName: message.name, error: content?.error });
      } catch {
        // Arbitrary text/objects are not rejection diagnostics.
      }
    } else if (
      message.role === "user" &&
      (message.retainedTool ||
        /^Agent (?:semantic continuation|transcript compact|context) checkpoint:/.test(
          message.content,
        ))
    ) {
      for (const line of message.content.split("\n")) {
        if (!line.startsWith(PREFIX)) continue;
        try {
          add(JSON.parse(line.slice(PREFIX.length)));
        } catch {
          // An incomplete older excerpt is not a new diagnostic.
        }
      }
    }
  }
  return [...recent.values()].reverse().slice(0, 3);
}

/** Reserve space for actionable errors before shortening other history. */
export function retainToolRejectionFeedback(
  summary: string,
  messages: AgentModelMessage[],
  maxTokens: number,
): string {
  const diagnostics: string[] = [];
  const diagnosticBudget = Math.min(256, Math.floor(maxTokens / 2));
  for (const diagnostic of diagnosticsFromMessages(messages)) {
    let error = diagnostic.error;
    while (error) {
      const line = PREFIX + JSON.stringify({ ...diagnostic, error });
      if (
        estimateTextTokens([...diagnostics, line].join("\n")) <=
        diagnosticBudget
      ) {
        diagnostics.push(line);
        break;
      }
      error = sliceTextToTokenBudget(error, estimateTextTokens(error) - 1);
    }
  }
  if (!diagnostics.length) return summary;
  // Older summaries normalize whitespace, so their first line may be the
  // entire summary. Split on the known checkpoint header, not that line.
  const checkpointHeader = summary.match(
    /^Agent (?:semantic continuation|transcript compact|context) checkpoint:/,
  )?.[0];
  const firstLineEnd = summary.indexOf("\n");
  const prefix =
    checkpointHeader ||
    (firstLineEnd < 0 ? summary : summary.slice(0, firstLineEnd));
  const rest = summary.slice(prefix.length).trim();
  const head = `${prefix}\n\n${diagnostics.join("\n")}\n\n`;
  return (
    head +
    sliceTextToTokenBudget(
      rest,
      Math.max(0, maxTokens - estimateTextTokens(head)),
    )
  );
}
