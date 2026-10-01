import type { AgentToolContext } from "../types";
import type { MaterialRef } from "./materialRef";
import type { PlanDocument } from "./types";
import { loadPlanDocument } from "./store";

function requiredIdentity(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
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
/**
 * A submission may not name a workflow material output: those came from the
 * classifier-era intent, and no turn has one now.
 */
export function rejectMaterialOutputId(outputId?: string): void {
  if (outputId)
    throw new Error(
      "No authored output with that identity was requested; omit materialOutputId to submit the final document.",
    );
}

/** Binds a save proposal to the material receipt and the frozen native parent. */
export async function resolveWorkflowNoteDocument(
  context: Pick<AgentToolContext, "request">,
  documentId: string,
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
  // The journey spans two turns — generate, then save — so the run that
  // finalized the document is not the run that saves it; what may not change
  // is the material the user approved, so the frozen MaterialRef is re-checked
  // here. The invocation controller authorizes the concrete target separately.
  if (document.version !== 2 || document.origin.kind !== "direct") {
    throw new Error(
      "The finalized document is not a direct version 2 Agent document.",
    );
  }
  if (frozenRef) assertMaterialRefMatches(document, frozenRef);
  return document;
}
