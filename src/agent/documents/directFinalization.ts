import type { TrustedReadObservation } from "../context/readObservationTypes";
import type { ZoteroGateway } from "../services/zoteroGateway";
import type { AgentRuntimeRequest, AgentToolArtifact } from "../types";
import type { DocumentCitationEvidence } from "./citationService";
import { finalizeDocument, persistFinalizedDocument } from "./finalizer";
import {
  directDocumentId,
  loadDocumentForRunByContentHash,
  loadLatestDocumentForRun,
  loadPlanDocument,
  loadPlanDocumentOutbox,
  nextDirectDocumentSequence,
} from "./store";
import type {
  DocumentCoverageItem,
  DocumentOutcomePolicy,
  PlanDocument,
  PlanDocumentAsset,
  PlanDocumentOutboxRecord,
  SubmitPlanDocumentInput,
} from "./types";
import {
  assertMaterialReady,
  materialDocumentId,
  resolveMaterialOutput,
} from "./workflowMaterial";
import { ToolInputRejection } from "../tools/execution/failure";
import { normalizeNoteSourceText } from "../../services/notes/noteRendering";
import type { MaterialOutputIntent } from "../contracts/workflowDependencies";

/** The already stored document, with the outbox record that published it. */
async function storedDocumentResult(document: PlanDocument): Promise<{
  document: PlanDocument;
  outbox: PlanDocumentOutboxRecord;
}> {
  const outbox = await loadPlanDocumentOutbox(document.documentId);
  if (!outbox) throw new Error("The document exists without its outbox");
  return { document, outbox };
}
function directDocumentSpec(params: {
  request: AgentRuntimeRequest;
  policy: DocumentOutcomePolicy;
  title: string;
  hasCitations: boolean;
}) {
  const researchGrounded =
    params.policy.integrityPolicy === "research_grounded";
  return {
    kind: params.policy.documentKind,
    title: params.title,
    requiredSections: researchGrounded ? ["Scope and limitations"] : [],
    requiresReferences: researchGrounded || params.hasCitations,
    requiresCoverageSection: researchGrounded,
    allowFigures: true,
    citationStyle: {
      styleId: "http://www.zotero.org/styles/apa",
      styleTitle: "APA",
      locale:
        typeof params.request.metadata?.queryLanguage === "string"
          ? params.request.metadata.queryLanguage
          : "en-US",
    },
  } as const;
}

function evidenceFromObservations(
  observations: readonly TrustedReadObservation[],
): DocumentCitationEvidence[] {
  return observations.map((observation) => ({
    version: 2,
    evidenceRef: observation.observationId,
    observationId: observation.observationId,
    libraryID: observation.libraryID,
    itemKey: observation.itemKey,
    sourceKind: observation.capabilities.includes("body")
      ? "body"
      : observation.capabilities.includes("abstract")
        ? "abstract"
        : "metadata",
    locator:
      observation.attachmentItemKey &&
      observation.pageIndex !== undefined &&
      observation.sourceFingerprint
        ? {
            kind: "pdf_page",
            attachmentItemKey: observation.attachmentItemKey,
            pageIndex: observation.pageIndex,
            sourceFingerprint: observation.sourceFingerprint,
          }
        : observation.attachmentItemKey
          ? {
              kind: "attachment_text",
              attachmentItemKey: observation.attachmentItemKey,
              pageIndex: observation.pageIndex,
              sourceFingerprint: observation.sourceFingerprint,
            }
          : undefined,
  }));
}

function coverageFromObservations(
  observations: readonly TrustedReadObservation[],
): DocumentCoverageItem[] {
  const byItem = new Map<string, DocumentCoverageItem>();
  for (const observation of observations) {
    const key = `${observation.libraryID}:${observation.itemKey}`;
    const item =
      Zotero.Items.getByLibraryAndKey(
        observation.libraryID,
        observation.itemKey,
      ) || null;
    const depth = observation.capabilities.includes("body")
      ? "body"
      : observation.capabilities.includes("abstract")
        ? "abstract"
        : observation.capabilities.includes("metadata")
          ? "metadata"
          : "none";
    const prior = byItem.get(key);
    const rank = { none: 0, metadata: 1, abstract: 2, body: 3 } as const;
    if (prior && rank[prior.evidenceDepth] >= rank[depth]) continue;
    byItem.set(key, {
      libraryID: observation.libraryID,
      itemKey: observation.itemKey,
      title:
        String(
          item?.getField?.("title") || item?.getDisplayTitle?.() || "",
        ).trim() || undefined,
      status: "included",
      evidenceDepth: depth,
    });
  }
  return [...byItem.values()];
}

function normalizeAssetHash(value: string | undefined): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^sha256:/, "");
}

function validateDirectAssetProvenance(params: {
  assets: readonly PlanDocumentAsset[];
  artifacts: readonly AgentToolArtifact[];
  observations: readonly TrustedReadObservation[];
  researchGrounded: boolean;
}): void {
  const observationIds = new Set(
    params.observations.map((entry) => entry.observationId),
  );
  for (const asset of params.assets) {
    const artifact = params.artifacts.find(
      (entry) =>
        entry.kind === "image" &&
        entry.storedPath === asset.durablePath &&
        entry.mimeType.toLowerCase() === asset.mimeType.toLowerCase() &&
        (!entry.contentHash ||
          normalizeAssetHash(entry.contentHash) ===
            normalizeAssetHash(asset.contentHash)),
    );
    if (!artifact) {
      throw new ToolInputRejection(
        `Document asset ${asset.assetId} was not emitted by a successful host tool call`,
      );
    }
    if (asset.provenance.origin === "generated") {
      if (
        params.researchGrounded &&
        asset.provenance.evidenceRefs.some((ref) => !observationIds.has(ref))
      ) {
        throw new ToolInputRejection(
          `Generated asset ${asset.assetId} has an invalid evidence reference`,
        );
      }
      continue;
    }
    const provenance = asset.provenance;
    const sourceObservation = params.observations.some(
      (entry) =>
        entry.libraryID === provenance.libraryID &&
        entry.itemKey === provenance.itemKey &&
        entry.attachmentItemKey === provenance.attachmentItemKey &&
        entry.sourceFingerprint === provenance.sourceFingerprint &&
        entry.pageIndex === provenance.pageIndex &&
        entry.capabilities.includes("figure"),
    );
    if (!sourceObservation) {
      throw new ToolInputRejection(
        `Extracted asset ${asset.assetId} is not backed by a host-verified figure observation`,
      );
    }
  }
}

export class DirectDocumentFinalizer {
  constructor(private readonly gateway: ZoteroGateway) {}

  async finalize(params: {
    request: AgentRuntimeRequest;
    runId: string;
    input: SubmitPlanDocumentInput;
    now?: number;
  }): Promise<{ document: PlanDocument; outbox: PlanDocumentOutboxRecord }> {
    const configuredPolicy = params.request.documentOutcomePolicy;
    const material = resolveMaterialOutput(
      params.request,
      params.input.materialOutputId,
    );
    const stableDocumentId = material
      ? materialDocumentId(params.request, material.id)
      : undefined;
    if (params.request.planContext?.phase === "planning") {
      throw new Error("Direct document finalization is not authorized");
    }
    if (params.request.planContext?.phase === "executing" && !material) {
      throw new Error("Plan document finalization must use the approved spec");
    }
    const policy: DocumentOutcomePolicy = configuredPolicy?.required
      ? configuredPolicy
      : {
          required: true,
          documentKind: params.input.documentKind || "custom",
          integrityPolicy: params.input.integrityPolicy || "authored",
          trigger: "document_intent",
        };
    return this.publish({
      request: params.request,
      runId: params.runId,
      input: params.input,
      policy,
      material,
      stableDocumentId,
      now: params.now,
    });
  }

  /**
   * Finalize one batch item's note body as its own durable document.
   *
   * A batch item is not the turn's deliverable, so it never inherits the
   * turn's document policy: a note written during a literature-review turn is
   * still a note, and holding it to that turn's grounding rules would reject
   * the whole batch. It is always authored material of kind `note`, titled
   * after the item it is written onto.
   */
  async finalizeNoteBody(params: {
    request: AgentRuntimeRequest;
    runId: string;
    title: string;
    markdown: string;
    now?: number;
  }): Promise<{ document: PlanDocument; outbox: PlanDocumentOutboxRecord }> {
    return this.publish({
      request: params.request,
      runId: params.runId,
      input: {
        title: params.title,
        // Exactly what `note_write` would store for the same body, so the
        // note carries the model's text and nothing the host invented.
        markdown: normalizeNoteSourceText(params.markdown),
        citations: [],
        quotes: [],
        assets: [],
        groundingReviewed: "passed",
        groundingIssues: [],
      },
      policy: {
        required: true,
        documentKind: "note",
        integrityPolicy: "authored",
        trigger: "document_intent",
      },
      now: params.now,
    });
  }

  private async publish(params: {
    request: AgentRuntimeRequest;
    runId: string;
    input: SubmitPlanDocumentInput;
    policy: DocumentOutcomePolicy;
    material?: MaterialOutputIntent;
    stableDocumentId?: string;
    now?: number;
  }): Promise<{ document: PlanDocument; outbox: PlanDocumentOutboxRecord }> {
    const { material, stableDocumentId, policy } = params;
    const prior = stableDocumentId
      ? await loadPlanDocument(stableDocumentId)
      : await loadLatestDocumentForRun(params.runId);
    if (prior && prior.conversationKey !== params.request.conversationKey)
      throw new Error(
        "The finalized material belongs to another conversation.",
      );
    // A workflow material output has one frozen identity, so its stored
    // version is the answer. A direct run has no such identity: it may author
    // several documents, and whether this submission is a retry of the stored
    // one is only known once its content hash is computed below.
    if (prior && stableDocumentId) return storedDocumentResult(prior);
    if (material) assertMaterialReady(params.request, material, this.gateway);
    const now = params.now ?? Date.now();
    const title = params.input.title.trim();
    const observations = params.request.documentReadObservations || [];
    const researchGrounded = policy.integrityPolicy === "research_grounded";
    if (
      researchGrounded &&
      !observations.some((entry) =>
        entry.capabilities.some((capability) =>
          ["abstract", "body", "figure", "quote"].includes(capability),
        ),
      )
    ) {
      throw new ToolInputRejection(
        "A literature-review document requires host-verified abstract or body evidence",
      );
    }
    if (researchGrounded && !params.input.citations.length) {
      throw new ToolInputRejection(
        "A literature-review document requires grounded citations",
      );
    }
    const spec = directDocumentSpec({
      request: params.request,
      policy,
      title,
      hasCitations: params.input.citations.length > 0,
    });
    const evidence = evidenceFromObservations(observations);
    const corpus = researchGrounded
      ? coverageFromObservations(observations)
      : params.input.citations.flatMap((cluster) => cluster.sources);
    const coverageItems = researchGrounded
      ? coverageFromObservations(observations)
      : [];
    const documentId =
      stableDocumentId ||
      directDocumentId(
        params.runId,
        await nextDirectDocumentSequence(params.runId),
      );
    const finalized = await finalizeDocument({
      gateway: this.gateway,
      input: params.input,
      now,
      context: {
        documentId,
        documentVersion: 1,
        conversationKey: params.request.conversationKey,
        integrityPolicy: policy.integrityPolicy,
        origin: {
          kind: "direct",
          runId: params.runId,
          sourceMessageTimestamp:
            Number(params.request.metadata?.sourceMessageTimestamp) || now,
          routingReceipt: params.request.skillRoutingReceipt,
          skillRoutingReceiptHash:
            params.request.skillRoutingReceipt?.routerIdentityHash,
        },
        spec,
        evidence,
        corpus,
        quoteCorpusKeys: new Set(
          observations.map((entry) => `${entry.libraryID}:${entry.itemKey}`),
        ),
        coverageItems,
        coverageStatus: researchGrounded ? "partial" : undefined,
        validateAssetProvenance: () =>
          validateDirectAssetProvenance({
            assets: params.input.assets,
            artifacts: params.request.documentArtifactObservations || [],
            observations,
            researchGrounded,
          }),
      },
    });
    // The stored document is this submission only when its content is
    // identical: a retry keeps the identity the run already published.
    // Different content is a new document, never a silent substitution of
    // older content for the input the model just submitted. One run may
    // publish many documents — a note batch publishes one per item — so the
    // retry it is looking for is not always the newest one.
    if (!stableDocumentId) {
      const duplicate = await loadDocumentForRunByContentHash({
        runId: params.runId,
        contentHash: finalized.document.contentHash,
        documentKind: spec.kind,
      });
      if (
        duplicate &&
        duplicate.conversationKey === params.request.conversationKey
      )
        return storedDocumentResult(duplicate);
    }
    await persistFinalizedDocument(finalized);
    return finalized;
  }
}
