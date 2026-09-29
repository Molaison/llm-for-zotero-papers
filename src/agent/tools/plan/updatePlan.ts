import { buildPaperDisplayLabels } from "../../../shared/paperDisplayLabels";
import { listScopeSnapshotItems } from "../../research/store";
import type { PlanArtifact } from "../../plans/types";
import type { AgentToolDefinition } from "../../types";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import { readOnlyInvocationPlan } from "../../authorization/invocationPlan";
import {
  preparePlanExecution,
  validateUpdatePlanInput,
  type UpdatePlanInput,
} from "../../plans/preparation";
export {
  validateUpdatePlanInput,
  resolvePlanContract,
  type UpdatePlanInput,
} from "../../plans/preparation";

const PLAN_EFFECT_OPERATIONS = [
  "update_metadata",
  "apply_tags",
  "remove_tags",
  "move_to_collection",
  "remove_from_collection",
  "create_collection",
  "set_item_collections",
  "save_notes_batch",
  "save_saved_search",
  "delete_saved_search",
  "update_collection",
  "update_library_tag",
  "set_item_tags",
  "create_items",
  "reparent_items",
  "relate_items",
  "delete_collection",
  "save_note",
  "import_identifiers",
  "trash_items",
  "restore_from_trash",
  "merge_items",
  "delete_attachment",
  "rename_attachment",
  "relink_attachment",
  "import_local_files",
  "note_create",
  "note_edit",
  "note_append",
  "annotation_write",
  "settings_update",
  "undo",
  "revert",
  "file_write",
  "command_execute",
  "zotero_script_execute",
  "read_full",
] as const;

const PLAN_EFFECT_TARGET_SCHEMA = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["domain", "libraryID", "targetIds", "scopeDigest"],
      properties: {
        domain: { type: "string", enum: ["zotero"] },
        libraryID: { type: "integer", minimum: 1 },
        targetIds: {
          type: "array",
          minItems: 1,
          items: { type: "string" },
          description:
            "Host-resolved native target identities such as item:42 or collection:7.",
        },
        scopeDigest: { type: "string" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["domain", "paths"],
      properties: {
        domain: { type: "string", enum: ["filesystem"] },
        paths: {
          type: "array",
          minItems: 1,
          items: { type: "string" },
        },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["domain", "fingerprints"],
      properties: {
        domain: { type: "string", enum: ["execution"] },
        fingerprints: {
          type: "array",
          minItems: 1,
          items: { type: "string" },
        },
      },
    },
  ],
};

const PLAN_EFFECT_RESTRICTION_SCHEMA = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "effects", "domains", "description"],
      properties: {
        kind: { type: "string", enum: ["deny_effects"] },
        effects: {
          type: "array",
          items: {
            type: "string",
            enum: ["read", "create", "modify", "delete", "execute", "egress"],
          },
        },
        domains: {
          type: "array",
          items: {
            type: "string",
            enum: [
              "zotero_library",
              "filesystem",
              "local_execution",
              "network",
              "privileged_zotero",
            ],
          },
        },
        exceptOperations: { type: "array", items: { type: "string" } },
        operations: { type: "array", items: { type: "string" } },
        description: { type: "string" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "mechanisms", "description"],
      properties: {
        kind: { type: "string", enum: ["deny_mechanisms"] },
        mechanisms: {
          type: "array",
          items: { type: "string", enum: ["shell", "zotero_script"] },
        },
        description: { type: "string" },
      },
    },
  ],
};

const PLAN_MATERIAL_BINDING_SCHEMA = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["role", "material"],
      properties: {
        role: { type: "string" },
        material: {
          type: "object",
          additionalProperties: false,
          required: ["documentId", "documentVersion", "contentHash"],
          properties: {
            documentId: { type: "string" },
            documentVersion: { type: "integer", minimum: 1 },
            contentHash: { type: "string" },
          },
        },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["role", "producedByStepId", "outputId"],
      properties: {
        role: { type: "string" },
        producedByStepId: { type: "string" },
        outputId: { type: "string" },
      },
    },
  ],
};

const PLAN_TARGET_BINDING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["role", "producedByEffectId"],
  properties: {
    role: { type: "string" },
    producedByEffectId: { type: "string" },
  },
};

const PLAN_EFFECT_COMMON_PROPERTIES = {
  effectId: { type: "string" },
  operation: { type: "string", enum: PLAN_EFFECT_OPERATIONS },
  parameters: { type: "object", additionalProperties: true },
  review: { type: "string", enum: ["default", "review", "direct"] },
  targetBindings: { type: "array", items: PLAN_TARGET_BINDING_SCHEMA },
  restrictions: { type: "array", items: PLAN_EFFECT_RESTRICTION_SCHEMA },
  dependsOnEffectIds: { type: "array", items: { type: "string" } },
  materialBindings: { type: "array", items: PLAN_MATERIAL_BINDING_SCHEMA },
};

export function createUpdatePlanTool(
  gateway?: ZoteroGateway,
): AgentToolDefinition<UpdatePlanInput, unknown> {
  return {
    spec: {
      name: "update_plan",
      description:
        "Create or revise the structured plan. Approved steps are immutable; this tool is available only during planning. Set ready=true only when the plan is ready for user review.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["steps", "ready"],
        properties: {
          explanation: {
            type: "string",
            description:
              "User-visible explanation rendered directly in the plan card. Follow the readable paper-mention rule; exact item keys belong in the structured scope fields.",
          },
          ready: { type: "boolean" },
          contract: {
            type: "object",
            description:
              "Composable approved investigation and deliverable. The host adds scopeSnapshot, researchPolicy, and the resolved citationStyle; do not invent them. Describe writes separately in effectSpecification.",
            additionalProperties: false,
            required: ["deliverable"],
            properties: {
              investigation: {
                type: "object",
                additionalProperties: false,
                required: [
                  "question",
                  "subquestions",
                  "criteria",
                  "reviewMode",
                  "readingStrategy",
                  "scope",
                  "requiredEvidenceDepth",
                  "estimatedDeepReadPapers",
                  "approvedLargeCorpus",
                ],
                properties: {
                  question: { type: "string" },
                  subquestions: {
                    type: "array",
                    minItems: 1,
                    items: {
                      type: "object",
                      additionalProperties: false,
                      required: ["id", "question"],
                      properties: {
                        id: { type: "string" },
                        question: { type: "string" },
                      },
                    },
                  },
                  criteria: {
                    type: "array",
                    minItems: 0,
                    items: {
                      type: "object",
                      additionalProperties: false,
                      required: ["id", "description", "kind"],
                      properties: {
                        id: { type: "string" },
                        description: { type: "string" },
                        kind: {
                          type: "string",
                          enum: ["include", "exclude"],
                        },
                      },
                    },
                  },
                  reviewMode: {
                    type: "string",
                    enum: ["narrative", "scoping", "systematic"],
                    description:
                      "Use narrative for an ordinary literature review, scoping to map a field, and systematic only when the user requests formal eligibility screening or a systematic-review method.",
                  },
                  readingStrategy: {
                    type: "string",
                    enum: ["adaptive", "selected"],
                    description:
                      "adaptive reads every paper in the frozen scope to the depth allowed by measured model capacity; selected is only for a user-requested bounded subset or a formal screening workflow.",
                  },
                  scopeAmendmentPolicy: {
                    type: "string",
                    enum: ["fixed", "within_source"],
                    description:
                      "fixed preserves an exact selected subset; within_source allows the host to add newly eligible papers from the same approved source.",
                  },
                  scope: {
                    type: "object",
                    additionalProperties: false,
                    required: ["libraryID", "kind"],
                    properties: {
                      libraryID: { type: "integer", minimum: 1 },
                      kind: {
                        type: "string",
                        enum: [
                          "library",
                          "collections",
                          "tags",
                          "items",
                          "mixed",
                        ],
                      },
                      collectionIds: {
                        type: "array",
                        items: { type: "integer", minimum: 1 },
                      },
                      tagNames: {
                        type: "array",
                        items: { type: "string" },
                      },
                      includeAutomaticTags: { type: "boolean" },
                      itemKeys: {
                        type: "array",
                        items: { type: "string" },
                      },
                    },
                  },
                  queryVariants: {
                    type: "array",
                    items: { type: "string" },
                  },
                  requiredEvidenceDepth: {
                    type: "string",
                    enum: ["metadata", "abstract", "body"],
                  },
                  estimatedDeepReadPapers: {
                    type: "integer",
                    minimum: 0,
                  },
                  approvedLargeCorpus: { type: "boolean" },
                },
              },
              deliverable: {
                type: "object",
                additionalProperties: false,
                required: ["kind"],
                properties: {
                  kind: {
                    type: "string",
                    enum: ["answer", "document", "completion_report"],
                  },
                  spec: {
                    type: "object",
                    description:
                      "Required only when deliverable.kind is document.",
                    additionalProperties: false,
                    required: [
                      "kind",
                      "title",
                      "requiredSections",
                      "requiresReferences",
                      "requiresCoverageSection",
                      "allowFigures",
                    ],
                    properties: {
                      kind: {
                        type: "string",
                        enum: [
                          "research_brief",
                          "literature_review",
                          "comparison",
                          "report",
                          "guide",
                          "custom",
                        ],
                      },
                      title: { type: "string" },
                      requiredSections: {
                        type: "array",
                        minItems: 1,
                        items: { type: "string" },
                      },
                      requiresReferences: { type: "boolean" },
                      requiresCoverageSection: { type: "boolean" },
                      allowFigures: { type: "boolean" },
                    },
                  },
                },
              },
            },
          },
          effectSpecification: {
            type: "object",
            description:
              "Concrete requested effects and restrictions. Omit when the Plan has no effectful action. Use deferredEffects only when research must choose exact targets and a later approval is required.",
            additionalProperties: false,
            required: ["version", "constraints", "effects", "deferredEffects"],
            properties: {
              version: { type: "integer", enum: [1] },
              constraints: {
                type: "array",
                items: PLAN_EFFECT_RESTRICTION_SCHEMA,
              },
              effects: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: [
                    "effectId",
                    "approval",
                    "operation",
                    "targets",
                    "targetBindings",
                    "parameters",
                    "review",
                    "restrictions",
                    "dependsOnEffectIds",
                    "materialBindings",
                  ],
                  properties: {
                    ...PLAN_EFFECT_COMMON_PROPERTIES,
                    approval: { type: "string", enum: ["initial"] },
                    targets: {
                      type: "array",
                      minItems: 1,
                      items: PLAN_EFFECT_TARGET_SCHEMA,
                    },
                  },
                },
              },
              deferredEffects: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: [
                    "effectId",
                    "approval",
                    "operation",
                    "targetSelectionDescription",
                    "targetBindings",
                    "parameters",
                    "review",
                    "restrictions",
                    "dependsOnEffectIds",
                    "materialBindings",
                  ],
                  properties: {
                    ...PLAN_EFFECT_COMMON_PROPERTIES,
                    approval: { type: "string", enum: ["after_research"] },
                    targetSelectionDescription: { type: "string" },
                  },
                },
              },
            },
          },
          steps: {
            type: "array",
            minItems: 1,
            maxItems: 7,
            items: {
              type: "object",
              additionalProperties: false,
              required: [
                "content",
                "activeForm",
                "acceptanceCriteria",
                "expectedEffect",
              ],
              properties: {
                planStepId: { type: "string" },
                effectIds: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "For mutation steps, the stable effect IDs from effectSpecification that this step fulfills.",
                },
                materialOutputId: {
                  type: "string",
                  description:
                    "For an intermediate generated artifact, its ID from requested material outputs. Use verifier material_integrity; saving it is a later mutation step.",
                },
                content: {
                  type: "string",
                  description:
                    "Concise user-visible step, ideally one sentence under 140 characters.",
                },
                activeForm: {
                  type: "string",
                  description:
                    "Short present-progress label shown while this step runs.",
                },
                acceptanceCriteria: {
                  type: "array",
                  minItems: 1,
                  description:
                    "Objective completion checks used by the host; keep implementation detail here rather than in content.",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["criterionId", "description", "verifier"],
                    properties: {
                      criterionId: { type: "string" },
                      description: { type: "string" },
                      verifier: {
                        type: "string",
                        enum: [
                          "verified_read",
                          "research_coverage",
                          "material_integrity",
                          "document_integrity",
                          "document_published",
                          "mutation_receipts",
                          "bounded_reasoning",
                          "user_decision",
                        ],
                      },
                    },
                  },
                },
                expectedCapability: { type: "string" },
                expectedEffect: {
                  type: "string",
                  enum: ["read", "artifact", "mutation", "reasoning"],
                },
              },
            },
          },
        },
      },
      executionClass: "control",
      workCategory: "planning",
    },
    /**
     * The plan machinery itself. Its calls are how a plan is drafted and
     * advanced, and the plan card already shows the reader the outcome, so a
     * row for each of them would report the trace's own plumbing.
     */
    presentation: { hiddenInTrace: true },
    isAvailable: (request) =>
      request.planContext?.phase === "planning" &&
      !request.planContext.nativePlanning,
    guidance: {
      matches: (request) => request.planContext?.phase === "planning",
      instruction:
        "update_plan takes a composable contract and its steps (the planning-phase section owns what the contract should contain). Every acceptance criterion is {criterionId,description,verifier}; the host derives completion requirements, so never provide a separate requirement list. Set ready=true only after the plan is complete for review; the host freezes the exact Zotero corpus, research policy, citation preferences, effect scope, and skill pins.",
    },
    validate: validateUpdatePlanInput,
    planInvocation: () =>
      readOnlyInvocationPlan({
        domains: [],
        reason:
          "This host-owned control updates only the active plan representation.",
      }),
    resolveTerminalResult: (input, result) => {
      if (!input.ready || !result.ok) return null;
      const artifact = (result.content as { artifact?: PlanArtifact })
        ?.artifact;
      if (artifact?.status !== "awaiting_approval") return null;
      return {
        finalText: [
          "The plan is ready for review.",
          artifact.explanation || "",
          artifact.steps
            .map((step, index) => `${index + 1}. ${step.content}`)
            .join("\n"),
        ]
          .filter(Boolean)
          .join("\n\n"),
        providerTranscript: "tool_only",
      };
    },
    execute: async (input, context) => {
      const artifact = await preparePlanExecution(input, context, gateway);
      await context.publishPlanEvent?.({
        type: input.ready ? "plan_ready" : "plan_updated",
        artifact,
      });
      const snapshot = artifact.contract?.investigation?.scopeSnapshot;
      const papers = snapshot
        ? await listScopeSnapshotItems(snapshot.snapshotId)
        : [];
      return {
        artifact,
        displayLabels: Object.fromEntries(
          buildPaperDisplayLabels(
            papers.map((paper) => ({
              ...paper,
              identity: `${paper.libraryID}:${paper.itemKey}`,
            })),
          ),
        ),
      };
    },
  };
}
