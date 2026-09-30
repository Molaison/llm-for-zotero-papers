import type {
  AgentRuntimeRequest,
  AgentToolArtifact,
  AgentToolResult,
} from "../types";
import {
  listTaskEvidence,
  loadPlanArtifact,
  loadPlanExecutionLedger,
} from "./store";
import { planExecutionCoordinator } from "./coordinator";
import type { PlanExecutionLedger, PlanEvent, TaskEvidence } from "./types";
import type { PlanRuntimeContext } from "./types";
import type { ZoteroMcpToolActivityEvent } from "../mcp/activityTypes";
import {
  interruptResearchExecution,
  loadLatestResearchMutationApprovalGrant,
} from "../research/store";
import { validateResearchMutationGrant } from "../research/mutationApproval";
import { researchMutationDigest } from "../research/mutationApproval";
import {
  loadLatestPlanDocumentForExecution,
  loadPlanDocumentOutbox,
} from "../documents/store";
import { createTrustedReadObservations } from "../context/readObservation";
import { planRequiresModelTaskUpdates } from "./taskOwnership";
import { projectLegacyPlanArtifactV5 } from "./effectSpecification";
import type { PlanArtifact, PlanEffectSpecification } from "./types";
import { getAllSkills } from "../skills/catalog";
import { resolvePinnedPlanSkills } from "../skills/planBindings";
import type { ResolvedPlanMaterialBinding } from "./effectAuthorization";
import { loadMaterialRef } from "../documents/workflowMaterial";
import { decodePlanEffectSpecification } from "./decoders";

export function buildPlanFinalCorrection(
  failure: string,
  requiresDocument: boolean,
  documentTaskActive = requiresDocument,
  modelTaskUpdatesRequired = true,
): string {
  if (requiresDocument && documentTaskActive) {
    return `${failure}. This approved plan requires a published document. Do not stop with ordinary answer text and do not try to complete the document task with task_update. Call submit_document now with the model-authored Markdown plus its citation and evidence mappings. If validation rejects the submission, correct the reported fields and call submit_document again; the host finalizer owns References, publication evidence, and completion of the document task.`;
  }
  if (!modelTaskUpdatesRequired) {
    return requiresDocument
      ? `${failure}. Complete the current approved research task: continue with the active research tool; the host advances its task state from verified evidence. Once the document task becomes active, call submit_document with the model-authored Markdown plus its citation and evidence mappings.`
      : `${failure}. Continue with the active scholarly tool; the host advances its task state from verified evidence.`;
  }
  return requiresDocument
    ? `${failure}. Complete the current approved task before attempting document publication. Use task_update only after the current task has its required verified evidence. Once the document task becomes active, call submit_document with the model-authored Markdown plus its citation and evidence mappings; do not try to complete the document task with task_update.`
    : `${failure}. Continue the approved plan. Use task_update only after the current task has verified evidence; do not claim completion from model judgment alone.`;
}

export function shouldOfferPlanFinalCorrection(params: {
  canCorrect: boolean;
  successfulToolResultCount: number;
  lastCorrectionSuccessfulToolCount: number;
}): boolean {
  return (
    params.canCorrect &&
    params.successfulToolResultCount > params.lastCorrectionSuccessfulToolCount
  );
}

export async function recordMcpPlanEvidence(
  plan: PlanRuntimeContext | undefined,
  event: ZoteroMcpToolActivityEvent,
): Promise<PlanExecutionLedger | null> {
  if (plan?.phase !== "executing" || event.phase !== "completed" || !event.ok) {
    return null;
  }
  let ledger = await loadPlanExecutionLedger(plan.executionId);
  const taskId = ledger?.activeTaskId;
  if (!ledger || !taskId) return null;
  if (event.actionReceipts?.length) {
    ledger = await planExecutionCoordinator.attachReceiptEvidence({
      executionId: plan.executionId,
      taskId,
      receipts: event.actionReceipts,
    });
  }
  const evidence = async (
    kind: TaskEvidence["kind"],
    reference: string,
    summary: string,
    payload?: TaskEvidence["payload"],
  ) => {
    const task = ledger?.tasks.find((entry) => entry.taskId === taskId);
    const requirementKind =
      kind === "reasoning_assertion" ? "bounded_reasoning" : kind;
    const requirement = task?.completionRequirements?.find(
      (entry) => entry.kind === requirementKind,
    );
    ledger = await planExecutionCoordinator.attachEvidence({
      version: requirement ? 3 : 1,
      evidenceId: `${plan.executionId}:${taskId}:${kind}:${event.requestId}`,
      executionId: plan.executionId,
      taskId,
      kind,
      verified: true,
      requirementId: requirement?.requirementId,
      criterionIds: requirement?.criterionIds,
      contractDigest: requirement?.contractDigest,
      payload:
        payload ||
        (requirement?.kind === "verified_read"
          ? {
              type: "verified_read",
              reference,
              sources: event.verifiedReadSources,
              observations: event.readObservations,
            }
          : requirement?.kind === "bounded_reasoning"
            ? { type: "bounded_reasoning", assertion: summary }
            : undefined),
      reference,
      summary,
      createdAt: event.timestamp,
    });
  };
  if (event.mutability === "read") {
    await evidence(
      "verified_read",
      `mcp:${event.requestId}`,
      `Verified ${event.toolName} result`,
      {
        type: "verified_read",
        reference: `mcp:${event.requestId}`,
        sources: event.verifiedReadSources,
        observations: event.readObservations,
      },
    );
  }
  if (event.artifacts?.length) {
    await evidence(
      "artifact",
      `mcp:${event.requestId}:artifacts`,
      `${event.artifacts.length} durable artifact${event.artifacts.length === 1 ? "" : "s"}`,
      {
        type: "tool_artifacts",
        artifacts: event.artifacts.map((artifact) => ({
          kind: artifact.kind,
          mimeType: artifact.mimeType,
          storedPath: artifact.storedPath,
          contentHash: artifact.contentHash,
        })),
      },
    );
  }
  return planExecutionCoordinator.advanceVerifiedTasks({
    executionId: plan.executionId,
    requirementKinds: [
      "verified_read",
      "material_integrity",
      "mutation_receipts",
    ],
  });
}

export type PlanFinalDecision =
  | { kind: "accept" }
  | { kind: "correct"; correction: string }
  | { kind: "fail"; failure: string };

export class PlanExecutionRunSession {
  private lastCorrectionSuccessfulToolCount = -1;
  private ledger: PlanExecutionLedger | null = null;
  private artifact: PlanArtifact | null = null;

  constructor(
    private readonly request: Pick<
      AgentRuntimeRequest,
      | "conversationKey"
      | "planContext"
      | "actionContract"
      | "actionProgress"
      | "classifiedIntent"
      | "loadedSkillRecords"
    >,
    /** Plan events only: the runtime stamps the planning stage around them. */
    private readonly emit: (event: PlanEvent) => Promise<void>,
  ) {}

  async initialize(): Promise<
    { kind: "ready" } | { kind: "failed"; userMessage: string }
  > {
    const plan = this.request.planContext;
    if (!plan) return { kind: "ready" };
    if (plan.phase === "planning") {
      const existing = await loadPlanArtifact(plan.planId, plan.revision);
      if (existing?.status === "approved") {
        return {
          kind: "failed",
          userMessage: "This plan revision is already approved and immutable.",
        };
      }
      return { kind: "ready" };
    }
    return this.bindExecution(plan);
  }

  /**
   * Binds this run to one approved execution: checks its identity, digests
   * and pinned skills, rebuilds its write authority, and starts its next task.
   */
  private async bindExecution(
    plan: Extract<PlanRuntimeContext, { phase: "executing" }>,
  ): Promise<{ kind: "ready" } | { kind: "failed"; userMessage: string }> {
    const ledger = await loadPlanExecutionLedger(plan.executionId);
    if (!ledger) {
      return {
        kind: "failed",
        userMessage: "The approved plan execution ledger could not be loaded.",
      };
    }
    if (
      ledger.planId !== plan.planId ||
      ledger.revision !== plan.revision ||
      ledger.planDigest !== plan.approvedDigest ||
      ledger.conversationKey !== this.request.conversationKey
    ) {
      return {
        kind: "failed",
        userMessage:
          "The approved plan identity no longer matches this conversation.",
      };
    }
    const storedArtifact = await loadPlanArtifact(plan.planId, plan.revision);
    if (!storedArtifact || storedArtifact.digest !== plan.approvedDigest) {
      return {
        kind: "failed",
        userMessage: "The approved plan artifact is unavailable or changed.",
      };
    }
    if (
      ledger.version !== 2 ||
      ledger.tasks.some((task) => task.version !== 2)
    ) {
      return {
        kind: "failed",
        userMessage:
          "This plan's legacy progress cannot be converted without losing completion requirements. Review and approve a new revision to continue.",
      };
    }
    let artifact = storedArtifact;
    if (storedArtifact.version !== 5) {
      const projection = await projectLegacyPlanArtifactV5(storedArtifact);
      if (projection.kind !== "compatible") {
        return {
          kind: "failed",
          userMessage: `This legacy plan requires renewed approval: ${projection.reason}`,
        };
      }
      artifact = projection.artifact;
    } else if (
      ledger.effectSpecificationDigest !== artifact.contractDigest ||
      ledger.grant.effectSpecificationDigest !== artifact.contractDigest
    ) {
      return {
        kind: "failed",
        userMessage: "The approved effect specification changed after review.",
      };
    }
    const skillResolution = await resolvePinnedPlanSkills({
      bindings: artifact.skillBindings || [],
      installedSkills: getAllSkills(),
    });
    if (skillResolution.kind !== "compatible") {
      return {
        kind: "failed",
        userMessage: skillResolution.reason,
      };
    }
    this.request.loadedSkillRecords = skillResolution.loadedSkills.map(
      (entry) => entry.loadedSkill,
    );
    if (storedArtifact.version !== 5 && storedArtifact.actionContract) {
      // Compatibility execution keeps the old concrete contract after the v5
      // projection proves that no approved target or restriction was lost.
      this.request.actionContract = storedArtifact.actionContract;
      this.request.classifiedIntent = storedArtifact.actionContract.intent;
      if (
        this.request.actionProgress?.contractId !==
        storedArtifact.actionContract.id
      ) {
        this.request.actionProgress = undefined;
      }
    } else if (artifact.effectSpecification?.deferredEffects.length) {
      // Never retain an action contract inferred from the synthetic execution
      // prompt. Only the separately approved exact-target grant is authority.
      this.request.actionContract = undefined;
      this.request.actionProgress = undefined;
      const grant = await loadLatestResearchMutationApprovalGrant(
        plan.executionId,
      );
      if (grant?.status === "approved") {
        try {
          if (
            grant.version === 4 &&
            ledger.researchEffectSpecificationDigest !==
              grant.effectSpecificationDigest
          ) {
            throw new Error(
              "The research-selected effects changed after approval",
            );
          }
          const validated = await validateResearchMutationGrant({
            grant,
            artifact: storedArtifact,
          });
          if (validated.kind === "v5_effects") {
            artifact = {
              ...artifact,
              effectSpecification: validated.effectSpecification,
            };
          } else {
            this.request.actionContract = validated.contract;
          }
        } catch {
          // A stale grant is never authority. The model must show a refreshed
          // exact-target preview before attempting another write.
        }
      }
    }
    this.artifact = artifact;
    this.ledger = await planExecutionCoordinator.startNextTask(
      plan.executionId,
    );
    this.request.planContext = {
      ...plan,
      activeTaskId: this.ledger.activeTaskId,
    };
    await this.publish({ type: "plan_execution_updated", ledger: this.ledger });
    return { kind: "ready" };
  }

  activeWorkflowObligationIds(): readonly string[] | undefined {
    const plan = this.request.planContext;
    if (!plan) return undefined;
    if (plan.phase !== "executing") return [];
    return (
      this.ledger?.tasks.find(
        (task) => task.taskId === this.ledger?.activeTaskId,
      )?.obligationIds || []
    );
  }

  activeWorkflowEffectIds(): readonly string[] | undefined {
    const plan = this.request.planContext;
    if (!plan) return undefined;
    if (plan.phase !== "executing") return [];
    const task = this.ledger?.tasks.find(
      (entry) => entry.taskId === this.ledger?.activeTaskId,
    );
    if (task?.effectIds?.length) return task.effectIds;
    if (!task || !this.artifact?.effectSpecification) return [];
    return (
      this.artifact.steps.find((step) => step.planStepId === task.planStepId)
        ?.effectIds || []
    );
  }

  approvedEffectSpecification(): PlanEffectSpecification | undefined {
    return this.artifact?.effectSpecification;
  }

  async resolvedWorkflowMaterials(): Promise<
    readonly ResolvedPlanMaterialBinding[]
  > {
    if (!this.artifact?.effectSpecification || !this.ledger) return [];
    const bindings = [
      ...this.artifact.effectSpecification.effects,
      ...this.artifact.effectSpecification.deferredEffects,
    ].flatMap((effect) =>
      effect.materialBindings.filter(
        (
          binding,
        ): binding is Extract<
          (typeof effect.materialBindings)[number],
          { producedByStepId: string }
        > => "producedByStepId" in binding,
      ),
    );
    const resolved: ResolvedPlanMaterialBinding[] = [];
    for (const binding of bindings) {
      const task = this.ledger.tasks.find(
        (entry) =>
          entry.planStepId === binding.producedByStepId &&
          entry.materialOutputId === binding.outputId,
      );
      if (!task) continue;
      const evidence = (
        await listTaskEvidence(this.ledger.executionId, task.taskId)
      ).find(
        (entry) =>
          entry.verified &&
          entry.payload?.type === "material_integrity" &&
          entry.payload.materialOutputId === binding.outputId &&
          entry.payload.documentVersion !== undefined,
      );
      if (evidence?.payload?.type !== "material_integrity") continue;
      const material = {
        documentId: evidence.payload.documentId,
        documentVersion: evidence.payload.documentVersion!,
        contentHash: evidence.payload.contentHash,
      };
      if (!(await loadMaterialRef(material, this.request.conversationKey))) {
        continue;
      }
      resolved.push({
        producedByStepId: binding.producedByStepId,
        outputId: binding.outputId,
        ...material,
      });
    }
    return resolved;
  }

  async resolvedWorkflowTargetBindings(): Promise<
    Readonly<Record<string, readonly string[]>>
  > {
    if (!this.artifact?.effectSpecification || !this.ledger) return {};
    const result: Record<string, string[]> = {};
    for (const effect of this.artifact.effectSpecification.effects) {
      if (!effect.targetBindings.length) continue;
      const resolved = new Set<string>();
      for (const binding of effect.targetBindings) {
        const producerTask = this.ledger.tasks.find((task) =>
          task.effectIds?.includes(binding.producedByEffectId),
        );
        if (!producerTask) continue;
        const evidence = await listTaskEvidence(
          this.ledger.executionId,
          producerTask.taskId,
        );
        for (const entry of evidence) {
          if (
            !entry.verified ||
            entry.kind !== "mutation_receipt" ||
            entry.payload?.type !== "mutation_receipts" ||
            !entry.payload.effectIds?.includes(binding.producedByEffectId) ||
            entry.receipt?.verification !== "verified"
          ) {
            continue;
          }
          for (const target of [
            ...(entry.receipt.appliedTargets || []),
            ...(entry.receipt.alreadySatisfiedTargets || []),
          ]) {
            resolved.add(target);
          }
        }
      }
      if (resolved.size) result[effect.effectId] = [...resolved].sort();
    }
    return result;
  }

  workflowProgress() {
    if (this.request.planContext?.phase !== "executing" || !this.ledger)
      return undefined;
    const active = this.ledger.tasks.find(
      (task) => task.taskId === this.ledger!.activeTaskId,
    );
    return {
      executionId: this.ledger.executionId,
      activeTask: active
        ? {
            taskId: active.taskId,
            content: active.content,
            materialOutputId: active.materialOutputId,
            expectedEffect: active.expectedEffect,
          }
        : null,
      completedTaskIds: this.ledger.tasks
        .filter((task) => task.status === "completed")
        .map((task) => task.taskId),
    };
  }

  async recordToolResult(params: {
    toolName: string;
    executionClass?: "read" | "control" | "external_effect";
    input?: unknown;
    result: AgentToolResult;
    artifacts?: AgentToolArtifact[];
    runId: string;
  }): Promise<void> {
    if (params.result.ok && params.toolName === "amend_plan") {
      await this.adoptSupersedingExecution();
    }
    const plan = this.request.planContext;
    if (!plan || plan.phase !== "executing") return;
    let ledger = await loadPlanExecutionLedger(plan.executionId);
    const taskId = ledger?.activeTaskId;
    if (!ledger || !taskId) return;
    if (
      params.result.ok &&
      params.toolName === "approve_research_mutation" &&
      ledger.researchEffectSpecificationDigest
    ) {
      const content =
        params.result.content &&
        typeof params.result.content === "object" &&
        !Array.isArray(params.result.content)
          ? (params.result.content as Record<string, unknown>)
          : undefined;
      const effectSpecification = decodePlanEffectSpecification(
        content?.effectSpecification,
      );
      if (
        (await researchMutationDigest(effectSpecification)) !==
        ledger.researchEffectSpecificationDigest
      ) {
        throw new Error(
          "The research-selected effects changed after their approval was persisted.",
        );
      }
      if (!this.artifact) {
        throw new Error("The approved Plan effect context is unavailable.");
      }
      // The approval tool can be followed by the actual write in the same
      // agent run. Refresh the in-memory matcher from the persisted digest so
      // the derived effect IDs are immediately usable.
      this.artifact = { ...this.artifact, effectSpecification };
    }
    if (params.result.actionReceipts.length) {
      ledger = await planExecutionCoordinator.attachReceiptEvidence({
        executionId: plan.executionId,
        taskId,
        receipts: params.result.actionReceipts,
      });
    }
    if (params.result.ok && params.executionClass === "read") {
      const reference = `${params.runId}:${params.result.callId}`;
      const observations = await createTrustedReadObservations({
        toolName: params.toolName,
        callId: params.result.callId,
        input: params.input,
        result: params.result.content,
      });
      ledger = await planExecutionCoordinator.attachEvidence(
        this.makeEvidence({
          executionId: plan.executionId,
          taskId,
          kind: "verified_read",
          verified: true,
          payload: {
            type: "verified_read",
            reference,
            sources: observations.map(
              ({
                libraryID,
                itemKey,
                attachmentItemKey,
                pageIndex,
                sourceFingerprint,
              }) => ({
                libraryID,
                itemKey,
                attachmentItemKey,
                pageIndex,
                sourceFingerprint,
              }),
            ),
            observations,
          },
          reference,
          summary: `Verified result from ${params.toolName}`,
        }),
      );
    }
    if (params.result.ok && params.artifacts?.length) {
      ledger = await planExecutionCoordinator.attachEvidence(
        this.makeEvidence({
          executionId: plan.executionId,
          taskId,
          kind: "artifact",
          verified: true,
          payload: {
            type: "tool_artifacts",
            artifacts: params.artifacts.map((artifact) => ({
              kind: artifact.kind,
              mimeType: artifact.mimeType,
              storedPath: artifact.storedPath,
              contentHash: artifact.contentHash,
            })),
          },
          reference: `${params.runId}:${params.result.callId}:artifacts`,
          summary: `${params.artifacts.length} durable artifact${params.artifacts.length === 1 ? "" : "s"}`,
        }),
      );
    }
    const deniedError =
      params.result.content &&
      typeof params.result.content === "object" &&
      !Array.isArray(params.result.content) &&
      typeof (params.result.content as { error?: unknown }).error === "string"
        ? (params.result.content as { error: string }).error
        : "";
    if (
      !params.result.ok &&
      params.toolName === "approve_research_mutation" &&
      deniedError.toLowerCase() === "user denied action"
    ) {
      ledger = await planExecutionCoordinator.attachEvidence({
        version: 1,
        evidenceId: `${plan.executionId}:${taskId}:research-mutation-declined:${params.result.callId}`,
        executionId: plan.executionId,
        taskId,
        kind: "validation",
        verified: true,
        reference: `user-declined:${params.result.callId}`,
        summary:
          "The user declined the exact research-selected mutation preview",
        createdAt: Date.now(),
      });
    }
    ledger = await planExecutionCoordinator.advanceVerifiedTasks({
      executionId: plan.executionId,
      requirementKinds: [
        "verified_read",
        "material_integrity",
        "mutation_receipts",
      ],
    });
    this.ledger = ledger;
    this.request.planContext = {
      ...plan,
      activeTaskId: ledger.activeTaskId,
    };
    await this.publish({ type: "plan_execution_updated", ledger });
  }

  async interrupt(reason: string): Promise<void> {
    const plan = this.request.planContext;
    if (!plan || plan.phase !== "executing") return;
    let ledger = await loadPlanExecutionLedger(plan.executionId);
    const task = ledger?.tasks.find(
      (entry) => entry.taskId === ledger?.activeTaskId,
    );
    if (!ledger || !task || task.status !== "in_progress") return;
    ledger = await planExecutionCoordinator.requestTransition({
      executionId: plan.executionId,
      taskId: task.taskId,
      toStatus: "interrupted",
      requestedBy: plan.provider,
      reason,
    });
    await interruptResearchExecution({
      executionId: plan.executionId,
      conversationKey: this.request.conversationKey,
    });
    this.ledger = ledger;
    this.request.planContext = {
      ...plan,
      activeTaskId: undefined,
    };
    await this.publish({ type: "plan_execution_updated", ledger });
  }

  async evaluateFinal(params: {
    canCorrect: boolean;
    successfulToolResultCount?: number;
  }): Promise<PlanFinalDecision> {
    const successfulToolResultCount = Math.max(
      0,
      params.successfulToolResultCount || 0,
    );
    const canOfferCorrection = shouldOfferPlanFinalCorrection({
      canCorrect: params.canCorrect,
      successfulToolResultCount,
      lastCorrectionSuccessfulToolCount: this.lastCorrectionSuccessfulToolCount,
    });
    const plan = this.request.planContext;
    if (!plan) return { kind: "accept" };
    if (plan.phase === "planning") {
      const artifact = await loadPlanArtifact(plan.planId, plan.revision);
      if (artifact?.status === "awaiting_approval") {
        await this.publish({ type: "plan_ready", artifact });
        return { kind: "accept" };
      }
      const correction =
        "Finish the planning phase by calling update_plan with objective acceptance criteria for every step and ready=true. Do not execute any mutation.";
      if (canOfferCorrection) {
        this.lastCorrectionSuccessfulToolCount = successfulToolResultCount;
        return { kind: "correct", correction };
      }
      return {
        kind: "fail",
        failure: "The provider stopped before producing a reviewable plan.",
      };
    }
    try {
      this.ledger = await loadPlanExecutionLedger(plan.executionId);
      const document = await loadLatestPlanDocumentForExecution(
        plan.executionId,
      );
      if (document) {
        const outbox = await loadPlanDocumentOutbox(document.documentId);
        if (outbox?.status === "pending" || outbox?.status === "delivered") {
          // Publication completion is committed only after the application
          // persists this exact visible message.
          return { kind: "accept" };
        }
      }
      this.ledger = await planExecutionCoordinator.assertCanFinalize(
        plan.executionId,
      );
      await this.publish({
        type: "plan_execution_updated",
        ledger: this.ledger,
      });
      return { kind: "accept" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (canOfferCorrection) {
        this.lastCorrectionSuccessfulToolCount = successfulToolResultCount;
        const artifact = await loadPlanArtifact(plan.planId, plan.revision);
        const requiresDocument =
          (artifact?.version === 4 || artifact?.version === 5) &&
          artifact.contract?.deliverable.kind === "document";
        const activeTask = this.ledger?.tasks.find(
          (task) => task.taskId === this.ledger?.activeTaskId,
        );
        return {
          kind: "correct",
          correction: buildPlanFinalCorrection(
            message,
            requiresDocument,
            activeTask?.expectedEffect === "artifact",
            this.ledger ? planRequiresModelTaskUpdates(this.ledger) : true,
          ),
        };
      }
      return { kind: "fail", failure: message };
    }
  }

  /**
   * An auto-approved contract revision supersedes the bound execution and
   * starts its successor inside this run, so later evidence and finalization
   * belong to the successor. The successor is bound as a new run binds its
   * execution; authority from the predecessor never carries over.
   */
  private async adoptSupersedingExecution(): Promise<void> {
    const plan = this.request.planContext;
    if (plan?.phase !== "executing") return;
    const current = await loadPlanExecutionLedger(plan.executionId);
    if (current?.status !== "superseded" || !current.supersededByExecutionId) {
      return;
    }
    const successor = await loadPlanExecutionLedger(
      current.supersededByExecutionId,
    );
    const artifact = successor
      ? await loadPlanArtifact(successor.planId, successor.revision)
      : null;
    if (
      !successor ||
      !artifact ||
      successor.predecessorExecutionId !== plan.executionId ||
      artifact.status !== "approved"
    ) {
      throw new Error(
        "The superseding Plan execution does not match this conversation's approved revision.",
      );
    }
    // A new execution run starts from its revision's approved contract.
    this.request.actionContract = artifact.actionContract;
    this.request.classifiedIntent = artifact.actionContract?.intent;
    if (
      this.request.actionProgress?.contractId !== artifact.actionContract?.id
    ) {
      this.request.actionProgress = undefined;
    }
    const bound = await this.bindExecution({
      ...plan,
      revision: successor.revision,
      executionId: successor.executionId,
      approvedDigest: successor.planDigest,
    });
    if (bound.kind === "failed") throw new Error(bound.userMessage);
  }

  private makeEvidence(
    params: Omit<TaskEvidence, "version" | "evidenceId" | "createdAt">,
  ): TaskEvidence {
    const createdAt = Date.now();
    const task = this.ledger?.tasks.find(
      (entry) => entry.taskId === params.taskId,
    );
    const requirementKind =
      params.kind === "reasoning_assertion" ? "bounded_reasoning" : params.kind;
    const requirement = task?.completionRequirements?.find(
      (entry) => entry.kind === requirementKind,
    );
    return {
      version: requirement ? 3 : 1,
      evidenceId: `${params.executionId}:${params.taskId}:${params.kind}:${createdAt}:${Math.random().toString(36).slice(2, 7)}`,
      ...params,
      requirementId: requirement?.requirementId,
      criterionIds: requirement?.criterionIds,
      contractDigest: requirement?.contractDigest,
      payload:
        params.payload ||
        (requirement?.kind === "verified_read"
          ? {
              type: "verified_read",
              reference: params.reference || params.summary || "verified read",
            }
          : requirement?.kind === "bounded_reasoning"
            ? {
                type: "bounded_reasoning",
                assertion:
                  params.summary || params.reference || "Reasoning completed",
              }
            : undefined),
      createdAt,
    };
  }

  private async publish(event: PlanEvent): Promise<void> {
    await this.emit(event);
  }
}
