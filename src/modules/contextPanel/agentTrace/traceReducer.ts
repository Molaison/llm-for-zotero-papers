import type { AgentRunEventRecord } from "../../../agent/types";
import { sanitizeText } from "../../../utils/textSanitization";
import {
  getToolActivityVisibleDedupeKey,
  isWithinToolActivityDedupeWindow,
  mergeToolActivityPayload,
} from "./toolActivityDedupe";

type AgentReasoningPayload = Extract<
  AgentRunEventRecord["payload"],
  { type: "reasoning" }
>;

export function appendAgentTraceText(
  base: string | undefined,
  next: unknown,
): string | undefined {
  const chunk = typeof next === "string" ? sanitizeText(next) : null;
  if (!chunk || !chunk.trim()) return base;
  return `${base || ""}${chunk}`;
}

export function getReasoningTraceKey(payload: AgentReasoningPayload): string {
  const stepId =
    typeof payload.stepId === "string" && payload.stepId.trim()
      ? payload.stepId.trim()
      : "";
  return stepId ? `step:${stepId}` : `round:${payload.round}`;
}

/**
 * How one pushed event changed the compacted list.
 *
 * `merged_tail` rewrote the last entry in place of growing the list; a
 * live projection that cached everything before that entry can keep it.
 * `merged_earlier` rewrote an entry before the last one, so anything
 * projected from that entry onwards is stale.
 */
export type AgentTraceCompactionChange =
  | "appended"
  | "merged_tail"
  | "merged_earlier";

export type AgentTraceCompactor = {
  /**
   * The compacted events so far. The compactor owns this array and rewrites
   * it as events arrive; callers read it and never mutate it.
   */
  readonly entries: AgentRunEventRecord[];
  push(entry: AgentRunEventRecord): AgentTraceCompactionChange;
};

/**
 * The one compaction implementation, fed an event at a time.
 *
 * `compactAgentTraceEvents` replays a whole list through it, and a live run
 * feeds it only the events that arrived since the last refresh, so the two
 * cannot disagree about what a compacted trace is.
 */
export function createAgentTraceCompactor(): AgentTraceCompactor {
  const compact: AgentRunEventRecord[] = [];
  const codexActivityIndexByVisibleKey = new Map<string, number>();
  const codexActivityIndexByItemId = new Map<string, number>();
  const rewritten = (index: number): AgentTraceCompactionChange =>
    index === compact.length - 1 ? "merged_tail" : "merged_earlier";
  return {
    entries: compact,
    push(entry: AgentRunEventRecord): AgentTraceCompactionChange {
      const previous = compact[compact.length - 1];
      if (
        entry.payload.type === "message_delta" &&
        previous?.payload.type === "message_delta"
      ) {
        compact[compact.length - 1] = {
          ...entry,
          payload: {
            type: "message_delta",
            text: (previous.payload.text || "") + (entry.payload.text || ""),
          },
        };
        return "merged_tail";
      }
      if (
        entry.payload.type === "reasoning" &&
        previous?.payload.type === "reasoning" &&
        getReasoningTraceKey(previous.payload) ===
          getReasoningTraceKey(entry.payload)
      ) {
        compact[compact.length - 1] = {
          ...entry,
          payload: {
            type: "reasoning",
            round: entry.payload.round,
            stepId: entry.payload.stepId || previous.payload.stepId,
            stepLabel: entry.payload.stepLabel || previous.payload.stepLabel,
            summary: appendAgentTraceText(
              previous.payload.summary,
              entry.payload.summary,
            ),
            details: appendAgentTraceText(
              previous.payload.details,
              entry.payload.details,
            ),
          },
        };
        return "merged_tail";
      }
      if (
        entry.payload.type === "codex_tool_activity" &&
        codexActivityIndexByItemId.has(entry.payload.itemId)
      ) {
        const existingIndex = codexActivityIndexByItemId.get(
          entry.payload.itemId,
        );
        if (existingIndex === undefined) {
          codexActivityIndexByItemId.delete(entry.payload.itemId);
        } else {
          const previousEntry = compact[existingIndex];
          const previousPayload = previousEntry?.payload;
          if (previousPayload?.type !== "codex_tool_activity") {
            codexActivityIndexByItemId.delete(entry.payload.itemId);
          } else {
            const previousKey =
              getToolActivityVisibleDedupeKey(previousPayload);
            if (
              codexActivityIndexByVisibleKey.get(previousKey) === existingIndex
            ) {
              codexActivityIndexByVisibleKey.delete(previousKey);
            }
            const payload = mergeToolActivityPayload(
              previousPayload,
              entry.payload,
            );
            compact[existingIndex] = {
              ...entry,
              payload,
            };
            codexActivityIndexByVisibleKey.set(
              getToolActivityVisibleDedupeKey(payload),
              existingIndex,
            );
            return rewritten(existingIndex);
          }
        }
      }
      if (entry.payload.type === "codex_tool_activity") {
        const visibleKey = getToolActivityVisibleDedupeKey(entry.payload);
        const previousVisibleIndex =
          codexActivityIndexByVisibleKey.get(visibleKey);
        if (previousVisibleIndex !== undefined) {
          const previousVisibleEntry = compact[previousVisibleIndex];
          if (
            previousVisibleEntry?.payload.type === "codex_tool_activity" &&
            isWithinToolActivityDedupeWindow(
              entry.createdAt,
              previousVisibleEntry.createdAt,
            )
          ) {
            compact[previousVisibleIndex] = {
              ...previousVisibleEntry,
              payload: mergeToolActivityPayload(
                previousVisibleEntry.payload,
                entry.payload,
              ),
            };
            codexActivityIndexByItemId.set(
              entry.payload.itemId,
              previousVisibleIndex,
            );
            return rewritten(previousVisibleIndex);
          }
        }
        codexActivityIndexByVisibleKey.set(visibleKey, compact.length);
        codexActivityIndexByItemId.set(entry.payload.itemId, compact.length);
      }
      compact.push(entry);
      return "appended";
    },
  };
}

export function compactAgentTraceEvents(
  events: readonly AgentRunEventRecord[],
): AgentRunEventRecord[] {
  const compactor = createAgentTraceCompactor();
  for (const entry of events) compactor.push(entry);
  return compactor.entries;
}

export function normalizeInlineTextForDedupe(text: string): string {
  return sanitizeText(text).replace(/\s+/g, " ").trim();
}
