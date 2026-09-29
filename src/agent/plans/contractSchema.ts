/**
 * The single owner of the plan-contract JSON schemas the plan tools advertise.
 *
 * update_plan advertises the contract, effect specification, and steps.
 * amend_plan contract_revision references the contract and the effect
 * specification instead of re-embedding them (update_plan and amend_plan are
 * never offered in the same turn). prepare_plan_execution derives its
 * native-alias contract and steps from these constants, because external
 * agents read that shape only from the MCP catalog, and references the effect
 * specification.
 *
 * The schemas guide the model; they are not the host's validation. Every tool
 * still runs the same decoders (decodePlanEffectSpecification in validate(),
 * decodePlanContract when the contract is resolved), so a loosened subtree
 * changes what the model is shown, not what the host accepts.
 *
 * The effect specification keeps its structure and required fields, but its
 * deepest enumerations (operation names, restriction, target, and
 * material-binding variants) are left to the decoder, whose errors name the
 * accepted values. Those subtrees were repeated up to three times inside one
 * schema and cost more than the rest of the plan contract combined.
 */

/**
 * An object whose shape the decoder owns. It still names one property:
 * Gemini's schema sanitizer (sanitizeGeminiSchema) turns a nested object with
 * no properties into a string parameter, so a bare { type: "object" } is not
 * portable across providers.
 */
function decodedObject(discriminator: string, description: string) {
  return {
    type: "object",
    description,
    properties: { [discriminator]: { type: "string" } },
  };
}

const PLAN_TARGET_BINDING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["role", "producedByEffectId"],
  properties: {
    role: { type: "string" },
    producedByEffectId: { type: "string" },
  },
};

const PLAN_EFFECT_RESTRICTION_LIST_SCHEMA = {
  type: "array",
  items: decodedObject(
    "kind",
    "{kind:'deny_effects', effects, domains, description, operations?, exceptOperations?} or {kind:'deny_mechanisms', mechanisms, description}.",
  ),
};

const PLAN_EFFECT_COMMON_PROPERTIES = {
  effectId: { type: "string" },
  operation: {
    type: "string",
    description: "An operation-catalog name such as apply_tags or save_note.",
  },
  parameters: { type: "object", additionalProperties: true },
  review: { type: "string", enum: ["default", "review", "direct"] },
  targetBindings: { type: "array", items: PLAN_TARGET_BINDING_SCHEMA },
  restrictions: PLAN_EFFECT_RESTRICTION_LIST_SCHEMA,
  dependsOnEffectIds: { type: "array", items: { type: "string" } },
  materialBindings: {
    type: "array",
    items: decodedObject(
      "role",
      "Either {role, material:{documentId, documentVersion, contentHash}} or {role, producedByStepId, outputId}.",
    ),
  },
};

export const PLAN_CONTRACT_SCHEMA = {
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
              enum: ["library", "collections", "tags", "items", "mixed"],
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
          description: "Required only when deliverable.kind is document.",
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
};

export const PLAN_EFFECT_SPECIFICATION_SCHEMA = {
  type: "object",
  description:
    "Concrete requested effects and restrictions. Omit when the Plan has no effectful action. Use deferredEffects only when research must choose exact targets and a later approval is required.",
  additionalProperties: false,
  required: ["version", "constraints", "effects", "deferredEffects"],
  properties: {
    version: { type: "integer", enum: [1] },
    constraints: PLAN_EFFECT_RESTRICTION_LIST_SCHEMA,
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
            items: decodedObject(
              "domain",
              "Host-resolved native target: {domain:'zotero', libraryID, targetIds, scopeDigest}, {domain:'filesystem', paths}, or {domain:'execution', fingerprints}.",
            ),
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
};

export const PLAN_STEPS_SCHEMA = {
  type: "array",
  minItems: 1,
  maxItems: 7,
  items: {
    type: "object",
    additionalProperties: false,
    required: ["content", "activeForm", "acceptanceCriteria", "expectedEffect"],
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
        description: "Short present-progress label shown while this step runs.",
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
};

/**
 * A whole replacement contract, by reference to update_plan's shape. It names
 * the contract's two top-level parts so the object survives Gemini's schema
 * sanitizer (a property-less object becomes a string, and a string contract
 * would never reach the decoder as a contract).
 */
export const PLAN_CONTRACT_REFERENCE_SCHEMA = {
  type: "object",
  description: "Plan contract; same shape as update_plan.contract.",
  required: ["deliverable"],
  properties: {
    deliverable: decodedObject(
      "kind",
      "Same shape as update_plan.contract.deliverable.",
    ),
    investigation: decodedObject(
      "question",
      "Same shape as update_plan.contract.investigation.",
    ),
  },
};

/** A whole replacement effect specification, by reference to update_plan's. */
export const PLAN_EFFECT_SPECIFICATION_REFERENCE_SCHEMA = {
  type: "object",
  description:
    "Effect specification; same shape as update_plan.effectSpecification.",
  required: ["version", "constraints", "effects", "deferredEffects"],
  properties: {
    version: { type: "integer", enum: [1] },
    constraints: PLAN_EFFECT_RESTRICTION_LIST_SCHEMA,
    effects: {
      type: "array",
      items: decodedObject("effectId", "Same shape as update_plan effects."),
    },
    deferredEffects: {
      type: "array",
      items: decodedObject(
        "effectId",
        "Same shape as update_plan deferredEffects.",
      ),
    },
  },
};
