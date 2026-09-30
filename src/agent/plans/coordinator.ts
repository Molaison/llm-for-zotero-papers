import { withConversationWriteLock } from "../../shared/conversationWriteFence";
import type {
  AgentActionContract,
  AgentActionReceipt,
} from "../contracts/types";
import { buildDefaultResearchFrame } from "../research/frame";
import { resolveResearchPolicy } from "../context/researchPolicy";
import { resolvePlannedReadingPapers } from "../context/readingBudget";
import {
  listScopeSnapshotItems,
  saveResearchCorpusItem,
  saveResearchJob,
  saveResearchWorkItem,
} from "../research/store";
import {
  assignCompletionRequirements,
  bindResearchRequirementsToScope,
  normalizeAcceptanceCriteria,
  normalizedText,
  requireFrozenWriteObligations,
  RESEARCH_OWNED_REQUIREMENT_KINDS,
  resolvePreResearchActionContract,
  supersedePriorDraft,
  updatePlanDraft,
} from "./draft";
import {
  listTaskEvidence,
  loadOpenContractRevisionProposal,
  loadPlanArtifact,
  loadPlanExecutionLedger,
  savePlanArtifact,
  savePlanExecutionLedger,
} from "./store";
import {
  assertExecutionMutable,
  assertTaskCompletionEvidence,
} from "./taskState";
import { updatePlanTask } from "./taskUpdates";
import type {
  ApprovedPlanGrant,
  ExecutionTask,
  PlanAcceptanceCriterion,
  PlanArtifact,
  PlanCompletionRequirementKind,
  PlanExecutionLedger,
  PlanEffectSpecification,
  PlanStep,
  TaskEvidence,
  TaskTransitionRequest,
} from "./types";
import { planStepObligationIds } from "./workflowBindings";
import { operationCatalogEntry } from "../contracts/operationCatalog";
import {
  matchPlanEffectReceipt,
  planEffectTargets,
} from "./effectAuthorization";
export {
  canonicalizePlanResearchEvidenceDepth,
  canonicalizePlanVerifierOwnership,
  computePlanContractDigest,
  computePlanDigest,
  resolvePreResearchActionContract,
} from "./draft";
export {
  assertTaskCompletionEvidence,
  assertTaskTransitionRequest,
} from "./taskState";

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export class PlanExecutionCoordinator {
  async bindResearchDerivedEffects(params: {
    executionId: string;
    effectSpecification: PlanEffectSpecification;
    effectSpecificationDigest: string;
    now?: number;
    alreadyInTransaction?: boolean;
  }): Promise<PlanExecutionLedger> {
    const ledger = await this.requireLedger(params.executionId);
    assertExecutionMutable(ledger);
    const artifact = await loadPlanArtifact(ledger.planId, ledger.revision);
    if (
      !artifact ||
      artifact.version !== 5 ||
      artifact.digest !== ledger.planDigest ||
      !artifact.effectSpecification?.deferredEffects.length
    ) {
      throw new Error("The Plan has no deferred v5 effects to bind");
    }
    const derived = params.effectSpecification.effects.filter((effect) =>
      Boolean(effect.derivedFromDeferredEffectId),
    );
    if (!derived.length) {
      throw new Error("The research approval contains no concrete effects");
    }
    const deferredIds = new Set(
      artifact.effectSpecification.deferredEffects.map(
        (effect) => effect.effectId,
      ),
    );
    if (
      derived.some(
        (effect) =>
          !effect.derivedFromDeferredEffectId ||
          !deferredIds.has(effect.derivedFromDeferredEffectId),
      )
    ) {
      throw new Error("A research-derived effect is outside the approved Plan");
    }
    const now = params.now ?? Date.now();
    const tasks = ledger.tasks.map((task) => {
      if (!task.effectIds?.some((id) => deferredIds.has(id))) return task;
      const effectIds = task.effectIds.flatMap((effectId) => {
        if (!deferredIds.has(effectId)) return [effectId];
        return derived
          .filter((effect) => effect.derivedFromDeferredEffectId === effectId)
          .map((effect) => effect.effectId);
      });
      if (!effectIds.length) {
        throw new Error(
          "The exact research approval does not cover every deferred mutation task",
        );
      }
      return { ...task, effectIds, updatedAt: now };
    });
    const updated: PlanExecutionLedger = {
      ...ledger,
      researchEffectSpecificationDigest: params.effectSpecificationDigest,
      tasks,
      updatedAt: now,
    };
    await savePlanExecutionLedger(updated, undefined, {
      alreadyInTransaction: params.alreadyInTransaction,
    });
    return updated;
  }

  async bindResearchDerivedActionContract(params: {
    executionId: string;
    contract: AgentActionContract;
    now?: number;
    alreadyInTransaction?: boolean;
  }): Promise<PlanExecutionLedger> {
    const ledger = await this.requireLedger(params.executionId);
    assertExecutionMutable(ledger);
    const artifact = await loadPlanArtifact(ledger.planId, ledger.revision);
    if (
      !artifact ||
      artifact.digest !== ledger.planDigest ||
      (artifact.version === 5
        ? !artifact.effectSpecification?.deferredEffects.length
        : artifact.contract?.effects?.libraryMutation.approval !==
          "after_research")
    ) {
      throw new Error("The plan does not authorize research-derived writes");
    }
    const now = params.now ?? Date.now();
    const updated: PlanExecutionLedger = {
      ...ledger,
      actionContractId: params.contract.id,
      tasks: ledger.tasks.map((task) =>
        task.expectedEffect === "mutation"
          ? {
              ...task,
              obligationIds: params.contract.obligations
                .filter(
                  (obligation) =>
                    !task.expectedCapability ||
                    obligation.capability === task.expectedCapability,
                )
                .map((obligation) => obligation.id),
              updatedAt: now,
            }
          : task,
      ),
      updatedAt: now,
    };
    if (
      updated.tasks.some(
        (task) =>
          task.expectedEffect === "mutation" && !task.obligationIds.length,
      )
    ) {
      throw new Error(
        "The exact mutation contract does not cover every approved mutation task",
      );
    }
    await savePlanExecutionLedger(updated, undefined, {
      alreadyInTransaction: params.alreadyInTransaction,
    });
    return updated;
  }

  async admitSupportingTask(params: {
    executionId: string;
    taskId: string;
    parentTaskId: string;
    content: string;
    activeForm?: string;
    acceptanceCriteria: readonly PlanAcceptanceCriterion[];
    expectedEffect: PlanStep["expectedEffect"];
    expectedCapability?: string;
    targetIds?: readonly string[];
    now?: number;
  }): Promise<PlanExecutionLedger> {
    const ledger = await this.requireLedger(params.executionId);
    assertExecutionMutable(ledger);
    if (ledger.tasks.some((task) => task.taskId === params.taskId))
      return ledger;
    const parent = ledger.tasks.find(
      (task) => task.taskId === params.parentTaskId,
    );
    if (!parent) throw new Error("Supporting task parent was not found");
    const artifact = await loadPlanArtifact(ledger.planId, ledger.revision);
    if (!artifact || artifact.digest !== ledger.planDigest) {
      throw new Error("Approved plan identity changed");
    }
    const contract = artifact.actionContract;
    if (params.expectedEffect === "mutation") {
      const matching =
        artifact.version === 5
          ? artifact.effectSpecification?.effects.filter((effect) => {
              const authority = operationCatalogEntry(effect.operation);
              return (
                (!params.expectedCapability ||
                  authority?.capability === params.expectedCapability) &&
                (!parent.effectIds?.length ||
                  parent.effectIds.includes(effect.effectId))
              );
            })
          : contract?.obligations.filter(
              (obligation) =>
                !params.expectedCapability ||
                obligation.capability === params.expectedCapability,
            );
      if (!matching?.length) {
        throw new Error(
          "Supporting task is outside the approved action contract",
        );
      }
      if (params.targetIds?.length) {
        const authorized = new Set(
          matching.flatMap((entry) =>
            "targets" in entry
              ? entry.targets.flatMap((target) =>
                  target.domain === "zotero" ? target.targetIds : [],
                )
              : entry.targetBoundary?.frozenTargetIds.map(String) || [],
          ),
        );
        if (
          authorized.size &&
          params.targetIds.some((target) => !authorized.has(String(target)))
        ) {
          throw new Error(
            "Supporting task targets are outside the approved boundary",
          );
        }
      }
    }
    const now = params.now ?? Date.now();
    const acceptanceCriteria = normalizeAcceptanceCriteria(
      params.acceptanceCriteria,
      "Supporting task acceptance criteria",
    );
    const supportingStep = assignCompletionRequirements({
      steps: [
        {
          planStepId: normalizedText(
            params.taskId,
            "Supporting task requirement namespace",
          ),
          content: params.content,
          activeForm: params.activeForm || params.content,
          acceptanceCriteria,
          expectedEffect: params.expectedEffect,
          expectedCapability: params.expectedCapability,
          targetBoundary: params.targetIds?.length
            ? { kind: "selection", targetIds: params.targetIds }
            : undefined,
        },
      ],
      contractDigest: artifact.contractDigest || artifact.digest,
    })[0];
    const child: ExecutionTask = {
      version: 2,
      taskId: normalizedText(params.taskId, "Supporting task ID"),
      executionId: ledger.executionId,
      planStepId: parent.planStepId,
      parentTaskId: parent.taskId,
      kind: "supporting_child",
      content: normalizedText(params.content, "Supporting task content"),
      activeForm: normalizedText(
        params.activeForm || params.content,
        "Supporting task activeForm",
      ),
      acceptanceCriteria,
      expectedEffect: params.expectedEffect,
      completionRequirements: supportingStep.completionRequirements,
      expectedCapability: params.expectedCapability,
      obligationIds: parent.obligationIds,
      effectIds: parent.effectIds,
      status: "pending",
      attemptCount: 0,
      evidenceIds: [],
      failureReasons: [],
      createdAt: now,
      updatedAt: now,
    };
    if (!child.acceptanceCriteria.length) {
      throw new Error("Supporting task requires acceptance criteria");
    }
    const updated: PlanExecutionLedger = {
      ...ledger,
      tasks: [...ledger.tasks, child],
      updatedAt: now,
    };
    await savePlanExecutionLedger(updated);
    return updated;
  }

  async cancelArtifact(params: {
    planId: string;
    revision: number;
    now?: number;
  }): Promise<PlanArtifact | null> {
    const artifact = await loadPlanArtifact(params.planId, params.revision);
    if (!artifact || artifact.status === "approved") return artifact;
    const cancelled: PlanArtifact = {
      ...artifact,
      status: "cancelled",
      updatedAt: params.now ?? Date.now(),
    };
    await savePlanArtifact(cancelled);
    return cancelled;
  }

  updateDraft = updatePlanDraft;

  supersedePriorDraft = supersedePriorDraft;

  async approve(params: {
    expectedDigest?: string;
    planId: string;
    revision: number;
    conversationGeneration: number;
    actionContract?: AgentActionContract;
    providerContinuationId?: string;
    authority?: ApprovedPlanGrant["authority"];
    now?: number;
  }): Promise<PlanExecutionLedger> {
    const artifact = await loadPlanArtifact(params.planId, params.revision);
    if (!artifact) throw new Error("Plan revision not found");
    return withConversationWriteLock(artifact.conversationKey, () =>
      this.approveCurrent(params),
    );
  }

  private async approveCurrent(
    params: Parameters<PlanExecutionCoordinator["approve"]>[0],
  ): Promise<PlanExecutionLedger> {
    const artifact = await loadPlanArtifact(params.planId, params.revision);
    if (!artifact) throw new Error("Plan revision not found");
    if (params.expectedDigest && artifact.digest !== params.expectedDigest)
      throw new Error("The plan changed after this review card was rendered");
    if (artifact.status !== "awaiting_approval") {
      throw new Error("Only a plan awaiting approval can be approved");
    }
    const actionContract =
      artifact.version === 5
        ? undefined
        : resolvePreResearchActionContract(
            artifact.contract,
            artifact.actionContract || params.actionContract,
          );
    if (
      artifact.actionContractId &&
      actionContract?.id !== artifact.actionContractId
    ) {
      throw new Error("The action contract changed after planning");
    }
    if (
      artifact.version !== 5 &&
      artifact.steps.some((step) => step.expectedEffect === "mutation") &&
      artifact.contract?.effects?.libraryMutation.approval !== "after_research"
    ) {
      requireFrozenWriteObligations(actionContract);
    }
    const now = params.now ?? Date.now();
    let amendmentService:
      | import("./amendments").PlanAmendmentService
      | undefined;
    let amendmentGrant:
      | import("./planAmendmentTypes").PlanAmendmentGrant
      | undefined;
    let predecessor: PlanExecutionLedger | null = null;
    if (artifact.revision > 1) {
      const amendment = await loadOpenContractRevisionProposal(artifact.planId);
      if (amendment) {
        const { PlanAmendmentService } = await import("./amendments");
        amendmentService = new PlanAmendmentService();
        predecessor = await loadPlanExecutionLedger(amendment.executionId);
        if (
          !predecessor ||
          predecessor.planId !== artifact.planId ||
          predecessor.revision !== amendment.planRevision ||
          predecessor.planDigest !== amendment.planDigest ||
          ["failed", "cancelled", "superseded"].includes(predecessor.status) ||
          predecessor.conversationKey !== artifact.conversationKey
        ) {
          throw new Error(
            "The contract revision no longer matches its predecessor execution",
          );
        }
        const proposalPayloadDigest = await amendmentService.digest({
          contract: artifact.contract,
          effectSpecification: artifact.effectSpecification,
          steps: artifact.steps,
          skillBindings: artifact.skillBindings,
        });
        if (
          amendment.kind !== "contract_revision" ||
          amendment.goalImpact !== "contract_revision" ||
          amendment.proposalPayloadDigest !== proposalPayloadDigest ||
          amendment.resultingScopeDigest !== artifact.contractDigest
        ) {
          throw new Error(
            "The reviewed Plan revision changed after its amendment proposal was recorded",
          );
        }
        if (
          amendment.executionDigest !==
          (await amendmentService.executionIdentityDigest(predecessor))
        ) {
          throw new Error(
            "The predecessor execution identity changed after the amendment was proposed",
          );
        }
        amendmentGrant = await amendmentService.authorize(
          amendment,
          params.authority || "user",
          now,
        );
      }
    }
    const grant: ApprovedPlanGrant = {
      version: 1,
      planId: artifact.planId,
      revision: artifact.revision,
      planDigest: artifact.digest,
      conversationKey: artifact.conversationKey,
      conversationGeneration: params.conversationGeneration,
      actionContractId: artifact.actionContractId,
      effectSpecificationDigest:
        artifact.version === 5 ? artifact.contractDigest : undefined,
      authority: params.authority || "user",
      approvedAt: now,
    };
    const executionId = makeId(
      `plan-execution-${artifact.planId}-r${artifact.revision}`,
    );
    const approvedScopeDigest =
      artifact.contract?.investigation?.scopeSnapshot?.digest;
    const tasks: ExecutionTask[] = artifact.steps.map((step) => ({
      version: 2,
      taskId: `${executionId}:${step.planStepId}`,
      executionId,
      planStepId: step.planStepId,
      kind: "required_step",
      content: step.content,
      activeForm: step.activeForm,
      acceptanceCriteria: step.acceptanceCriteria,
      expectedEffect: step.expectedEffect,
      actionIndexes: step.actionIndexes,
      effectIds: step.effectIds,
      materialOutputId: step.materialOutputId,
      completionRequirements: approvedScopeDigest
        ? bindResearchRequirementsToScope(
            step.completionRequirements,
            approvedScopeDigest,
          )
        : step.completionRequirements,
      expectedCapability: step.expectedCapability,
      obligationIds: planStepObligationIds(step, actionContract),
      status: "pending",
      attemptCount: 0,
      evidenceIds: [],
      failureReasons: [],
      createdAt: now,
      updatedAt: now,
    }));
    const approved: PlanArtifact = {
      ...artifact,
      status: "approved",
      approvedAt: now,
      updatedAt: now,
    };
    const ledger: PlanExecutionLedger = {
      version: 2,
      executionId,
      planId: artifact.planId,
      revision: artifact.revision,
      planDigest: artifact.digest,
      conversationKey: artifact.conversationKey,
      attempt: 1,
      provider: artifact.provider,
      providerContinuationId:
        params.providerContinuationId ||
        (artifact.nativePlanning && !artifact.nativePlanning.ephemeral
          ? artifact.nativePlanning.threadId
          : undefined),
      actionContractId: artifact.actionContractId,
      effectSpecificationDigest:
        artifact.version === 5 ? artifact.contractDigest : undefined,
      grant,
      status: "pending",
      tasks,
      createdAt: now,
      updatedAt: now,
    };
    let approvedLedger = ledger;
    try {
      await Zotero.DB.executeTransaction(async () => {
        await savePlanArtifact(approved);
        await savePlanExecutionLedger(ledger, undefined, {
          alreadyInTransaction: true,
        });
        const investigation = artifact.contract?.investigation;
        const snapshotId = investigation?.scopeSnapshot?.snapshotId;
        if (investigation && snapshotId) {
          const parentTask = tasks.find((task) =>
            task.completionRequirements?.some(
              (requirement) => requirement.kind === "research_coverage",
            ),
          );
          if (!parentTask) {
            throw new Error(
              "A research plan requires a visible task that owns research coverage",
            );
          }
          const snapshotItems = await listScopeSnapshotItems(snapshotId);
          if (snapshotItems.length !== investigation.scopeSnapshot?.itemCount) {
            throw new Error(
              "The approved research scope snapshot is incomplete",
            );
          }
          const researchJobId = `${executionId}:research`;
          const policy =
            artifact.contract?.researchPolicy ||
            resolveResearchPolicy("plan_research");
          await saveResearchJob(
            {
              version: 2,
              researchJobId,
              executionId,
              parentTaskId: parentTask.taskId,
              contractDigest: artifact.contractDigest || artifact.digest,
              baseSnapshotId: snapshotId,
              snapshotId,
              scopeLineageDigest: investigation.scopeSnapshot!.digest,
              policy,
              status: "pending",
              activeStage: "inventory",
              totalItems: snapshotItems.length,
              screenedItems: 0,
              candidateItems: 0,
              deepReadCompleted: 0,
              deepReadPlanned: resolvePlannedReadingPapers(
                investigation,
                snapshotItems.length,
              ),
              // Adaptive reviews run the network loop: the host frame is
              // the contract every node fills, and the phase starts at nodes.
              ...(investigation.readingStrategy === "adaptive" &&
              investigation.reviewMode !== "systematic"
                ? {
                    frame: buildDefaultResearchFrame(investigation, now),
                    synthesisPhase: "nodes" as const,
                  }
                : {}),
              createdAt: now,
              updatedAt: now,
            },
            artifact.conversationKey,
          );
          for (const snapshotItem of snapshotItems) {
            await saveResearchCorpusItem({
              version: 1,
              researchJobId,
              executionId,
              parentTaskId: parentTask.taskId,
              libraryID: snapshotItem.libraryID,
              itemKey: snapshotItem.itemKey,
              localItemId: snapshotItem.localItemId,
              ordinal: snapshotItem.ordinal,
              screeningStatus: "pending",
              criterionResults: {},
              inventoryRecorded: false,
              hasAbstract: false,
              attachmentItemKeys: [],
              duplicateAttachmentKeys: [],
              readable: Boolean(snapshotItem.attachmentFingerprint),
              indexed: false,
              sourceFingerprint:
                snapshotItem.attachmentFingerprint ||
                snapshotItem.metadataFingerprint,
              updatedAt: now,
            });
            await saveResearchWorkItem({
              version: 1,
              workItemId: `${researchJobId}:work:inventory:${snapshotItem.libraryID}:${snapshotItem.itemKey}`,
              researchJobId,
              executionId,
              parentTaskId: parentTask.taskId,
              libraryID: snapshotItem.libraryID,
              itemKey: snapshotItem.itemKey,
              stage: "inventory",
              subquestionIds: [],
              status: "pending",
              attemptCount: 0,
              evidenceRefs: [],
              createdAt: now,
              updatedAt: now,
            });
          }
        }
        if (
          amendmentService &&
          amendmentGrant &&
          predecessor &&
          predecessor.status !== "superseded"
        ) {
          await amendmentService.migrateSuccessorExecutionState({
            predecessorExecutionId: predecessor.executionId,
            successorExecutionId: ledger.executionId,
            now,
            alreadyInTransaction: true,
          });
          approvedLedger = (
            await this.supersedeExecution({
              executionId: predecessor.executionId,
              successorExecutionId: ledger.executionId,
              now,
              alreadyInTransaction: true,
            })
          ).successor;
          amendmentGrant = await amendmentService.markApplied(
            amendmentGrant,
            now,
          );
        }
      });
    } catch (error) {
      if (amendmentService && amendmentGrant) {
        await amendmentService.markFailed(amendmentGrant, error, now);
      }
      throw error;
    }
    return approvedLedger;
  }

  async supersedeExecution(params: {
    executionId: string;
    successorExecutionId: string;
    now?: number;
    alreadyInTransaction?: boolean;
  }): Promise<{
    superseded: PlanExecutionLedger;
    successor: PlanExecutionLedger;
  }> {
    if (params.executionId === params.successorExecutionId) {
      throw new Error("An execution cannot supersede itself");
    }
    const [current, successor] = await Promise.all([
      this.requireLedger(params.executionId),
      this.requireLedger(params.successorExecutionId),
    ]);
    if (
      current.planId !== successor.planId ||
      successor.revision <= current.revision
    ) {
      throw new Error("A successor execution must use a later Plan revision");
    }
    const now = params.now ?? Date.now();
    const superseded: PlanExecutionLedger = {
      ...current,
      status: "superseded",
      activeTaskId: undefined,
      supersededByExecutionId: successor.executionId,
      updatedAt: now,
      completedAt: now,
    };
    const linkedSuccessor: PlanExecutionLedger = {
      ...successor,
      predecessorExecutionId: current.executionId,
      updatedAt: now,
    };
    const priorArtifact = await loadPlanArtifact(
      current.planId,
      current.revision,
    );
    const write = async () => {
      await savePlanExecutionLedger(superseded, undefined, {
        alreadyInTransaction: true,
      });
      await savePlanExecutionLedger(linkedSuccessor, undefined, {
        alreadyInTransaction: true,
      });
      if (priorArtifact) {
        await savePlanArtifact({
          ...priorArtifact,
          status: "superseded",
          updatedAt: now,
        });
      }
    };
    if (params.alreadyInTransaction) await write();
    else await Zotero.DB.executeTransaction(write);
    return { superseded, successor: linkedSuccessor };
  }

  async startNextTask(
    executionId: string,
    now = Date.now(),
  ): Promise<PlanExecutionLedger> {
    const ledger = await this.requireLedger(executionId);
    assertExecutionMutable(ledger);
    if (ledger.tasks.some((task) => task.status === "in_progress"))
      return ledger;
    const next = ledger.tasks.find(
      (task) => task.status === "pending" || task.status === "interrupted",
    );
    if (!next) return ledger;
    return this.requestTransition(
      {
        executionId,
        taskId: next.taskId,
        toStatus: "in_progress",
        requestedBy: "host",
      },
      now,
    );
  }

  async reopenForScopeAmendment(params: {
    executionId: string;
    scopeLineageDigest: string;
    now?: number;
    alreadyInTransaction?: boolean;
  }): Promise<PlanExecutionLedger> {
    const ledger = await this.requireLedger(params.executionId);
    assertExecutionMutable(ledger);
    const now = params.now ?? Date.now();
    const earliestAffected = ledger.tasks.findIndex((task) =>
      task.completionRequirements?.some((requirement) =>
        ["verified_read", "research_coverage"].includes(requirement.kind),
      ),
    );
    if (earliestAffected < 0) {
      throw new Error(
        "The execution has no host-owned research task to reopen",
      );
    }
    const suffix = params.scopeLineageDigest
      .replace(/[^a-zA-Z0-9]/g, "")
      .slice(-16);
    const tasks: ExecutionTask[] = ledger.tasks.map((task, index) => {
      if (index < earliestAffected) return task;
      const preservesVerifiedEffect =
        task.expectedEffect === "mutation" && task.status === "completed";
      if (preservesVerifiedEffect) return task;
      const completionRequirements = task.completionRequirements?.map(
        (requirement) => ({
          ...requirement,
          requirementId: `${requirement.requirementId}:scope:${suffix}`,
          targetBoundary: RESEARCH_OWNED_REQUIREMENT_KINDS.has(requirement.kind)
            ? {
                ...(requirement.targetBoundary || {}),
                scopeDigest: params.scopeLineageDigest,
              }
            : requirement.targetBoundary,
        }),
      );
      return {
        ...task,
        status: index === earliestAffected ? "in_progress" : "pending",
        attemptCount:
          index === earliestAffected
            ? task.attemptCount + 1
            : task.attemptCount,
        evidenceIds: [],
        failureReasons: [],
        completionRequirements,
        startedAt: index === earliestAffected ? now : undefined,
        completedAt: undefined,
        updatedAt: now,
      };
    });
    const updated: PlanExecutionLedger = {
      ...ledger,
      status: "running",
      activeTaskId: tasks[earliestAffected].taskId,
      tasks,
      completedAt: undefined,
      updatedAt: now,
    };
    await savePlanExecutionLedger(updated, undefined, {
      alreadyInTransaction: params.alreadyInTransaction,
    });
    return updated;
  }

  /**
   * Advance consecutive tasks whose complete contracts are already satisfied
   * by host-issued evidence. Research tools call this at durable boundaries so
   * the model never has to mirror verified host state through task_update.
   */
  async advanceVerifiedTasks(params: {
    executionId: string;
    requirementKinds: readonly PlanCompletionRequirementKind[];
    now?: number;
  }): Promise<PlanExecutionLedger> {
    const allowed = new Set(params.requirementKinds);
    let ledger = await this.requireLedger(params.executionId);
    assertExecutionMutable(ledger);
    let now = params.now ?? Date.now();

    while (true) {
      if (!ledger.tasks.some((task) => task.status === "in_progress")) {
        ledger = await this.startNextTask(params.executionId, now);
      }
      const active = ledger.tasks.find(
        (task) => task.taskId === ledger.activeTaskId,
      );
      if (!active || active.status !== "in_progress") return ledger;
      const requirements = active.completionRequirements || [];
      if (
        !requirements.length ||
        requirements.some((requirement) => !allowed.has(requirement.kind))
      ) {
        return ledger;
      }
      try {
        await this.assertCompletionEvidence(active);
      } catch {
        return ledger;
      }
      ledger = await this.requestTransition(
        {
          executionId: params.executionId,
          taskId: active.taskId,
          toStatus: "completed",
          requestedBy: "host",
        },
        now,
      );
      now += 1;
    }
  }

  /**
   * The research job reports that every manifest paper is durable. This is the
   * only evidence that completes a scope-bound reading task.
   */
  async completeResearchReading(params: {
    executionId: string;
    researchJobId: string;
    scopeLineageDigest: string;
    durablePapers: number;
    totalPapers: number;
    now?: number;
  }): Promise<PlanExecutionLedger> {
    const ledger = await this.requireLedger(params.executionId);
    assertExecutionMutable(ledger);
    const now = params.now ?? Date.now();
    for (const task of ledger.tasks) {
      const requirement = task.completionRequirements?.find(
        (entry) =>
          entry.kind === "verified_read" &&
          entry.targetBoundary?.scopeDigest === params.scopeLineageDigest,
      );
      if (!requirement || task.status === "completed") continue;
      await this.attachEvidence({
        version: 3,
        evidenceId: `${params.researchJobId}:reading:${params.scopeLineageDigest}`,
        executionId: params.executionId,
        taskId: task.taskId,
        kind: "verified_read",
        verified: true,
        requirementId: requirement.requirementId,
        criterionIds: requirement.criterionIds,
        contractDigest: requirement.contractDigest,
        payload: {
          type: "research_reading",
          researchJobId: params.researchJobId,
          scopeLineageDigest: params.scopeLineageDigest,
          durablePapers: params.durablePapers,
          totalPapers: params.totalPapers,
        },
        reference: params.researchJobId,
        summary: `Every manifest paper is durable: ${params.durablePapers}/${params.totalPapers}`,
        createdAt: now,
      });
    }
    return this.advanceVerifiedTasks({
      executionId: params.executionId,
      requirementKinds: ["verified_read"],
      now: now + 1,
    });
  }

  async attachReceiptEvidence(params: {
    executionId: string;
    taskId: string;
    receipts: readonly AgentActionReceipt[];
    now?: number;
  }): Promise<PlanExecutionLedger> {
    const ledger = await this.requireLedger(params.executionId);
    const task = ledger.tasks.find((entry) => entry.taskId === params.taskId);
    if (!task) throw new Error("Execution task not found");
    const artifact =
      ledger.effectSpecificationDigest || task.effectIds?.length
        ? await loadPlanArtifact(ledger.planId, ledger.revision)
        : null;
    if (
      (ledger.effectSpecificationDigest || task.effectIds?.length) &&
      (!artifact || artifact.digest !== ledger.planDigest)
    ) {
      throw new Error("Approved plan identity changed");
    }
    let receipts = params.receipts;
    let receiptEffects;
    if (artifact?.version === 5 && artifact.effectSpecification) {
      const specification = artifact.effectSpecification;
      const matched = params.receipts.flatMap((receipt) => {
        const effectIds = matchPlanEffectReceipt({
          specification,
          activeEffectIds: task.effectIds || [],
          receipt,
        });
        if (effectIds.length) return [{ receipt, effectIds }];
        // A read needs no approval: it counts only toward a read effect the
        // plan named. Only an unmatched write ran outside the approved plan.
        if (receipt.capability === "zotero.read") return [];
        throw new Error(
          `Receipt '${receipt.id}' does not match an active approved effect`,
        );
      });
      if (!matched.length) return ledger;
      receipts = matched.map((entry) => entry.receipt);
      receiptEffects = matched.map(({ receipt, effectIds }) => ({
        receiptId: receipt.id,
        effectIds,
        effectTargets: effectIds.map((effectId) => ({
          effectId,
          targetIds: planEffectTargets(
            specification.effects.find(
              (effect) => effect.effectId === effectId,
            )!,
          ),
        })),
      }));
    }
    return updatePlanTask({
      ...params,
      receipts,
      kind: "receipts",
      receiptEffects,
    });
  }

  async attachEvidence(
    evidence: TaskEvidence,
    options: { alreadyInTransaction?: boolean } = {},
  ): Promise<PlanExecutionLedger> {
    return updatePlanTask({
      kind: "evidence",
      executionId: evidence.executionId,
      taskId: evidence.taskId,
      evidence: [evidence],
      now: evidence.createdAt,
      ...options,
    });
  }

  async requestTransition(
    request: TaskTransitionRequest,
    now = Date.now(),
    options: { alreadyInTransaction?: boolean } = {},
  ): Promise<PlanExecutionLedger> {
    return updatePlanTask({
      kind: "transition",
      executionId: request.executionId,
      taskId: request.taskId,
      request,
      now,
      ...options,
    });
  }

  async requestTransitionWithEvidence(params: {
    request: TaskTransitionRequest;
    evidence: TaskEvidence;
    now?: number;
  }): Promise<PlanExecutionLedger> {
    return updatePlanTask({
      kind: "transition",
      executionId: params.request.executionId,
      taskId: params.request.taskId,
      request: params.request,
      evidence: [params.evidence],
      now: params.now,
    });
  }

  /** Commit a model-supplied transition batch as one database transaction. */
  async requestTransitionBatch(
    updates: readonly Readonly<{
      request: TaskTransitionRequest;
      evidence?: TaskEvidence;
    }>[],
    now = Date.now(),
  ): Promise<PlanExecutionLedger> {
    if (!updates.length)
      throw new Error("At least one task transition is required");
    const executionIds = new Set(
      updates.map((entry) => entry.request.executionId),
    );
    const taskIds = new Set(updates.map((entry) => entry.request.taskId));
    if (executionIds.size !== 1) {
      throw new Error("A task transition batch must belong to one execution");
    }
    if (taskIds.size !== updates.length) {
      throw new Error("A task may appear only once in one transition batch");
    }
    return Zotero.DB.executeTransaction(async () => {
      let ledger: PlanExecutionLedger | undefined;
      for (const update of updates) {
        ledger = await updatePlanTask({
          kind: "transition",
          executionId: update.request.executionId,
          taskId: update.request.taskId,
          request: update.request,
          evidence: update.evidence ? [update.evidence] : undefined,
          now,
          alreadyInTransaction: true,
        });
      }
      return ledger!;
    });
  }

  async assertCanFinalize(executionId: string): Promise<PlanExecutionLedger> {
    const ledger = await this.requireLedger(executionId);
    assertExecutionMutable(ledger);
    const unresolved = ledger.tasks.filter(
      (task) =>
        task.status !== "completed" &&
        !(task.kind === "required_step" && task.status === "skipped") &&
        !(task.kind === "supporting_child" && task.status === "cancelled"),
    );
    if (unresolved.length) {
      throw new Error(
        `Approved plan is not verified complete: ${unresolved
          .map((task) => `${task.content} (${task.status})`)
          .join(", ")}`,
      );
    }
    for (const task of ledger.tasks.filter(
      (entry) => entry.status === "completed",
    )) {
      await this.assertCompletionEvidence(task);
    }
    return ledger;
  }

  private async assertCompletionEvidence(task: ExecutionTask): Promise<void> {
    const evidence = await listTaskEvidence(task.executionId, task.taskId);
    assertTaskCompletionEvidence(task, evidence);
  }

  private async requireLedger(
    executionId: string,
  ): Promise<PlanExecutionLedger> {
    const ledger = await loadPlanExecutionLedger(executionId);
    if (!ledger) throw new Error("Plan execution ledger not found");
    return ledger;
  }
}

export const planExecutionCoordinator = new PlanExecutionCoordinator();
