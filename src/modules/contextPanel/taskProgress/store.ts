/**
 * The Task progress store: one record per conversation of what the current
 * task is doing — its run state, the per-paper ledger, the scope it covers,
 * and the plan steps while a plan runs.
 *
 * The store owns no DOM. Writers are the turn owners (the agent engine, the
 * Codex callbacks, the request lifecycle); readers are the Task progress
 * views, which subscribe and repaint on their own schedule. Every writer is
 * idempotent, so a replayed or duplicated event changes nothing.
 *
 * At most `TASK_PROGRESS_MAX_CONVERSATIONS` conversations are kept, least
 * recently written first out; a conversation with a live run is evicted only
 * when every kept conversation is live.
 */
import {
  applyFinalCitations,
  applyTaskPaperLedgerDelta,
  createTaskPaperLedger,
  type TaskPaperLedger,
  type TaskPaperLedgerDelta,
} from "../../../agent/context/taskPaperLedger";
import type {
  TaskPaperScopeContexts,
  TaskPaperScopeListing,
} from "../../../agent/context/taskPaperScopeListing";
import type {
  PlanExecutionLedger,
  PlanEvent,
} from "../../../agent/plans/types";
import type { QuoteCitation } from "../../../shared/types";

export type TaskRunState =
  | "idle"
  | "working"
  | "answering"
  | "completed"
  | "failed"
  | "cancelled";

export type TaskProgressResearch = Extract<
  PlanEvent,
  { type: "plan_research_progress" }
>["progress"];

export type TaskProgressPlan = {
  ledger: PlanExecutionLedger;
  research?: TaskProgressResearch;
};

export type TaskProgressStepStatus = "pending" | "in_progress" | "completed";

export type TaskProgressStep = {
  label: string;
  status: TaskProgressStepStatus;
};

/**
 * Steps that are not an in-plugin plan: a built-in action's progress, or the
 * checklist Codex keeps with its `update_plan` tool.
 */
export type TaskProgressChecklist = {
  source: "action" | "codex";
  /** The run the steps belong to (an action gets its own id). */
  runId: string;
  /** The action's name; empty for Codex. */
  title: string;
  steps: TaskProgressStep[];
  /** Steps completed, and steps in all (an action announces its total). */
  done: number;
  total: number;
  /** The action's latest step summary. */
  summary: string;
  /** Set once the steps' run ended. */
  outcome?: "completed" | "failed" | "cancelled";
  /** Completion or error text at the end. */
  detail?: string;
};

/** The scope a turn attached, and its listing once the snapshot resolved it. */
export type TaskProgressScope = {
  /** Identity of the attached contexts; a new signature replaces the listing. */
  signature: string;
  libraryID: number;
  contexts: TaskPaperScopeContexts;
  /** "Drift + Learning", or empty when nothing names the scope. */
  label: string;
  listing: TaskPaperScopeListing | null;
};

export type TaskProgressRecord = {
  conversationKey: number;
  /** Bumped on every change; views repaint only when it moves. */
  version: number;
  runState: TaskRunState;
  /** The run the state describes, once the runtime named it. */
  runId?: string;
  /** Question number of the current run, 1-based; 0 before any run. */
  turnIndex: number;
  /** Question number of every run seen, by run id. */
  turnByRunId: Record<string, number>;
  ledger: TaskPaperLedger;
  scope: TaskProgressScope | null;
  /** The live plan, or null when none runs. */
  plan: TaskProgressPlan | null;
  /** An action's or Codex's steps, kept until the next question starts. */
  checklist: TaskProgressChecklist | null;
  /**
   * True once a plan, an action or a Codex plan ran here: the row then stays
   * for the conversation.
   */
  planSeen: boolean;
  /** Bumped when the answer starts streaming; open drawers collapse. */
  collapseSeq: number;
  /** True once the persisted history was folded in. */
  hydrated: boolean;
  /** Identity of this record; a cleared and recreated record gets a new one. */
  epoch: number;
};

export const TASK_PROGRESS_MAX_CONVERSATIONS = 6;

const records = new Map<number, TaskProgressRecord>();
let nextEpoch = 1;
const listeners = new Set<(conversationKey: number) => void>();

function normalizeKey(value: unknown): number {
  const key = Math.floor(Number(value || 0));
  return Number.isFinite(key) && key > 0 ? key : 0;
}

function isLive(state: TaskRunState): boolean {
  return state === "working" || state === "answering";
}

function evict(): void {
  while (records.size > TASK_PROGRESS_MAX_CONVERSATIONS) {
    let victim: number | undefined;
    for (const [key, record] of records) {
      if (!isLive(record.runState)) {
        victim = key;
        break;
      }
    }
    if (victim === undefined) victim = records.keys().next().value;
    if (victim === undefined) return;
    records.delete(victim);
  }
}

function emptyRecord(conversationKey: number): TaskProgressRecord {
  return {
    conversationKey,
    version: 0,
    runState: "idle",
    turnIndex: 0,
    turnByRunId: {},
    ledger: createTaskPaperLedger(),
    scope: null,
    plan: null,
    checklist: null,
    planSeen: false,
    collapseSeq: 0,
    hydrated: false,
    epoch: nextEpoch++,
  };
}

/** The record to write, most recently used last. */
function writable(conversationKey: number): TaskProgressRecord | null {
  const key = normalizeKey(conversationKey);
  if (!key) return null;
  const existing = records.get(key);
  if (existing) {
    records.delete(key);
    records.set(key, existing);
    return existing;
  }
  const created = emptyRecord(key);
  records.set(key, created);
  evict();
  return records.get(key) || null;
}

/** Tell every view; a broken view (e.g. a closed window's) never breaks the writer. */
function notify(conversationKey: number): void {
  for (const listener of Array.from(listeners)) {
    try {
      listener(conversationKey);
    } catch {
      /* a broken view must not break the writer */
    }
  }
}

function changed(record: TaskProgressRecord): void {
  record.version += 1;
  notify(record.conversationKey);
}

export function getTaskProgress(
  conversationKey: number,
): TaskProgressRecord | null {
  return records.get(normalizeKey(conversationKey)) || null;
}

export function subscribeTaskProgress(
  listener: (conversationKey: number) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function highestTurn(record: TaskProgressRecord): number {
  return Math.max(0, record.turnIndex, ...Object.values(record.turnByRunId));
}

/**
 * A run starts: the row turns to working. Called by the request lifecycle
 * (no run id yet) and again by the runtime once it names the run; the second
 * call attaches the id to the same run instead of starting another.
 *
 * `turnIndex` is the question's 1-based position in the conversation. It
 * defaults to the run's position in the order runs were seen.
 */
export function beginTaskRun(
  conversationKey: number,
  params: { runId?: string; turnIndex?: number } = {},
): void {
  const record = writable(conversationKey);
  if (!record) return;
  const runId = params.runId?.trim() || undefined;
  const requestedTurn =
    params.turnIndex && params.turnIndex > 0 ? Math.floor(params.turnIndex) : 0;
  if (runId && record.runId === runId) {
    if (requestedTurn && requestedTurn !== record.turnIndex) {
      record.turnIndex = requestedTurn;
      record.turnByRunId[runId] = requestedTurn;
      changed(record);
    }
    return;
  }
  if (isLive(record.runState) && !record.runId) {
    // The request began this run; the runtime now names it.
    record.runId = runId;
    record.turnIndex = requestedTurn || record.turnIndex;
    if (runId) record.turnByRunId[runId] = record.turnIndex;
    changed(record);
    return;
  }
  // A replayed start of a run already seen never restarts it.
  if (runId && record.turnByRunId[runId] !== undefined) return;
  const turn = requestedTurn || highestTurn(record) + 1;
  record.runState = "working";
  record.runId = runId;
  record.turnIndex = turn;
  if (runId) record.turnByRunId[runId] = turn;
  // A new question starts fresh steps; an earlier action's or Codex plan's
  // steps are done with.
  if (record.checklist && record.checklist.runId !== runId) {
    record.checklist = null;
  }
  changed(record);
}

function turnFor(
  record: TaskProgressRecord,
  runId: string | undefined,
): number | undefined {
  if (runId && record.turnByRunId[runId] !== undefined) {
    return record.turnByRunId[runId];
  }
  if (!runId || runId === record.runId) {
    return record.turnIndex || undefined;
  }
  return undefined;
}

/** True when the event names this record's current run (or names none). */
function isCurrentRun(
  record: TaskProgressRecord,
  runId: string | undefined,
): boolean {
  return !runId || !record.runId || record.runId === runId;
}

/**
 * Fold one `paper_ledger_update` delta in. The turn comes from the run that
 * produced it; a delta from an unknown run falls back to the current turn.
 */
export function applyTaskPaperUpdate(
  conversationKey: number,
  delta: TaskPaperLedgerDelta,
  runId?: string,
): void {
  const record = writable(conversationKey);
  if (!record || !delta) return;
  const turn = turnFor(record, runId || delta.runId) ?? record.turnIndex;
  const before = Object.keys(record.ledger.appliedCalls).length;
  applyTaskPaperLedgerDelta(record.ledger, delta, turn || undefined);
  if (Object.keys(record.ledger.appliedCalls).length !== before) {
    changed(record);
  }
}

/**
 * The answer started streaming. Returns true on the transition, which also
 * asks every open drawer for this conversation to collapse.
 */
export function markTaskAnswering(
  conversationKey: number,
  runId?: string,
): boolean {
  const record = records.get(normalizeKey(conversationKey));
  if (!record || record.runState !== "working" || !isCurrentRun(record, runId))
    return false;
  writable(conversationKey);
  record.runState = "answering";
  record.collapseSeq += 1;
  changed(record);
  return true;
}

/**
 * The answer is final: mark the papers it cites and show ✓. Applying the
 * same answer again replaces that turn's citations, so it is idempotent.
 */
export function completeTaskRun(
  conversationKey: number,
  params: {
    runId?: string;
    quoteCitations?: readonly QuoteCitation[];
    libraryID?: number;
  } = {},
): void {
  const record = writable(conversationKey);
  if (!record) return;
  const turn = turnFor(record, params.runId);
  if (turn && params.quoteCitations) {
    applyFinalCitations(
      record.ledger,
      params.quoteCitations,
      turn,
      params.libraryID,
    );
  }
  if (isCurrentRun(record, params.runId)) {
    if (params.runId && !record.runId) {
      record.runId = params.runId;
      if (turn) record.turnByRunId[params.runId] = turn;
    }
    record.runState = "completed";
  }
  changed(record);
}

/** The run stopped early. The partial ledger stays. */
export function endTaskRun(
  conversationKey: number,
  outcome: "failed" | "cancelled",
  runId?: string,
): void {
  const record = records.get(normalizeKey(conversationKey));
  if (!record || !isLive(record.runState) || !isCurrentRun(record, runId))
    return;
  writable(conversationKey);
  record.runState = outcome;
  changed(record);
}

/** The live plan's steps, or null once no plan runs. */
export function setTaskPlan(
  conversationKey: number,
  plan: TaskProgressPlan | null,
): void {
  const existing = records.get(normalizeKey(conversationKey));
  if (!plan && !existing?.plan) return;
  const record = writable(conversationKey);
  if (!record) return;
  if (
    plan &&
    record.plan &&
    record.plan.ledger === plan.ledger &&
    record.plan.research === plan.research
  )
    return;
  record.plan = plan;
  if (plan) record.planSeen = true;
  changed(record);
}

/**
 * The scope the latest turn attached. A new signature drops the old listing;
 * the same signature keeps it, so a view can resolve a listing once.
 */
export function setTaskScope(
  conversationKey: number,
  scope: Omit<TaskProgressScope, "listing"> & {
    listing?: TaskPaperScopeListing | null;
  },
): void {
  const record = writable(conversationKey);
  if (!record) return;
  const previous = record.scope;
  if (previous && previous.signature === scope.signature) {
    if (scope.listing && scope.listing !== previous.listing) {
      previous.listing = scope.listing;
      changed(record);
    } else if (scope.label !== previous.label) {
      previous.label = scope.label;
      changed(record);
    }
    return;
  }
  record.scope = { ...scope, listing: scope.listing || null };
  changed(record);
}

// ---------------------------------------------------------------------------
// Checklists: built-in actions and Codex plans
// ---------------------------------------------------------------------------

function countDone(steps: readonly TaskProgressStep[]): number {
  return steps.filter((step) => step.status === "completed").length;
}

/**
 * A built-in action starts. Its steps become the conversation's steps and
 * the row shows it working, unless a question is running: an action never
 * takes over a live question's state.
 */
export function beginTaskAction(
  conversationKey: number,
  params: { runId: string; title: string },
): void {
  const record = writable(conversationKey);
  if (!record || !params.runId) return;
  record.checklist = {
    source: "action",
    runId: params.runId,
    title: params.title,
    steps: [],
    done: 0,
    total: 0,
    summary: "",
  };
  record.planSeen = true;
  if (!isLive(record.runState)) {
    record.runState = "working";
    record.runId = params.runId;
  }
  changed(record);
}

function actionChecklist(
  record: TaskProgressRecord | null | undefined,
  runId: string,
): TaskProgressChecklist | null {
  const checklist = record?.checklist;
  return checklist?.source === "action" &&
    checklist.runId === runId &&
    !checklist.outcome
    ? checklist
    : null;
}

/** The action reached step `index` of `total`. */
export function setTaskActionStep(
  conversationKey: number,
  runId: string,
  params: { step: string; index: number; total: number },
): void {
  const record = records.get(normalizeKey(conversationKey));
  const checklist = actionChecklist(record, runId);
  if (!record || !checklist) return;
  const index = Math.max(1, Math.floor(params.index) || 1);
  const steps: TaskProgressStep[] = checklist.steps.map((step, position) => ({
    ...step,
    status: position < index - 1 ? "completed" : step.status,
  }));
  steps[index - 1] = { label: params.step, status: "in_progress" };
  for (let position = 0; position < index - 1; position++) {
    steps[position] ||= { label: "", status: "completed" };
  }
  checklist.steps = steps.slice(0, Math.max(index, 0));
  checklist.total = Math.max(Math.floor(params.total) || 0, index);
  checklist.done = countDone(checklist.steps);
  checklist.summary = "";
  writable(conversationKey);
  changed(record);
}

/** The action finished a step and said what it did. */
export function setTaskActionSummary(
  conversationKey: number,
  runId: string,
  summary: string,
): void {
  const record = records.get(normalizeKey(conversationKey));
  const checklist = actionChecklist(record, runId);
  if (!record || !checklist || checklist.summary === summary) return;
  checklist.summary = summary;
  writable(conversationKey);
  changed(record);
}

/** The action ended; the row shows how, with its completion or error text. */
export function endTaskAction(
  conversationKey: number,
  runId: string,
  outcome: "completed" | "failed" | "cancelled",
  detail?: string,
): void {
  const record = records.get(normalizeKey(conversationKey));
  const checklist = actionChecklist(record, runId);
  if (!record || !checklist) return;
  if (outcome === "completed") {
    checklist.steps = checklist.steps.map((step) => ({
      ...step,
      status: "completed",
    }));
    checklist.done = Math.max(checklist.total, checklist.steps.length);
    checklist.total = checklist.done;
  } else {
    checklist.done = countDone(checklist.steps);
  }
  checklist.outcome = outcome;
  if (detail) checklist.detail = detail;
  if (record.runId === runId && isLive(record.runState)) {
    record.runState = outcome;
  }
  writable(conversationKey);
  changed(record);
}

/** Codex's own plan for a run: its `update_plan` checklist, as it stands. */
export function setTaskChecklist(
  conversationKey: number,
  params: {
    source: "codex";
    runId: string;
    steps: TaskProgressStep[];
    outcome?: TaskProgressChecklist["outcome"];
  },
): void {
  if (!params.runId || !params.steps.length) return;
  const record = writable(conversationKey);
  if (!record) return;
  const previous = record.checklist;
  if (
    previous?.source === params.source &&
    previous.runId === params.runId &&
    previous.outcome === params.outcome &&
    JSON.stringify(previous.steps) === JSON.stringify(params.steps)
  ) {
    return;
  }
  const done = countDone(params.steps);
  record.checklist = {
    source: params.source,
    runId: params.runId,
    title: "",
    steps: params.steps.map((step) => ({ ...step })),
    done,
    total: params.steps.length,
    summary: "",
    ...(params.outcome ? { outcome: params.outcome } : {}),
  };
  record.planSeen = true;
  changed(record);
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export type TaskProgressHistoryRun = {
  runId: string;
  /** The question the run answered, 1-based. */
  turn: number;
  /** Still running: its citations are not final yet. */
  live?: boolean;
  deltas: TaskPaperLedgerDelta[];
  /** The citations the persisted answer kept. */
  quoteCitations?: readonly QuoteCitation[];
};

export type TaskProgressHistory = {
  runs: TaskProgressHistoryRun[];
  /** The latest question's number. */
  latestTurn: number;
  /** How the latest question ended, or null when it has no answer. */
  settled: TaskRunState | null;
  /** A plan or a Codex plan ran in the conversation. */
  planSeen: boolean;
  /** The latest run's Codex plan, if it had one. */
  checklist: Omit<
    TaskProgressChecklist,
    "done" | "total" | "summary" | "title"
  > | null;
  libraryID?: number;
};

/**
 * Fold a conversation's persisted history in: every run's ledger updates
 * under its question, each finished answer's citations, whether a plan ran,
 * and — when nothing runs now — the latest question's outcome. Merges with
 * whatever this session already recorded; every step is idempotent. Returns
 * whether anything changed.
 */
export function hydrateTaskProgress(
  conversationKey: number,
  history: TaskProgressHistory,
): boolean {
  const record = writable(conversationKey);
  if (!record) return false;
  const before = hydrationSignature(record);
  for (const run of history.runs) {
    if (!run.runId || !(run.turn > 0)) continue;
    if (record.turnByRunId[run.runId] === undefined) {
      record.turnByRunId[run.runId] = run.turn;
    }
    const turn = record.turnByRunId[run.runId];
    for (const delta of run.deltas) {
      applyTaskPaperLedgerDelta(record.ledger, delta, turn);
    }
    if (!run.live && run.quoteCitations) {
      applyFinalCitations(
        record.ledger,
        run.quoteCitations,
        turn,
        history.libraryID,
      );
    }
  }
  if (history.planSeen) record.planSeen = true;
  // Only a record this session never ran takes the history's outcome.
  if (record.runState === "idle") {
    const latest = history.runs[history.runs.length - 1];
    record.turnIndex = Math.max(record.turnIndex, history.latestTurn);
    if (latest && latest.turn === history.latestTurn) {
      record.runId = latest.runId;
    }
    if (history.settled) record.runState = history.settled;
    if (history.checklist && !record.checklist) {
      const steps = history.checklist.steps.map((step) => ({ ...step }));
      record.checklist = {
        ...history.checklist,
        title: "",
        steps,
        done: countDone(steps),
        total: steps.length,
        summary: "",
      };
      record.planSeen = true;
    }
  }
  record.hydrated = true;
  // Views repaint only when the history added something: a live run's row
  // must not churn because its conversation's history was folded in.
  if (hydrationSignature(record) === before) return false;
  changed(record);
  return true;
}

function hydrationSignature(record: TaskProgressRecord): string {
  return JSON.stringify([
    record.ledger.papers,
    record.planSeen,
    record.runState,
    record.runId,
    record.turnIndex,
    record.checklist,
  ]);
}

/** The 1-based question number of a user message in its conversation. */
export function taskTurnIndexFor(
  history: ReadonlyArray<{ role: string; compactMarker?: boolean }> | undefined,
  userMessage?: { role: string },
): number {
  if (!history?.length) return 0;
  let count = 0;
  for (const message of history) {
    if (message.role !== "user" || message.compactMarker) continue;
    count += 1;
    if (message === userMessage) return count;
  }
  return userMessage ? 0 : count;
}

/** Bumped by every clear; a rebuild started before a clear is dropped. */
const clearCounts = new Map<number, number>();
let clearAllCount = 0;

/** Changes whenever the conversation's record is cleared. */
export function getTaskProgressClearCount(conversationKey: number): number {
  return clearAllCount + (clearCounts.get(normalizeKey(conversationKey)) || 0);
}

export function clearTaskProgress(conversationKey: number): void {
  const key = normalizeKey(conversationKey);
  if (!key) return;
  clearCounts.set(key, (clearCounts.get(key) || 0) + 1);
  const record = records.get(key);
  if (!record) return;
  records.delete(key);
  record.version += 1;
  notify(key);
}

export function clearAllTaskProgress(): void {
  clearAllCount += 1;
  const keys = Array.from(records.keys());
  records.clear();
  for (const key of keys) notify(key);
}

/** Conversation keys kept, least recently written first (tests, diagnostics). */
export function listTaskProgressConversations(): number[] {
  return Array.from(records.keys());
}
