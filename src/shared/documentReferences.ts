import type {
  DocumentReferenceConfidence,
  DocumentReferenceEvidence,
  PdfChunkMeta,
} from "../services/paperContent/types";

export type QueryReferenceKind = "figure" | "table";

export type QueryReference = {
  kind: QueryReferenceKind;
  id: string;
  panel?: string;
  surface: string;
};

export type DocumentReferenceMatch = {
  chunkIndex: number;
  confidence: DocumentReferenceConfidence;
  references: QueryReference[];
};

const REFERENCE_PATTERN =
  /\b(fig(?:ure)?s?\.?|tables?)\s*([sS]?\d+)([a-z])?\b|([图表])\s*([sS]?\d+)([a-z])?/giu;

function normalizeId(value: string): string {
  return value.trim().toUpperCase();
}

function referenceKey(
  reference: Pick<QueryReference, "kind" | "id" | "panel">,
): string {
  return `${reference.kind}:${normalizeId(reference.id)}:${reference.panel || ""}`;
}

export function parseDocumentReferences(query: string): QueryReference[] {
  const matches: Array<QueryReference & { index: number }> = [];
  for (const match of query.matchAll(REFERENCE_PATTERN)) {
    const latinKind = match[1];
    const cjkKind = match[4];
    const kind: QueryReferenceKind = latinKind
      ? /^table/i.test(latinKind)
        ? "table"
        : "figure"
      : cjkKind === "表"
        ? "table"
        : "figure";
    const id = normalizeId(match[2] || match[5] || "");
    if (!id) continue;
    const panel = (match[3] || match[6] || "").toLowerCase() || undefined;
    matches.push({
      kind,
      id,
      ...(panel ? { panel } : {}),
      surface: match[0],
      index: match.index || 0,
    });
  }
  matches.sort((left, right) => left.index - right.index);
  const seen = new Set<string>();
  const references: QueryReference[] = [];
  for (const { index: _index, ...reference } of matches) {
    const key = referenceKey(reference);
    if (seen.has(key)) continue;
    seen.add(key);
    references.push(reference);
  }
  return references;
}

function evidenceFromMatch(
  match: RegExpMatchArray,
  confidence: DocumentReferenceConfidence,
  provenance: string,
): DocumentReferenceEvidence | null {
  const label = match[1] || match[4] || "";
  const id = normalizeId(match[2] || match[5] || "");
  if (!label || !id) return null;
  return {
    kind: /^table/i.test(label) || label === "表" ? "table" : "figure",
    id,
    ...(match[3] || match[6]
      ? { panel: (match[3] || match[6]).toLowerCase() }
      : {}),
    confidence,
    provenance: [provenance],
  };
}

export function extractDocumentReferenceEvidence(
  text: string,
): DocumentReferenceEvidence[] {
  const normalized = text.trim();
  if (!normalized) return [];
  const firstLine = normalized.split(/\n/, 1)[0] || "";
  const anchored = firstLine.match(
    /^(?:#{1,6}\s*)?(fig(?:ure)?\.?|table)\s*([sS]?\d+)([a-z])?\b|^([图表])\s*([sS]?\d+)([a-z])?/iu,
  );
  if (anchored) {
    const evidence = evidenceFromMatch(anchored, "medium", "caption-text");
    return evidence ? [evidence] : [];
  }
  const mentioned = normalized.matchAll(REFERENCE_PATTERN).next().value as
    | RegExpMatchArray
    | undefined;
  if (!mentioned) return [];
  const evidence = evidenceFromMatch(mentioned, "low", "body-text-mention");
  return evidence ? [evidence] : [];
}

function confidenceRank(confidence: DocumentReferenceConfidence): number {
  if (confidence === "high") return 3;
  if (confidence === "medium") return 2;
  return 1;
}

function evidenceMatchesQuery(
  evidence: DocumentReferenceEvidence,
  query: QueryReference,
): boolean {
  if (evidence.kind !== query.kind || normalizeId(evidence.id) !== query.id) {
    return false;
  }
  return !query.panel || !evidence.panel || evidence.panel === query.panel;
}

export function resolveDocumentReferenceMatches(
  references: QueryReference[],
  chunks: PdfChunkMeta[],
): DocumentReferenceMatch[] {
  if (!references.length || !chunks.length) return [];
  const ambiguousReferenceKeys = new Set<string>();
  for (const reference of references) {
    const structuralMatches = chunks.filter((chunk) =>
      (chunk.references || []).some(
        (entry) =>
          evidenceMatchesQuery(entry, reference) &&
          confidenceRank(entry.confidence) >= confidenceRank("medium"),
      ),
    );
    if (structuralMatches.length > 1) {
      ambiguousReferenceKeys.add(referenceKey(reference));
    }
  }
  const matches: DocumentReferenceMatch[] = [];
  for (const chunk of chunks) {
    const evidence = chunk.references || [];
    const matchedReferences = references.filter((reference) =>
      evidence.some((entry) => evidenceMatchesQuery(entry, reference)),
    );
    if (!matchedReferences.length) continue;
    const matchedEvidence = evidence.filter((entry) =>
      matchedReferences.some((reference) =>
        evidenceMatchesQuery(entry, reference),
      ),
    );
    const evidenceConfidence =
      matchedEvidence.reduce<DocumentReferenceConfidence>(
        (best, entry) =>
          confidenceRank(entry.confidence) > confidenceRank(best)
            ? entry.confidence
            : best,
        "low",
      );
    const confidence = matchedReferences.some((reference) =>
      ambiguousReferenceKeys.has(referenceKey(reference)),
    )
      ? "low"
      : evidenceConfidence;
    matches.push({
      chunkIndex: chunk.chunkIndex,
      confidence,
      references: matchedReferences.map(({ kind, id, panel, surface }) => ({
        kind,
        id,
        ...(panel ? { panel } : {}),
        surface,
      })),
    });
  }
  return matches;
}

export function buildCanonicalReferenceQuery(
  reference: QueryReference,
): string {
  const label = reference.kind === "figure" ? "Figure" : "Table";
  return `${label} ${reference.id}${reference.panel || ""}`;
}
