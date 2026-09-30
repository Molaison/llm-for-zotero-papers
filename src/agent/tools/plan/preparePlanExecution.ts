import { createUpdatePlanTool } from "./updatePlan";
import {
  preparePlanExecution,
  validateUpdatePlanInput,
  type UpdatePlanInput,
} from "../../plans/preparation";
import type { AgentToolDefinition } from "../../types";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import type {
  PlanAcceptanceCriterion,
  PlanCompletionRequirementKind,
} from "../../plans/types";
import { fail, validateObject } from "../shared";
import {
  PLAN_CONTRACT_SCHEMA,
  PLAN_EFFECT_SPECIFICATION_REFERENCE_SCHEMA,
  PLAN_STEPS_SCHEMA,
} from "../../plans/contractSchema";

function defaultCriterionVerifier(
  expectedEffect: unknown,
): PlanCompletionRequirementKind {
  if (expectedEffect === "read") return "verified_read";
  if (expectedEffect === "mutation") return "mutation_receipts";
  if (expectedEffect === "artifact") return "material_integrity";
  return "bounded_reasoning";
}

function nonEmptyStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.flatMap((entry) =>
    typeof entry === "string" && entry.trim() ? [entry.trim()] : [],
  );
  return values.length ? values : undefined;
}

function normalizeNativeResearchScope(
  value: unknown,
  fallbackLibraryID: unknown,
): unknown {
  if (!validateObject<Record<string, unknown>>(value)) return value;
  const libraryID = value.libraryID ?? fallbackLibraryID;
  const kindAliases: Record<string, string> = {
    collection: "collections",
    tag: "tags",
    item: "items",
  };
  const nativeItems = Array.isArray(value.items) ? value.items : undefined;
  const kind =
    kindAliases[String(value.kind)] ||
    value.kind ||
    (nativeItems?.length
      ? "items"
      : Array.isArray(value.collectionIds) || value.collectionId !== undefined
        ? "collections"
        : Array.isArray(value.tagNames) || Array.isArray(value.tags)
          ? "tags"
          : undefined);
  if (kind === "library") return { libraryID, kind };
  if (kind === "collections") {
    const collectionIds = Array.isArray(value.collectionIds)
      ? value.collectionIds
      : value.collectionId !== undefined
        ? [value.collectionId]
        : undefined;
    return { libraryID, kind, collectionIds };
  }
  if (kind === "tags") {
    const tagNames = nonEmptyStrings(value.tagNames ?? value.tags);
    return {
      libraryID,
      kind,
      tagNames,
      includeAutomaticTags: value.includeAutomaticTags === true,
    };
  }
  const nativeItemKeys = nativeItems
    ? nativeItems.flatMap((entry) => {
        if (typeof entry === "string" && entry.trim()) return [entry.trim()];
        if (!validateObject<Record<string, unknown>>(entry)) return [];
        if (typeof entry.itemKey === "string" && entry.itemKey.trim())
          return [entry.itemKey.trim()];
        const itemId = Number(entry.itemId ?? entry.contextItemId);
        if (!Number.isInteger(itemId) || itemId <= 0) return [];
        const zotero = (
          globalThis as typeof globalThis & {
            Zotero?: {
              Items?: {
                get?: (
                  id: number,
                ) => { key?: string; libraryID?: number } | undefined;
              };
            };
          }
        ).Zotero;
        const item = zotero?.Items?.get?.(itemId);
        if (
          !item?.key ||
          (typeof libraryID === "number" &&
            item.libraryID !== undefined &&
            item.libraryID !== libraryID)
        )
          return [];
        return [item.key];
      })
    : undefined;
  if (kind === "items") {
    return {
      libraryID,
      kind,
      itemKeys: nonEmptyStrings(value.itemKeys) || nativeItemKeys,
    };
  }
  if (kind === "mixed") {
    return {
      libraryID,
      kind,
      collectionIds: Array.isArray(value.collectionIds)
        ? value.collectionIds
        : undefined,
      tagNames: nonEmptyStrings(value.tagNames ?? value.tags),
      includeAutomaticTags: value.includeAutomaticTags === true,
      itemKeys: nonEmptyStrings(value.itemKeys) || nativeItemKeys,
    };
  }
  return value;
}

function normalizeNativePlanContract(
  value: unknown,
  fallbackLibraryID: unknown,
): unknown {
  if (!validateObject<Record<string, unknown>>(value)) return value;
  const contract = { ...value };
  const investigation = validateObject<Record<string, unknown>>(
    contract.investigation,
  )
    ? { ...contract.investigation }
    : undefined;
  if (investigation) {
    investigation.scope = normalizeNativeResearchScope(
      investigation.scope,
      fallbackLibraryID,
    );
    if (Array.isArray(investigation.subquestions)) {
      investigation.subquestions = investigation.subquestions.map(
        (entry, index) =>
          typeof entry === "string"
            ? { id: `question-${index + 1}`, question: entry }
            : entry,
      );
    }
    // Narrative reviews do not perform eligibility screening. Native Codex
    // often describes evidence boundaries in `criteria`; the host already
    // enforces those through the plan steps and research policy.
    if (
      investigation.reviewMode === "narrative" &&
      (!Array.isArray(investigation.criteria) ||
        investigation.criteria.some(
          (criterion) =>
            typeof criterion === "string" ||
            !validateObject<Record<string, unknown>>(criterion),
        ))
    ) {
      investigation.criteria = [];
    }
    if (
      investigation.readingStrategy === "adaptive" &&
      investigation.estimatedDeepReadPapers !== 0
    ) {
      investigation.estimatedDeepReadPapers = 0;
    }
    contract.investigation = investigation;
  }
  if (validateObject<Record<string, unknown>>(contract.deliverable)) {
    const deliverable = { ...contract.deliverable };
    if (
      deliverable.kind === "document" &&
      validateObject<Record<string, unknown>>(deliverable.spec)
    ) {
      const nativeSpec = deliverable.spec;
      const supportedKinds = new Set([
        "research_brief",
        "literature_review",
        "comparison",
        "report",
        "guide",
        "custom",
      ]);
      const nativeKind = nativeSpec.kind ?? nativeSpec.documentKind;
      const kind = supportedKinds.has(String(nativeKind))
        ? nativeKind
        : investigation
          ? "literature_review"
          : "custom";
      const requiredSections =
        nonEmptyStrings(nativeSpec.requiredSections) ||
        nonEmptyStrings(nativeSpec.sections) ||
        (kind === "literature_review"
          ? ["Introduction and scope", "Thematic synthesis", "Conclusion"]
          : ["Overview"]);
      deliverable.spec = {
        kind,
        title: nativeSpec.title,
        requiredSections,
        requiresReferences:
          typeof nativeSpec.requiresReferences === "boolean"
            ? nativeSpec.requiresReferences
            : kind === "literature_review",
        requiresCoverageSection:
          typeof nativeSpec.requiresCoverageSection === "boolean"
            ? nativeSpec.requiresCoverageSection
            : Boolean(investigation),
        allowFigures:
          typeof nativeSpec.allowFigures === "boolean"
            ? nativeSpec.allowFigures
            : false,
      };
    }
    contract.deliverable = deliverable;
  }
  return contract;
}

/**
 * Native Codex commonly authors concise acceptance-check strings in its plan.
 * Promote that shorthand at the native staging boundary so the persisted plan
 * still carries the same typed, host-verifiable requirement contract.
 */
function normalizeNativePlanPreparationInput(args: unknown): unknown {
  if (!validateObject<Record<string, unknown>>(args)) return args;
  if (!Array.isArray(args.steps)) return args;
  const finalStepIndex = args.steps.length - 1;
  return {
    ...args,
    contract: normalizeNativePlanContract(args.contract, args.libraryID),
    steps: args.steps.map((step, stepIndex) => {
      if (!validateObject<Record<string, unknown>>(step)) return step;
      if (!Array.isArray(step.acceptanceCriteria)) return step;
      const planStepId =
        typeof step.planStepId === "string" && step.planStepId.trim()
          ? step.planStepId.trim()
          : `step-${stepIndex + 1}`;
      const criterionBase =
        planStepId
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "") || `step-${stepIndex + 1}`;
      const verifier =
        stepIndex === finalStepIndex &&
        validateObject(args.contract) &&
        validateObject(args.contract.deliverable) &&
        args.contract.deliverable.kind === "document"
          ? "document_integrity"
          : defaultCriterionVerifier(step.expectedEffect);
      return {
        ...step,
        acceptanceCriteria: step.acceptanceCriteria.map(
          (criterion, criterionIndex): unknown => {
            if (typeof criterion !== "string" || !criterion.trim()) {
              return criterion;
            }
            return {
              criterionId: `${criterionBase}-criterion-${criterionIndex + 1}`,
              description: criterion.trim(),
              verifier,
            } satisfies PlanAcceptanceCriterion;
          },
        ),
      };
    }),
  };
}

/** Native Codex authors the proposal; this tool stages only its execution requirements. */
export function createPreparePlanExecutionTool(
  gateway?: ZoteroGateway,
): AgentToolDefinition<UpdatePlanInput, unknown> {
  const original = createUpdatePlanTool(gateway);
  const stepsSchema = PLAN_STEPS_SCHEMA as Record<string, unknown>;
  const stepSchema = stepsSchema.items as Record<string, unknown>;
  const stepProperties = stepSchema.properties as Record<string, unknown>;
  const acceptanceCriteriaSchema = stepProperties.acceptanceCriteria as Record<
    string,
    unknown
  >;
  const contractSchema = PLAN_CONTRACT_SCHEMA as Record<string, unknown>;
  const contractProperties = contractSchema.properties as Record<
    string,
    unknown
  >;
  const investigationSchema = contractProperties.investigation as Record<
    string,
    unknown
  >;
  const investigationProperties = investigationSchema.properties as Record<
    string,
    unknown
  >;
  const scopeSchema = investigationProperties.scope as Record<string, unknown>;
  const scopeProperties = scopeSchema.properties as Record<string, unknown>;
  const deliverableSchema = contractProperties.deliverable as Record<
    string,
    unknown
  >;
  const deliverableProperties = deliverableSchema.properties as Record<
    string,
    unknown
  >;
  const documentSpecSchema = deliverableProperties.spec as Record<
    string,
    unknown
  >;
  return {
    ...original,
    spec: {
      ...original.spec,
      name: "prepare_plan_execution",
      description:
        "Stage the execution requirements for your native Codex plan before completing the proposal. The host canonicalizes concise native research shapes (including singular collection/item/tag scope names, string subquestions, narrative boundary objects, document defaults, and string acceptance checks), freezes the exact Zotero scope, and creates durable tasks. This cannot approve the proposal or execute effects; only the user can approve the later run. Omit effects unless the user requested library changes.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["contract", "steps"],
        properties: {
          contract: {
            ...contractSchema,
            properties: {
              ...contractProperties,
              investigation: {
                ...investigationSchema,
                properties: {
                  ...investigationProperties,
                  subquestions: {
                    ...(investigationProperties.subquestions as Record<
                      string,
                      unknown
                    >),
                    items: {
                      oneOf: [
                        (
                          investigationProperties.subquestions as Record<
                            string,
                            unknown
                          >
                        ).items,
                        { type: "string" },
                      ],
                    },
                  },
                  criteria: {
                    oneOf: [
                      investigationProperties.criteria,
                      {
                        type: "object",
                        description:
                          "Concise narrative-review boundaries; the host normalizes these to its non-screening research policy.",
                        additionalProperties: { type: "string" },
                      },
                    ],
                  },
                  scope: {
                    ...scopeSchema,
                    properties: {
                      ...scopeProperties,
                      kind: {
                        type: "string",
                        enum: [
                          "library",
                          "collection",
                          "collections",
                          "tag",
                          "tags",
                          "item",
                          "items",
                          "mixed",
                        ],
                      },
                      collectionId: { type: "integer", minimum: 1 },
                      items: {
                        type: "array",
                        items: {
                          oneOf: [
                            { type: "string" },
                            {
                              type: "object",
                              additionalProperties: true,
                              properties: {
                                itemKey: { type: "string" },
                                itemId: { type: "integer", minimum: 1 },
                              },
                            },
                          ],
                        },
                      },
                    },
                  },
                },
              },
              deliverable: {
                ...deliverableSchema,
                properties: {
                  ...deliverableProperties,
                  spec: {
                    ...documentSpecSchema,
                    additionalProperties: true,
                    required: ["title"],
                  },
                },
              },
            },
          },
          effectSpecification: PLAN_EFFECT_SPECIFICATION_REFERENCE_SCHEMA,
          steps: {
            ...stepsSchema,
            items: {
              ...stepSchema,
              properties: {
                ...stepProperties,
                acceptanceCriteria: {
                  ...acceptanceCriteriaSchema,
                  items: {
                    oneOf: [acceptanceCriteriaSchema.items, { type: "string" }],
                  },
                },
              },
            },
          },
        },
      },
    },
    guidance: undefined,
    isAvailable: (request) =>
      request.planContext?.phase === "planning" &&
      Boolean(request.planContext.nativePlanning),
    validate: (args) => {
      if (
        validateObject(args) &&
        validateObject(args.contract) &&
        validateObject(args.contract.deliverable) &&
        validateObject(args.contract.deliverable.spec)
      ) {
        const spec = args.contract.deliverable.spec;
        if (
          spec.include !== undefined &&
          !nonEmptyStrings(spec.requiredSections) &&
          !nonEmptyStrings(spec.sections)
        )
          return fail(
            "Specify requiredSections as literal Markdown heading titles. Put content features such as author-year citations and all-paper table coverage in acceptanceCriteria, not an include list of headings.",
          );
      }
      const normalizedArgs = normalizeNativePlanPreparationInput(args);
      if (
        !validateObject(normalizedArgs) ||
        !validateObject(normalizedArgs.contract)
      )
        return fail(
          "prepare_plan_execution requires an explicit typed contract",
        );
      return validateUpdatePlanInput({
        ...normalizedArgs,
        ready: false,
      });
    },
    execute: async (input, context) => {
      if (
        context.request.planContext?.phase !== "planning" ||
        !context.request.planContext.nativePlanning
      ) {
        throw new Error(
          "prepare_plan_execution requires an active native planning attempt",
        );
      }
      const artifact = await preparePlanExecution(
        { ...input, ready: false, explanation: undefined },
        context,
        gateway,
      );
      await context.publishPlanEvent?.({ type: "plan_updated", artifact });
      return {
        artifact,
        next: "Complete your native plan proposal. Execution remains blocked until the user reviews and approves it.",
      };
    },
  };
}
