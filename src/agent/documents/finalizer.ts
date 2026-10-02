import { renderMarkdownForNote } from "../../utils/markdown";
import { canonicalJson } from "../services/libraryMutation/canonicalJson";
import type { ZoteroGateway } from "../services/zoteroGateway";
import { sha256Text } from "../store/journalRecoveryBlobStore";
import {
  formatDocumentCitations,
  type DocumentCitationEvidence,
} from "./citationService";
import {
  assertDocumentDraftValid,
  collectHeadings,
  collectMissingSections,
  normalizeHeading,
} from "./draftValidation";
import {
  utf8Bytes,
  validateAssets,
  validateVisibleDocumentPrivacy,
} from "./finalizationValidation";
import {
  materializePlanDocumentAssets,
  savePlanDocumentInTransaction,
} from "./store";
import {
  PLAN_DOCUMENT_MARKDOWN_MAX_BYTES,
  type DocumentArtifactV2,
  type DocumentSpec,
  type PlanDocumentOutboxRecord,
  type SubmitPlanDocumentInput,
} from "./types";
import { resolveVerifiedQuotes } from "./verifiedQuotes";
import { ToolInputRejection } from "../tools/execution/failure";

type DocumentFinalizationContext = Pick<
  DocumentArtifactV2,
  | "documentId"
  | "documentVersion"
  | "conversationKey"
  | "origin"
  | "integrityPolicy"
  | "coverageStatus"
  | "coverageItems"
> & {
  spec: DocumentSpec;
  corpus: readonly { libraryID: number; itemKey: string }[];
  evidence: readonly DocumentCitationEvidence[];
  quoteCorpusKeys: ReadonlySet<string>;
  /** Source owners attest figures against their native observations or research ledger. */
  validateAssetProvenance: () => void | Promise<void>;
};

type FinalizedDocument = {
  document: DocumentArtifactV2;
  outbox: PlanDocumentOutboxRecord;
  /** Format repairs the host made instead of rejecting, in the order made. */
  repairs: string[];
};

const MISSING_SECTION_PLACEHOLDER = "Not stated in the submitted document.";
const COVERAGE_SECTION = "Scope and limitations";

/**
 * Add each missing required section as a heading with a one-line placeholder.
 * A draft References section stays last, since the host replaces it.
 */
function appendMissingSections(params: {
  markdown: string;
  spec: DocumentSpec;
  repairs: string[];
}): string {
  const missing = collectMissingSections({
    headings: collectHeadings(params.markdown),
    requiredSections: params.spec.requiredSections,
    requiresCoverageSection: params.spec.requiresCoverageSection,
  });
  if (!missing.length) return params.markdown;
  const sections = missing.map((normalized) => {
    const displayName =
      params.spec.requiredSections.find(
        (section) => normalizeHeading(section) === normalized,
      ) ||
      (normalized === normalizeHeading(COVERAGE_SECTION)
        ? COVERAGE_SECTION
        : normalized);
    params.repairs.push(`added missing section "${displayName}"`);
    return `## ${displayName}\n\n${MISSING_SECTION_PLACEHOLDER}`;
  });
  const lines = params.markdown.split(/\r?\n/);
  const referencesIndex = lines.findIndex((line) => {
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    return heading ? normalizeHeading(heading[1]) === "references" : false;
  });
  if (referencesIndex < 0)
    return `${params.markdown.trimEnd()}\n\n${sections.join("\n\n")}`;
  const before = lines.slice(0, referencesIndex).join("\n").trimEnd();
  const after = lines.slice(referencesIndex).join("\n");
  return `${before}\n\n${sections.join("\n\n")}\n\n${after}`;
}

/** One integrity pipeline for every origin; source acquisition stays with its owner. */
export async function finalizeDocument(params: {
  gateway: ZoteroGateway;
  input: SubmitPlanDocumentInput;
  context: DocumentFinalizationContext;
  now: number;
}): Promise<FinalizedDocument> {
  const { input, context, now } = params;
  const { spec, origin } = context;
  const planned = origin.kind === "planned";
  const researchGrounded = context.integrityPolicy === "research_grounded";
  // Per-item note material is note text, not a document anyone publishes. It
  // is held to the same rules as a single `note_write`, which requires no
  // heading and applies no visible-document privacy check: the two ways of
  // writing the same note must not disagree about what a note may contain.
  const noteMaterial = spec.kind === "note";
  // Plans retain their approved evidence requirements, including authored plans.
  const requireEvidence = planned || researchGrounded;
  const submittedTitle = input.title.trim();
  if (!submittedTitle)
    throw new ToolInputRejection("Document title is required");
  // The approved spec owns the title. A differing submission is a format
  // problem the host repairs (title and leading H1), not a reason to discard a
  // finished document.
  const title = spec.title;
  const repairs: string[] = [];
  const retitledMarkdown =
    submittedTitle === title
      ? input.markdown
      : input.markdown.replace(
          /^([ \t]*#[ \t]+)(.+?)[ \t]*$/m,
          (line, hashes: string, heading: string) =>
            heading.trim() === submittedTitle ? `${hashes}${title}` : line,
        );
  // Format problems the host can repair without changing what the document
  // claims are repaired and reported, so one submission lands.
  let titledMarkdown = retitledMarkdown;
  if (
    !planned &&
    !researchGrounded &&
    !noteMaterial &&
    collectHeadings(titledMarkdown).size === 0
  ) {
    titledMarkdown = `# ${title}\n\n${titledMarkdown}`;
    repairs.push("added title heading");
  }
  titledMarkdown = appendMissingSections({
    markdown: titledMarkdown,
    spec,
    repairs,
  });
  if (!spec.allowFigures && input.assets.length)
    throw new ToolInputRejection(
      "The approved document spec does not allow figures",
    );
  if (utf8Bytes(titledMarkdown) > PLAN_DOCUMENT_MARKDOWN_MAX_BYTES)
    throw new ToolInputRejection("Document Markdown exceeds the 2 MiB limit");
  assertDocumentDraftValid({
    markdown: titledMarkdown,
    requiredSections: spec.requiredSections,
    requiresCoverageSection: spec.requiresCoverageSection,
    validateQuotes: planned,
  });
  if (!noteMaterial) validateVisibleDocumentPrivacy(titledMarkdown);
  validateAssets(input.assets, requireEvidence);
  if (
    input.groundingReviewed === "passed_with_limitations" &&
    !input.groundingIssues.length
  )
    throw new ToolInputRejection(
      "A grounding review with limitations must record the detected issues",
    );
  const resolvedQuotes = await resolveVerifiedQuotes({
    markdown: titledMarkdown,
    quotes: input.quotes,
    corpusKeys: context.quoteCorpusKeys,
    evidenceByRef: new Map(
      context.evidence.map((entry) => [entry.evidenceRef, entry]),
    ),
    citations: input.citations,
  });
  repairs.push(...resolvedQuotes.repairs);
  if (!noteMaterial) validateVisibleDocumentPrivacy(resolvedQuotes.markdown);
  await context.validateAssetProvenance();
  const formatted = await formatDocumentCitations({
    gateway: params.gateway,
    draftMarkdown: resolvedQuotes.markdown,
    clusters: [...input.citations, ...resolvedQuotes.addedCitations],
    // A downgraded quote's paper already passed the quote corpus check.
    corpus: [
      ...context.corpus,
      ...resolvedQuotes.addedCitations.flatMap((cluster) => cluster.sources),
    ],
    evidence: context.evidence,
    spec,
    requireEvidence,
  });
  repairs.push(...formatted.repairs);
  if (utf8Bytes(formatted.visibleMarkdown) > PLAN_DOCUMENT_MARKDOWN_MAX_BYTES)
    throw new ToolInputRejection("Finalized document exceeds the 2 MiB limit");
  // Check the complete visible payload before copying any assets or publishing it.
  const assets = await materializePlanDocumentAssets(input.assets);
  const validation: DocumentArtifactV2["validation"] = {
    integrityValidated: true,
    groundingReviewed: requireEvidence ? input.groundingReviewed : "not_run",
    quoteVerified: resolvedQuotes.verifiedQuotes.length
      ? "verified"
      : "not_applicable",
    issues: [...input.groundingIssues, ...repairs],
  };
  const contentHash = `sha256:${await sha256Text(
    canonicalJson({
      title,
      markdown: formatted.visibleMarkdown,
      citations: formatted.citationBundle,
      verifiedQuotes: resolvedQuotes.verifiedQuotes,
      assets,
      coverageItems: context.coverageItems,
      // Preserve the existing per-origin content identity for durable retries.
      ...(origin.kind === "planned"
        ? {
            coverageStatus: context.coverageStatus,
            scopeLineageDigest: origin.scopeLineageDigest,
          }
        : {}),
      validation,
    }),
  )}`;
  const document: DocumentArtifactV2 = {
    version: 2,
    documentId: context.documentId,
    documentVersion: context.documentVersion,
    documentKind: spec.kind,
    integrityPolicy: context.integrityPolicy,
    origin,
    conversationKey: context.conversationKey,
    title,
    visibleMarkdown: formatted.visibleMarkdown,
    visibleHtml: renderMarkdownForNote(formatted.visibleMarkdown),
    citationBundle: formatted.citationBundle,
    verifiedQuotes: resolvedQuotes.verifiedQuotes,
    assets,
    coverageStatus: context.coverageStatus,
    coverageItems: context.coverageItems,
    validation,
    contentHash,
    createdAt: now,
  };
  return {
    document,
    outbox: {
      version: 1,
      outboxId: `${document.documentId}:message`,
      documentId: document.documentId,
      conversationKey: document.conversationKey,
      messageTimestamp: now,
      visibleMarkdown: document.visibleMarkdown,
      status: "pending",
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
    },
    repairs,
  };
}

/** Persist the document and its pending outbox together. */
export async function persistFinalizedDocument(
  finalized: FinalizedDocument,
): Promise<void> {
  await Zotero.DB.executeTransaction(async () => {
    await savePlanDocumentInTransaction(finalized);
  });
}
