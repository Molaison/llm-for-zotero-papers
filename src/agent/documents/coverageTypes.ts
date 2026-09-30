/** Coverage and evidence records that submitted documents, their citations,
 * and their coverage sections read. */
export type ResearchCoverageStatus =
  | "complete"
  | "complete_with_limitations"
  | "partial"
  | "failed";

export type ResearchScopeSnapshotItem = Readonly<{
  snapshotId: string;
  libraryID: number;
  itemKey: string;
  localItemId?: number;
  /** Frozen display metadata used by recovery and final coverage reporting. */
  title?: string;
  firstCreator?: string;
  year?: string;
  metadataFingerprint?: string;
  attachmentFingerprint?: string;
  ordinal: number;
}>;

export type ResearchQualityReport = Readonly<{
  version: 1;
  computedAt: number;
  papers: number;
  nodes: number;
  claims: number;
  claimsWithLocators: number;
  nodesWithEdges: number;
  edges: number;
  edgesVerified: number;
  edgesTentative: number;
  edgesRefuted: number;
  contradictions: number;
  subquestionClaims: Readonly<Record<string, number>>;
  themes: number;
  themesWithEdges: number;
  openQuestions: number;
  answeredQuestions: number;
  crossPaperParagraphs?: number;
  crossPaperParagraphsSupported?: number;
}>;

export type ResearchEvidenceRecord = Readonly<{
  version: 1 | 2;
  evidenceRef: string;
  researchJobId: string;
  executionId: string;
  parentTaskId: string;
  libraryID: number;
  itemKey: string;
  sourceFingerprint: string;
  sourceKind: "metadata" | "abstract" | "body" | "figure" | "quote";
  /** Required on v2 evidence; points to host-issued observation metadata. */
  observationId?: string;
  locator?: Readonly<{
    kind: "pdf_page";
    attachmentItemKey: string;
    pageIndex: number;
    sourceFingerprint: string;
  }>;
  createdAt: number;
}>;
