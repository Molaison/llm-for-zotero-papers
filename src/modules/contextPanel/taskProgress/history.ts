/**
 * Rebuild a conversation's Task progress from what it persisted, when the
 * conversation is shown again (panel mount, conversation switch, restart).
 *
 * Sources, all already stored — nothing new is written:
 * - the question numbering: the conversation's user messages;
 * - every run's `paper_ledger_update` events (in-plugin Agent runs and the
 *   Codex/Claude Code run snapshots, which carry the MCP deltas);
 * - each finished answer's `quoteCitations`, the citations it rendered;
 * - whether a plan ran (`plan_*` events) or Codex kept a plan (its
 *   `codex-plan-checklist` event): the row then stays for the conversation;
 * - the latest run's Codex plan, shown as the steps.
 *
 * A built-in action leaves no conversation record, so its steps and its
 * "an action ran here" mark last only for the session.
 *
 * Rebuilding is lazy (a panel sync asks), once per record, and never for a
 * conversation being deleted or whose key is retired.
 */
import { listAgentRunEventsForRuns } from "../../../agent/store/traceStore";
import type { AgentRunEventRecord, AgentEvent } from "../../../agent/types";
import type { TaskPaperLedgerDelta } from "../../../agent/context/taskPaperLedger";
import { isConversationKeyRetiredInMemory } from "../../../shared/conversationKeyLedger";
import {
  areConversationWritesFrozen,
  getConversationWriteGeneration,
} from "../../../shared/conversationWriteFence";
import { chatHistory, loadedConversationKeys } from "../state";
import type { Message } from "../types";
import { readCodexPlanChecklist } from "./codexPlan";
import {
  getTaskProgress,
  getTaskProgressClearCount,
  hydrateTaskProgress,
  type TaskProgressHistory,
  type TaskProgressHistoryRun,
  type TaskRunState,
} from "./store";

/** Event kinds a rebuild reads; everything else in a trace is skipped. */
export const TASK_PROGRESS_HISTORY_EVENT_TYPES = [
  "paper_ledger_update",
  "codex_progress",
  "plan_updated",
  "plan_ready",
  "plan_execution_updated",
] as const;

const PLAN_EVENT_TYPES = new Set<string>([
  "plan_updated",
  "plan_ready",
  "plan_execution_updated",
]);

function settledState(message: Message | undefined): TaskRunState | null {
  if (!message || message.role !== "assistant" || message.streaming) {
    return null;
  }
  if (message.text === "[Cancelled]") return "cancelled";
  if (message.interrupted || /^Error:/.test(message.text || "")) {
    return "failed";
  }
  return "completed";
}

/** The history a conversation's messages and run events describe. Pure. */
export function buildTaskProgressHistory(
  messages: readonly Message[],
  eventsByRun: ReadonlyMap<string, readonly AgentRunEventRecord[]>,
  libraryID?: number,
): TaskProgressHistory {
  const runs: TaskProgressHistoryRun[] = [];
  let question = 0;
  let planSeen = false;
  for (const message of messages) {
    if (message.role === "user") {
      if (!message.compactMarker) question += 1;
      continue;
    }
    const runId = message.agentRunId?.trim();
    if (message.role !== "assistant" || !runId || question < 1) continue;
    const events = eventsByRun.get(runId) || [];
    const deltas: TaskPaperLedgerDelta[] = [];
    for (const entry of events) {
      const payload: AgentEvent = entry.payload;
      if (payload.type === "paper_ledger_update" && payload.delta) {
        deltas.push(payload.delta);
      } else if (PLAN_EVENT_TYPES.has(payload.type)) {
        planSeen = true;
      } else if (readCodexPlanChecklist(payload)) {
        planSeen = true;
      }
    }
    runs.push({
      runId,
      turn: question,
      live: Boolean(message.streaming),
      deltas,
      quoteCitations: message.quoteCitations,
    });
  }
  const last = messages[messages.length - 1];
  const latest = runs[runs.length - 1];
  let checklist: TaskProgressHistory["checklist"] = null;
  if (latest && latest.turn === question) {
    for (const entry of eventsByRun.get(latest.runId) || []) {
      const steps = readCodexPlanChecklist(entry.payload);
      if (steps) checklist = { source: "codex", runId: latest.runId, steps };
    }
  }
  return {
    runs,
    latestTurn: question,
    settled: settledState(last),
    planSeen,
    checklist,
    libraryID,
  };
}

type HistoryLoader = (runIds: string[]) => Promise<AgentRunEventRecord[]>;

const defaultLoader: HistoryLoader = (runIds) =>
  listAgentRunEventsForRuns(runIds, TASK_PROGRESS_HISTORY_EVENT_TYPES);

let loader: HistoryLoader = defaultLoader;
const inflight = new Map<number, Promise<void>>();

export function setTaskProgressHistoryLoaderForTests(
  next?: HistoryLoader,
): void {
  loader = next || defaultLoader;
}

export async function waitForTaskProgressHydrationForTests(
  conversationKey: number,
): Promise<void> {
  await inflight.get(conversationKey);
}

/** True while the conversation may not be rebuilt at all. */
function isFenced(conversationKey: number): boolean {
  return (
    isConversationKeyRetiredInMemory(conversationKey) ||
    areConversationWritesFrozen(conversationKey)
  );
}

/**
 * Fold the conversation's persisted history into its Task progress record,
 * once. Waits for the conversation's messages to load; drops the result if
 * the conversation was cleared, deleted or retired while its events loaded.
 */
export function ensureTaskProgressHydrated(
  conversationKey: number,
  libraryID?: number,
  onHydrated?: () => void,
): void {
  const key = Math.floor(Number(conversationKey) || 0);
  if (!(key > 0) || inflight.has(key)) return;
  if (getTaskProgress(key)?.hydrated) return;
  if (!loadedConversationKeys.has(key) || isFenced(key)) return;
  const generation = getConversationWriteGeneration(key);
  const clears = getTaskProgressClearCount(key);
  const stillCurrent = () =>
    !isFenced(key) &&
    getConversationWriteGeneration(key) === generation &&
    getTaskProgressClearCount(key) === clears &&
    loadedConversationKeys.has(key);
  const runIds = Array.from(
    new Set(
      (chatHistory.get(key) || [])
        .map((message) =>
          message.role === "assistant" ? message.agentRunId?.trim() || "" : "",
        )
        .filter(Boolean),
    ),
  );
  const task = (async () => {
    const events = runIds.length ? await loader(runIds) : [];
    if (!stillCurrent()) return;
    const byRun = new Map<string, AgentRunEventRecord[]>();
    for (const event of events) {
      const list = byRun.get(event.runId);
      if (list) list.push(event);
      else byRun.set(event.runId, [event]);
    }
    const changed = hydrateTaskProgress(
      key,
      buildTaskProgressHistory(chatHistory.get(key) || [], byRun, libraryID),
    );
    if (changed) onHydrated?.();
  })()
    .catch(() => undefined)
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, task);
}
