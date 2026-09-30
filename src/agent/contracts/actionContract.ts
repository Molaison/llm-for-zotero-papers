import { annotationMatchesPayload } from "../../services/pdf/pdfAnnotationState";
import {
  buildQuoteTextIndex,
  findQuoteSourceSpansAllowingLayoutArtifacts,
} from "../../services/quotes/quoteTextNormalization";
import { actionDependencies } from "./workflowDependencies";
import { validatedWorkflowReuse } from "./workflowContinuation";
import {
  validWorkflowDependencies,
  workflowDependencyIssue,
} from "./workflowDependencies";
import type {
  AgentActionContract,
  AgentActionEvidence,
  AgentActionObligation,
  AgentActionParameters,
  AgentActionProgressLedger,
  AgentActionProposal,
  AgentActionReceipt,
  AgentExternalMutationEvidence,
  AgentLibraryMutationEvidence,
  AgentRuntimeRequest,
  AgentToolDefinition,
  AgentToolEffect,
  AgentToolContext,
} from "../types";
import {
  itemTarget,
  normalizePath,
  prepareActionExecution,
  nativeNoteWriteFacts,
  verifyNoteWriteTarget,
  type ActionContractGateway,
  type PreparedActionExecution,
} from "./actionOperationEvidence";
import {
  ActionReferenceResolutionError,
  listCurrentLibraryTargetIds,
  listScopeTargetIds,
  resolveCreatedDestinations,
  resolveScope,
  resolveDescriptiveTargets,
} from "./actionScope";
import { getOriginalAgentPermissionMode } from "../originalAgentPermissionMode";
import type { OriginalAgentPermissionMode } from "../../shared/originalAgentPermissionMode";
import { canonicalJsonEqual } from "../services/libraryMutation/canonicalJson";
import { mutationPostconditionIsSatisfied } from "../services/libraryMutation/handlerOperations";
import {
  verifyRecordedPostImage,
  type PostImageReader,
} from "../services/recordedPostImage";
import type { RevertedStep } from "../services/changeReverter";
import { innermostToolResult, toolResultString } from "./toolResultEnvelope";
import { readFlatMaterialRef } from "../documents/materialRef";

export type {
  ActionContractGateway,
  PreparedActionExecution,
} from "./actionOperationEvidence";
export {
  describeLibraryMutationActions,
  describeLibraryMutationInput,
  extractLibraryMutationOperations,
} from "./actionOperationEvidence";

export type ScopeValidationFailure = {
  code:
    | "workflow_dependency"
    | "missing_typed_proposal"
    | "different_operation"
    | "different_parameters"
    | "closed_obligation"
    | "hard_constraint"
    | "protected_target"
    | "stale_scope"
    | "fixed_selection"
    | "added_target"
    | "incomplete_batch"
    | "scope_mismatch";
  message: string;
  expectedCount: number;
  proposedCount: number;
  rejectedTargets: string[];
  missingTargets: string[];
  amendableObligation?: {
    obligationId: string;
    libraryID: number;
    boundaryKind: "collection" | "library";
    previousTargetIds: number[];
    currentTargetIds: number[];
    addedTargetIds: number[];
  };
};

function createContractId(request: AgentRuntimeRequest): string {
  return `action-contract:${request.conversationKey}:${Date.now()}:${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

function receiptKey(receipt: AgentActionReceipt): string {
  return [
    receipt.obligationId || "unmatched",
    receipt.proposalId,
    receipt.evidenceRef || receipt.id,
  ].join("|");
}

function sameArrayValues(
  left: readonly unknown[],
  right: readonly unknown[],
): boolean {
  const normalize = (values: readonly unknown[]) =>
    [...new Set(values)].sort((a, b) => String(a).localeCompare(String(b)));
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function parametersMatch(
  expected: AgentActionParameters | undefined,
  actual: AgentActionParameters | undefined,
): boolean {
  if (!expected) return true;
  const actualValue = actual || {};
  return Object.entries(expected).every(([key, value]) => {
    if (value === undefined) return true;
    const proposed = actualValue[key as keyof AgentActionParameters];
    return Array.isArray(value)
      ? Array.isArray(proposed) && sameArrayValues(value, proposed)
      : value && typeof value === "object"
        ? canonicalJsonEqual(value, proposed)
        : proposed === value;
  });
}

function matchingObligations(
  contract: AgentActionContract,
  proposal: AgentActionProposal,
): AgentActionObligation[] {
  return contract.obligations.filter(
    (obligation) =>
      !obligation.destinationCreation &&
      obligation.operation === proposal.operation &&
      obligation.proofDomain === proposal.proofDomain &&
      parametersMatch(obligation.parameters, proposal.parameters) &&
      (obligation.operation !== "move_to_collection" ||
        obligation.parameters?.sourceCollectionId ===
          proposal.parameters?.sourceCollectionId),
  );
}

function obligationStatus(
  progress: AgentActionProgressLedger | undefined,
  obligationId: string,
) {
  return progress?.obligations.find(
    (entry) => entry.obligationId === obligationId,
  )?.status;
}

function obligationIsUnresolved(
  progress: AgentActionProgressLedger | undefined,
  obligationId: string,
): boolean {
  const status = obligationStatus(progress, obligationId);
  return (
    status !== "fulfilled" &&
    status !== "already_satisfied" &&
    status !== "cancelled"
  );
}

function unresolvedBoundaryItemIds(
  obligation: AgentActionObligation,
  progress: AgentActionProgressLedger | undefined,
): number[] {
  if (!obligation.targetBoundary) return [];
  const entry = progress?.obligations.find(
    (candidate) => candidate.obligationId === obligation.id,
  );
  if (!entry) return obligation.targetBoundary.frozenTargetIds;
  if (!obligationIsUnresolved(progress, obligation.id)) return [];
  return entry.unresolvedTargetIds
    .map((target) => Number(target.match(/^item:(\d+)$/)?.[1]))
    .filter((itemId) => Number.isInteger(itemId) && itemId > 0);
}

function isSourceCollectionItemObligation(
  obligation: AgentActionObligation,
): boolean {
  return Boolean(
    obligation.scopeRole !== "destination" &&
    obligation.scope &&
    obligation.targetBoundary?.kind === "collection",
  );
}

function proposalItemTargets(proposal: AgentActionProposal): string[] {
  return proposal.requestedTargets.filter((target) =>
    /^item:\d+$/.test(target),
  );
}

function proposalSatisfiesConstraints(
  obligation: AgentActionObligation,
  proposal: AgentActionProposal,
): boolean {
  const prefix = obligation.constraints?.tagPrefix;
  if (
    prefix &&
    (proposal.parameters?.tags || []).some((tag) => !tag.startsWith(prefix))
  ) {
    return false;
  }
  if (
    obligation.constraints?.collectionMode === "move" &&
    proposal.parameters?.sourceCollectionId === undefined
  ) {
    return false;
  }
  return true;
}

function assignedSourceCollectionObligations(
  contract: AgentActionContract,
  proposal: AgentActionProposal,
  progress?: AgentActionProgressLedger,
): AgentActionObligation[] {
  const requested = new Set(proposalItemTargets(proposal));
  return matchingObligations(contract, proposal).filter(
    (obligation) =>
      isSourceCollectionItemObligation(obligation) &&
      obligationIsUnresolved(progress, obligation.id) &&
      proposalSatisfiesConstraints(obligation, proposal) &&
      unresolvedBoundaryItemIds(obligation, progress).some((itemId) =>
        requested.has(itemTarget(itemId)),
      ),
  );
}

function narrowReceiptToBoundary(
  receipt: AgentActionReceipt,
  obligation: AgentActionObligation,
  addedTargetIds: readonly number[] = [],
): AgentActionReceipt {
  if (!obligation.targetBoundary) return receipt;
  const allowed = new Set(
    [...obligation.targetBoundary.frozenTargetIds, ...addedTargetIds].map(
      itemTarget,
    ),
  );
  const narrow = (targets: string[]) =>
    targets.filter((target) => allowed.has(target));
  return {
    ...receipt,
    requestedTargets: narrow(receipt.requestedTargets),
    appliedTargets: narrow(receipt.appliedTargets),
    alreadySatisfiedTargets: narrow(receipt.alreadySatisfiedTargets),
    rejectedTargets: narrow(receipt.rejectedTargets),
  };
}

function failure(
  message: string,
  contract: AgentActionContract,
  prepared: PreparedActionExecution,
  rejectedTargets: string[] = prepared.requestedTargets,
  missingTargets: string[] = contract.obligations.map(
    (obligation) => obligation.operation,
  ),
  code: ScopeValidationFailure["code"] = "scope_mismatch",
  amendableObligation?: ScopeValidationFailure["amendableObligation"],
): ScopeValidationFailure {
  return {
    code,
    message,
    expectedCount: contract.obligations.length,
    proposedCount: prepared.proposals.length,
    rejectedTargets,
    missingTargets,
    amendableObligation,
  };
}

function numericItemTargets(targets: readonly string[]): number[] {
  return targets
    .map((target) => Number(target.match(/^item:(\d+)$/)?.[1]))
    .filter((itemId) => Number.isInteger(itemId) && itemId > 0);
}

function targetDelta(previous: readonly number[], current: readonly number[]) {
  const oldSet = new Set(previous);
  const currentSet = new Set(current);
  return {
    added: current.filter((itemId) => !oldSet.has(itemId)),
    removed: previous.filter((itemId) => !currentSet.has(itemId)),
  };
}

/**
 * What the action contract can read back for itself.
 *
 * It holds its own narrow Zotero gateway, not the mutation service, so a
 * post-image whose shape needs the mutation handlers reads back as "not
 * re-readable" here rather than as agreement.
 */
function contractPostImageReader(
  gateway: ActionContractGateway,
): PostImageReader {
  return {
    getItem: (itemId) => gateway.getItem(itemId),
    ...(gateway.getSettingNativeState
      ? { readSetting: (key) => gateway.getSettingNativeState!(key).value }
      : {}),
  };
}

function readEvidenceRef(content: unknown): string | undefined {
  return toolResultString(content, ["actionId", "journalStepId"]);
}

function evidenceTargets(evidence: AgentLibraryMutationEvidence): string[] {
  return [
    ...(evidence.postState.items || []).map((item) => `item:${item.itemId}`),
    ...(evidence.postState.collections || []).map(
      (collection) => `collection:${collection.collectionId}`,
    ),
    ...(evidence.postState.savedSearches || []).map(
      (search) => `saved-search:${search.savedSearchId}`,
    ),
  ];
}

function matchingNativeEvidence(
  proposal: AgentActionProposal,
  evidence: AgentActionEvidence[] | undefined,
): AgentLibraryMutationEvidence | undefined {
  return evidence?.find(
    (entry): entry is AgentLibraryMutationEvidence =>
      entry.source === "library_mutation" &&
      entry.proofDomain === "zotero_state" &&
      proposal.operationValue !== undefined &&
      canonicalJsonEqual(entry.operationValue, proposal.operationValue),
  );
}

/**
 * The record the mutation boundary attached for a write that no library
 * mutation operation describes.
 *
 * One `executeExternalMutation` call journals exactly one such step and
 * attaches exactly one record, and a proposal that reaches this point has no
 * operation of its own to match evidence against. Identity therefore comes
 * from the call, and a result carrying several records — a multi-file export
 * writes one per file — is not matched at all rather than matched to whichever
 * came first.
 */
function externalMutationEvidence(
  evidence: AgentActionEvidence[] | undefined,
): AgentExternalMutationEvidence | undefined {
  const external = (evidence || []).filter(
    (entry): entry is AgentExternalMutationEvidence =>
      entry.source === "external_mutation",
  );
  return external.length === 1 ? external[0] : undefined;
}

/**
 * The per-step native re-read `revertActions` performed, as the undo and
 * revert tools report it. A result without it proves nothing about native
 * state, so the receipt treats an empty list as "not re-read".
 */
function revertedSteps(result: Record<string, unknown>): RevertedStep[] {
  const entries = Array.isArray(result.revertedSteps)
    ? result.revertedSteps
    : [];
  return entries.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const step = entry as Record<string, unknown>;
    const verification = String(step.verification || "");
    if (
      verification !== "matched" &&
      verification !== "mismatched" &&
      verification !== "not_re_readable"
    ) {
      return [];
    }
    return [
      {
        actionId: String(step.actionId || ""),
        sequence: Number(step.sequence) || 0,
        verification,
        ...(typeof step.reason === "string" ? { reason: step.reason } : {}),
      } as RevertedStep,
    ];
  });
}

/**
 * A post-state re-read the tool performed for itself, for effects whose proof
 * domain is `execution`. A shell command has no such state and attaches none,
 * which is what keeps `run_command` at `execution_only`.
 */
function readExecutionPostState(content: unknown): {
  verified: boolean;
  facts: string[];
  reason?: string;
} | null {
  const report = innermostToolResult(content).executionPostState;
  if (!report || typeof report !== "object") return null;
  const record = report as Record<string, unknown>;
  if (typeof record.verified !== "boolean") return null;
  return {
    verified: record.verified,
    facts: Array.isArray(record.facts) ? record.facts.map(String) : [],
    ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
  };
}

function fileEvidence(
  proposal: AgentActionProposal,
  content: unknown,
): {
  verified: boolean;
  target: string;
  evidenceRef?: string;
  reason?: string;
} {
  const record = innermostToolResult(content);
  const filePath = String(
    record.filePath || proposal.parameters?.filePath || "",
  );
  const actualHash =
    typeof record.contentHash === "string" ? record.contentHash : "";
  const expectedHash =
    proposal.expectedContentHash ||
    proposal.parameters?.contentHash ||
    (typeof record.expectedContentHash === "string"
      ? record.expectedContentHash
      : "");
  const target = filePath ? `file:${filePath}` : "file:unknown";
  if (!filePath || record.exists !== true || !actualHash) {
    return {
      verified: false,
      target,
      reason:
        "The written file was not read back with an exact path and content hash.",
    };
  }
  if (expectedHash && actualHash !== expectedHash) {
    return {
      verified: false,
      target,
      reason: `File readback hash ${actualHash} did not match ${expectedHash}.`,
    };
  }
  if (proposal.expectedFiles?.length) {
    const files = Array.isArray(record.exportedFiles)
      ? (record.exportedFiles as Record<string, unknown>[])
      : [];
    for (const expected of proposal.expectedFiles) {
      const actual = files.find((file) => file.filePath === expected.path);
      if (
        !actual ||
        actual.exists !== true ||
        actual.contentHash !== expected.contentHash ||
        actual.bytesWritten !== expected.byteLength
      )
        return {
          verified: false,
          target,
          reason: `Export member ${expected.path} was not verified against the authorized bytes.`,
        };
    }
  }
  return { verified: true, target, evidenceRef: `sha256:${actualHash}` };
}

export class ActionContractService {
  constructor(
    private readonly gateway: ActionContractGateway,
    private readonly references?: import("./semanticReferences").SemanticReferenceResolver,
  ) {}

  async createContract(
    request: AgentRuntimeRequest,
    options: { mode?: OriginalAgentPermissionMode } = {},
  ): Promise<AgentActionContract> {
    if (!request.classifiedIntent?.semantic)
      throw new Error(
        "A semantic interpretation is required before constructing an action contract.",
      );
    const judgment =
      (options.mode ?? getOriginalAgentPermissionMode()) === "yolo";
    const semantic = request.classifiedIntent.semantic;
    const assumptions: string[] = [...(semantic.assumptions || [])];
    if (semantic.questions.length) {
      if (!judgment)
        throw new ActionReferenceResolutionError(semantic.questions.join("\n"));
      assumptions.push(
        ...semantic.questions.map(
          (question) => `Unresolved: ${question} The agent decides.`,
        ),
      );
    }
    const skipped = new Map<number, import("./types").AgentActionOperation>();
    const attempt = async <T>(
      index: number,
      operation: import("./types").AgentActionOperation,
      run: () => Promise<T>,
    ): Promise<T | null> => {
      try {
        return await run();
      } catch (error) {
        if (!judgment || !(error instanceof ActionReferenceResolutionError))
          throw error;
        // Judgment authority resolves ambiguity, never the user's own
        // prohibitions: a constraint violation stays a pre-turn refusal.
        if (error.cause === "hard_constraint") throw error;
        skipped.set(index, operation);
        assumptions.push(
          `The requested ${operation.replace(/_/g, " ")} could not be resolved (${error.message}) so the agent will choose its target.`,
        );
        return null;
      }
    };
    if (
      !validWorkflowDependencies(
        request.classifiedIntent.actionIntents,
        request.classifiedIntent.semantic.materialOutputs,
      )
    )
      throw new Error(
        "The semantic workflow contains unresolved or cyclic dependencies.",
      );
    const reuse = validatedWorkflowReuse(request);
    const intents: import("../types").AgentActionIntent[] = [];
    for (const [
      index,
      intent,
    ] of request.classifiedIntent.actionIntents.entries()) {
      const resolvedIntent = reuse?.reuse.actions.some(
        (link) => link.actionIndex === index,
      )
        ? intent
        : await attempt(index, intent.operation, () =>
            resolveDescriptiveTargets(
              this.gateway,
              request,
              intent,
              this.references,
            ),
          );
      // Keep index alignment for dependsOn and destinationFrom; skipped
      // entries produce no obligations below.
      intents.push(resolvedIntent ?? intent);
    }
    if (
      request.classifiedIntent.semantic.reading.coverage === "exhaustive" &&
      !intents.some((intent) => intent.operation === "read_full")
    ) {
      intents.push({
        operation: "read_full",
        capability: "zotero.read",
        proofDomain: "zotero_state",
        coverage: "all",
        targetKind: "papers",
        constraints: { readMode: "full" },
      });
    }
    const writeDisposition =
      request.classifiedIntent?.writeDisposition ||
      (intents.length ? "required" : "none");
    if (writeDisposition === "required" && !intents.length) {
      throw new Error(
        "Action contract construction failed: write intent had no valid typed obligations.",
      );
    }
    if (
      writeDisposition === "none" &&
      intents.some((intent) => intent.operation !== "read_full")
    ) {
      throw new Error(
        "Action contract construction failed: no-write intent contained mutation obligations.",
      );
    }
    const contractId = createContractId(request);
    const reusedActions = new Map(
      (reuse?.reuse.actions || []).map((link) => [
        link.actionIndex,
        reuse!.checkpoint.contract.obligations.filter(
          (obligation, position) =>
            (obligation.sourceActionIndex ?? position) ===
            link.previousActionIndex,
        ),
      ]),
    );
    const collectionCreations = new Map<number, AgentActionObligation[]>();
    for (const [index, intent] of intents.entries()) {
      if (skipped.has(index)) continue;
      if (intent.operation !== "create_collection") continue;
      const created =
        reusedActions.get(index) ||
        (await attempt(index, intent.operation, () =>
          resolveScope(this.gateway, request, intent, [], this.references),
        ));
      if (!created) continue;
      collectionCreations.set(
        index,
        created.map((obligation, offset) => ({
          ...obligation,
          id: `${contractId}:creation:${index}:${offset}`,
          sourceActionIndex: index,
        })),
      );
    }
    const resolved: AgentActionObligation[] = [];
    for (const [index, intent] of intents.entries()) {
      if (skipped.has(index)) continue;
      const obligations =
        collectionCreations.get(index) ||
        reusedActions.get(index) ||
        (await attempt(index, intent.operation, () =>
          resolveScope(
            this.gateway,
            request,
            intent,
            [...collectionCreations.values()].flat(),
            this.references,
            index,
          ),
        ));
      if (!obligations) continue;
      const dependencies = actionDependencies(intent).filter(
        (dependency) => !skipped.has(dependency),
      );
      resolved.push(
        ...obligations.map((obligation) => ({
          ...obligation,
          dependsOn: dependencies.length ? dependencies : undefined,
          contentFrom: intent.contentFrom,
          sourceActionIndex: index,
        })),
      );
    }
    if (reuse)
      for (const obligation of resolved) {
        if (!obligation.destinationCreation) continue;
        const oldId = obligation.destinationCreation.obligationId;
        const old = reuse.checkpoint.contract.obligations.find(
          (entry) => entry.id === oldId,
        );
        const link = reuse.reuse.actions.find(
          (entry) => entry.previousActionIndex === old?.sourceActionIndex,
        );
        const creation = link
          ? collectionCreations.get(link.actionIndex)?.[0]
          : undefined;
        if (old && !creation)
          throw new Error(
            "The reused destination creation has no current workflow owner.",
          );
        if (creation)
          obligation.destinationCreation = {
            ...obligation.destinationCreation,
            obligationId: creation.id,
          };
      }
    // The contract's own copy of the intent is what material production reads,
    // so a skipped action must not remain a prerequisite or an evidence source
    // there: the output falls back to the papers already in turn context.
    const frozenIntent: import("../types").ClassifiedTurnIntent = JSON.parse(
      JSON.stringify(request.classifiedIntent),
    );
    for (const output of frozenIntent.semantic?.materialOutputs || []) {
      const sourceActionIndexes = output.sourceActionIndexes.filter(
        (index) => !skipped.has(index),
      );
      const afterActions = output.afterActions.filter(
        (index) => !skipped.has(index),
      );
      if (
        sourceActionIndexes.length === output.sourceActionIndexes.length &&
        afterActions.length === output.afterActions.length
      )
        continue;
      output.sourceActionIndexes = sourceActionIndexes;
      output.afterActions = afterActions;
      assumptions.push(
        `Material "${output.id}" will draw on the papers in context because its requested source could not be resolved.`,
      );
    }
    return {
      version: 4,
      id: contractId,
      intent: frozenIntent,
      hardConstraints: JSON.parse(
        JSON.stringify(request.classifiedIntent.semantic.constraints),
      ),
      writeDisposition,
      interpretationSource:
        request.classifiedIntent?.actionInterpretationSource || "semantic",
      obligations: resolved.map((obligation, index) => ({
        ...obligation,
        id: obligation.id.startsWith(`${contractId}:creation:`)
          ? obligation.id
          : `${contractId}:obligation:${index}`,
      })),
      ...(assumptions.length ? { assumptions } : {}),
      ...(skipped.size
        ? {
            skippedActions: [...skipped.entries()]
              .sort(([left], [right]) => left - right)
              .map(([actionIndex, operation]) => ({ actionIndex, operation })),
          }
        : {}),
    };
  }

  createProgress(contract: AgentActionContract): AgentActionProgressLedger {
    return {
      version: 1,
      contractId: contract.id,
      state: "pending",
      correctionCount: 0,
      obligations: contract.obligations.map((obligation) => ({
        obligationId: obligation.id,
        status: "open",
        verifiedTargetIds: [],
        unresolvedTargetIds:
          obligation.targetBoundary &&
          (obligation.scopeRole !== "destination" ||
            obligation.destinationCreation)
            ? obligation.targetBoundary.frozenTargetIds.map(itemTarget)
            : [],
        journalStepIds: [],
        failureReasons: [],
      })),
      appliedReceiptKeys: [],
      authorizationGrants: [],
      updatedAt: Date.now(),
    };
  }

  applyReceipts(
    progress: AgentActionProgressLedger,
    receipts: AgentActionReceipt[],
  ): void {
    for (const receipt of receipts) {
      const obligation = progress.obligations.find(
        (entry) => entry.obligationId === receipt.obligationId,
      );
      if (!obligation) continue;
      if (
        obligation.status === "cancelled" ||
        obligation.status === "fulfilled" ||
        obligation.status === "already_satisfied"
      ) {
        continue;
      }
      const key = receiptKey(receipt);
      if (progress.appliedReceiptKeys.includes(key)) continue;
      progress.appliedReceiptKeys.push(key);
      const verifiedTargets = [
        ...receipt.appliedTargets,
        ...receipt.alreadySatisfiedTargets,
      ];
      obligation.verifiedTargetIds = [
        ...new Set([...obligation.verifiedTargetIds, ...verifiedTargets]),
      ];
      obligation.unresolvedTargetIds = obligation.unresolvedTargetIds.filter(
        (target) => !verifiedTargets.includes(target),
      );
      if (receipt.evidenceRef) {
        obligation.journalStepIds = [
          ...new Set([...obligation.journalStepIds, receipt.evidenceRef]),
        ];
      }
      obligation.failureReasons = [
        ...new Set([...obligation.failureReasons, ...receipt.reasons]),
      ];
      if (receipt.status === "cancelled") {
        obligation.status = "cancelled";
      } else if (receipt.status === "failed") {
        obligation.status = "failed";
      } else if (
        receipt.status === "applied" ||
        receipt.status === "already_satisfied" ||
        receipt.status === "observed"
      ) {
        obligation.status = obligation.unresolvedTargetIds.length
          ? "partially_fulfilled"
          : receipt.status === "already_satisfied"
            ? "already_satisfied"
            : "fulfilled";
      } else if (verifiedTargets.length) {
        obligation.status = "partially_fulfilled";
      }
    }
    progress.updatedAt = Date.now();
  }

  resolveWorkflowContract(
    contract: AgentActionContract | undefined,
    progress?: AgentActionProgressLedger,
  ) {
    return contract
      ? resolveCreatedDestinations(this.gateway, contract, progress)
      : undefined;
  }

  async prepare(
    tool: AgentToolDefinition<any, any>,
    input: unknown,
    context?: AgentToolContext,
  ): Promise<PreparedActionExecution> {
    return await prepareActionExecution(tool, input, context);
  }

  async validateScope(
    contract: AgentActionContract | undefined,
    prepared: PreparedActionExecution,
    options: {
      allowPartialCoverage?: boolean;
      concreteWrite?: boolean;
      progress?: AgentActionProgressLedger;
    } = {},
  ): Promise<ScopeValidationFailure | null> {
    if (!contract) return null;
    contract = resolveCreatedDestinations(
      this.gateway,
      contract,
      options.progress,
    );
    if (
      prepared.executionClass === "external_effect" &&
      !prepared.proposals.length &&
      (!prepared.hasExplicitAdapter || options.concreteWrite)
    ) {
      return failure(
        "Write-capable invocation rejected: the tool did not produce a typed action proposal.",
        contract,
        prepared,
        undefined,
        undefined,
        "missing_typed_proposal",
      );
    }
    if (!prepared.proposals.length) return null;
    if (!contract.obligations.length) {
      return failure(
        "The semantic intent contains no authorized action obligations.",
        contract,
        prepared,
        undefined,
        undefined,
        "different_operation",
      );
    }

    for (const proposal of prepared.proposals) {
      const matches = matchingObligations(contract, proposal);
      if (!matches.length) {
        const sameOperation = contract.obligations.filter(
          (obligation) =>
            obligation.operation === proposal.operation &&
            obligation.proofDomain === proposal.proofDomain,
        );
        return failure(
          sameOperation.length
            ? `Action ${proposal.operation} has different parameters from the resolved request. Expected one of ${JSON.stringify(sameOperation.map((obligation) => obligation.parameters || {}))}; received ${JSON.stringify(proposal.parameters || {})}. Resolve this discrepancy before execution.`
            : `Action ${proposal.operation} in ${proposal.proofDomain} does not match any authorized obligation.`,
          contract,
          prepared,
          proposal.requestedTargets.length
            ? proposal.requestedTargets
            : [proposal.operation],
          undefined,
          sameOperation.length ? "different_parameters" : "different_operation",
        );
      }
      let openMatches = matches.filter((obligation) =>
        obligationIsUnresolved(options.progress, obligation.id),
      );
      if (!openMatches.length) {
        const cancelled = matches.some(
          (obligation) =>
            options.progress?.obligations.find(
              (entry) => entry.obligationId === obligation.id,
            )?.status === "cancelled",
        );
        return failure(
          cancelled
            ? `Action ${proposal.operation} was cancelled and cannot be retried without a new user request.`
            : `Action ${proposal.operation} is already verified and cannot be executed again.`,
          contract,
          prepared,
          proposal.requestedTargets,
          [],
          "closed_obligation",
        );
      }
      const dependencies = openMatches.map((obligation) => ({
        obligation,
        issue: workflowDependencyIssue(
          contract!,
          obligation,
          proposal,
          options.progress,
        ),
      }));
      openMatches = dependencies
        .filter((entry) => !entry.issue)
        .map((entry) => entry.obligation);
      if (!openMatches.length)
        return failure(
          dependencies.map((entry) => entry.issue).join(" "),
          contract,
          prepared,
          proposal.requestedTargets,
          [],
          "workflow_dependency",
        );
      for (const obligation of openMatches) {
        if (isSourceCollectionItemObligation(obligation)) continue;
        const prefix = obligation.constraints?.tagPrefix;
        const tags = proposal.parameters?.tags || [];
        if (prefix && tags.some((tag) => !tag.startsWith(prefix))) {
          return failure(
            `Action constraint rejected: every tag must start with "${prefix}".`,
            contract,
            prepared,
            tags
              .filter((tag) => !tag.startsWith(prefix))
              .map((tag) => `tag:${tag}`),
            [],
            "hard_constraint",
          );
        }
      }
      const sourceCollectionMatches = openMatches.filter(
        isSourceCollectionItemObligation,
      );
      const assignedSourceCollections = assignedSourceCollectionObligations(
        contract,
        proposal,
        options.progress,
      );
      if (sourceCollectionMatches.length) {
        const requestedItems = proposalItemTargets(proposal);
        if (!requestedItems.length || !assignedSourceCollections.length) {
          return failure(
            "Action scope rejected: proposed targets do not intersect an unresolved source-collection boundary.",
            contract,
            prepared,
            requestedItems,
            [],
          );
        }
        const libraries = new Set(
          assignedSourceCollections.map(
            (obligation) => obligation.targetBoundary!.libraryID,
          ),
        );
        if (libraries.size !== 1) {
          return failure(
            "Action scope rejected: source-collection boundaries belong to different Zotero libraries.",
            contract,
            prepared,
            requestedItems,
            [],
          );
        }
        const authorizedUnion = new Set(
          assignedSourceCollections.flatMap((obligation) =>
            unresolvedBoundaryItemIds(obligation, options.progress).map(
              itemTarget,
            ),
          ),
        );
        const rejected = requestedItems.filter(
          (target) => !authorizedUnion.has(target),
        );
        if (rejected.length) {
          const currentByObligation = await Promise.all(
            assignedSourceCollections.map(async (obligation) => {
              const scope = obligation.scope!;
              const currentTargets = await listScopeTargetIds(this.gateway, {
                libraryID: scope.libraryID,
                collectionId: scope.collectionId,
                collectionPath: scope.collectionPath,
                targetKind: obligation.targetKind,
                includeDescendants: scope.includeDescendants,
              });
              return { obligation, currentTargets };
            }),
          );
          const amendable = currentByObligation.find(
            ({ obligation, currentTargets }) => {
              const boundary = obligation.targetBoundary!;
              const delta = targetDelta(
                boundary.frozenTargetIds,
                currentTargets,
              );
              const rejectedIds = numericItemTargets(rejected);
              const requestedIds = numericItemTargets(requestedItems);
              const requiredIds = [
                ...unresolvedBoundaryItemIds(obligation, options.progress),
                ...delta.added,
              ];
              return (
                delta.added.length > 0 &&
                delta.removed.length === 0 &&
                rejectedIds.every((itemId) => delta.added.includes(itemId)) &&
                requiredIds.every((itemId) => requestedIds.includes(itemId))
              );
            },
          );
          if (amendable) {
            const boundary = amendable.obligation.targetBoundary!;
            const delta = targetDelta(
              boundary.frozenTargetIds,
              amendable.currentTargets,
            );
            return failure(
              "Action scope includes newly added targets from the approved source.",
              contract,
              prepared,
              rejected,
              [],
              "added_target",
              {
                obligationId: amendable.obligation.id,
                libraryID: boundary.libraryID,
                boundaryKind: boundary.kind as "collection" | "library",
                previousTargetIds: [...boundary.frozenTargetIds],
                currentTargetIds: amendable.currentTargets,
                addedTargetIds: delta.added,
              },
            );
          }
          return failure(
            "Action scope rejected: proposed targets fall outside the assigned source-collection union.",
            contract,
            prepared,
            rejected,
            [],
          );
        }
        for (const obligation of assignedSourceCollections) {
          const scope = obligation.scope!;
          const boundary = obligation.targetBoundary!;
          const currentTargets = await listScopeTargetIds(this.gateway, {
            libraryID: scope.libraryID,
            collectionId: scope.collectionId,
            collectionPath: scope.collectionPath,
            targetKind: obligation.targetKind,
            includeDescendants: scope.includeDescendants,
          });
          const delta = targetDelta(boundary.frozenTargetIds, currentTargets);
          if (delta.added.length || delta.removed.length) {
            return failure(
              "Frozen target scope changed after planning; refresh and retry before mutating.",
              contract,
              prepared,
              [],
              boundary.frozenTargetIds.map(itemTarget),
              "stale_scope",
            );
          }
        }
      }
      for (const obligation of openMatches.filter(
        (entry) => !isSourceCollectionItemObligation(entry),
      )) {
        const scope = obligation.scope;
        if (obligation.scopeRole === "destination" && scope) {
          if (!proposal.destinationCollectionIds.includes(scope.collectionId)) {
            return failure(
              `Action destination must be exact collection ${scope.collectionId}.`,
              contract,
              prepared,
              proposal.destinationCollectionIds.map((id) => `collection:${id}`),
              [`collection:${scope.collectionId}`],
            );
          }
        }
        if (!obligation.targetBoundary) continue;
        const boundary = obligation.targetBoundary;
        const expected = new Set(boundary.frozenTargetIds.map(itemTarget));
        const rejected = proposal.requestedTargets.filter(
          (target) => target.startsWith("item:") && !expected.has(target),
        );
        if (boundary.kind === "selection" && rejected.length) {
          return failure(
            "Action scope rejected: an exact selected target set is fixed.",
            contract,
            prepared,
            rejected,
            [],
            "fixed_selection",
          );
        }
        const currentTargets =
          scope &&
          obligation.scopeRole !== "destination" &&
          (boundary.kind === "collection" || boundary.kind === "selection")
            ? (
                await listScopeTargetIds(this.gateway, {
                  libraryID: scope.libraryID,
                  collectionId: scope.collectionId,
                  collectionPath: scope.collectionPath,
                  targetKind: obligation.targetKind,
                  includeDescendants: scope.includeDescendants,
                })
              ).filter(
                (id) =>
                  boundary.kind === "collection" ||
                  boundary.frozenTargetIds.includes(id),
              )
            : boundary.kind === "library"
              ? await listCurrentLibraryTargetIds(this.gateway, {
                  libraryID: boundary.libraryID,
                  targetKind: obligation.targetKind,
                })
              : boundary.frozenTargetIds.filter((itemId) =>
                  Boolean(this.gateway.getItem(itemId)),
                );
        const delta = targetDelta(boundary.frozenTargetIds, currentTargets);
        if (delta.added.length || delta.removed.length) {
          const requestedIds = numericItemTargets(proposal.requestedTargets);
          const proposalCoversCurrent = [
            ...unresolvedBoundaryItemIds(obligation, options.progress),
            ...delta.added,
          ].every((itemId) => requestedIds.includes(itemId));
          if (
            boundary.kind !== "selection" &&
            delta.added.length > 0 &&
            delta.removed.length === 0 &&
            proposalCoversCurrent
          ) {
            return failure(
              "Action scope includes newly added targets from the approved source.",
              contract,
              prepared,
              delta.added.map(itemTarget),
              [],
              "added_target",
              {
                obligationId: obligation.id,
                libraryID: boundary.libraryID,
                boundaryKind: boundary.kind,
                previousTargetIds: [...boundary.frozenTargetIds],
                currentTargetIds: currentTargets,
                addedTargetIds: delta.added,
              },
            );
          }
          return failure(
            "Frozen target scope changed after planning; refresh and retry before mutating.",
            contract,
            prepared,
            [],
            boundary.frozenTargetIds.map(itemTarget),
            "stale_scope",
          );
        }
        if (rejected.length) {
          return failure(
            "Action scope rejected: proposed targets fall outside the frozen boundary.",
            contract,
            prepared,
            rejected,
            [],
            boundary.kind === "selection"
              ? "fixed_selection"
              : "scope_mismatch",
          );
        }
      }
    }

    for (const obligation of contract.obligations) {
      const progressStatus = options.progress?.obligations.find(
        (entry) => entry.obligationId === obligation.id,
      )?.status;
      if (
        progressStatus === "fulfilled" ||
        progressStatus === "already_satisfied" ||
        progressStatus === "cancelled" ||
        !obligation.targetBoundary ||
        obligation.scopeRole === "destination" ||
        !prepared.proposals.some((proposal) =>
          matchingObligations(contract, proposal).includes(obligation),
        ) ||
        options.allowPartialCoverage
      ) {
        continue;
      }
      const proposed = new Set(
        prepared.proposals
          .filter((proposal) => {
            if (!isSourceCollectionItemObligation(obligation)) {
              return matchingObligations(contract, proposal).includes(
                obligation,
              );
            }
            return assignedSourceCollectionObligations(
              contract,
              proposal,
              options.progress,
            ).includes(obligation);
          })
          .flatMap((proposal) => proposal.requestedTargets),
      );
      const missing = unresolvedBoundaryItemIds(obligation, options.progress)
        .map(itemTarget)
        .filter((target) => !proposed.has(target));
      if (missing.length) {
        return failure(
          "Action coverage rejected: every frozen target must be authorized before the batch starts.",
          contract,
          prepared,
          [],
          missing,
          "incomplete_batch",
        );
      }
    }
    return null;
  }

  async finalize(
    contract: AgentActionContract | undefined,
    prepared: PreparedActionExecution,
    params: {
      ok: boolean;
      effect?: AgentToolEffect;
      cancelled?: boolean;
      reason?: string;
      content?: unknown;
      actionEvidence?: AgentActionEvidence[];
    },
    progress?: AgentActionProgressLedger,
    amendment?: Readonly<{
      obligationId: string;
      addedTargetIds: readonly number[];
    }>,
  ): Promise<AgentActionReceipt[]> {
    if (contract)
      contract = resolveCreatedDestinations(this.gateway, contract, progress);
    const batches = prepared.proposals.map((proposal) => {
      let obligations: Array<AgentActionObligation | undefined>;
      if (!contract) {
        obligations = [undefined];
      } else {
        const matches = matchingObligations(contract, proposal);
        const hasSourceCollectionMatch = matches.some(
          isSourceCollectionItemObligation,
        );
        obligations = hasSourceCollectionMatch
          ? [
              ...assignedSourceCollectionObligations(
                contract,
                proposal,
                progress,
              ),
              ...matches.filter(
                (obligation) =>
                  !isSourceCollectionItemObligation(obligation) &&
                  obligationIsUnresolved(progress, obligation.id),
              ),
            ]
          : matches;
      }
      return (obligations.length ? obligations : [undefined]).map(
        async (obligation) => {
          const receipt = await this.finalizeProposal(
            proposal,
            obligation,
            params,
          );
          return obligation && isSourceCollectionItemObligation(obligation)
            ? narrowReceiptToBoundary(
                receipt,
                obligation,
                amendment?.obligationId === obligation.id
                  ? amendment.addedTargetIds
                  : [],
              )
            : receipt;
        },
      );
    });
    return (
      await Promise.all(batches.map((batch) => Promise.all(batch)))
    ).flat();
  }

  private async finalizeProposal(
    proposal: AgentActionProposal,
    obligation: AgentActionObligation | undefined,
    params: {
      ok: boolean;
      effect?: AgentToolEffect;
      cancelled?: boolean;
      reason?: string;
      content?: unknown;
      actionEvidence?: AgentActionEvidence[];
    },
  ): Promise<AgentActionReceipt> {
    const evidenceRef = readEvidenceRef(params.content);
    const base = {
      version: 2 as const,
      id: `${proposal.id}:${obligation?.id || "unmatched"}:${evidenceRef || "result"}`,
      obligationId: obligation?.id,
      proposalId: proposal.id,
      proofDomain: proposal.proofDomain,
      capability: proposal.capability,
      operation: proposal.operation,
      requestedTargets: proposal.requestedTargets,
      rejectedTargets: [] as string[],
      normalizedParameters: proposal.parameters,
      reasons: params.reason ? [params.reason] : [],
      verifiedFacts:
        proposal.operation === "read_full" ? ["read_mode:full"] : [],
      materialRef: readFlatMaterialRef(proposal.parameters),
      evidenceRef,
    };
    if (params.cancelled) {
      return {
        ...base,
        verification: "not_applicable",
        status: "cancelled",
        appliedTargets: [],
        alreadySatisfiedTargets: [],
      };
    }
    if (!params.ok) {
      const noteState = (
        innermostToolResult(params.content)?.noteChange as
          | { state?: string }
          | undefined
      )?.state;
      return {
        ...base,
        verification: "unverified",
        status:
          noteState === "unverified" || noteState === "mismatch"
            ? "unverified"
            : "failed",
        appliedTargets: [],
        alreadySatisfiedTargets: [],
      };
    }
    if (proposal.proofDomain === "execution") {
      const postState = readExecutionPostState(params.content);
      // No re-readable state is the normal case here — a shell command leaves
      // none. An execution that *did* declare an expected effect re-reads it
      // and says so, and then the receipt reports that proof rather than
      // hiding a library write behind "the command ran".
      if (!postState) {
        return {
          ...base,
          verification: "execution_only",
          status: "observed",
          appliedTargets: [],
          alreadySatisfiedTargets: [],
        };
      }
      return {
        ...base,
        verification: postState.verified ? "verified" : "unverified",
        status: postState.verified ? "applied" : "unverified",
        appliedTargets: postState.verified ? proposal.requestedTargets : [],
        alreadySatisfiedTargets: [],
        rejectedTargets: postState.verified ? [] : proposal.requestedTargets,
        // Carried whether or not the re-read confirmed the effect: each fact
        // names its own outcome, so a receipt that could not check is
        // distinguishable from one that checked and disagreed. The tool never
        // emits a "satisfied" fact for a re-read that was not satisfied.
        verifiedFacts: [...base.verifiedFacts, ...postState.facts],
        reasons: [
          ...base.reasons,
          ...(postState.reason ? [postState.reason] : []),
        ],
      };
    }
    if (proposal.proofDomain === "file_state") {
      const proof = fileEvidence(proposal, params.content);
      return {
        ...base,
        id: `${base.id}:${proof.evidenceRef || "unverified"}`,
        evidenceRef: proof.evidenceRef,
        verification: proof.verified ? "verified" : "unverified",
        status: proof.verified
          ? params.effect === "none"
            ? "already_satisfied"
            : "applied"
          : "unverified",
        requestedTargets: proposal.expectedFiles?.map(
          (file) => `file:${file.path}`,
        ) || [proof.target],
        appliedTargets:
          proof.verified && params.effect !== "none"
            ? proposal.requestedTargets
            : [],
        alreadySatisfiedTargets:
          proof.verified && params.effect === "none"
            ? proposal.requestedTargets
            : [],
        verifiedFacts: proof.verified
          ? [
              ...base.verifiedFacts,
              ...(proposal.expectedFiles || []).map(
                (file) => `${file.path}:sha256:${file.contentHash}`,
              ),
            ]
          : base.verifiedFacts,
        reasons: [...base.reasons, ...(proof.reason ? [proof.reason] : [])],
      };
    }
    if (proposal.operation === "read_full") {
      return {
        ...base,
        verification: "verified",
        status: "observed",
        appliedTargets: [],
        alreadySatisfiedTargets: [],
      };
    }
    if (
      proposal.operation === "note_create" ||
      proposal.operation === "note_edit" ||
      proposal.operation === "note_append"
    ) {
      const verification = await verifyNoteWriteTarget(
        proposal,
        params.content,
        this.gateway,
      );
      // The obligation concerns the parent paper; the created note is its
      // output. Native verification above has already checked that exact
      // parent relationship and the stored content before crediting coverage.
      const coveredTargets =
        proposal.operation === "note_create" &&
        proposal.parameters?.targetItemId
          ? [itemTarget(proposal.parameters.targetItemId)]
          : verification.targets;
      return verification.targets
        ? {
            ...base,
            verification: "verified",
            status: params.effect === "none" ? "already_satisfied" : "applied",
            requestedTargets: coveredTargets!,
            verifiedFacts: [
              ...base.verifiedFacts,
              ...(proposal.operation === "note_create"
                ? verification.targets.map((target) => `created_note:${target}`)
                : []),
              ...verification.facts,
            ],
            appliedTargets: params.effect === "none" ? [] : coveredTargets!,
            alreadySatisfiedTargets:
              params.effect === "none" ? coveredTargets! : [],
          }
        : {
            ...base,
            verification: "unverified",
            status: "unverified",
            appliedTargets: [],
            alreadySatisfiedTargets: [],
            reasons: [...base.reasons, verification.reason],
          };
    }
    if (proposal.operation === "annotation_write") {
      const result = innermostToolResult(params.content);
      const annotationId = Number(result.annotationId);
      const annotation = annotationId
        ? this.gateway.getItem(annotationId)
        : null;
      const expected = result.expectedAnnotation as
        | import("../../services/pdf/pdfAnnotationState").PdfHighlightPayload
        | undefined;
      const parameters = proposal.parameters;
      const verified = Boolean(
        expected &&
        parameters?.expectedText &&
        expected.source?.documentFingerprint &&
        expected.position &&
        expected.color === parameters.annotationColor &&
        expected.comment === parameters.annotationComment &&
        (parameters.pageIndex === undefined ||
          expected.position.pageIndex === parameters.pageIndex) &&
        findQuoteSourceSpansAllowingLayoutArtifacts(
          buildQuoteTextIndex(expected.text),
          parameters.expectedText,
        ).length === 1 &&
        annotationMatchesPayload(
          annotation,
          Number(parameters.targetItemId),
          expected,
        ),
      );
      const target = annotationId
        ? `item:${annotationId}`
        : proposal.requestedTargets[0] || "annotation:unknown";
      return {
        ...base,
        verification: verified ? "verified" : "unverified",
        status: verified
          ? params.effect === "none"
            ? "already_satisfied"
            : "applied"
          : "unverified",
        requestedTargets: [target],
        appliedTargets: verified && params.effect !== "none" ? [target] : [],
        alreadySatisfiedTargets:
          verified && params.effect === "none" ? [target] : [],
        rejectedTargets: verified ? [] : [target],
      };
    }
    if (proposal.operation === "undo" || proposal.operation === "revert") {
      const result = innermostToolResult(params.content);
      // The actions this call actually tried to put back. The multi-revert
      // form of `undo` also discloses newer irreversible actions it never
      // attempted, and those must not count against it either way.
      const attempted = Array.isArray(result.actionIds)
        ? result.actionIds.length
        : 0;
      const noWork =
        result.status === "nothing_reversible" ||
        (attempted === 0 &&
          Number(result.reverted) === 0 &&
          Number(result.partiallyReverted) === 0 &&
          params.effect === "none");
      const reverted = revertedSteps(result);
      const reportedComplete =
        proposal.operation === "undo"
          ? result.status === "undone"
          : attempted > 0 &&
            Number(result.reverted) === attempted &&
            Number(result.partiallyReverted) === 0;
      // Replaying an inverse is not proof that the inverse landed. Every step
      // this call replayed re-read its own target afterwards; the receipt is
      // verified only when every attempted action came back and all of those
      // re-reads found the recorded pre-image in place.
      const verified =
        noWork ||
        (reportedComplete &&
          reverted.length > 0 &&
          reverted.every((step) => step.verification === "matched"));
      const unmatched = reverted.filter(
        (step) => step.verification !== "matched",
      );
      return {
        ...base,
        verification: verified ? "verified" : "unverified",
        status: verified
          ? noWork
            ? "already_satisfied"
            : "applied"
          : "unverified",
        appliedTargets: verified && !noWork ? proposal.requestedTargets : [],
        alreadySatisfiedTargets:
          verified && noWork ? proposal.requestedTargets : [],
        rejectedTargets: verified ? [] : proposal.requestedTargets,
        // Named even on an unverified receipt: the reader needs to know how
        // much of the undo was proven, not only that it was not all of it.
        verifiedFacts: [
          ...base.verifiedFacts,
          ...reverted
            .filter((step) => step.verification === "matched")
            .map(
              (step) =>
                `reverted_step:${step.actionId}:${step.sequence}:matched`,
            ),
        ],
        reasons: [
          ...base.reasons,
          ...unmatched.map(
            (step) =>
              `Reverted step ${step.sequence} of ${step.actionId} re-read as ${step.verification}${
                step.reason ? `: ${step.reason}` : ""
              }.`,
          ),
          ...(!verified && !unmatched.length && !reverted.length && !noWork
            ? [
                "No reverted step re-read its target, so nothing proves the inverse landed.",
              ]
            : []),
        ],
        evidenceRef:
          proposal.operation === "undo" && typeof result.actionId === "string"
            ? result.actionId
            : base.evidenceRef,
      };
    }

    const operation = proposal.operationValue;
    if (!operation) {
      return this.externalMutationReceipt(base, proposal, params);
    }
    const evidence = matchingNativeEvidence(proposal, params.actionEvidence);
    const verified = Boolean(
      evidence &&
      mutationPostconditionIsSatisfied(operation, evidence.postState),
    );
    const targets = proposal.requestedTargets.length
      ? proposal.requestedTargets
      : evidence
        ? evidenceTargets(evidence)
        : [];
    const wasAlreadySatisfied = Boolean(
      evidence &&
      mutationPostconditionIsSatisfied(operation, evidence.preState),
    );
    const alreadySatisfied =
      verified && (wasAlreadySatisfied || params.effect === "none");
    // The captured post-state proves the operation's postcondition, which is a
    // claim about the whole set. A write that created notes carries, beside
    // it, the read-back each note's creation forced; those are re-checked here
    // against live state so the receipt names the same per-note content
    // evidence a single note write names. They are additive: each fact stands
    // on its own re-read, so they are minted whether or not the whole-set
    // postcondition held, and a note this call did not write has none. A note
    // whose re-read fails states why instead, so the receipt names the note it
    // could not read back rather than leaving a silent gap in the facts.
    const noteReadBacks = await nativeNoteWriteFacts(
      proposal,
      evidence?.noteWrites,
      this.gateway,
    );
    // The set-level postcondition decides what landed; the per-note re-reads
    // decide what this receipt can vouch for. A note the receipt could not
    // read back leaves the write in place -- the mutation window proved it --
    // but the verdict drops to `unverified`, exactly as the single-note branch
    // does for the same failed re-read. A receipt must never say "verified"
    // beside a reason that names a note it could not confirm.
    const readBackGap = noteReadBacks.reasons.length > 0;
    return {
      ...base,
      verifiedFacts: [...base.verifiedFacts, ...noteReadBacks.facts],
      evidenceRef: evidence?.journalStepId || base.evidenceRef,
      verification: verified && !readBackGap ? "verified" : "unverified",
      status: verified
        ? alreadySatisfied
          ? "already_satisfied"
          : "applied"
        : "unverified",
      requestedTargets: targets,
      appliedTargets: verified && !alreadySatisfied ? targets : [],
      alreadySatisfiedTargets: alreadySatisfied ? targets : [],
      rejectedTargets: verified ? [] : targets,
      reasons: [
        ...base.reasons,
        ...(verified
          ? []
          : [
              evidence
                ? `The mutation handler rejected the captured native post-state for ${operation.type}.`
                : `No captured native post-state was attached for ${operation.type}.`,
            ]),
        ...noteReadBacks.reasons,
      ],
    };
  }

  /**
   * The receipt for a Zotero write that no library mutation operation
   * describes and that has no operation-specific verifier of its own.
   *
   * Its evidence is the pre-image and post-image the mutation boundary
   * journalled. Neither proves anything by itself — both were written by the
   * call being judged — so an image is re-read here, against live Zotero
   * state, at the moment the receipt is minted. When the write declared what
   * it was *authorized* to make true, that is the image compared, and
   * `verified` then means live state holds the authorized change rather than
   * whatever the tool chose to write.
   *
   * Scope. The contract holds its own narrow Zotero gateway, so the shapes it
   * can read back are the single-object ones: a note, a created item, a file,
   * a path, a preference. A post-image that is a captured library-operation
   * state needs the mutation handlers and the operation it was captured for;
   * that is the library branch's evidence, which carries both, and such an
   * image reaching this branch reads back as `not_re_readable` rather than as
   * agreement.
   */
  private async externalMutationReceipt(
    base: Omit<
      AgentActionReceipt,
      "verification" | "status" | "appliedTargets" | "alreadySatisfiedTargets"
    >,
    proposal: AgentActionProposal,
    params: {
      effect?: AgentToolEffect;
      actionEvidence?: AgentActionEvidence[];
    },
  ): Promise<AgentActionReceipt> {
    const evidence = externalMutationEvidence(params.actionEvidence);
    if (!evidence) {
      return {
        ...base,
        verification: "unverified",
        status: "unverified",
        appliedTargets: [],
        alreadySatisfiedTargets: [],
        reasons: [
          ...base.reasons,
          "No native Zotero post-state verifier is registered for this action.",
        ],
      };
    }
    const authorized = evidence.authorizedPostImage !== undefined;
    const postImage = await verifyRecordedPostImage({
      image: {
        expected: authorized
          ? evidence.authorizedPostImage
          : evidence.postImage,
      },
      reader: contractPostImageReader(this.gateway),
    });
    const verified = postImage.kind === "satisfied";
    const targets = proposal.requestedTargets;
    // A write that changed nothing already held the state its post-image
    // records, which is the same "already satisfied" the library path reports
    // for an operation whose pre-image already met its postcondition.
    const alreadySatisfied = verified && params.effect === "none";
    return {
      ...base,
      evidenceRef: evidence.journalStepId || base.evidenceRef,
      verification: verified ? "verified" : "unverified",
      status: verified
        ? alreadySatisfied
          ? "already_satisfied"
          : "applied"
        : "unverified",
      requestedTargets: targets,
      appliedTargets: verified && !alreadySatisfied ? targets : [],
      alreadySatisfiedTargets: alreadySatisfied ? targets : [],
      rejectedTargets: verified ? [] : targets,
      reasons: [
        ...base.reasons,
        ...(verified
          ? []
          : [
              `This ${evidence.operation} write could not be verified: ${
                postImage.kind === "mismatched"
                  ? authorized
                    ? "live Zotero state does not hold what this write was authorized to produce"
                    : "live Zotero state no longer matches what this write recorded when it applied"
                  : postImage.reason ||
                    "its recorded post-image could not be read back"
              }.`,
            ]),
      ],
    };
  }

  rejectionReceipts(
    contract: AgentActionContract | undefined,
    prepared: PreparedActionExecution,
    validationFailure: ScopeValidationFailure,
  ): AgentActionReceipt[] {
    const proposals = prepared.proposals.length
      ? prepared.proposals
      : [
          {
            id: "missing-proposal",
            proofDomain: "zotero_state" as const,
            capability: "zotero.read" as const,
            operation: "read_full" as const,
            source: "full_read" as const,
            requestedTargets: [] as string[],
            destinationCollectionIds: [] as number[],
          },
        ];
    return proposals.map((proposal) => ({
      version: 2,
      id: `${proposal.id}:rejected`,
      proposalId: proposal.id,
      proofDomain: proposal.proofDomain,
      capability: proposal.capability,
      operation: proposal.operation,
      verification: "not_applicable",
      status: "failed",
      requestedTargets: proposal.requestedTargets,
      appliedTargets: [],
      alreadySatisfiedTargets: [],
      rejectedTargets: validationFailure.rejectedTargets,
      normalizedParameters: proposal.parameters,
      reasons: [validationFailure.message],
      verifiedFacts: [],
      obligationId: contract
        ? matchingObligations(contract, proposal)[0]?.id
        : undefined,
    }));
  }
}
