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
import type { ExecutionCheckpoint, OutcomeEffect } from "../../execution/types";
import type { TaskPaperScopeSet } from "../../context/taskPaperScopeListing";
import {
  declareOutcomes,
  markOutcomes,
  type OutcomeDeclaration,
  type OutcomeModelMark,
} from "../../loop/outcomes";

type ExpectedEffect = "read" | "artifact" | "mutation" | "reasoning";

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
  "Give each new task an expectedEffect: read, artifact, mutation, or reasoning.";
const HOST_MARKS_DONE =
  "Nothing changed: the host marks parts done from the tools' results, so progress needs no task_update call. Continue the work, or answer when it is done.";
const SCOPE_OR_TARGETS = "Give a part targetIds or scope:true, not both.";
const NO_SCOPE_PAPERS =
  "This turn's paper scope lists no papers; name the part's papers in targetIds.";
const NO_STATUS =
  "task_update takes no status: the host marks parts done from the tools' results. Declare parts in tasks, and list one that cannot be done under skipped, blocked or cancelled with the reason.";

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
 */
function declaredTargets(
  request: TaskDeclaration,
  scopePapers: TaskPaperScopeSet | undefined,
): string[] | undefined {
  if (!request.scope) return request.targetIds;
  if (request.targetIds?.length) {
    throw new ToolInputRejection(SCOPE_OR_TARGETS);
  }
  if (!scopePapers?.itemIds.length) {
    throw new ToolInputRejection(NO_SCOPE_PAPERS);
  }
  return scopePapers.itemIds.map((itemId) => `item:${itemId}`);
}

/**
 * One ordinary call: its declarations become declared parts, then its
 * skipped, blocked or cancelled parts are marked with their reasons. A
 * repeated declaration changes nothing, and `ignored` says so. A malformed
 * call is an input rejection.
 */
function applyOrdinaryTaskUpdates(
  checkpoint: ExecutionCheckpoint,
  input: TaskUpdateInput,
  now: number,
  scopePapers: TaskPaperScopeSet | undefined,
): { checkpoint: ExecutionCheckpoint; ignored: boolean } {
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
    for (const request of input.tasks) {
      const taskId = qualified(request.taskId);
      onlyOnce(declared, taskId);
      const prior = existing.get(taskId);
      if (!prior) {
        const effect: OutcomeEffect | undefined =
          request.expectedEffect === "reasoning"
            ? "answer"
            : request.expectedEffect;
        if (!effect) throw new ToolInputRejection(EXPECTED_EFFECT_REQUIRED);
        declarations.push({
          taskId,
          description: request.description || "",
          effect,
          capability: actionCapability(request.expectedCapability),
          targets: declaredTargets(request, scopePapers),
          ...(request.scope ? { scope: true } : {}),
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
      if (!marked.has(taskId)) ignored = true;
    }
    const applied = markOutcomes(
      declareOutcomes(checkpoint, declarations, now),
      marks,
      now,
    );
    return {
      checkpoint: applied.checkpoint,
      ignored: ignored || applied.ignored.length > 0,
    };
  } catch (error) {
    if (error instanceof ToolInputRejection) throw error;
    throw new ToolInputRejection(
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function createTaskUpdateTool(): AgentToolDefinition<
  TaskUpdateInput,
  unknown
> {
  return {
    spec: {
      name: "task_update",
      description:
        "Declare a compound request's parts for the host to track: expectedCapability such as zotero.notes for a write; targetIds, or scope:true for the whole Paper scope. The host marks parts done; list one that cannot be done under skipped or blocked, with the reason.",
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
      const checkpoint = await context.updateExecutionCheckpoint((current) => {
        assertCheckpointOwner(current, execution);
        const applied = applyOrdinaryTaskUpdates(
          current,
          input,
          Date.now(),
          context.request.turnScopePapers,
        );
        ignored = applied.ignored;
        return applied.checkpoint;
      });
      return ignored ? { checkpoint, note: HOST_MARKS_DONE } : { checkpoint };
    },
  };
}
