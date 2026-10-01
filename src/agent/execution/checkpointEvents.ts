import type { AgentEvent } from "../types";
import type {
  ExecutionCheckpoint,
  ExecutionCheckpointDelta,
  ExecutionCheckpointTask,
  ExecutionCheckpointTaskDelta,
  OutcomeException,
} from "./types";

/**
 * How a run's ledger travels and is stored: its first publication whole, and
 * each later change as a delta from the ledger the run published before.
 *
 * A long job's ledger holds its frozen scope and grows with every read, so
 * storing it whole on every change would grow as the scope times the reads.
 * A delta names only what changed: new outcomes whole (a frozen scope is
 * stored once, where it was declared), lists by the entries they gained, and
 * every other field by its new value. Folding a run's events in order gives
 * back each ledger exactly, which resuming after a restart relies on.
 *
 * A delta states the length of every list it extends, and folding refuses a
 * delta whose lists do not have those lengths, and every delta after it,
 * until the next whole ledger. The runtime publishes the whole ledger again
 * after a publication that failed, so a lost event costs nothing but the
 * deltas between it and that whole ledger, which then restores it exactly.
 */

type Task = ExecutionCheckpointTask;
type Fields = Record<string, unknown>;

export type ExecutionCheckpointEvent = Extract<
  AgentEvent,
  { type: "execution_checkpoint" | "execution_checkpoint_delta" }
>;

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => sameValue(entry, right[index]))
    );
  }
  if (
    !left ||
    !right ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return false;
  }
  const leftKeys = Object.keys(left).filter(
    (key) => (left as Fields)[key] !== undefined,
  );
  const rightKeys = Object.keys(right).filter(
    (key) => (right as Fields)[key] !== undefined,
  );
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) =>
      sameValue((left as Fields)[key], (right as Fields)[key]),
    )
  );
}

function extends_(
  before: readonly unknown[],
  after: readonly unknown[],
): boolean {
  return (
    after.length > before.length &&
    before.every((entry, index) => sameValue(entry, after[index]))
  );
}

function isException(value: unknown): value is OutcomeException {
  return Boolean(
    value &&
    typeof value === "object" &&
    Object.keys(value).every((key) => key === "targets" || key === "reason") &&
    Array.isArray((value as OutcomeException).targets),
  );
}

/** Exceptions that only gained targets or entries, or null. */
function grownExceptions(
  before: readonly unknown[],
  after: readonly unknown[],
): ExecutionCheckpointTaskDelta["exceptions"] | null {
  if (
    after.length < before.length ||
    !before.every(isException) ||
    !after.every(isException)
  ) {
    return null;
  }
  const grow: NonNullable<
    NonNullable<ExecutionCheckpointTaskDelta["exceptions"]>["grow"]
  >[number][] = [];
  for (const [at, entry] of before.entries()) {
    const next = after[at];
    if (next.reason !== entry.reason) return null;
    if (sameValue(entry.targets, next.targets)) continue;
    if (!extends_(entry.targets, next.targets)) return null;
    grow.push({
      at,
      from: entry.targets.length,
      add: next.targets.slice(entry.targets.length),
    });
  }
  const add = after.slice(before.length).map((entry, offset) => ({
    at: before.length + offset,
    targets: [...entry.targets],
    reason: entry.reason,
  }));
  return {
    ...(grow.length ? { grow } : {}),
    ...(add.length ? { add } : {}),
  };
}

function diffTask(
  before: Task,
  after: Task,
): ExecutionCheckpointTaskDelta | undefined {
  const was = before as unknown as Fields;
  const now = after as unknown as Fields;
  const set: Fields = {};
  const unset: string[] = [];
  const grow: Record<string, { from: number; add: unknown[] }> = {};
  let exceptions: ExecutionCheckpointTaskDelta["exceptions"];
  for (const key of new Set([...Object.keys(was), ...Object.keys(now)])) {
    const previous = was[key];
    const next = now[key];
    if (next === undefined) {
      if (previous !== undefined) unset.push(key);
      continue;
    }
    if (sameValue(previous, next)) continue;
    if (Array.isArray(previous) && Array.isArray(next)) {
      if (key === "exceptions") {
        const grown = grownExceptions(previous, next);
        if (grown) {
          exceptions = grown;
          continue;
        }
      } else if (extends_(previous, next)) {
        grow[key] = { from: previous.length, add: next.slice(previous.length) };
        continue;
      }
    }
    set[key] = next;
  }
  if (
    !unset.length &&
    !Object.keys(set).length &&
    !Object.keys(grow).length &&
    !exceptions
  ) {
    return undefined;
  }
  return {
    taskId: after.taskId,
    ...(Object.keys(set).length ? { set: set as Partial<Task> } : {}),
    ...(unset.length ? { unset } : {}),
    ...(Object.keys(grow).length ? { grow } : {}),
    ...(exceptions ? { exceptions } : {}),
  };
}

/**
 * What changed from one ledger to the next, or null when a delta cannot say
 * it (another execution, an outcome removed or moved, an ending undone).
 */
export function diffExecutionCheckpoint(
  previous: ExecutionCheckpoint,
  next: ExecutionCheckpoint,
): ExecutionCheckpointDelta | null {
  const was = previous as unknown as Fields;
  const now = next as unknown as Fields;
  for (const key of new Set([...Object.keys(was), ...Object.keys(now)])) {
    if (key === "tasks" || key === "updatedAt" || key === "end") continue;
    if (!sameValue(was[key], now[key])) return null;
  }
  if (previous.end && !sameValue(previous.end, next.end)) return null;
  if (
    previous.tasks.length > next.tasks.length ||
    previous.tasks.some(
      (task, index) => task.taskId !== next.tasks[index].taskId,
    )
  ) {
    return null;
  }
  const tasks: ExecutionCheckpointTaskDelta[] = [];
  next.tasks.forEach((task, index) => {
    const before = previous.tasks[index];
    if (!before) {
      tasks.push({ taskId: task.taskId, task });
      return;
    }
    const change = diffTask(before, task);
    if (change) tasks.push(change);
  });
  return {
    executionId: next.executionId,
    updatedAt: next.updatedAt,
    tasks,
    ...(next.end && !previous.end ? { end: next.end } : {}),
  };
}

function applyTaskDelta(
  task: Task,
  change: ExecutionCheckpointTaskDelta,
): Task | null {
  const next: Fields = { ...(task as unknown as Fields) };
  for (const key of change.unset || []) delete next[key];
  Object.assign(next, change.set || {});
  for (const [key, list] of Object.entries(change.grow || {})) {
    const current = next[key];
    if (!Array.isArray(current) || current.length !== list.from) return null;
    next[key] = [...current, ...list.add];
  }
  if (change.exceptions) {
    const entries = [...((next.exceptions as OutcomeException[]) || [])];
    for (const grown of change.exceptions.grow || []) {
      const entry = entries[grown.at];
      if (!entry || entry.targets.length !== grown.from) return null;
      entries[grown.at] = {
        ...entry,
        targets: [...entry.targets, ...grown.add],
      };
    }
    for (const added of change.exceptions.add || []) {
      if (added.at !== entries.length) return null;
      entries.push({ targets: [...added.targets], reason: added.reason });
    }
    next.exceptions = entries;
  }
  return next as unknown as Task;
}

/** The ledger a delta makes of the one before it, or null if it does not fit. */
export function applyExecutionCheckpointDelta(
  checkpoint: ExecutionCheckpoint,
  delta: ExecutionCheckpointDelta,
): ExecutionCheckpoint | null {
  if (delta.executionId !== checkpoint.executionId) return null;
  const tasks = [...checkpoint.tasks];
  for (const change of delta.tasks) {
    const index = tasks.findIndex((task) => task.taskId === change.taskId);
    if (change.task) {
      if (index >= 0) return null;
      tasks.push(change.task);
      continue;
    }
    if (index < 0) return null;
    const next = applyTaskDelta(tasks[index], change);
    if (!next) return null;
    tasks[index] = next;
  }
  return {
    ...checkpoint,
    tasks,
    updatedAt: delta.updatedAt,
    ...(delta.end ? { end: delta.end } : {}),
  };
}

/** The event that publishes `next` after `published`, the run's last one. */
export function executionCheckpointEvent(
  published: ExecutionCheckpoint | undefined,
  next: ExecutionCheckpoint,
): ExecutionCheckpointEvent {
  const delta = published ? diffExecutionCheckpoint(published, next) : null;
  return delta
    ? { type: "execution_checkpoint_delta", delta }
    : { type: "execution_checkpoint", checkpoint: next };
}

/**
 * A run's ledger as its events arrive. A delta that does not fit is refused
 * with every delta after it, until a whole ledger arrives.
 */
export class ExecutionCheckpointFold {
  private checkpoint: ExecutionCheckpoint | undefined;
  private broken = false;

  apply(event: AgentEvent): ExecutionCheckpoint | undefined {
    if (event.type === "execution_checkpoint") {
      this.checkpoint = event.checkpoint;
      this.broken = false;
    } else if (event.type === "execution_checkpoint_delta") {
      const next =
        this.checkpoint && !this.broken
          ? applyExecutionCheckpointDelta(this.checkpoint, event.delta)
          : null;
      if (next) this.checkpoint = next;
      else this.broken = true;
    }
    return this.broken ? undefined : this.checkpoint;
  }

  /** The last ledger the events proved, whatever came after it. */
  get latest(): ExecutionCheckpoint | undefined {
    return this.checkpoint;
  }
}
