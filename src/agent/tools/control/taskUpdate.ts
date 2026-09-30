import type {
  AgentToolDefinition,
  AgentToolInputValidation,
  ExecutionTaskStatus,
} from "../../types";
import type { MaterialRef } from "../../documents/materialRef";
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
import {
  declareOutcomes,
  markOutcomes,
  type OutcomeDeclaration,
  type OutcomeModelMark,
} from "../../loop/outcomes";

type TaskVerifier =
  | "verified_read"
  | "research_coverage"
  | "document_integrity"
  | "document_published"
  | "mutation_receipts"
  | "bounded_reasoning"
  | "user_decision";

type TaskAcceptanceCriterion = Readonly<{
  criterionId: string;
  description: string;
  verifier: TaskVerifier;
}>;

type TaskUpdateRequest = {
  taskId: string;
  status: ExecutionTaskStatus;
  description?: string;
  dependencies?: string[];
  parentTaskId?: string;
  content?: string;
  activeForm?: string;
  acceptanceCriteria?: TaskAcceptanceCriterion[];
  expectedEffect?: "read" | "artifact" | "mutation" | "reasoning";
  expectedCapability?: string;
  targetIds?: string[];
  reason?: string;
  reasoningAssertion?: string;
  journalActionIds?: string[];
  verifiedReceiptIds?: string[];
  readEvidenceIds?: string[];
  materialRefs?: MaterialRef[];
};

type TaskUpdateInput = {
  /** Compatible shorthand for one transition. */
  task?: TaskUpdateRequest;
  /** Atomic batch form. */
  tasks: TaskUpdateRequest[];
};

const STATUSES = new Set<ExecutionTaskStatus>([
  "pending",
  "in_progress",
  "waiting_for_user",
  "interrupted",
  "completed",
  "blocked",
  "failed",
  "skipped",
  "cancelled",
]);
const VERIFIERS = new Set<TaskVerifier>([
  "verified_read",
  "research_coverage",
  "document_integrity",
  "document_published",
  "mutation_receipts",
  "bounded_reasoning",
  "user_decision",
]);

const MATERIAL_REF_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["documentId", "documentVersion", "contentHash"],
  properties: {
    documentId: { type: "string" },
    documentVersion: { type: "integer", minimum: 1 },
    contentHash: { type: "string" },
  },
} as const;

const TASK_UPDATE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["taskId", "status"],
  properties: {
    taskId: { type: "string" },
    status: { type: "string", enum: Array.from(STATUSES) },
    description: {
      type: "string",
      description: "Required when creating an ordinary tracked task.",
    },
    dependencies: { type: "array", items: { type: "string" } },
    reason: { type: "string" },
    reasoningAssertion: {
      type: "string",
      description:
        "Required when completing an approved bounded-reasoning Plan task.",
    },
    parentTaskId: { type: "string" },
    content: { type: "string" },
    activeForm: { type: "string" },
    acceptanceCriteria: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["criterionId", "description", "verifier"],
        properties: {
          criterionId: { type: "string" },
          description: { type: "string" },
          verifier: {
            type: "string",
            enum: Array.from(VERIFIERS),
          },
        },
      },
    },
    expectedEffect: {
      type: "string",
      enum: ["read", "artifact", "mutation", "reasoning"],
    },
    expectedCapability: { type: "string" },
    targetIds: { type: "array", items: { type: "string" } },
    journalActionIds: { type: "array", items: { type: "string" } },
    verifiedReceiptIds: { type: "array", items: { type: "string" } },
    readEvidenceIds: { type: "array", items: { type: "string" } },
    materialRefs: { type: "array", items: MATERIAL_REF_SCHEMA },
  },
} as const;

function stringList(
  value: unknown,
  label: string,
): AgentToolInputValidation<string[] | undefined> {
  if (value === undefined) return ok(undefined);
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || !entry.trim())
  ) {
    return fail(`${label} must be an array of non-empty strings`);
  }
  return ok([...new Set(value.map((entry) => entry.trim()))]);
}

function parseMaterialRefs(
  value: unknown,
): AgentToolInputValidation<MaterialRef[] | undefined> {
  if (value === undefined) return ok(undefined);
  if (!Array.isArray(value)) return fail("materialRefs must be an array");
  const refs: MaterialRef[] = [];
  for (const [index, entry] of value.entries()) {
    if (!validateObject<Record<string, unknown>>(entry)) {
      return fail(`materialRefs[${index}] must be an object`);
    }
    const documentId =
      typeof entry.documentId === "string" ? entry.documentId.trim() : "";
    const contentHash =
      typeof entry.contentHash === "string" ? entry.contentHash.trim() : "";
    const documentVersion = Number(entry.documentVersion);
    if (
      !documentId ||
      !contentHash ||
      !Number.isSafeInteger(documentVersion) ||
      documentVersion < 1
    ) {
      return fail(`materialRefs[${index}] has an invalid immutable identity`);
    }
    refs.push({ documentId, documentVersion, contentHash });
  }
  return ok(refs);
}

function parseTaskUpdate(
  raw: unknown,
  label: string,
): AgentToolInputValidation<TaskUpdateRequest> {
  if (!validateObject<Record<string, unknown>>(raw)) {
    return fail(`${label} must be an object`);
  }
  const taskId = typeof raw.taskId === "string" ? raw.taskId.trim() : "";
  const status = raw.status as ExecutionTaskStatus;
  if (!taskId || !STATUSES.has(status)) {
    return fail(`${label} has an invalid identity/status`);
  }
  const acceptanceCriteria = Array.isArray(raw.acceptanceCriteria)
    ? raw.acceptanceCriteria.flatMap((value) => {
        if (!validateObject<Record<string, unknown>>(value)) return [];
        const criterionId =
          typeof value.criterionId === "string" ? value.criterionId.trim() : "";
        const description =
          typeof value.description === "string" ? value.description.trim() : "";
        const verifier = value.verifier as TaskVerifier;
        return criterionId && description && VERIFIERS.has(verifier)
          ? [{ criterionId, description, verifier }]
          : [];
      })
    : undefined;
  if (
    Array.isArray(raw.acceptanceCriteria) &&
    acceptanceCriteria?.length !== raw.acceptanceCriteria.length
  ) {
    return fail(`${label}.acceptanceCriteria is invalid`);
  }
  if (
    raw.expectedEffect !== undefined &&
    !["read", "artifact", "mutation", "reasoning"].includes(
      String(raw.expectedEffect),
    )
  ) {
    return fail(`${label}.expectedEffect is invalid`);
  }
  const dependencies = stringList(raw.dependencies, `${label}.dependencies`);
  if (!dependencies.ok) return dependencies;
  const journalActionIds = stringList(
    raw.journalActionIds,
    `${label}.journalActionIds`,
  );
  if (!journalActionIds.ok) return journalActionIds;
  const verifiedReceiptIds = stringList(
    raw.verifiedReceiptIds,
    `${label}.verifiedReceiptIds`,
  );
  if (!verifiedReceiptIds.ok) return verifiedReceiptIds;
  const readEvidenceIds = stringList(
    raw.readEvidenceIds,
    `${label}.readEvidenceIds`,
  );
  if (!readEvidenceIds.ok) return readEvidenceIds;
  const materialRefs = parseMaterialRefs(raw.materialRefs);
  if (!materialRefs.ok) return materialRefs;
  return ok({
    taskId,
    status,
    description:
      typeof raw.description === "string"
        ? raw.description.trim() || undefined
        : undefined,
    dependencies: dependencies.value,
    reason:
      typeof raw.reason === "string" && raw.reason.trim()
        ? raw.reason.trim()
        : undefined,
    reasoningAssertion:
      typeof raw.reasoningAssertion === "string" &&
      raw.reasoningAssertion.trim()
        ? raw.reasoningAssertion.trim()
        : undefined,
    parentTaskId:
      typeof raw.parentTaskId === "string"
        ? raw.parentTaskId.trim() || undefined
        : undefined,
    content:
      typeof raw.content === "string"
        ? raw.content.trim() || undefined
        : undefined,
    activeForm:
      typeof raw.activeForm === "string"
        ? raw.activeForm.trim() || undefined
        : undefined,
    acceptanceCriteria,
    expectedEffect: raw.expectedEffect as TaskUpdateRequest["expectedEffect"],
    expectedCapability:
      typeof raw.expectedCapability === "string"
        ? raw.expectedCapability.trim() || undefined
        : undefined,
    targetIds: Array.isArray(raw.targetIds)
      ? raw.targetIds.map(String).filter(Boolean)
      : undefined,
    journalActionIds: journalActionIds.value,
    verifiedReceiptIds: verifiedReceiptIds.value,
    readEvidenceIds: readEvidenceIds.value,
    materialRefs: materialRefs.value,
  });
}

export function validateTaskUpdateInput(
  args: unknown,
): AgentToolInputValidation<TaskUpdateInput> {
  if (!validateObject<Record<string, unknown>>(args)) {
    return fail("task_update expects an object");
  }
  const hasTask = args.task !== undefined;
  const hasTasks = args.tasks !== undefined;
  if (hasTask === hasTasks) {
    return fail("task_update requires exactly one of task or tasks");
  }
  if (hasTask) {
    const parsed = parseTaskUpdate(args.task, "task_update.task");
    return parsed.ok
      ? ok({ task: parsed.value, tasks: [parsed.value] })
      : parsed;
  }
  if (!Array.isArray(args.tasks) || !args.tasks.length) {
    return fail("task_update.tasks must be a non-empty array");
  }
  const tasks: TaskUpdateRequest[] = [];
  for (const [index, raw] of args.tasks.entries()) {
    const parsed = parseTaskUpdate(raw, `task_update.tasks[${index}]`);
    if (!parsed.ok) return parsed;
    tasks.push(parsed.value);
  }
  return ok({ tasks });
}

const OUTCOME_MARK_STATUSES: ReadonlySet<ExecutionTaskStatus> = new Set([
  "skipped",
  "blocked",
  "cancelled",
]);
const EXPECTED_EFFECT_REQUIRED =
  "Give each new task an expectedEffect: read, artifact, mutation, or reasoning.";
const HOST_MARKS_DONE =
  "Nothing changed: the host marks parts done from the tools' results, so progress needs no task_update call. Continue the work, or answer when it is done.";

function actionCapability(
  value: string | undefined,
): AgentActionCapability | undefined {
  return value && ACTION_CAPABILITIES.has(value as AgentActionCapability)
    ? (value as AgentActionCapability)
    : undefined;
}

/**
 * One ordinary call: new tasks become declared parts, then skipped, blocked
 * or cancelled marks apply. Any other requested status changes nothing, and
 * `ignored` says so. A malformed call is an input rejection.
 */
function applyOrdinaryTaskUpdates(
  checkpoint: ExecutionCheckpoint,
  requests: readonly TaskUpdateRequest[],
  now: number,
): { checkpoint: ExecutionCheckpoint; ignored: boolean } {
  try {
    const existing = new Map(
      checkpoint.tasks.map((task) => [task.taskId, task]),
    );
    const seen = new Set<string>();
    const declarations: OutcomeDeclaration[] = [];
    const marks: OutcomeModelMark[] = [];
    let ignored = false;
    for (const request of requests) {
      const taskId = ordinaryExecutionTaskId(
        checkpoint.executionId,
        request.taskId,
      );
      if (seen.has(taskId)) {
        throw new Error(`Task ${taskId} may appear only once in one update`);
      }
      seen.add(taskId);
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
          targets: request.targetIds,
        });
      } else if (request.description) {
        // A repeat keeps the part; a new description for it is refused.
        declarations.push({
          taskId,
          description: request.description,
          effect: prior.effect || "answer",
        });
      }
      if (OUTCOME_MARK_STATUSES.has(request.status)) {
        marks.push({
          taskId,
          status: request.status as OutcomeModelMark["status"],
          reason: request.reason || "",
        });
      } else if (prior || request.status !== "pending") {
        ignored = true;
      }
    }
    const marked = markOutcomes(
      declareOutcomes(checkpoint, declarations, now),
      marks,
      now,
    );
    return {
      checkpoint: marked.checkpoint,
      ignored: ignored || marked.ignored.length > 0,
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
        "Declare a compound request's parts for the host to track: taskId, description, expectedEffect (read, artifact, mutation, or reasoning), and expectedCapability such as zotero.notes for a write. The host marks parts done; mark one skipped or blocked, with the reason, only if it cannot be done.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          task: TASK_UPDATE_SCHEMA,
          tasks: {
            type: "array",
            minItems: 1,
            items: TASK_UPDATE_SCHEMA,
          },
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
          input.tasks,
          Date.now(),
        );
        ignored = applied.ignored;
        return applied.checkpoint;
      });
      return ignored ? { checkpoint, note: HOST_MARKS_DONE } : { checkpoint };
    },
  };
}
