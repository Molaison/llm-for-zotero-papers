import type {
  AgentActionCapability,
  AgentActionProposal,
  AgentActionReceipt,
} from "../contracts/types";
import { operationLabel } from "../contracts/operationCatalog";
import type { MaterialRef } from "../documents/materialRef";
import {
  materialRefKey,
  ordinaryExecutionTaskId,
} from "../execution/checkpoint";
import type {
  ExecutionCheckpoint,
  ExecutionCheckpointTask,
  OutcomeEffect,
  OutcomeException,
  RunEndState,
} from "../execution/types";
import type { RunStopRule } from "./stopRules";

/**
 * The outcome ledger of an ordinary Original Agent turn.
 *
 * The model declares the parts of a compound request and may mark one
 * skipped, blocked or cancelled with a reason; only host evidence completes
 * one. Every function returns a new checkpoint, or the same one when nothing
 * changed, and never mutates its input.
 *
 * How deep a read must go. A read part that names papers (its targets, or
 * every paper of the turn's scope) asks for each paper's text: a paper is
 * done when a read returned its text (passages, sections, pages, figures,
 * the full text, or an overview of it, sampled or complete). An abstract, an
 * outline or a metadata row does not tick it. A paper the host reports has
 * no readable text becomes an exception, so the part can still complete with
 * the rest read. A read part that names no papers completes on any read, an
 * abstract included.
 */

export type OutcomeDeclaration = {
  taskId: string;
  description: string;
  effect: OutcomeEffect;
  capability?: AgentActionCapability;
  targets?: readonly string[];
  /** The targets are every paper of the turn's scope, frozen now. */
  scope?: boolean;
};

export type OutcomeModelMark = {
  taskId: string;
  status: "skipped" | "blocked" | "cancelled";
  reason: string;
};

export type OutcomeEvidence =
  | {
      kind: "read";
      /** Papers whose text the read returned. */
      targets: readonly string[];
      /** Papers it read no deeper than an abstract or an outline. */
      shallow?: readonly string[];
      /** Papers the host reported have no readable text. */
      noText?: readonly string[];
      observationIds: readonly string[];
    }
  | { kind: "receipt"; receipt: AgentActionReceipt }
  | { kind: "material"; materialRef: MaterialRef }
  | {
      kind: "declined";
      /** The declined tool call, which identifies the decline. */
      callId: string;
      proposals: readonly Pick<
        AgentActionProposal,
        "capability" | "operation" | "requestedTargets"
      >[];
      /**
       * The user approved the call without these targets: rows it left
       * untouched in the review card. Only a part that names them records it.
       */
      narrowed?: true;
    }
  | { kind: "answer" };

/** Every reason the host writes into the ledger, for the UI to translate. */
export const OUTCOME_REASONS = Object.freeze({
  markReasonRequired: "A skipped, blocked, or cancelled task needs the reason.",
  unverified:
    "The change could not be verified; check the current state before retrying.",
  declined: "You declined this change.",
  notApplied: "Not applied",
  notDone: "Not done before the answer.",
  writeFailed: "The change was not applied.",
  noText: "No readable text",
});

type Task = ExecutionCheckpointTask;
type Write = Pick<AgentActionProposal, "capability" | "requestedTargets">;
type EvidenceResult = { checkpoint: ExecutionCheckpoint; changed: boolean };

const OUTCOME_EFFECTS: ReadonlySet<string> = new Set<OutcomeEffect>([
  "read",
  "artifact",
  "mutation",
  "answer",
]);
const MARK_STATUSES: ReadonlySet<string> = new Set([
  "skipped",
  "blocked",
  "cancelled",
]);
const MARKABLE_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "in_progress",
  "blocked",
]);
const RECEIPT_CANDIDATE_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "blocked",
]);
const DECLINE_CANDIDATE_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "in_progress",
]);
const PROOF_VERIFICATIONS: ReadonlySet<string> = new Set([
  "verified",
  "execution_only",
]);
const DONE_RECEIPT_STATUSES: ReadonlySet<string> = new Set([
  "applied",
  "already_satisfied",
  "partial",
  "observed",
]);
const NOTE_CONTENT_OPERATIONS: ReadonlySet<string> = new Set([
  "note_create",
  "note_edit",
  "note_append",
]);
const INTERRUPTING_STOP_RULES: ReadonlySet<RunStopRule> = new Set<RunStopRule>([
  "interrupted_by_error",
  "stream_interrupted_again",
  "incomplete_step_limit",
  "segment_without_progress",
  "repeated_tool_errors",
]);
const LOCAL_TASK_ID_LENGTH = 128;

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function union(
  base: readonly string[] | undefined,
  added: readonly string[],
): string[] {
  return unique([...(base || []), ...added]);
}

/** A bare Zotero id, as models write one. */
const BARE_ID = /^[1-9]\d*$/;

/** The kinds of target the host's receipts and reads name: `item:5`, … */
const TARGET_KINDS: ReadonlySet<string> = new Set([
  "item",
  "collection",
  "saved-search",
  "attachment",
  "note",
  "file",
  "search",
  "setting",
  "tag",
  "tags",
]);

/**
 * A part's targets in the forms receipts and reads name. A bare id is an
 * item's (`item:<id>`), except under zotero.collections, whose writes name
 * items (filing papers) and folders (renaming one) alike: there it stays
 * bare and matches whichever of the two a receipt names (`resolveTarget`).
 * A target that is no such form, such as "new collection" or a DOI, names
 * nothing a receipt can carry, so it is left out, and a part left with none
 * tracks its capability's writes, as a part without targets does.
 */
function outcomeTargets(
  values: readonly string[] | undefined,
  capability?: AgentActionCapability,
): string[] {
  return unique(
    (values || [])
      .map((value) => String(value).trim())
      .filter(Boolean)
      .flatMap((value) => {
        if (BARE_ID.test(value))
          return [
            capability === "zotero.collections" ? value : `item:${value}`,
          ];
        const kind = /^([a-z][a-z-]*):\S/.exec(value)?.[1];
        return kind && TARGET_KINDS.has(kind) ? [value] : [];
      }),
  );
}

/**
 * The target among `named` that a part's declared target means: itself, or,
 * for a bare id, the one target named with that id. A bare id two targets
 * share (item 5 and folder 5) means neither.
 */
function resolveTarget(
  declared: string,
  named: readonly string[],
): string | undefined {
  if (named.includes(declared)) return declared;
  if (!BARE_ID.test(declared)) return undefined;
  const matches = named.filter(
    (target) => target.slice(target.indexOf(":") + 1) === declared,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function covers(task: Task, targets: readonly string[]): boolean {
  return (
    !task.targets?.length ||
    task.targets.some((target) => resolveTarget(target, targets) !== undefined)
  );
}

function acceptsWrite(task: Task, write: Write): boolean {
  return (
    task.effect === "mutation" &&
    (!task.capability || task.capability === write.capability) &&
    covers(task, write.requestedTargets)
  );
}

/** A verified note body: written content the host can point to. */
function isNoteContent(receipt: AgentActionReceipt): boolean {
  return (
    receipt.capability === "zotero.notes" &&
    NOTE_CONTENT_OPERATIONS.has(receipt.operation) &&
    receipt.verification === "verified" &&
    DONE_RECEIPT_STATUSES.has(receipt.status)
  );
}

/** A read is not a write, so it neither closes a mutation nor becomes one. */
function isWrite(write: Pick<Write, "capability">): boolean {
  return write.capability !== "zotero.read";
}

/** Whether a receipt or a declined call is already bound to some outcome. */
function isBound(checkpoint: ExecutionCheckpoint, identity: string): boolean {
  return checkpoint.tasks.some(
    (task) =>
      task.receiptIds?.includes(identity) ||
      task.verifiedReceiptIds.includes(identity),
  );
}

function newTask(taskId: string, description: string, now: number): Task {
  return {
    taskId,
    description,
    dependencies: [],
    status: "pending",
    journalActionIds: [],
    verifiedReceiptIds: [],
    readEvidenceIds: [],
    materialRefs: [],
    createdAt: now,
    updatedAt: now,
  };
}

/** The first namespaced id among `local(1)`, `local(2)`, … no task uses. */
function freeTaskId(
  checkpoint: ExecutionCheckpoint,
  local: (attempt: number) => string,
): string {
  const taken = new Set(checkpoint.tasks.map((task) => task.taskId));
  for (let attempt = 1; ; attempt += 1) {
    const taskId = ordinaryExecutionTaskId(
      checkpoint.executionId,
      local(attempt),
    );
    if (!taken.has(taskId)) return taskId;
  }
}

/** `host:<receipt id>` within the task-id alphabet and length. */
function hostReceiptTaskId(
  checkpoint: ExecutionCheckpoint,
  receiptId: string,
): string {
  const base = `host:${receiptId}`.replace(/[^A-Za-z0-9._-]/g, "-");
  return freeTaskId(checkpoint, (attempt) => {
    const suffix = attempt === 1 ? "" : `-${attempt}`;
    return `${base.slice(0, LOCAL_TASK_ID_LENGTH - suffix.length)}${suffix}`;
  });
}

function unchanged(checkpoint: ExecutionCheckpoint): EvidenceResult {
  return { checkpoint, changed: false };
}

/** Replace each task `update` returns a new version of. */
function mapTasks(
  checkpoint: ExecutionCheckpoint,
  now: number,
  update: (task: Task, index: number) => Task | undefined,
): EvidenceResult {
  let changed = false;
  const tasks = checkpoint.tasks.map((task, index) => {
    const next = update(task, index);
    if (!next) return task;
    changed = true;
    return next;
  });
  if (!changed) return unchanged(checkpoint);
  return { checkpoint: { ...checkpoint, tasks, updatedAt: now }, changed };
}

function appended(
  checkpoint: ExecutionCheckpoint,
  task: Task,
  now: number,
): EvidenceResult {
  return {
    checkpoint: {
      ...checkpoint,
      tasks: [...checkpoint.tasks, task],
      updatedAt: now,
    },
    changed: true,
  };
}

function withException(
  exceptions: readonly OutcomeException[],
  targets: readonly string[],
  reason: string,
): readonly OutcomeException[] {
  if (!targets.length) return exceptions;
  const index = exceptions.findIndex((entry) => entry.reason === reason);
  if (index < 0) return [...exceptions, { targets, reason }];
  return exceptions.map((entry, at) =>
    at === index ? { targets: union(entry.targets, targets), reason } : entry,
  );
}

function completed(task: Task): Task {
  const { reason, ...rest } = task;
  return { ...rest, status: "completed" };
}

/*
 * Batches. A write that names several papers is accounted paper by paper:
 * the papers a failed batch did not change, the papers of a declined batch,
 * and the rows the user left untouched in a card it approved become
 * exceptions with the reason, and the part stays open for the next batch. A
 * write that names one paper keeps the single-write rules: a failure leaves
 * its part open with the reason, and a decline blocks it. A later success
 * clears a paper's exception, even after its part settled.
 */

/** A write that names several papers. */
function isBatch(targets: readonly string[]): boolean {
  return unique(targets).length > 1;
}

/** Except `targets` with `reason`; a paper already excepted keeps its first reason. */
function exceptTargets(
  exceptions: readonly OutcomeException[],
  targets: readonly string[],
  reason: string,
): readonly OutcomeException[] {
  const excepted = new Set(exceptions.flatMap((entry) => entry.targets));
  return withException(
    exceptions,
    targets.filter((target) => !excepted.has(target)),
    reason,
  );
}

/** The exceptions without the papers since done. */
function withoutDone(
  exceptions: readonly OutcomeException[],
  done: readonly string[],
): readonly OutcomeException[] {
  return exceptions.flatMap((entry) => {
    const left = entry.targets.filter((target) => !done.includes(target));
    return left.length ? [{ ...entry, targets: left }] : [];
  });
}

/** The papers a failed batch named and did not change. */
function failedBatchTargets(receipt: AgentActionReceipt): string[] {
  if (receipt.status !== "failed" || !isBatch(receipt.requestedTargets)) {
    return [];
  }
  const settled = new Set([
    ...receipt.appliedTargets,
    ...receipt.alreadySatisfiedTargets,
    ...receipt.rejectedTargets,
  ]);
  return unique(receipt.requestedTargets).filter(
    (target) => !settled.has(target),
  );
}

/**
 * A part that names papers, once each is done or excepted: completed when
 * any is done; with none done, blocked when the user declined one, as a
 * declined write is, and otherwise skipped with the first reason.
 */
function settleTargets(task: Task): Task {
  const targets = task.targets || [];
  const done = new Set(task.doneTargets || []);
  const exceptions = task.exceptions || [];
  const accounted = new Set([
    ...done,
    ...exceptions.flatMap((entry) => entry.targets),
  ]);
  if (!targets.length || !targets.every((target) => accounted.has(target))) {
    return task;
  }
  if (targets.some((target) => done.has(target))) return completed(task);
  return exceptions.some((entry) => entry.reason === OUTCOME_REASONS.declined)
    ? { ...task, status: "blocked", reason: OUTCOME_REASONS.declined }
    : { ...task, status: "skipped", reason: exceptions[0].reason };
}

/** A settled part takes a receipt that proves one of its excepted papers done. */
function clearsException(task: Task, receipt: AgentActionReceipt): boolean {
  if (task.status !== "completed" && task.status !== "skipped") return false;
  if (
    !PROOF_VERIFICATIONS.has(receipt.verification) ||
    !DONE_RECEIPT_STATUSES.has(receipt.status)
  ) {
    return false;
  }
  const proven = [
    ...receipt.appliedTargets,
    ...receipt.alreadySatisfiedTargets,
  ];
  return (task.exceptions || []).some((entry) =>
    entry.targets.some((target) => resolveTarget(target, proven) !== undefined),
  );
}

/**
 * A declined batch, or rows left untouched in an approved card: each open
 * part that names those papers excepts them. Undefined for a declined
 * one-paper write, or a declined batch no part names, which the single-write
 * rule handles; rows no part names record nothing.
 */
function declineBatch(
  checkpoint: ExecutionCheckpoint,
  evidence: Extract<OutcomeEvidence, { kind: "declined" }>,
  writes: readonly Write[],
  identity: string,
  now: number,
): EvidenceResult | undefined {
  const declined = unique(writes.flatMap((write) => write.requestedTargets));
  if (!evidence.narrowed && !isBatch(declined)) return undefined;
  const chosen = new Set(
    checkpoint.tasks.flatMap((task, index) =>
      task.targets?.length &&
      DECLINE_CANDIDATE_STATUSES.has(task.status) &&
      writes.some((write) => acceptsWrite(task, write))
        ? [index]
        : [],
    ),
  );
  if (!chosen.size)
    return evidence.narrowed ? unchanged(checkpoint) : undefined;
  return mapTasks(checkpoint, now, (task, index) => {
    if (!chosen.has(index)) return undefined;
    const done = new Set(task.doneTargets || []);
    // The part's own papers the call named, in the part's own form.
    const exceptions = exceptTargets(
      task.exceptions || [],
      task.targets!.filter(
        (target) =>
          resolveTarget(target, declined) !== undefined && !done.has(target),
      ),
      OUTCOME_REASONS.declined,
    );
    return settleTargets({
      ...task,
      receiptIds: union(task.receiptIds, [identity]),
      ...(exceptions.length ? { exceptions } : {}),
      updatedAt: now,
    });
  });
}

function bindReceipt(
  task: Task,
  receipt: AgentActionReceipt,
  now: number,
): Task {
  const targets = task.targets || [];
  // The part's own targets a receipt's list names, in the part's own form.
  const own = (values: readonly string[]): string[] =>
    unique(
      targets.length
        ? targets.filter(
            (target) => resolveTarget(target, values) !== undefined,
          )
        : values,
    );
  const proves =
    PROOF_VERIFICATIONS.has(receipt.verification) &&
    DONE_RECEIPT_STATUSES.has(receipt.status);
  const doneTargets = union(
    task.doneTargets,
    proves
      ? own([...receipt.appliedTargets, ...receipt.alreadySatisfiedTargets])
      : [],
  );
  const exceptions = exceptTargets(
    exceptTargets(
      withoutDone(task.exceptions || [], doneTargets),
      own(receipt.rejectedTargets),
      receipt.reasons[0]?.trim() || OUTCOME_REASONS.notApplied,
    ),
    own(failedBatchTargets(receipt)),
    receipt.reasons[0]?.trim() || OUTCOME_REASONS.writeFailed,
  );
  const { exceptions: _previous, ...rest } = task;
  const bound: Task = {
    ...rest,
    verifiedReceiptIds:
      proves && receipt.verification === "verified"
        ? union(task.verifiedReceiptIds, [receipt.id])
        : task.verifiedReceiptIds,
    receiptIds: union(task.receiptIds, [receipt.id]),
    ...(doneTargets.length ? { doneTargets } : {}),
    ...(exceptions.length ? { exceptions } : {}),
    updatedAt: now,
  };
  if (receipt.status === "unverified") {
    return { ...bound, status: "blocked", reason: OUTCOME_REASONS.unverified };
  }
  const settled = settleTargets(bound);
  if (settled !== bound) return settled;
  if (!targets.length && proves) return completed(bound);
  if (
    (receipt.status === "failed" || receipt.status === "cancelled") &&
    !isBatch(receipt.requestedTargets)
  ) {
    return {
      ...bound,
      reason: receipt.reasons[0]?.trim() || OUTCOME_REASONS.writeFailed,
    };
  }
  return bound;
}

/** A read part that names no papers: any read completes it. */
function readAnyInto(
  task: Task,
  read: readonly string[],
  observationIds: readonly string[],
  now: number,
): Task {
  const doneTargets = union(task.doneTargets, read);
  return {
    ...task,
    status: "completed",
    readEvidenceIds: union(task.readEvidenceIds, observationIds),
    ...(doneTargets.length ? { doneTargets } : {}),
    updatedAt: now,
  };
}

/**
 * A read part that names papers takes only its own, at the depth the module
 * doc sets: a paper whose text was read is done, a paper the host found no
 * text for is excepted, and the part settles once every paper is one or the
 * other.
 */
function readTargetsInto(
  task: Task,
  read: readonly string[],
  noText: readonly string[],
  observationIds: readonly string[],
  now: number,
): Task | undefined {
  const targets = task.targets || [];
  const own = (values: readonly string[]) =>
    values.filter((value) => targets.includes(value));
  if (!own(read).length && !own(noText).length) return undefined;
  const doneTargets = union(task.doneTargets, own(read));
  const done = new Set(doneTargets);
  // A paper read after the host found no text for it is done, not excepted.
  const kept = (task.exceptions || []).flatMap((entry) => {
    const left = entry.targets.filter((target) => !done.has(target));
    return left.length ? [{ ...entry, targets: left }] : [];
  });
  const exceptions = withException(
    kept,
    own(noText).filter((target) => !done.has(target)),
    OUTCOME_REASONS.noText,
  );
  const readEvidenceIds = union(task.readEvidenceIds, observationIds);
  if (
    doneTargets.length === (task.doneTargets?.length || 0) &&
    readEvidenceIds.length === task.readEvidenceIds.length &&
    JSON.stringify(exceptions) === JSON.stringify(task.exceptions || [])
  ) {
    return undefined;
  }
  const { exceptions: _previous, ...rest } = task;
  const next: Task = {
    ...rest,
    readEvidenceIds,
    ...(doneTargets.length ? { doneTargets } : {}),
    ...(exceptions.length ? { exceptions } : {}),
    updatedAt: now,
  };
  const accounted = new Set([
    ...doneTargets,
    ...exceptions.flatMap((entry) => entry.targets),
  ]);
  if (!targets.every((target) => accounted.has(target))) return next;
  return doneTargets.length
    ? completed(next)
    : { ...next, status: "skipped", reason: exceptions[0].reason };
}

function applyRead(
  checkpoint: ExecutionCheckpoint,
  evidence: Extract<OutcomeEvidence, { kind: "read" }>,
  now: number,
): EvidenceResult {
  const read = unique(evidence.targets);
  const shallow = unique(evidence.shallow || []);
  const noText = unique(evidence.noText || []);
  const observationIds = unique(evidence.observationIds);
  const anyRead = unique([...read, ...shallow]);
  const bound = new Set(
    checkpoint.tasks.flatMap((task) => task.readEvidenceIds),
  );
  const replayed =
    observationIds.length > 0 && observationIds.every((id) => bound.has(id));
  return mapTasks(checkpoint, now, (task) => {
    if (task.status !== "pending" || task.effect !== "read") return undefined;
    // A read reaches each part that names its papers, once: one another part
    // already holds still ticks a part declared after it (a back-fill, or a
    // re-read the cache answered).
    if (task.targets?.length) {
      return readTargetsInto(task, read, noText, observationIds, now);
    }
    // A part that names no papers completes on a new read only, and finding
    // that a paper has no text reads nothing.
    if (replayed) return undefined;
    return anyRead.length || observationIds.length
      ? readAnyInto(task, anyRead, observationIds, now)
      : undefined;
  });
}

/**
 * The writes one receipt proves, each as the parts see it: the receipt
 * itself, and for an import that files its items in a folder, that
 * membership too: a zotero.collections write over the folder and the items,
 * under the same receipt. The import's postcondition checked that every
 * imported item is in the folder, so a receipt that proves the import
 * proves the membership. The membership goes only to a part that asks for
 * folder writes or names the folder or the items.
 */
function provenWrites(receipt: AgentActionReceipt): AgentActionReceipt[] {
  const folder = receipt.normalizedParameters?.destinationCollectionId;
  if (
    receipt.capability !== "zotero.import" ||
    !Number.isInteger(folder) ||
    Number(folder) <= 0
  )
    return [receipt];
  const membership = `collection:${folder}`;
  const add = (targets: readonly string[]) =>
    targets.length ? unique([membership, ...targets]) : [];
  return [
    receipt,
    {
      ...receipt,
      capability: "zotero.collections",
      requestedTargets: unique([membership, ...receipt.requestedTargets]),
      appliedTargets: add(receipt.appliedTargets),
      alreadySatisfiedTargets: receipt.appliedTargets.length
        ? receipt.alreadySatisfiedTargets
        : add(receipt.alreadySatisfiedTargets),
    },
  ];
}

function applyReceipt(
  checkpoint: ExecutionCheckpoint,
  receipt: AgentActionReceipt,
  now: number,
): EvidenceResult {
  if (!isWrite(receipt) || isBound(checkpoint, receipt.id)) {
    return unchanged(checkpoint);
  }
  // Each write the receipt proves binds every part that names its targets,
  // else the first part without targets that takes it.
  const chosen = new Map<number, AgentActionReceipt>();
  for (const write of provenWrites(receipt)) {
    const membership = write !== receipt;
    const candidates = checkpoint.tasks.flatMap((task, index) =>
      !chosen.has(index) &&
      (RECEIPT_CANDIDATE_STATUSES.has(task.status) ||
        clearsException(task, write)) &&
      acceptsWrite(task, write) &&
      (!membership ||
        task.capability === "zotero.collections" ||
        Boolean(task.targets?.length))
        ? [index]
        : [],
    );
    const targeted = candidates.filter(
      (index) => checkpoint.tasks[index].targets?.length,
    );
    for (const index of targeted.length ? targeted : candidates.slice(0, 1))
      chosen.set(index, write);
  }
  if (chosen.size) {
    return mapTasks(checkpoint, now, (task, index) => {
      const write = chosen.get(index);
      return write ? bindReceipt(task, write, now) : undefined;
    });
  }
  // Written content saved as a note is the artifact a part asked for.
  const artifact = isNoteContent(receipt)
    ? checkpoint.tasks.findIndex(
        (task) => task.status === "pending" && task.effect === "artifact",
      )
    : -1;
  if (artifact >= 0) {
    return mapTasks(checkpoint, now, (task, index) =>
      index === artifact ? bindReceipt(task, receipt, now) : undefined,
    );
  }
  const targets = unique(receipt.requestedTargets);
  const host: Task = {
    ...newTask(
      hostReceiptTaskId(checkpoint, receipt.id),
      operationLabel(receipt.operation),
      now,
    ),
    effect: "mutation",
    origin: "host",
    capability: receipt.capability,
    operation: receipt.operation,
    ...(targets.length ? { targets } : {}),
  };
  return appended(checkpoint, bindReceipt(host, receipt, now), now);
}

function applyMaterial(
  checkpoint: ExecutionCheckpoint,
  materialRef: MaterialRef,
  now: number,
): EvidenceResult {
  const key = materialRefKey(materialRef);
  const bound = checkpoint.tasks.some((task) =>
    task.materialRefs.some((reference) => materialRefKey(reference) === key),
  );
  if (bound) return unchanged(checkpoint);
  const chosen = checkpoint.tasks.findIndex(
    (task) => task.status === "pending" && task.effect === "artifact",
  );
  const { documentId, documentVersion, contentHash } = materialRef;
  return mapTasks(checkpoint, now, (task, index) =>
    index === chosen
      ? {
          ...task,
          status: "completed",
          materialRefs: [
            ...task.materialRefs,
            { documentId, documentVersion, contentHash },
          ],
          updatedAt: now,
        }
      : undefined,
  );
}

function applyDeclined(
  checkpoint: ExecutionCheckpoint,
  evidence: Extract<OutcomeEvidence, { kind: "declined" }>,
  now: number,
): EvidenceResult {
  const writes = evidence.proposals.filter(isWrite);
  const identity = `declined:${evidence.callId}`;
  if (!writes.length || isBound(checkpoint, identity)) {
    return unchanged(checkpoint);
  }
  const batch = declineBatch(checkpoint, evidence, writes, identity, now);
  if (batch) return batch;
  const chosen = checkpoint.tasks.findIndex(
    (task) =>
      DECLINE_CANDIDATE_STATUSES.has(task.status) &&
      writes.some((write) => acceptsWrite(task, write)),
  );
  if (chosen >= 0) {
    return mapTasks(checkpoint, now, (task, index) =>
      index === chosen
        ? {
            ...task,
            status: "blocked",
            reason: OUTCOME_REASONS.declined,
            receiptIds: union(task.receiptIds, [identity]),
            updatedAt: now,
          }
        : undefined,
    );
  }
  const [first] = writes;
  const targets = unique(writes.flatMap((write) => write.requestedTargets));
  return appended(
    checkpoint,
    {
      ...newTask(
        freeTaskId(checkpoint, (attempt) => `host-declined-${attempt}`),
        operationLabel(first.operation),
        now,
      ),
      status: "blocked",
      effect: "mutation",
      origin: "host",
      capability: first.capability,
      operation: first.operation,
      ...(targets.length ? { targets } : {}),
      receiptIds: [identity],
      reason: OUTCOME_REASONS.declined,
    },
    now,
  );
}

function applyAnswer(
  checkpoint: ExecutionCheckpoint,
  now: number,
): EvidenceResult {
  // Content written in the accepted answer is the artifact a part asked for.
  return mapTasks(checkpoint, now, (task) =>
    task.status === "pending" &&
    (!task.effect || task.effect === "answer" || task.effect === "artifact")
      ? { ...task, status: "completed", updatedAt: now }
      : undefined,
  );
}

function hasEvidence(task: Task): boolean {
  return [
    task.journalActionIds,
    task.verifiedReceiptIds,
    task.readEvidenceIds,
    task.materialRefs,
    task.receiptIds || [],
    task.doneTargets || [],
    task.exceptions || [],
  ].some((entries) => entries.length > 0);
}

/** Add declared parts as pending model outcomes; a repeat is a no-op. */
export function declareOutcomes(
  checkpoint: ExecutionCheckpoint,
  declarations: readonly OutcomeDeclaration[],
  now: number,
): ExecutionCheckpoint {
  const existing = new Map(checkpoint.tasks.map((task) => [task.taskId, task]));
  const seen = new Set<string>();
  const created: Task[] = [];
  for (const declaration of declarations) {
    const taskId = ordinaryExecutionTaskId(
      checkpoint.executionId,
      declaration.taskId,
    );
    if (seen.has(taskId)) {
      throw new Error(`Task ${taskId} may appear only once in one update`);
    }
    seen.add(taskId);
    const description =
      typeof declaration.description === "string"
        ? declaration.description.trim()
        : "";
    if (!description) {
      throw new Error(`New task ${taskId} requires a description`);
    }
    const prior = existing.get(taskId);
    if (prior) {
      if (prior.description !== description) {
        throw new Error(`Existing task ${taskId} has immutable presentation`);
      }
      continue;
    }
    if (!OUTCOME_EFFECTS.has(declaration.effect)) {
      throw new Error(
        `New task ${taskId} requires an effect: read, artifact, mutation, or answer`,
      );
    }
    const targets = outcomeTargets(declaration.targets, declaration.capability);
    // A part that names a write capability is a write, whatever effect it
    // claims: models declare "save it as a note" as an artifact too.
    const effect =
      declaration.capability && isWrite({ capability: declaration.capability })
        ? "mutation"
        : declaration.effect;
    created.push({
      ...newTask(taskId, description, now),
      effect,
      origin: "model",
      ...(declaration.capability ? { capability: declaration.capability } : {}),
      ...(targets.length ? { targets } : {}),
      ...(declaration.scope && targets.length ? { scope: true as const } : {}),
    });
  }
  if (!created.length) return checkpoint;
  return {
    ...checkpoint,
    tasks: [...checkpoint.tasks, ...created],
    updatedAt: now,
  };
}

/**
 * Whether `next` declares a read part over named papers that `previous` did
 * not have: such a part takes the reads its turn already made (a back-fill).
 */
export function declaresReadPart(
  previous: ExecutionCheckpoint,
  next: ExecutionCheckpoint,
): boolean {
  const known = new Set(previous.tasks.map((task) => task.taskId));
  return next.tasks.some(
    (task) =>
      !known.has(task.taskId) &&
      task.effect === "read" &&
      Boolean(task.targets?.length),
  );
}

/** Apply skipped, blocked or cancelled marks; `ignored` lists refused ones. */
export function markOutcomes(
  checkpoint: ExecutionCheckpoint,
  marks: readonly OutcomeModelMark[],
  now: number,
): { checkpoint: ExecutionCheckpoint; ignored: string[] } {
  const indexById = new Map(
    checkpoint.tasks.map((task, index) => [task.taskId, index]),
  );
  const tasks = [...checkpoint.tasks];
  const seen = new Set<string>();
  const ignored: string[] = [];
  let changed = false;
  for (const mark of marks) {
    const taskId = ordinaryExecutionTaskId(checkpoint.executionId, mark.taskId);
    if (seen.has(taskId)) {
      throw new Error(`Task ${taskId} may appear only once in one update`);
    }
    seen.add(taskId);
    const index = indexById.get(taskId);
    if (index === undefined) throw new Error(`Unknown task ${taskId}`);
    if (!MARK_STATUSES.has(mark.status)) {
      ignored.push(taskId);
      continue;
    }
    const reason = typeof mark.reason === "string" ? mark.reason.trim() : "";
    if (!reason) throw new Error(OUTCOME_REASONS.markReasonRequired);
    if (!MARKABLE_STATUSES.has(tasks[index].status)) {
      ignored.push(taskId);
      continue;
    }
    tasks[index] = {
      ...tasks[index],
      status: mark.status,
      reason,
      updatedAt: now,
    };
    changed = true;
  }
  return {
    checkpoint: changed ? { ...checkpoint, tasks, updatedAt: now } : checkpoint,
    ignored,
  };
}

/** Bind one piece of host evidence; applying it again changes nothing. */
export function applyOutcomeEvidence(
  checkpoint: ExecutionCheckpoint,
  evidence: OutcomeEvidence,
  now: number,
): EvidenceResult {
  switch (evidence.kind) {
    case "read":
      return applyRead(checkpoint, evidence, now);
    case "receipt":
      return applyReceipt(checkpoint, evidence.receipt, now);
    case "material":
      return applyMaterial(checkpoint, evidence.materialRef, now);
    case "declined":
      return applyDeclined(checkpoint, evidence, now);
    case "answer":
      return applyAnswer(checkpoint, now);
  }
}

/** The model's declared outcomes that still need work beyond the answer. */
export function openDeclaredOutcomes(
  checkpoint: ExecutionCheckpoint | undefined,
): ExecutionCheckpointTask[] {
  return (checkpoint?.tasks || []).filter(
    (task) =>
      task.origin === "model" &&
      task.effect !== undefined &&
      task.effect !== "answer" &&
      task.status === "pending",
  );
}

/** Outcome progress as a string that moves only with evidence or a mark. */
export function outcomeProgressSignature(
  checkpoint: ExecutionCheckpoint | undefined,
): string {
  return JSON.stringify(
    (checkpoint?.tasks || []).map((task) => [
      task.taskId,
      task.status,
      task.doneTargets?.length || 0,
      (task.exceptions || []).reduce(
        (count, entry) => count + entry.targets.length,
        0,
      ),
      task.verifiedReceiptIds.length,
      task.readEvidenceIds.length,
      task.materialRefs.length,
    ]),
  );
}

/** The honest end state from the run status, stop rule and ledger. */
export function decideRunEnd(
  checkpoint: ExecutionCheckpoint | undefined,
  run: { status: "completed" | "failed" | "cancelled"; stopRule: RunStopRule },
): RunEndState {
  const tasks = checkpoint?.tasks || [];
  if (run.status === "cancelled") return "cancelled";
  if (tasks.some((task) => task.status === "blocked")) return "blocked";
  if (run.status === "failed") {
    return INTERRUPTING_STOP_RULES.has(run.stopRule) && tasks.some(hasEvidence)
      ? "interrupted"
      : "failed";
  }
  return tasks.some(
    (task) => task.status !== "completed" || task.exceptions?.length,
  )
    ? "completed_with_exceptions"
    : "completed";
}

/** Record the end state; with exceptions, pending outcomes become skipped. */
export function settleOutcomes(
  checkpoint: ExecutionCheckpoint,
  end: RunEndState,
  now: number,
): ExecutionCheckpoint {
  const tasks =
    end === "completed_with_exceptions"
      ? checkpoint.tasks.map(
          (task): Task =>
            task.status === "pending"
              ? {
                  ...task,
                  status: "skipped",
                  reason: task.reason || OUTCOME_REASONS.notDone,
                  updatedAt: now,
                }
              : task,
        )
      : checkpoint.tasks;
  return { ...checkpoint, tasks, end: { state: end }, updatedAt: now };
}
