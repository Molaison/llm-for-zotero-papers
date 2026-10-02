import type {
  AgentToolDefinition,
  AgentToolInputValidation,
} from "../../types";
import { readOnlyInvocationPlan } from "../../authorization/invocationPlan";
import { fail, ok, validateObject } from "../shared";
import { ToolInputRejection } from "../execution/failure";
import { ACTION_CAPABILITIES } from "../../contracts/operationCatalog";
import type { AgentActionCapability } from "../../contracts/types";
import {
  assertCheckpointOwner,
  ordinaryExecutionTaskId,
} from "../../execution/checkpoint";
import type {
  ExecutionCheckpoint,
  ExecutionCheckpointTask,
  ExecutionTaskStatus,
  OutcomeEffect,
} from "../../execution/types";
import type { TaskPaperScopeSet } from "../../context/taskPaperScopeListing";
import {
  runDigestParts,
  type DigestJobHostDeps,
  type DigestRunResult,
} from "../../digests/digestJobHost";
import {
  declareOutcomes,
  isOutcomeTargetId,
  markOutcomes,
  type OutcomeDeclaration,
  type OutcomeModelMark,
} from "../../loop/outcomes";

type ExpectedEffect = "read" | "artifact" | "mutation" | "reasoning" | "digest";

/** A part of the request the model declares for the host to track. */
type TaskDeclaration = {
  taskId: string;
  description?: string;
  expectedEffect?: ExpectedEffect;
  expectedCapability?: string;
  targetIds?: string[];
  /** The part covers every paper of the turn's scope. */
  scope?: boolean;
};

/** A declared part that cannot be done, and why. */
type TaskException = { taskId: string; reason: string };

type ExceptionStatus = OutcomeModelMark["status"];

const EXCEPTION_STATUSES: readonly ExceptionStatus[] = [
  "skipped",
  "blocked",
  "cancelled",
];

type TaskUpdateInput = {
  tasks: TaskDeclaration[];
} & Record<ExceptionStatus, TaskException[]>;

const EXPECTED_EFFECTS: readonly ExpectedEffect[] = [
  "read",
  "artifact",
  "mutation",
  "reasoning",
  "digest",
];

const DECLARATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["taskId", "description", "expectedEffect"],
  properties: {
    taskId: { type: "string" },
    description: { type: "string" },
    expectedEffect: { type: "string", enum: [...EXPECTED_EFFECTS] },
    expectedCapability: { type: "string" },
    targetIds: { type: "array", items: { type: "string" } },
    scope: { type: "boolean" },
  },
} as const;

const EXCEPTION_SCHEMA = {
  type: "array",
  minItems: 1,
  items: {
    type: "object",
    additionalProperties: false,
    required: ["taskId", "reason"],
    properties: {
      taskId: { type: "string" },
      reason: { type: "string" },
    },
  },
} as const;

const EXPECTED_EFFECT_REQUIRED =
  "Give each new task an expectedEffect: read, artifact, mutation, reasoning, or digest (one host-made summary per paper).";
const DIGEST_NEEDS_PAPERS =
  "A digest part names the papers it digests: targetIds, or scope:true for the whole Paper scope.";
/** The most papers one digest part may name. */
export const DIGEST_MAX_PAPERS_PER_PART = 200;
function digestTooLarge(count: number): string {
  return `A digest part over ${count} papers is too large (at most ${DIGEST_MAX_PAPERS_PER_PART}). Narrow the scope to a collection, a tag, or explicit targetIds, or ask the user to confirm the whole set and then declare it as several digest parts of at most ${DIGEST_MAX_PAPERS_PER_PART} papers each.`;
}
/** The note for targetIds that name no Zotero item. */
function notIdsNote(values: readonly string[]): string {
  return `targetIds take Zotero ids (12 or item:12), and these are not ids: ${values
    .map((value) => JSON.stringify(value))
    .join(
      ", ",
    )}. Find the papers' ids with library_search, or use scope:true for the whole Paper scope.`;
}
/** The note for a new effect on a part that already holds evidence. */
function effectFixedNote(
  local: string,
  prior: OutcomeEffect,
  requested: OutcomeEffect,
): string {
  const name = (effect: OutcomeEffect) =>
    effect === "answer" ? "reasoning" : effect;
  return `Task ${local} already has progress as a ${name(prior)} part, so it cannot become a ${name(requested)} part. Declare the ${name(requested)} part under a new taskId, such as "${local}-${name(requested)}".`;
}
const HOST_MARKS_DONE =
  "Nothing changed: the host marks parts done from the tools' results, so progress needs no task_update call. Continue the work, or answer when it is done.";
/** The note for skips refused because nothing was delivered for their parts. */
function skipRefusedNote(ids: readonly string[]): string {
  const list = ids.join(", ");
  return `Skip refused for ${list}: nothing was delivered for ${ids.length === 1 ? "it" : "them"} in this run (no document, note, or read evidence is bound to it). Produce it with the tools, or, if it truly cannot be done, list it under blocked with the concrete obstacle.`;
}
const NO_SCOPE_PAPERS =
  "This turn states no paper scope to cover; name the part's papers in targetIds.";
const NO_STATUS =
  "task_update takes no status: the host marks parts done from the tools' results. Declare parts in tasks, and list one that cannot be done under skipped, blocked or cancelled with the reason.";

/**
 * One part as the model reads it back: its id, status and counts. The ledger
 * itself, with the papers a part froze, stays with the host.
 */
type TaskUpdatePart = {
  taskId: string;
  status: ExecutionTaskStatus;
  /** Targets done, of the targets it names. */
  done?: number;
  total?: number;
  /** Targets not done, with up to three of the host's reasons. */
  exceptions?: number;
  reasons?: string[];
  /** Why it was skipped, blocked or cancelled, or why a write failed. */
  reason?: string;
  scope?: true;
};

const NAMED_EXCEPTION_REASONS = 3;

function answerPart(
  checkpoint: ExecutionCheckpoint,
  task: ExecutionCheckpointTask,
): TaskUpdatePart {
  const prefix = `${checkpoint.executionId}:task:`;
  const exceptions = task.exceptions || [];
  const excepted = exceptions.reduce(
    (count, entry) => count + entry.targets.length,
    0,
  );
  return {
    taskId: task.taskId.startsWith(prefix)
      ? task.taskId.slice(prefix.length)
      : task.taskId,
    status: task.status,
    ...(task.targets?.length
      ? { done: task.doneTargets?.length || 0, total: task.targets.length }
      : {}),
    ...(excepted
      ? {
          exceptions: excepted,
          reasons: [...new Set(exceptions.map((entry) => entry.reason))].slice(
            0,
            NAMED_EXCEPTION_REASONS,
          ),
        }
      : {}),
    ...(task.reason ? { reason: task.reason } : {}),
    ...(task.scope ? { scope: true as const } : {}),
  };
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function parseDeclaration(
  raw: unknown,
  label: string,
): AgentToolInputValidation<TaskDeclaration> {
  if (!validateObject<Record<string, unknown>>(raw)) {
    return fail(`${label} must be an object`);
  }
  if (raw.status !== undefined) return fail(NO_STATUS);
  const taskId = typeof raw.taskId === "string" ? raw.taskId.trim() : "";
  if (!taskId) return fail(`${label} needs a taskId`);
  if (
    raw.expectedEffect !== undefined &&
    !EXPECTED_EFFECTS.includes(raw.expectedEffect as ExpectedEffect)
  ) {
    return fail(`${label}.expectedEffect is invalid`);
  }
  if (raw.scope !== undefined && typeof raw.scope !== "boolean") {
    return fail(`${label}.scope must be true or false`);
  }
  return ok({
    taskId,
    description: optionalText(raw.description),
    expectedEffect: raw.expectedEffect as ExpectedEffect | undefined,
    expectedCapability: optionalText(raw.expectedCapability),
    targetIds: Array.isArray(raw.targetIds)
      ? raw.targetIds.map(String).filter(Boolean)
      : undefined,
    ...(raw.scope === true ? { scope: true } : {}),
  });
}

function parseException(
  raw: unknown,
  label: string,
): AgentToolInputValidation<TaskException> {
  if (!validateObject<Record<string, unknown>>(raw)) {
    return fail(`${label} must be an object`);
  }
  const taskId = typeof raw.taskId === "string" ? raw.taskId.trim() : "";
  if (!taskId) return fail(`${label} needs a taskId`);
  return ok({ taskId, reason: optionalText(raw.reason) || "" });
}

function parseList<T>(
  value: unknown,
  label: string,
  parse: (raw: unknown, label: string) => AgentToolInputValidation<T>,
): AgentToolInputValidation<T[]> {
  if (value === undefined) return ok([]);
  if (!Array.isArray(value) || !value.length) {
    return fail(`${label} must be a non-empty array`);
  }
  const parsed: T[] = [];
  for (const [index, raw] of value.entries()) {
    const entry = parse(raw, `${label}[${index}]`);
    if (!entry.ok) return entry;
    parsed.push(entry.value);
  }
  return ok(parsed);
}

export function validateTaskUpdateInput(
  args: unknown,
): AgentToolInputValidation<TaskUpdateInput> {
  if (!validateObject<Record<string, unknown>>(args)) {
    return fail("task_update expects an object");
  }
  const tasks = parseList(args.tasks, "task_update.tasks", parseDeclaration);
  if (!tasks.ok) return tasks;
  const input: TaskUpdateInput = {
    tasks: tasks.value,
    skipped: [],
    blocked: [],
    cancelled: [],
  };
  for (const status of EXCEPTION_STATUSES) {
    const exceptions = parseList(
      args[status],
      `task_update.${status}`,
      parseException,
    );
    if (!exceptions.ok) return exceptions;
    input[status] = exceptions.value;
  }
  if (
    !input.tasks.length &&
    EXCEPTION_STATUSES.every((status) => !input[status].length)
  ) {
    return fail(
      "task_update needs tasks to declare, or parts listed under skipped, blocked or cancelled",
    );
  }
  return ok(input);
}

function actionCapability(
  value: string | undefined,
): AgentActionCapability | undefined {
  return value && ACTION_CAPABILITIES.has(value as AgentActionCapability)
    ? (value as AgentActionCapability)
    : undefined;
}

/**
 * The targets a new part declares: its targetIds, or, with `scope`, every
 * paper of the turn's scope as the host resolved it, frozen now in scope
 * order. A later change to the scope never reaches a part declared before.
 * A part that names targetIds and also sets `scope` tracks the papers it
 * named: they say exactly what is meant, so `scope` is ignored rather than
 * the call refused.
 */
function declaredTargets(
  request: TaskDeclaration,
  scopePapers: TaskPaperScopeSet | undefined,
): { targets?: string[]; scope?: true } {
  if (!request.scope || request.targetIds?.length) {
    return { targets: request.targetIds };
  }
  if (!scopePapers?.itemIds.length) {
    throw new ToolInputRejection(NO_SCOPE_PAPERS);
  }
  return {
    targets: scopePapers.itemIds.map((itemId) => `item:${itemId}`),
    scope: true,
  };
}

/**
 * A digest part the host is asked to run, and the papers to digest now;
 * `retried` are those the part holds as failed, with the reason it holds.
 */
export type DigestPartRun = {
  taskId: string;
  targets: string[];
  retried?: Array<{ target: string; reason: string }>;
};

/**
 * The papers a repeated digest declaration asks for: its targetIds, as the
 * part's own targets in the part's own order, or, without targetIds, every
 * paper the part has not done (a resume after Stop, or a retry of failures).
 */
function digestRetryTargets(
  task: ExecutionCheckpointTask,
  targetIds: readonly string[] | undefined,
): string[] {
  const targets = task.targets || [];
  if (targetIds?.length) {
    const named = new Set(
      targetIds.map((id) => (/^[1-9]\d*$/.test(id) ? `item:${id}` : id)),
    );
    return targets.filter((target) => named.has(target));
  }
  const done = new Set(task.doneTargets || []);
  return targets.filter((target) => !done.has(target));
}

/** The host effect a model's expectedEffect names. */
function outcomeEffect(
  expected: ExpectedEffect | undefined,
): OutcomeEffect | undefined {
  return expected === "reasoning" ? "answer" : expected;
}

/**
 * Whether a declared part still holds nothing the host bound to it: it is
 * pending, the model declared it, and no read, write, material, digested
 * paper or exception is on it. Only such a part may take a new effect.
 */
function redeclarable(task: ExecutionCheckpointTask): boolean {
  return (
    task.status === "pending" &&
    task.origin !== "host" &&
    [
      task.journalActionIds,
      task.verifiedReceiptIds,
      task.readEvidenceIds,
      task.materialRefs,
      task.receiptIds || [],
      task.doneTargets || [],
      task.exceptions || [],
    ].every((entries) => entries.length === 0)
  );
}

/**
 * One ordinary call: its declarations become declared parts, then its
 * skipped, blocked or cancelled parts are marked with their reasons. A
 * repeated declaration changes nothing, and `ignored` says so, except for a
 * digest part: declaring one, or repeating it, asks the host to run it, and
 * `digestParts` lists those runs with their papers. A repeat with a new
 * expectedEffect re-declares a part that holds no evidence yet: the part is
 * replaced in place under its id, pending, with the new effect, description
 * and capability, and with targets frozen again when the repeat gives
 * targetIds or scope (else it keeps its own). `changed` lists those parts. A
 * part with evidence keeps its effect, and the repeat is refused. A
 * malformed call is an input rejection.
 */
export function applyOrdinaryTaskUpdates(
  checkpoint: ExecutionCheckpoint,
  input: TaskUpdateInput,
  now: number,
  scopePapers: TaskPaperScopeSet | undefined,
): {
  checkpoint: ExecutionCheckpoint;
  ignored: boolean;
  refused: string[];
  digestParts: DigestPartRun[];
  changed: string[];
} {
  try {
    const existing = new Map(
      checkpoint.tasks.map((task) => [task.taskId, task]),
    );
    const qualified = (local: string) =>
      ordinaryExecutionTaskId(checkpoint.executionId, local);
    const onlyOnce = (seen: Set<string>, taskId: string) => {
      if (seen.has(taskId)) {
        throw new Error(`Task ${taskId} may appear only once in one update`);
      }
      seen.add(taskId);
    };
    const marks: OutcomeModelMark[] = [];
    const marked = new Set<string>();
    for (const status of EXCEPTION_STATUSES) {
      for (const exception of input[status]) {
        const taskId = qualified(exception.taskId);
        onlyOnce(marked, taskId);
        marks.push({ taskId, status, reason: exception.reason });
      }
    }
    const declarations: OutcomeDeclaration[] = [];
    const declared = new Set<string>();
    let ignored = false;
    // Digest parts this call asks to run: new ones with every paper, repeated
    // ones with the papers the repeat names (`digestRetryTargets`).
    const digestRuns: Array<{ taskId: string; targetIds?: string[] }> = [];
    // Parts this call re-declares with a new effect, by id.
    const redeclared = new Map<string, ExecutionCheckpointTask>();
    for (const request of input.tasks) {
      const taskId = qualified(request.taskId);
      onlyOnce(declared, taskId);
      const prior = existing.get(taskId);
      const requestedEffect = outcomeEffect(request.expectedEffect);
      // The effect the part would take: a write capability makes it a
      // mutation (`declareOutcomes`), so repeating such a declaration word
      // for word is a repeat, not a new effect.
      const capability = actionCapability(request.expectedCapability);
      const effectiveEffect =
        requestedEffect && capability && capability !== "zotero.read"
          ? "mutation"
          : requestedEffect;
      const newEffect =
        prior !== undefined &&
        effectiveEffect !== undefined &&
        effectiveEffect !== (prior.effect || "answer");
      if (newEffect && !redeclarable(prior)) {
        throw new ToolInputRejection(
          effectFixedNote(
            request.taskId,
            prior.effect || "answer",
            effectiveEffect,
          ),
        );
      }
      // Papers are named by id; a write part may also name what is not in
      // the library yet ("new collection"), which tracks its capability.
      if (
        request.targetIds?.length &&
        (effectiveEffect || prior?.effect) !== "mutation"
      ) {
        const notIds = request.targetIds.filter(
          (value) => !isOutcomeTargetId(value),
        );
        if (notIds.length) throw new ToolInputRejection(notIdsNote(notIds));
      }
      if (!prior || newEffect) {
        const effect = requestedEffect;
        if (!effect) throw new ToolInputRejection(EXPECTED_EFFECT_REQUIRED);
        const { targets, scope } =
          prior && !request.scope && !request.targetIds?.length
            ? {
                targets: prior.targets ? [...prior.targets] : undefined,
                scope: prior.scope,
              }
            : declaredTargets(request, scopePapers);
        if (prior) redeclared.set(taskId, prior);
        if (effect === "digest" && !targets?.length)
          throw new ToolInputRejection(DIGEST_NEEDS_PAPERS);
        if (
          effectiveEffect === "digest" &&
          (targets?.length || 0) > DIGEST_MAX_PAPERS_PER_PART
        )
          throw new ToolInputRejection(digestTooLarge(targets!.length));
        if (effect === "digest") digestRuns.push({ taskId });
        declarations.push({
          taskId,
          description: request.description || prior?.description || "",
          effect,
          capability,
          targets,
          ...(scope ? { scope } : {}),
        });
        continue;
      }
      // A repeat keeps the part; a new description for it is refused.
      if (request.description)
        declarations.push({
          taskId,
          description: request.description,
          effect: prior.effect || "answer",
        });
      if (prior.effect === "digest") {
        digestRuns.push({ taskId, targetIds: request.targetIds });
        continue;
      }
      if (!marked.has(taskId)) ignored = true;
    }
    const applied = markOutcomes(
      replaceInPlace(
        checkpoint,
        declareOutcomes(
          redeclared.size
            ? {
                ...checkpoint,
                tasks: checkpoint.tasks.filter(
                  (task) => !redeclared.has(task.taskId),
                ),
              }
            : checkpoint,
          declarations,
          now,
        ),
        redeclared,
      ),
      marks,
      now,
    );
    const prefix = `${checkpoint.executionId}:task:`;
    const tasks = new Map(
      applied.checkpoint.tasks.map((task) => [task.taskId, task]),
    );
    const digestParts = digestRuns.flatMap(({ taskId, targetIds }) => {
      const task = tasks.get(taskId);
      // A part the same call marks, or one a write capability made a
      // mutation, runs no digest.
      if (task?.effect !== "digest" || marked.has(taskId)) return [];
      const targets = digestRetryTargets(task, targetIds);
      if (!targets.length) return [];
      const retried = targets.flatMap((target) => {
        const held = task.exceptions?.find((entry) =>
          entry.targets.includes(target),
        );
        return held ? [{ target, reason: held.reason }] : [];
      });
      return [{ taskId, targets, ...(retried.length ? { retried } : {}) }];
    });
    const local = (taskId: string) =>
      taskId.startsWith(prefix) ? taskId.slice(prefix.length) : taskId;
    return {
      checkpoint: applied.checkpoint,
      digestParts,
      changed: [...redeclared.keys()].map(local),
      ignored: ignored || applied.ignored.length > 0,
      refused: applied.refused.map(({ taskId }) => local(taskId)),
    };
  } catch (error) {
    if (error instanceof ToolInputRejection) throw error;
    throw new ToolInputRejection(
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Put each re-declared part back where its predecessor stood, keeping when it
 * was first declared; `declared` appended it as new.
 */
function replaceInPlace(
  original: ExecutionCheckpoint,
  declared: ExecutionCheckpoint,
  redeclared: ReadonlyMap<string, ExecutionCheckpointTask>,
): ExecutionCheckpoint {
  if (!redeclared.size) return declared;
  const byId = new Map(declared.tasks.map((task) => [task.taskId, task]));
  const placed = new Set(original.tasks.map((task) => task.taskId));
  const tasks = original.tasks.map((task) => {
    const prior = redeclared.get(task.taskId);
    const next = byId.get(task.taskId)!;
    return prior ? { ...next, createdAt: prior.createdAt } : next;
  });
  return {
    ...declared,
    tasks: [
      ...tasks,
      ...declared.tasks.filter((task) => !placed.has(task.taskId)),
    ],
  };
}

export type TaskUpdateToolDeps = {
  /**
   * The host that runs a declared digest part. Without it a digest part is
   * declared and tracked, and nothing digests it.
   */
  digests?: DigestJobHostDeps;
};

type TaskUpdateResult = {
  parts: TaskUpdatePart[];
  /** Parts this call re-declared with a new effect. */
  changed?: string[];
  note?: string;
} & DigestRunResult;

export function createTaskUpdateTool(
  deps: TaskUpdateToolDeps = {},
): AgentToolDefinition<TaskUpdateInput, TaskUpdateResult> {
  return {
    spec: {
      name: "task_update",
      description:
        "Declare a compound request's parts for the host to track: expectedCapability such as zotero.notes for a write; targetIds, or scope:true for the whole Paper scope; expectedEffect 'digest' asks the host to summarize each named paper itself and return the summaries. The host marks parts done; list one that cannot be done under skipped or blocked, with the reason.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          tasks: { type: "array", minItems: 1, items: DECLARATION_SCHEMA },
          skipped: EXCEPTION_SCHEMA,
          blocked: EXCEPTION_SCHEMA,
          cancelled: EXCEPTION_SCHEMA,
        },
      },
      executionClass: "control",
      workCategory: "planning",
    },
    /**
     * Its calls declare the parts the host tracks, and Task progress already
     * shows the reader those parts, so a row for each call would report the
     * trace's own plumbing.
     */
    presentation: { hiddenInTrace: true },
    isAvailable: (request) =>
      request.executionContext?.permissionOwner === "original_agent",
    validate: validateTaskUpdateInput,
    planInvocation: () =>
      readOnlyInvocationPlan({
        domains: [],
        reason:
          "This host-owned control updates only task progress in the active workflow.",
      }),
    execute: async (input, context) => {
      const execution = context.request.executionContext;
      if (execution?.permissionOwner !== "original_agent") {
        throw new Error(
          "task_update requires an ordinary Original Agent execution",
        );
      }
      if (!context.runId || !context.updateExecutionCheckpoint) {
        throw new Error(
          "Ordinary task progress requires durable run checkpoint persistence",
        );
      }
      let ignored = false;
      let refused: string[] = [];
      let digestParts: DigestPartRun[] = [];
      let changed: string[] = [];
      let checkpoint = await context.updateExecutionCheckpoint((current) => {
        assertCheckpointOwner(current, execution);
        const applied = applyOrdinaryTaskUpdates(
          current,
          input,
          Date.now(),
          context.request.turnScopePapers,
        );
        ignored = applied.ignored;
        refused = applied.refused;
        digestParts = applied.digestParts;
        changed = applied.changed;
        return applied.checkpoint;
      });
      let digests: DigestRunResult = {};
      if (digestParts.length && deps.digests) {
        const prefix = `${checkpoint.executionId}:task:`;
        digests = await runDigestParts({
          parts: digestParts,
          context,
          deps: deps.digests,
          localTaskId: (taskId) =>
            taskId.startsWith(prefix) ? taskId.slice(prefix.length) : taskId,
        });
        // The ledger as the papers' outcomes left it.
        checkpoint = await context.updateExecutionCheckpoint(
          (current) => current,
        );
      }
      const parts = checkpoint.tasks.map((task) =>
        answerPart(checkpoint, task),
      );
      const reported = {
        parts,
        ...(changed.length ? { changed } : {}),
      };
      // A refused skip is the note the model must act on; it outranks the
      // reminder that progress needs no call.
      if (refused.length)
        return { ...reported, note: skipRefusedNote(refused), ...digests };
      return ignored
        ? { ...reported, note: HOST_MARKS_DONE, ...digests }
        : { ...reported, ...digests };
    },
  };
}
