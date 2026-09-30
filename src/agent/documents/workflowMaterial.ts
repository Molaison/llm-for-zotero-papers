import { getInterpretedTurnPapers } from "../context/turnPaperScope";
import type { AgentRuntimeRequest, AgentToolContext } from "../types";
import type { ZoteroGateway } from "../services/zoteroGateway";
import {
  actionIsComplete,
  obligationsForAction,
  type MaterialOutputIntent,
} from "../contracts/workflowDependencies";
import type { MaterialRef } from "./materialRef";
import type { PlanDocument } from "./types";
import { loadPlanDocument } from "./store";

function requiredIdentity(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

/** Stable identity supplied by the host-owned execution or Plan lifecycle. */
export function materialDocumentIdForWorkflow(
  workflowId: string,
  outputId: string,
): string {
  const workflow = requiredIdentity(
    workflowId,
    "The material workflow identity",
  );
  const output = requiredIdentity(outputId, "The material output identity");
  return `material:${encodeURIComponent(workflow)}:${encodeURIComponent(output)}`;
}

function legacyMaterialDocumentId(
  request: AgentRuntimeRequest,
  outputId: string,
): string | undefined {
  const identity =
    request.actionContract?.intent?.semantic?.id ||
    request.classifiedIntent?.semantic?.id;
  return identity ? `material:${identity}:${outputId}` : undefined;
}

export function materialDocumentId(
  request: AgentRuntimeRequest,
  outputId: string,
): string {
  if (request.executionContext?.executionId) {
    return materialDocumentIdForWorkflow(
      request.executionContext.executionId,
      outputId,
    );
  }
  const legacyId = legacyMaterialDocumentId(request, outputId);
  if (legacyId) return legacyId;
  throw new Error("The authored material has no frozen workflow identity.");
}

export function materialRefFromDocument(
  document: Pick<
    PlanDocument,
    "documentId" | "documentVersion" | "contentHash"
  >,
): MaterialRef {
  if (
    !Number.isSafeInteger(document.documentVersion) ||
    document.documentVersion < 1
  ) {
    throw new Error(
      "The material document version must be a positive integer.",
    );
  }
  const contentHash = requiredIdentity(
    document.contentHash,
    "The material content hash",
  );
  return {
    documentId: requiredIdentity(
      document.documentId,
      "The material document ID",
    ),
    documentVersion: document.documentVersion,
    contentHash,
  };
}

export function assertMaterialRefMatches(
  document: Pick<
    PlanDocument,
    "documentId" | "documentVersion" | "contentHash"
  >,
  reference: MaterialRef,
): void {
  materialRefFromDocument(reference);
  // Name the part that moved: the user approved one exact material, and a
  // refusal is only actionable when it says which half of that identity broke.
  if (document.documentId !== reference.documentId) {
    throw new Error(
      `The finalized material identity has changed: the approved document ID '${reference.documentId}' is not stored document '${document.documentId}'.`,
    );
  }
  if (document.documentVersion !== reference.documentVersion) {
    throw new Error(
      `The finalized material version or content has changed: the approved document version ${reference.documentVersion} is no longer the stored version ${document.documentVersion}.`,
    );
  }
  if (document.contentHash !== reference.contentHash) {
    throw new Error(
      `The finalized material version or content has changed: the approved content hash '${reference.contentHash}' is no longer the stored content hash '${document.contentHash}'.`,
    );
  }
}

export async function loadMaterialRef(
  reference: MaterialRef,
  conversationKey?: number,
): Promise<PlanDocument | null> {
  const document = await loadPlanDocument(reference.documentId);
  if (!document) return null;
  assertMaterialRefMatches(document, reference);
  if (
    conversationKey !== undefined &&
    document.conversationKey !== conversationKey
  ) {
    throw new Error("The finalized material belongs to another conversation.");
  }
  return document;
}
export function resolveMaterialOutput(
  request: AgentRuntimeRequest,
  outputId?: string,
): MaterialOutputIntent | undefined {
  const outputs =
    request.actionContract?.intent?.semantic?.materialOutputs ||
    request.classifiedIntent?.semantic?.materialOutputs ||
    [];
  if (!outputs.length) {
    if (outputId)
      throw new Error(
        "No authored output with that identity was requested; omit materialOutputId to submit the final document.",
      );
    return undefined;
  }
  const output = outputId
    ? outputs.find((entry) => entry.id === outputId)
    : outputs.length === 1
      ? outputs[0]
      : undefined;
  if (!output)
    throw new Error("Specify the materialOutputId from the frozen workflow.");
  return output;
}
export function assertMaterialReady(
  request: AgentRuntimeRequest,
  output: MaterialOutputIntent,
  gateway: ZoteroGateway,
): void {
  const contract = request.actionContract;
  if (
    !contract ||
    !output.afterActions.every((index) =>
      actionIsComplete(contract, request.actionProgress, index),
    )
  )
    throw new Error(
      `Complete and verify the prerequisite actions before producing '${output.id}'.`,
    );
  if (output.requiredEvidence === "none") return;
  const targetIds = [
    ...new Set(
      output.sourceActionIndexes.flatMap((index) =>
        obligationsForAction(contract, index).flatMap(
          (obligation) => obligation.targetBoundary?.frozenTargetIds || [],
        ),
      ),
    ),
  ];
  if (output.sourceActionIndexes.length && !targetIds.length)
    throw new Error(
      `The frozen paper sources for '${output.id}' are unresolved.`,
    );
  const sourceIds = output.sourceActionIndexes.length
    ? targetIds
    : (
        getInterpretedTurnPapers(
          request.turnPaperScope,
          request.classifiedIntent?.paperTargetIntent,
        ) || request.turnPaperScope.papers.map((entry) => entry.paper)
      ).map((paper) => paper.itemId);
  const sources = sourceIds.map((id) => gateway.getItem(id));
  if (sources.some((source) => !source || source.deleted))
    throw new Error(`A frozen source paper for '${output.id}' is unavailable.`);
  if (!sources.length)
    throw new Error(`Resolve the paper evidence sources for '${output.id}'.`);
  for (const source of sources) {
    if (
      !(request.documentReadObservations || []).some(
        (observation) =>
          observation.issuer === "zotero_host" &&
          observation.libraryID === source!.libraryID &&
          observation.itemKey === source!.key &&
          (output.requiredEvidence === "metadata"
            ? observation.capabilities.some((kind) =>
                ["metadata", "abstract", "body"].includes(kind),
              )
            : observation.capabilities.includes("body")),
      )
    )
      throw new Error(
        `Read the requested source paper through the host tools before generating '${output.id}'.`,
      );
  }
}
export function recordMaterialOutput(
  request: AgentRuntimeRequest,
  output: MaterialOutputIntent,
  document: PlanDocument,
): void {
  const progress = request.actionProgress;
  if (!progress || progress.contractId !== request.actionContract?.id)
    throw new Error("The output's action progress is unavailable.");
  const receipt = {
    outputId: output.id,
    ...materialRefFromDocument(document),
  };
  progress.materialOutputs = [
    ...(progress.materialOutputs || []).filter(
      (entry) => entry.outputId !== output.id,
    ),
    receipt,
  ];
}
export async function loadWorkflowMaterial(
  request: AgentRuntimeRequest,
  outputId?: string,
): Promise<PlanDocument | null> {
  const outputs =
    request.actionContract?.intent?.semantic?.materialOutputs ||
    request.classifiedIntent?.semantic?.materialOutputs ||
    [];
  for (const output of [...outputs].reverse()) {
    if (outputId && output.id !== outputId) continue;
    const receipt = request.actionProgress?.materialOutputs?.find(
      (entry) => entry.outputId === output.id,
    );
    const document = await loadPlanDocument(
      receipt?.documentId || materialDocumentId(request, output.id),
    );
    if (
      receipt &&
      (document?.contentHash !== receipt.contentHash ||
        document.documentVersion !== receipt.documentVersion)
    )
      continue;
    if (document?.conversationKey === request.conversationKey) return document;
  }
  return null;
}

/** Binds a save proposal to the material receipt and the frozen native parent. */
export async function resolveWorkflowNoteDocument(
  context: Pick<AgentToolContext, "request">,
  documentId: string,
  targetItemId?: number,
  mode: "create" | "edit" | "append" = "create",
  /** The MaterialRef frozen into the authorized proposal, when one exists. */
  frozenRef?: MaterialRef,
): Promise<PlanDocument> {
  const request = context.request;
  const document = await loadPlanDocument(documentId);
  if (!document || document.conversationKey !== request.conversationKey) {
    throw new Error(
      "The finalized workflow document identity or content has changed.",
    );
  }
  const progress = request.actionProgress;
  // Fresh ordinary Agent work has no semantic contract. Its direct document is
  // still an exact, host-persisted material version. The journey spans two
  // turns — generate, then save — so the run that finalized it is not the run
  // that saves it; what may not change is the material the user approved, so
  // the frozen MaterialRef is re-checked here. The invocation controller
  // authorizes the concrete target separately.
  if (!request.actionContract && !progress) {
    if (document.version !== 2 || document.origin.kind !== "direct") {
      throw new Error(
        "The finalized document is not a direct version 2 Agent document.",
      );
    }
    if (frozenRef) assertMaterialRefMatches(document, frozenRef);
    return document;
  }
  const receipt = progress?.materialOutputs?.find(
    (entry) => entry.documentId === documentId,
  );
  const obligation = request.actionContract?.obligations.find(
    (entry) =>
      entry.operation === `note_${mode}` &&
      entry.contentFrom === receipt?.outputId &&
      entry.targetBoundary?.frozenTargetIds.includes(targetItemId || 0),
  );
  if (
    !receipt ||
    !obligation ||
    progress?.contractId !== request.actionContract?.id
  )
    throw new Error(
      "The note must use the finalized workflow document and its exact authorized destination.",
    );
  assertMaterialRefMatches(document, receipt);
  if (frozenRef) assertMaterialRefMatches(document, frozenRef);
  return document;
}
