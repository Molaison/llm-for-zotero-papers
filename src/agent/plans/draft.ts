import type { AgentActionContract } from "../contracts/types";
import { canonicalJson } from "../services/libraryMutation/canonicalJson";
import type { PlanSkillRoutingReceipt } from "../skills/routingTypes";
import { sha256Text } from "../store/journalRecoveryBlobStore";
import { buildDefaultPlanContract, decodePlanContract } from "./contracts";
import { decodePlanEffectSpecification } from "./decoders";
import { buildPlanEffectSpecification } from "./effectSpecification";
import {
  loadOpenContractRevisionProposal,
  loadPlanArtifact,
  loadPlanExecutionLedger,
  savePlanArtifact,
} from "./store";
import type {
  PlanAcceptanceCriterion,
  PlanArtifact,
  PlanCompletionRequirement,
  PlanCompletionRequirementKind,
  PlanContract,
  PlanEffectSpecification,
  PlanProvider,
  PlanSkillBinding,
  PlanStep,
} from "./types";
import { validatePlanEffectBindings } from "./workflowBindings";
import { operationCatalogEntry } from "../contracts/operationCatalog";

export function normalizedText(value: unknown, label: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${label} is required`);
  return text;
}

const CRITERION_VERIFIERS = new Set<PlanCompletionRequirementKind>([
  "verified_read",
  "research_coverage",
  "material_integrity",
  "document_integrity",
  "document_published",
  "mutation_receipts",
  "bounded_reasoning",
  "user_decision",
]);

export function normalizeAcceptanceCriteria(
  value: readonly PlanAcceptanceCriterion[],
  label: string,
): PlanAcceptanceCriterion[] {
  if (!value.length) throw new Error(`${label} requires acceptance criteria`);
  const ids = new Set<string>();
  return value.map((criterion, index) => {
    if (!criterion || typeof criterion !== "object") {
      throw new Error(`${label}[${index}] must be a typed criterion`);
    }
    const criterionId = normalizedText(
      criterion.criterionId,
      `${label}[${index}].criterionId`,
    );
    if (ids.has(criterionId)) {
      throw new Error(`${label} contains duplicate criterion ${criterionId}`);
    }
    ids.add(criterionId);
    if (!CRITERION_VERIFIERS.has(criterion.verifier)) {
      throw new Error(`${label}[${index}].verifier is invalid`);
    }
    return {
      criterionId,
      description: normalizedText(
        criterion.description,
        `${label}[${index}].description`,
      ),
      verifier: criterion.verifier,
    };
  });
}

export async function computePlanContractDigest(
  contract: PlanContract,
  effectSpecification?: PlanEffectSpecification,
): Promise<string> {
  return `sha256:${await sha256Text(
    canonicalJson(
      effectSpecification ? { contract, effectSpecification } : contract,
    ),
  )}`;
}

/**
 * Resolve only the authority that may exist before research has selected its
 * targets. A request-level classifier contract is deliberately ignored for an
 * after-research effect; that authority can only come from the second gate.
 */
export function resolvePreResearchActionContract(
  contract: PlanContract | undefined,
  fallback?: AgentActionContract,
): AgentActionContract | undefined {
  const effect = contract?.effects?.libraryMutation;
  if (effect?.approval === "after_research") return undefined;
  return effect?.approval === "initial" ? effect.contract : fallback;
}

export async function computePlanDigest(params: {
  planId: string;
  conversationKey: number;
  revision: number;
  actionContractId?: string;
  steps: readonly PlanStep[];
  skillRoutingReceipt?: PlanSkillRoutingReceipt;
  skillBindings?: readonly PlanSkillBinding[];
  nativePlanning?: import("./types").NativePlanBinding;
  contract?: PlanContract;
  contractDigest?: string;
  effectSpecification?: PlanEffectSpecification;
}): Promise<string> {
  return `sha256:${await sha256Text(canonicalJson(params))}`;
}

export function assignCompletionRequirements(params: {
  steps: readonly Omit<PlanStep, "completionRequirements">[];
  contractDigest: string;
}): PlanStep[] {
  return params.steps.map((step) => {
    const criteria =
      step.acceptanceCriteria as readonly PlanAcceptanceCriterion[];
    const grouped = new Map<
      PlanCompletionRequirementKind,
      PlanAcceptanceCriterion[]
    >();
    for (const criterion of criteria) {
      const entries = grouped.get(criterion.verifier) || [];
      entries.push(criterion);
      grouped.set(criterion.verifier, entries);
    }
    const completionRequirements: PlanCompletionRequirement[] = [
      ...grouped,
    ].map(([kind, entries]) => ({
      requirementId: `${step.planStepId}:requirement:${kind}`,
      kind,
      criterionIds: entries.map((entry) => entry.criterionId),
      contractDigest: params.contractDigest,
      targetBoundary: step.targetBoundary
        ? {
            targetIds: step.targetBoundary.targetIds,
            scopeDigest: step.targetBoundary.scopeDigest,
            expectedCount: step.targetBoundary.targetIds?.length,
          }
        : undefined,
    }));
    return { ...step, completionRequirements };
  });
}

export const RESEARCH_OWNED_REQUIREMENT_KINDS =
  new Set<PlanCompletionRequirementKind>([
    "verified_read",
    "research_coverage",
  ]);

/**
 * Reading and coverage requirements of a research plan are owned by the
 * research job: they complete against its scope lineage digest, never against
 * an individual read. The binding follows scope amendments.
 */
export function bindResearchRequirementsToScope(
  requirements: readonly PlanCompletionRequirement[] | undefined,
  scopeDigest: string,
): readonly PlanCompletionRequirement[] | undefined {
  return requirements?.map((requirement) =>
    RESEARCH_OWNED_REQUIREMENT_KINDS.has(requirement.kind)
      ? {
          ...requirement,
          targetBoundary: {
            ...(requirement.targetBoundary || {}),
            scopeDigest,
          },
        }
      : requirement,
  );
}

/** A planned deep read is a body-evidence promise, regardless of provider wording. */
export function canonicalizePlanResearchEvidenceDepth(
  contract: PlanContract,
): PlanContract {
  const investigation = contract.investigation;
  if (
    !investigation ||
    (investigation.readingStrategy !== "adaptive" &&
      investigation.estimatedDeepReadPapers <= 0) ||
    investigation.requiredEvidenceDepth === "body"
  ) {
    return contract;
  }
  return {
    ...contract,
    investigation: {
      ...investigation,
      requiredEvidenceDepth: "body",
    },
  };
}

/**
 * Completion verifier placement is a host contract, not a provider formatting
 * exercise. Preserve the model-authored criterion text and IDs while moving
 * research coverage to the final research step and document integrity and
 * publication to the final artifact step.
 */
export function canonicalizePlanVerifierOwnership(params: {
  contract: PlanContract;
  steps: readonly Omit<PlanStep, "completionRequirements">[];
}): Omit<PlanStep, "completionRequirements">[] {
  const steps = params.steps.map((step) => ({
    ...step,
    acceptanceCriteria: (
      step.acceptanceCriteria as readonly PlanAcceptanceCriterion[]
    ).map((criterion) => ({ ...criterion })),
  }));
  const existingIds = new Set(
    steps.flatMap((step) =>
      (step.acceptanceCriteria as readonly PlanAcceptanceCriterion[]).map(
        (criterion) => criterion.criterionId,
      ),
    ),
  );
  const uniqueId = (base: string) => {
    let id = base;
    let suffix = 2;
    while (existingIds.has(id)) id = `${base}-${suffix++}`;
    existingIds.add(id);
    return id;
  };
  const moveKinds = (
    kinds: readonly PlanCompletionRequirementKind[],
    ownerIndex: number,
    defaults: readonly PlanAcceptanceCriterion[],
  ) => {
    const selected: PlanAcceptanceCriterion[] = [];
    for (let index = 0; index < steps.length; index += 1) {
      const retained: PlanAcceptanceCriterion[] = [];
      for (const criterion of steps[index]
        .acceptanceCriteria as readonly PlanAcceptanceCriterion[]) {
        if (kinds.includes(criterion.verifier)) selected.push(criterion);
        else retained.push(criterion);
      }
      steps[index] = { ...steps[index], acceptanceCriteria: retained };
    }
    for (const fallback of defaults) {
      if (!selected.some((entry) => entry.verifier === fallback.verifier)) {
        selected.push({
          ...fallback,
          criterionId: uniqueId(fallback.criterionId),
        });
      }
    }
    steps[ownerIndex] = {
      ...steps[ownerIndex],
      acceptanceCriteria: [
        ...(steps[ownerIndex]
          .acceptanceCriteria as readonly PlanAcceptanceCriterion[]),
        ...selected,
      ],
    };
  };

  if (params.contract.investigation) {
    let researchOwner = -1;
    for (let index = steps.length - 1; index >= 0; index -= 1) {
      if (
        steps[index].expectedEffect === "read" ||
        steps[index].expectedEffect === "reasoning"
      ) {
        researchOwner = index;
        break;
      }
    }
    if (researchOwner < 0) {
      throw new Error("A research plan requires a read or reasoning step");
    }
    moveKinds(["research_coverage"], researchOwner, [
      {
        criterionId: "host-research-coverage",
        description:
          "The frozen corpus is durably screened and the approved evidence depth is complete",
        verifier: "research_coverage",
      },
    ]);
  }

  if (params.contract.deliverable.kind === "document") {
    const documentOwner = steps.length - 1;
    moveKinds(["document_integrity", "document_published"], documentOwner, [
      {
        criterionId: "host-document-integrity",
        description:
          "The finalized document satisfies the approved document contract",
        verifier: "document_integrity",
      },
      {
        criterionId: "host-document-published",
        description: "The finalized document is published to the conversation",
        verifier: "document_published",
      },
    ]);
  }
  for (let index = 0; index < steps.length; index += 1) {
    if (steps[index].acceptanceCriteria.length) continue;
    const verifier: PlanCompletionRequirementKind =
      steps[index].expectedEffect === "read"
        ? "verified_read"
        : steps[index].expectedEffect === "mutation"
          ? "mutation_receipts"
          : "bounded_reasoning";
    steps[index] = {
      ...steps[index],
      acceptanceCriteria: [
        {
          criterionId: uniqueId(`host-step-${index + 1}`),
          description: `Verified completion of: ${steps[index].content}`,
          verifier,
        },
      ],
    };
  }
  return steps;
}

export function requireFrozenWriteObligations(
  contract: AgentActionContract | undefined,
): void {
  if (!contract?.obligations.some((entry) => entry.operation !== "read_full")) {
    throw new Error(
      "This mutation plan has no frozen write obligations. Ask the user to state the requested action and exact targets explicitly, then revise the plan before approval.",
    );
  }
}

function validatePlanStepContract(params: {
  contract: PlanContract;
  effectSpecification: PlanEffectSpecification;
  steps: readonly PlanStep[];
}): void {
  const mutationIndexes = params.steps
    .map((step, index) => (step.expectedEffect === "mutation" ? index : -1))
    .filter((index) => index >= 0);
  const hasEffects = Boolean(
    params.effectSpecification.effects.length ||
    params.effectSpecification.deferredEffects.length,
  );
  if (hasEffects !== Boolean(mutationIndexes.length)) {
    throw new Error(
      hasEffects
        ? "A library-mutation contract requires a mutation plan step"
        : "A mutation plan step requires an approved library-mutation contract",
    );
  }
  validatePlanEffectBindings(params.effectSpecification, params.steps);
  // Material evidence exists only for a draft a later save effect consumes;
  // without that consumer nothing can satisfy the step and execution stalls.
  const consumedMaterials = new Set(
    [
      ...params.effectSpecification.effects,
      ...params.effectSpecification.deferredEffects,
    ].flatMap((effect) =>
      effect.materialBindings.flatMap((binding) =>
        "producedByStepId" in binding
          ? [JSON.stringify([binding.producedByStepId, binding.outputId])]
          : [],
      ),
    ),
  );
  const requirementOwners = new Map<PlanCompletionRequirementKind, number[]>();
  params.steps.forEach((step, index) => {
    for (const requirement of step.completionRequirements || []) {
      const owners = requirementOwners.get(requirement.kind) || [];
      owners.push(index);
      requirementOwners.set(requirement.kind, owners);
      if (
        requirement.kind === "material_integrity" &&
        !consumedMaterials.has(
          JSON.stringify([step.planStepId, step.materialOutputId]),
        )
      ) {
        throw new Error(
          "material_integrity is only for an artifact step whose materialOutputId a later save effect binds; a formal document is finalized in the final artifact step with document_integrity and document_published",
        );
      }
      if (
        requirement.kind === "mutation_receipts" &&
        step.expectedEffect !== "mutation"
      ) {
        throw new Error("Mutation receipts may only complete a mutation step");
      }
      if (
        (requirement.kind === "document_integrity" ||
          requirement.kind === "document_published") &&
        step.expectedEffect !== "artifact"
      ) {
        throw new Error(
          "Document completion requirements require an artifact step",
        );
      }
    }
  });
  const exactlyOne = (kind: PlanCompletionRequirementKind): number => {
    const owners = requirementOwners.get(kind) || [];
    if (owners.length !== 1) {
      throw new Error(`A v3 plan requires exactly one ${kind} owner`);
    }
    return owners[0];
  };
  if (params.contract.investigation) {
    const researchOwner = exactlyOne("research_coverage");
    if (
      params.effectSpecification.deferredEffects.length > 0 &&
      mutationIndexes.some((index) => index <= researchOwner)
    ) {
      throw new Error(
        "Research coverage must complete before a research-selected mutation step",
      );
    }
  } else if (requirementOwners.has("research_coverage")) {
    throw new Error("Research coverage requires an investigation contract");
  }
  if (hasEffects) {
    const receiptOwners = requirementOwners.get("mutation_receipts") || [];
    if (
      receiptOwners.length !== mutationIndexes.length ||
      receiptOwners.some((index) => !mutationIndexes.includes(index))
    ) {
      throw new Error(
        "Every mutation step requires its own mutation-receipts requirement",
      );
    }
  }
  if (params.contract.deliverable.kind === "document") {
    const integrityOwner = exactlyOne("document_integrity");
    const publishedOwner = exactlyOne("document_published");
    const finalIndex = params.steps.length - 1;
    if (
      integrityOwner !== finalIndex ||
      publishedOwner !== finalIndex ||
      params.steps[finalIndex].expectedEffect !== "artifact"
    ) {
      throw new Error(
        "The formal document must be the final artifact step and own integrity and publication",
      );
    }
  } else if (
    requirementOwners.has("document_integrity") ||
    requirementOwners.has("document_published")
  ) {
    throw new Error(
      "Document completion requirements require a document deliverable",
    );
  }
}

export async function updatePlanDraft(params: {
  planId: string;
  conversationKey: number;
  provider: PlanProvider;
  revision: number;
  explanation?: string;
  steps: ReadonlyArray<{
    planStepId?: string;
    actionIndexes?: readonly number[];
    effectIds?: readonly string[];
    materialOutputId?: string;
    content: string;
    activeForm?: string;
    acceptanceCriteria: readonly PlanAcceptanceCriterion[];
    expectedCapability?: string;
    expectedEffect: PlanStep["expectedEffect"];
    targetBoundary?: PlanStep["targetBoundary"];
  }>;
  contract?: PlanContract;
  effectSpecification?: PlanEffectSpecification;
  actionContractId?: string;
  actionContract?: AgentActionContract;
  sourceRunId?: string;
  nativePlanning?: import("./types").NativePlanBinding;
  skillRoutingReceipt?: PlanSkillRoutingReceipt;
  skillBindings?: readonly PlanSkillBinding[];
  ready?: boolean;
  now?: number;
}): Promise<PlanArtifact> {
  if (
    params.nativePlanning &&
    params.ready &&
    !params.nativePlanning.proposal?.markdown.trim()
  ) {
    throw new Error(
      "A completed native proposal is required before plan review",
    );
  }
  const now = params.now ?? Date.now();
  const existing = await loadPlanArtifact(params.planId, params.revision);
  if (existing?.status === "approved") {
    throw new Error("An approved plan revision is immutable");
  }
  if (existing?.status === "cancelled" || existing?.status === "superseded") {
    throw new Error("This plan revision is no longer active");
  }
  if (!params.steps.length)
    throw new Error("A plan requires at least one step");
  const legacyContract = canonicalizePlanResearchEvidenceDepth(
    decodePlanContract(
      params.contract ||
        buildDefaultPlanContract({
          actionContract: params.actionContract,
          steps: params.steps,
        }),
      { requireSnapshot: params.ready === true },
    ),
  );
  const mutationEffect = legacyContract.effects?.libraryMutation;
  const initialMutation =
    mutationEffect?.approval === "initial"
      ? mutationEffect.contract
      : undefined;
  if (
    params.actionContract &&
    initialMutation &&
    params.actionContract.id !== initialMutation.id
  ) {
    throw new Error(
      "The plan contract action authority does not match the request",
    );
  }
  // An inferred request contract cannot authorize targets that research has
  // not selected yet. The only authority for an after-research effect is the
  // separately persisted exact-target grant created at the second gate.
  const actionContract = resolvePreResearchActionContract(
    legacyContract,
    params.actionContract,
  );
  const actionContractId = actionContract?.id;
  if (params.actionContractId && params.actionContractId !== actionContractId) {
    throw new Error(
      "The supplied action contract ID does not match the plan contract",
    );
  }
  const builtEffects = params.effectSpecification
    ? {
        kind: "compatible" as const,
        specification: decodePlanEffectSpecification(
          params.effectSpecification,
        ),
        actionIndexEffectIds: new Map<number, readonly string[]>(),
      }
    : buildPlanEffectSpecification({
        contract: legacyContract,
        actionContract,
      });
  if (params.effectSpecification && legacyContract.effects) {
    throw new Error(
      "A v5 plan must declare effects only through effectSpecification",
    );
  }
  if (builtEffects.kind !== "compatible") {
    throw new Error(
      `The plan requires renewed approval: ${builtEffects.reason}`,
    );
  }
  const effectSpecification = builtEffects.specification;
  const decodedContract: PlanContract = {
    investigation: legacyContract.investigation,
    deliverable: legacyContract.deliverable,
    researchPolicy: legacyContract.researchPolicy,
  };
  const contractDigest = await computePlanContractDigest(
    decodedContract,
    effectSpecification,
  );
  const seen = new Set<string>();
  const seenCriteria = new Set<string>();
  const normalizedSteps = params.steps.map((step, index) => {
    const planStepId =
      step.planStepId?.trim() ||
      `${params.planId}:r${params.revision}:s${index + 1}`;
    if (seen.has(planStepId))
      throw new Error(`Duplicate planStepId: ${planStepId}`);
    seen.add(planStepId);
    const acceptanceCriteria = normalizeAcceptanceCriteria(
      step.acceptanceCriteria,
      `Plan step ${index + 1} acceptance criteria`,
    );
    for (const criterion of acceptanceCriteria) {
      if (seenCriteria.has(criterion.criterionId)) {
        throw new Error(
          `Duplicate acceptance criterion ID: ${criterion.criterionId}`,
        );
      }
      seenCriteria.add(criterion.criterionId);
    }
    return {
      planStepId,
      content: normalizedText(step.content, `Plan step ${index + 1} content`),
      activeForm: normalizedText(
        step.activeForm || step.content,
        `Plan step ${index + 1} activeForm`,
      ),
      acceptanceCriteria,
      expectedCapability: step.expectedCapability?.trim() || undefined,
      expectedEffect: step.expectedEffect,
      effectIds:
        step.effectIds ||
        step.actionIndexes?.flatMap(
          (index) => builtEffects.actionIndexEffectIds.get(index) || [],
        ),
      materialOutputId: step.materialOutputId,
      targetBoundary: step.targetBoundary,
    };
  });
  const candidateEffects = [
    ...effectSpecification.effects,
    ...effectSpecification.deferredEffects,
  ];
  const boundSteps = normalizedSteps.map((step) => {
    if (step.expectedEffect !== "mutation" || step.effectIds?.length) {
      return step;
    }
    const matching = candidateEffects.filter((effect) => {
      const authority = operationCatalogEntry(effect.operation);
      return (
        !step.expectedCapability ||
        authority?.capability === step.expectedCapability
      );
    });
    if (matching.length !== 1) {
      throw new Error(
        `Mutation step '${step.planStepId}' requires frozen write obligations and explicit stable effectIds`,
      );
    }
    return { ...step, effectIds: [matching[0].effectId] };
  });
  const canonicalSteps = canonicalizePlanVerifierOwnership({
    contract: decodedContract,
    steps: boundSteps,
  });
  const steps = assignCompletionRequirements({
    steps: canonicalSteps,
    contractDigest,
  });
  validatePlanStepContract({
    contract: decodedContract,
    effectSpecification,
    steps,
  });
  const skillBindings = [
    ...new Map(
      [
        ...((existing?.version === 5 && existing.skillBindings) || []),
        ...(params.skillBindings || []),
      ].map((binding) => [binding.id, binding]),
    ).values(),
  ].sort((left, right) => left.id.localeCompare(right.id));
  const digest = await computePlanDigest({
    planId: params.planId,
    conversationKey: params.conversationKey,
    revision: params.revision,
    steps,
    skillBindings,
    ...(params.nativePlanning ? { nativePlanning: params.nativePlanning } : {}),
    contract: decodedContract,
    contractDigest,
    effectSpecification,
  });
  const artifact: PlanArtifact = {
    version: 5,
    planId: params.planId,
    conversationKey: params.conversationKey,
    provider: params.provider,
    revision: params.revision,
    digest,
    status: params.ready ? "awaiting_approval" : "drafting",
    explanation: params.explanation?.trim() || undefined,
    sourceRunId: params.sourceRunId || existing?.sourceRunId,
    ...(params.nativePlanning ? { nativePlanning: params.nativePlanning } : {}),
    skillBindings,
    contract: decodedContract,
    contractDigest,
    effectSpecification,
    steps,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  await supersedePriorDraft(params.planId, params.revision, now);
  await savePlanArtifact(artifact);
  if (params.ready && params.revision > 1) {
    const priorAmendment = await loadOpenContractRevisionProposal(
      params.planId,
    );
    if (priorAmendment && params.revision > priorAmendment.planRevision + 1) {
      const predecessor = await loadPlanExecutionLedger(
        priorAmendment.executionId,
      );
      if (
        !predecessor ||
        predecessor.planDigest !== priorAmendment.planDigest ||
        predecessor.planId !== params.planId
      ) {
        throw new Error(
          "The revised amendment no longer matches its predecessor execution",
        );
      }
      const { PlanAmendmentService } = await import("./amendments");
      const service = new PlanAmendmentService();
      const successor = await service.buildProposal({
        kind: "contract_revision",
        goalImpact: "contract_revision",
        planId: priorAmendment.planId,
        planRevision: priorAmendment.planRevision,
        planDigest: priorAmendment.planDigest,
        executionId: priorAmendment.executionId,
        executionDigest: priorAmendment.executionDigest,
        conversationKey: priorAmendment.conversationKey,
        previousScopeDigest: priorAmendment.previousScopeDigest,
        resultingScopeDigest: artifact.contractDigest || artifact.digest,
        targetSetDigest: await service.digest(
          artifact.contract?.investigation?.scope ||
            artifact.contract?.deliverable,
        ),
        proposalPayloadDigest: await service.digest({
          contract: artifact.contract,
          effectSpecification: artifact.effectSpecification,
          steps: artifact.steps,
          skillBindings: artifact.skillBindings,
        }),
        replacementContract: artifact.contract,
        replacementSteps: artifact.steps,
        replacementActionContract: undefined,
        replacementEffectSpecification: artifact.effectSpecification,
        replacementSkillBindings: artifact.skillBindings,
        rationale:
          params.explanation ||
          "The reviewed successor Plan was revised before approval.",
        now,
      });
      await service.supersedeProposal(
        priorAmendment.proposalDigest,
        successor,
        now,
      );
    }
  }
  return artifact;
}

export async function supersedePriorDraft(
  planId: string,
  revision: number,
  now = Date.now(),
): Promise<void> {
  if (revision <= 1) return;
  const prior = await loadPlanArtifact(planId, revision - 1);
  if (
    prior &&
    (prior.status === "drafting" || prior.status === "awaiting_approval")
  ) {
    await savePlanArtifact({
      ...prior,
      status: "superseded",
      updatedAt: now,
    });
  }
}
