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
  | {
      kind: "material";
      materialRef: MaterialRef;
      /** The part the producing call named (its local taskId), if any. */
      taskId?: string;
      /** The document's kind, as submit_document's documentKind names it. */
      documentKind?: string;
      /** `item:ID` of every source the material cites. */
      citedTargets?: readonly string[];
    }
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
  | {
      kind: "answer";
      /** `item:ID` of every source the accepted answer cites. */
      citedTargets?: readonly string[];
    }
  | {
      kind: "failed";
      /** Papers a tool failed on twice the same way; the host gives up on them. */
      targets: readonly string[];
      reason: string;
    };

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
  notCovered: "Not covered by the delivered content",
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
/** Writes that create a note on a paper: repeating one writes it twice. */
const NOTE_CREATING_OPERATIONS: ReadonlySet<string> = new Set([
  "note_create",
  "save_note",
  "save_notes_batch",
]);
const INTERRUPTING_STOP_RULES: ReadonlySet<RunStopRule> = new Set<RunStopRule>([
  "interrupted_by_error",
  "stream_interrupted_again",
  "incomplete_step_limit",
  "segment_without_progress",
  "repeated_tool_errors",
  "page_failed",
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

/** Whether one of a part's `values` (its targets, done or excepted) means `target`. */
function namesTarget(
  values: readonly string[] | undefined,
  target: string,
): boolean {
  return (values || []).some(
    (value) => resolveTarget(value, [target]) !== undefined,
  );
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

/** A write that creates a note on each paper it names. */
function createsNotes(
  write: Pick<AgentActionProposal, "capability" | "operation">,
): boolean {
  return (
    write.capability === "zotero.notes" &&
    NOTE_CREATING_OPERATIONS.has(write.operation)
  );
}

/**
 * Whether a new note on `paper` would be this part's note on it: a part that
 * takes notes and names the paper without having it done, open to the note's
 * receipt (pending or blocked, or settled with the paper excepted, which a
 * note on it clears). The note's receipt binds such a part
 * (`notePapersByPart`); the duplicate-note guard (`papersAlreadyWritten`)
 * and the resume reconciliation ask whether one is left.
 */
function owesNote(task: Task, paper: string): boolean {
  if (
    task.effect !== "mutation" ||
    (task.capability && task.capability !== "zotero.notes") ||
    !namesTarget(task.targets, paper) ||
    namesTarget(task.doneTargets, paper)
  )
    return false;
  return (
    RECEIPT_CANDIDATE_STATUSES.has(task.status) ||
    ((task.status === "completed" || task.status === "skipped") &&
      namesTarget(
        (task.exceptions || []).flatMap((entry) => entry.targets),
        paper,
      ))
  );
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

/**
 * Bind a receipt to one part. `papers`, for a note, are the receipt's
 * targets it gives this part (`notePapersByPart`); the part takes no other.
 */
function bindReceipt(
  task: Task,
  receipt: AgentActionReceipt,
  now: number,
  papers?: readonly string[],
): Task {
  const targets = task.targets || [];
  // The part's own targets a receipt's list names, in the part's own form.
  const own = (values: readonly string[]): string[] => {
    const given = papers
      ? values.filter((value) => papers.includes(value))
      : values;
    return unique(
      targets.length
        ? targets.filter((target) => resolveTarget(target, given) !== undefined)
        : given,
    );
  };
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

/**
 * One part per note: the papers a note-creating write gives each of the
 * parts for notes that take it (`candidates`, in declaration order). A
 * paper goes to the first of them that names it and has not got it done, so
 * the next note on the paper goes to the next such part, and two parts that
 * each ask a note of a paper take two. A paper every one of them has done
 * goes to the first that names it, which it ticks no further. A tag, a
 * folder or a field set twice is one state, so those writes bind every part
 * that names their targets instead.
 */
function notePapersByPart(
  tasks: readonly Task[],
  candidates: readonly number[],
  write: AgentActionReceipt,
): Map<number, string[]> {
  const papers = unique([
    ...write.requestedTargets,
    ...write.appliedTargets,
    ...write.alreadySatisfiedTargets,
    ...write.rejectedTargets,
  ]);
  const byPart = new Map<number, string[]>();
  for (const paper of papers) {
    const naming = candidates.filter((index) =>
      namesTarget(tasks[index].targets, paper),
    );
    const index =
      naming.find((at) => !namesTarget(tasks[at].doneTargets, paper)) ??
      naming[0];
    if (index !== undefined)
      byPart.set(index, [...(byPart.get(index) || []), paper]);
  }
  return byPart;
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
  // else the first part without targets that takes it; a note binds one
  // part for notes on each paper (`notePapersByPart`).
  const chosen = new Map<
    number,
    { write: AgentActionReceipt; papers?: string[] }
  >();
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
    if (targeted.length && createsNotes(write)) {
      // A part that takes any write may be a tag's or a folder's as well as
      // a note's: it takes every note on its papers, as it takes any write.
      const forNotes = targeted.filter(
        (index) => checkpoint.tasks[index].capability,
      );
      for (const [index, papers] of notePapersByPart(
        checkpoint.tasks,
        forNotes,
        write,
      ))
        chosen.set(index, { write, papers });
      for (const index of targeted)
        if (!checkpoint.tasks[index].capability) chosen.set(index, { write });
      continue;
    }
    for (const index of targeted.length ? targeted : candidates.slice(0, 1))
      chosen.set(index, { write });
  }
  if (chosen.size) {
    return mapTasks(checkpoint, now, (task, index) => {
      const binding = chosen.get(index);
      return binding
        ? bindReceipt(task, binding.write, now, binding.papers)
        : undefined;
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

/*
 * Delivered content. A document, or the accepted answer, is the artifact a
 * part asked for. A part that names papers is accounted per paper: the papers
 * the content cites are done, and the rest become exceptions, so "12/12"
 * means twelve papers were covered. A part that names none completes.
 */

/** A document kind's words in a part's description, for an unnamed binding. */
const KIND_DESCRIPTION_PATTERNS: Readonly<Record<string, RegExp>> = {
  literature_review: /\b(review|synthesis|synthesi[sz]e)\b/i,
  research_brief: /\bbrief\b/i,
  comparison: /\bcompar/i,
  report: /\breport\b/i,
  guide: /\b(guide|tutorial|how[- ]to)\b/i,
};

function isPendingArtifact(task: Task): boolean {
  return task.status === "pending" && task.effect === "artifact";
}

/**
 * The part delivered content binds to, and whether it binds as a revision.
 *
 * A call that names a part binds only to it: an open artifact part is
 * covered; a settled artifact part takes the material as a revision of what
 * it already delivered, its counts unchanged; any other part takes nothing.
 * A call that names no existing part binds to the first pending artifact part
 * whose description names the content's kind, else to the first pending
 * artifact part. Undefined when nothing takes it.
 */
function artifactPartFor(
  checkpoint: ExecutionCheckpoint,
  named: { taskId?: string; kind?: string },
): { index: number; revision: boolean } | undefined {
  let taskId: string | undefined;
  try {
    taskId = named.taskId
      ? ordinaryExecutionTaskId(checkpoint.executionId, named.taskId)
      : undefined;
  } catch {
    // A malformed id names no part; the content still binds by its kind.
  }
  const own = taskId
    ? checkpoint.tasks.findIndex((task) => task.taskId === taskId)
    : -1;
  if (own >= 0) {
    const task = checkpoint.tasks[own];
    if (task.effect !== "artifact") return undefined;
    return { index: own, revision: !MARKABLE_STATUSES.has(task.status) };
  }
  const pattern = named.kind
    ? KIND_DESCRIPTION_PATTERNS[named.kind]
    : undefined;
  const byKind = pattern
    ? checkpoint.tasks.findIndex(
        (task) => isPendingArtifact(task) && pattern.test(task.description),
      )
    : -1;
  const index =
    byKind >= 0 ? byKind : checkpoint.tasks.findIndex(isPendingArtifact);
  return index >= 0 ? { index, revision: false } : undefined;
}

/**
 * Complete an artifact part from content citing `cited`. With `cited`
 * unknown the part completes whole. Otherwise each of its targets the content
 * cites is done, and each other target is excepted as not covered.
 */
function coverTargets(
  task: Task,
  cited: readonly string[] | undefined,
  now: number,
): Task {
  const targets = task.targets || [];
  if (!targets.length || !cited) return { ...completed(task), updatedAt: now };
  const doneTargets = union(
    task.doneTargets,
    targets.filter((target) => cited.includes(target)),
  );
  const done = new Set(doneTargets);
  const exceptions = exceptTargets(
    task.exceptions || [],
    targets.filter((target) => !done.has(target)),
    OUTCOME_REASONS.notCovered,
  );
  return {
    ...completed(task),
    doneTargets,
    ...(exceptions.length ? { exceptions } : {}),
    updatedAt: now,
  };
}

function applyMaterial(
  checkpoint: ExecutionCheckpoint,
  evidence: Extract<OutcomeEvidence, { kind: "material" }>,
  now: number,
): EvidenceResult {
  const key = materialRefKey(evidence.materialRef);
  const bound = checkpoint.tasks.some((task) =>
    task.materialRefs.some((reference) => materialRefKey(reference) === key),
  );
  if (bound) return unchanged(checkpoint);
  const chosen = artifactPartFor(checkpoint, {
    taskId: evidence.taskId,
    kind: evidence.documentKind,
  });
  if (!chosen) return unchanged(checkpoint);
  const { documentId, documentVersion, contentHash } = evidence.materialRef;
  return mapTasks(checkpoint, now, (task, index) => {
    if (index !== chosen.index) return undefined;
    const next = chosen.revision
      ? { ...task, updatedAt: now }
      : coverTargets(task, evidence.citedTargets, now);
    return {
      ...next,
      materialRefs: [
        ...task.materialRefs,
        { documentId, documentVersion, contentHash },
      ],
    };
  });
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

/**
 * Papers the host gave up on after the same failure twice: a pending part
 * that names one and has not done it records the failure as its exception,
 * so the job goes on to the next paper; a part with every paper done or
 * given up on settles, as after any other exception.
 */
function applyFailure(
  checkpoint: ExecutionCheckpoint,
  failure: { targets: readonly string[]; reason: string },
  now: number,
): EvidenceResult {
  const reason = failure.reason.trim() || OUTCOME_REASONS.notApplied;
  return mapTasks(checkpoint, now, (task) => {
    if (
      task.origin !== "model" ||
      !MARKABLE_STATUSES.has(task.status) ||
      (task.effect !== "read" && task.effect !== "mutation")
    )
      return undefined;
    const targets = task.targets || [];
    const done = new Set(task.doneTargets || []);
    const excepted = new Set(
      (task.exceptions || []).flatMap((entry) => entry.targets),
    );
    const given = targets.filter(
      (target) =>
        !done.has(target) &&
        !excepted.has(target) &&
        resolveTarget(target, failure.targets) !== undefined,
    );
    if (!given.length) return undefined;
    const exceptions = withException(task.exceptions || [], given, reason);
    const next: Task = { ...task, exceptions, updatedAt: now };
    const accounted = new Set([
      ...done,
      ...exceptions.flatMap((entry) => entry.targets),
    ]);
    if (!targets.every((target) => accounted.has(target))) return next;
    return done.size
      ? completed(next)
      : { ...next, status: "skipped", reason: exceptions[0].reason };
  });
}

function applyAnswer(
  checkpoint: ExecutionCheckpoint,
  evidence: Extract<OutcomeEvidence, { kind: "answer" }>,
  now: number,
): EvidenceResult {
  // Content written in the accepted answer is the artifact a part asked for.
  return mapTasks(checkpoint, now, (task) => {
    if (task.status !== "pending") return undefined;
    if (!task.effect || task.effect === "answer")
      return { ...task, status: "completed", updatedAt: now };
    // TODO(runtime answer evidence): the task that owns runtime.ts passes the
    // answer's cited targets; until then they are unknown and parts complete whole.
    if (task.effect === "artifact")
      return coverTargets(task, evidence.citedTargets, now);
    return undefined;
  });
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

/**
 * A skip reason claiming the part was delivered. Only host evidence says
 * that, so a part with none keeps open under such a skip.
 */
const DELIVERY_CLAIMS: readonly RegExp[] = [
  /\b(already|previously)\s+(been\s+)?(delivered|done|complete|completed|written|produced|submitted|provided|generated|created|saved|covered|answered)\b/i,
  /\b(delivered|covered|included|provided|written|addressed)\s+(above|below|in|within)\b/i,
  /\bsee\s+(the\s+)?(document|review|answer|above)\b/i,
];

/** Parts whose delivery is content: a document or the answer. */
const CONTENT_EFFECTS: ReadonlySet<string> = new Set(["artifact", "answer"]);

/**
 * Apply skipped, blocked or cancelled marks. `ignored` lists marks on parts
 * that cannot take one; `refused` lists skips claiming a delivery the part
 * has no evidence of, with the claimed reason.
 */
export function markOutcomes(
  checkpoint: ExecutionCheckpoint,
  marks: readonly OutcomeModelMark[],
  now: number,
): {
  checkpoint: ExecutionCheckpoint;
  ignored: string[];
  refused: Array<{ taskId: string; reason: string }>;
} {
  const indexById = new Map(
    checkpoint.tasks.map((task, index) => [task.taskId, index]),
  );
  const tasks = [...checkpoint.tasks];
  const seen = new Set<string>();
  const ignored: string[] = [];
  const refused: Array<{ taskId: string; reason: string }> = [];
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
    if (
      mark.status === "skipped" &&
      CONTENT_EFFECTS.has(tasks[index].effect || "") &&
      DELIVERY_CLAIMS.some((claim) => claim.test(reason)) &&
      !hasEvidence(tasks[index])
    ) {
      refused.push({ taskId, reason });
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
    refused,
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
      return applyMaterial(checkpoint, evidence, now);
    case "declined":
      return applyDeclined(checkpoint, evidence, now);
    case "answer":
      return applyAnswer(checkpoint, evidence, now);
    case "failed":
      return applyFailure(checkpoint, evidence, now);
  }
}

/**
 * Receipts read back from the change journal of the run a resumed ledger
 * comes from (`execution/journalReceipts.ts`), applied where the ledger lacks
 * them. A run that ended while a write was running, or a Zotero that quit
 * mid-batch, can leave a write in the journal that no receipt in the ledger
 * speaks for. A receipt is applied only when an open part names one of the
 * papers it proves and no part that takes it holds that paper done already:
 * a write the ledger knows, by whichever receipt, is never applied twice, and
 * a paper no open part asks for gets no part of its own.
 *
 * A note is counted rather than looked up, as it binds one part for notes a
 * paper: the ledger holds as many notes on a paper as it has parts for notes
 * with the paper done, and the journal names the run's notes in the order
 * they were written, so the notes on a paper past that many are the ones the
 * ledger lacks. Each goes to the next part that still owes the paper a note,
 * if one does.
 */
export function reconcileJournaledReceipts(
  checkpoint: ExecutionCheckpoint,
  receipts: readonly AgentActionReceipt[],
  now: number,
): EvidenceResult {
  let current = checkpoint;
  const notesHeld = (paper: string) =>
    checkpoint.tasks.filter(
      (task) =>
        task.effect === "mutation" &&
        task.capability === "zotero.notes" &&
        namesTarget(task.doneTargets, paper),
    ).length;
  const notesJournaled = new Map<string, number>();
  for (const receipt of receipts) {
    if (!isWrite(receipt)) continue;
    const proven = unique([
      ...receipt.appliedTargets,
      ...receipt.alreadySatisfiedTargets,
    ]);
    if (createsNotes(receipt)) {
      const lacked = proven.map((paper) => {
        const count = (notesJournaled.get(paper) || 0) + 1;
        notesJournaled.set(paper, count);
        return count > notesHeld(paper);
      });
      if (
        isBound(current, receipt.id) ||
        !lacked.every(Boolean) ||
        !proven.some((paper) =>
          current.tasks.some((task) => owesNote(task, paper)),
        )
      )
        continue;
      current = applyReceipt(current, receipt, now).checkpoint;
      continue;
    }
    if (isBound(current, receipt.id)) continue;
    const takes = (task: Task) => acceptsWrite(task, receipt);
    const held = current.tasks.some(
      (task) =>
        takes(task) &&
        (task.doneTargets || []).some(
          (target) => resolveTarget(target, proven) !== undefined,
        ),
    );
    const owed = current.tasks.some(
      (task) =>
        RECEIPT_CANDIDATE_STATUSES.has(task.status) &&
        Boolean(task.targets?.length) &&
        takes(task),
    );
    if (held || !owed) continue;
    current = applyReceipt(current, receipt, now).checkpoint;
  }
  return current === checkpoint
    ? unchanged(checkpoint)
    : { checkpoint: current, changed: true };
}

/**
 * The papers a note-creating write names that the job has already written
 * every note it asks for on: a declared part for notes holds each as done,
 * by its receipt, and no part still owes it a note (`owesNote`). Each note
 * binds one part (`notePapersByPart`), so a paper two parts ask a note of
 * takes two notes before a third is refused. Such a write would write the
 * paper twice, so the host does not run it (`toolExecution.ts`); the
 * receipts that ticked the papers stay the proof. `left` are the papers the
 * same write names that are still owed; null when none is written already.
 *
 * A part holds one done flag a paper, so a single part that asks for two
 * notes on each paper cannot count the second; the host's answer asks the
 * model to declare that note as a part of its own, which then owes it. The
 * guard does not tell two notes apart by their text: a note written again
 * in other words, as a model that starts its page over writes it, is the
 * same note twice.
 *
 * Only note creation is held to this: setting a folder, a tag or a field
 * again changes nothing ("already satisfied"), and a second, different one
 * on the same paper is a change of its own.
 */
export function papersAlreadyWritten(
  checkpoint: ExecutionCheckpoint | undefined,
  proposals: readonly Pick<
    AgentActionProposal,
    "capability" | "operation" | "requestedTargets"
  >[],
): { written: string[]; left: string[]; parts: string[] } | null {
  const targets = unique(
    proposals
      .filter(createsNotes)
      .flatMap((proposal) =>
        proposal.requestedTargets.filter((target) =>
          target.startsWith("item:"),
        ),
      ),
  );
  const noteParts = (checkpoint?.tasks || []).filter(
    (task) =>
      task.origin === "model" &&
      task.effect === "mutation" &&
      (!task.capability || task.capability === "zotero.notes") &&
      Boolean(task.targets?.length),
  );
  if (!targets.length || !noteParts.length) return null;
  const written: string[] = [];
  const parts = new Set<string>();
  for (const target of targets) {
    const holders = noteParts.filter(
      (task) =>
        task.capability === "zotero.notes" &&
        namesTarget(task.targets, target) &&
        namesTarget(task.doneTargets, target),
    );
    const owed = noteParts.some((task) => owesNote(task, target));
    if (!holders.length || owed) continue;
    written.push(target);
    for (const task of holders) parts.add(task.description);
  }
  if (!written.length) return null;
  return {
    written,
    left: targets.filter((target) => !written.includes(target)),
    parts: [...parts],
  };
}

/**
 * Whether "continue" picks a settled ledger back up: one its run left
 * interrupted, or one the user stopped while a declared part was still
 * open. Stop is the outer bound of a long job, not its end, so the job goes
 * on from its first paper not yet settled.
 */
export function resumesOnContinue(checkpoint: ExecutionCheckpoint): boolean {
  const state = checkpoint.end?.state;
  return (
    state === "interrupted" ||
    (state === "cancelled" && openDeclaredOutcomes(checkpoint).length > 0)
  );
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
