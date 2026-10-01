export type EvidenceChunkKind =
  | "abstract"
  | "introduction"
  | "methods"
  | "results"
  | "discussion"
  | "conclusion"
  | "references"
  | "figure-caption"
  | "table-caption"
  | "appendix"
  | "body"
  | "unknown";

function normalizeText(value: unknown): string {
  return `${value ?? ""}`.replace(/\s+/g, " ").trim().toLowerCase();
}

export function normalizeEvidenceSectionLabel(value?: string): string {
  return normalizeText(value || "")
    .replace(/^#+\s*/, "")
    .replace(/[:.\s-]+$/g, "")
    .trim();
}

export function isFrontMatterSection(sectionLabel?: string): boolean {
  const section = normalizeEvidenceSectionLabel(sectionLabel);
  if (!section) return false;
  return /^(?:abstract|summary|highlights?|in brief|keywords?|title|authors?|article info(?:rmation)?)$/.test(
    section,
  );
}

export function isBodyEvidenceSection(
  sectionLabel?: string,
  chunkKind?: EvidenceChunkKind,
): boolean {
  if (chunkKind === "references") return false;
  if (chunkKind && chunkKind !== "abstract" && chunkKind !== "unknown") {
    return true;
  }
  const section = normalizeEvidenceSectionLabel(sectionLabel);
  if (!section) return chunkKind !== "abstract";
  return !isFrontMatterSection(section);
}

/**
 * The parts of a paper evidence ranking can be asked to prefer. Each is an
 * EvidenceChunkKind except "limitations", which papers discuss in
 * discussion-like sections.
 */
export const EVIDENCE_SECTION_KINDS = [
  "methods",
  "results",
  "discussion",
  "limitations",
  "introduction",
  "conclusion",
  "abstract",
  "figure-caption",
  "table-caption",
] as const;

export type EvidenceSectionKind = (typeof EVIDENCE_SECTION_KINDS)[number];

/** Section labels that hold each kind. No label names a caption, so captions
 * are recognized by their chunk kind instead. */
const SECTION_LABEL_PATTERNS: Record<
  Exclude<EvidenceSectionKind, "figure-caption" | "table-caption">,
  RegExp
> = {
  methods:
    /\b(?:method|methods|methodology|approach|protocol|design|implementation|experiment|ablation)\b/,
  results:
    /\b(?:result|results|finding|findings|evaluation|experiment|analysis|discussion)\b/,
  limitations: /\b(?:limitations?|discussion|future|caveat|threat)\b/,
  discussion: /\bdiscussion\b/,
  introduction:
    /\b(?:introduction|background|related work|literature review)\b/,
  conclusion: /\b(?:conclusions?|concluding remarks)\b/,
  abstract: /^abstract$/,
};

/** English question words that ask for a section. */
const SECTION_CUE_PATTERNS: ReadonlyArray<
  readonly [EvidenceSectionKind, RegExp]
> = [
  [
    "methods",
    /\b(?:method|methods|methodology|approach|protocol|design|implementation|ablation|experiment(?:al)? setup)\b/,
  ],
  [
    "results",
    /\b(?:result|results|finding|findings|evidence|effect|outcome|performance)\b/,
  ],
  ["limitations", /\b(?:limitations?|future work|caveat|threat)\b/],
];

function sectionCueKinds(text: string): EvidenceSectionKind[] {
  const normalized = normalizeText(text);
  return SECTION_CUE_PATTERNS.filter(([, cue]) => cue.test(normalized)).map(
    ([kind]) => kind,
  );
}

/**
 * The sections a request asks about: the sections the caller names (the
 * model reads them from a request in any language), else the English cue
 * words of the question, else those of its query variants.
 */
export function wantedSectionKinds(params: {
  question: string;
  queryVariants?: readonly string[];
  sections?: readonly EvidenceSectionKind[];
}): EvidenceSectionKind[] {
  if (params.sections?.length) return [...new Set(params.sections)];
  const asked = sectionCueKinds(params.question);
  if (asked.length) return asked;
  return [...new Set((params.queryVariants || []).flatMap(sectionCueKinds))];
}

/** Whether a chunk lies in one of `kinds`. */
export function isInSectionKinds(
  kinds: readonly EvidenceSectionKind[],
  sectionLabel?: string,
  chunkKind?: string,
): boolean {
  const section = normalizeEvidenceSectionLabel(sectionLabel);
  return kinds.some((kind) =>
    kind === "figure-caption" || kind === "table-caption"
      ? chunkKind === kind
      : Boolean(section) && SECTION_LABEL_PATTERNS[kind].test(section),
  );
}

function scoreSectionMatch(
  kinds: readonly EvidenceSectionKind[],
  sectionLabel?: string,
  chunkKind?: string,
): number {
  if (isInSectionKinds(kinds, sectionLabel, chunkKind)) return 2;
  const section = normalizeEvidenceSectionLabel(sectionLabel);
  if (!section) return 0;
  return isFrontMatterSection(section) ? 0 : 0.25;
}

export function scoreSectionPreference(
  query: string,
  sectionLabel?: string,
): number {
  return scoreSectionMatch(sectionCueKinds(query), sectionLabel);
}

export function queryHasExplicitSectionPreference(query: string): boolean {
  return sectionCueKinds(query).length > 0;
}

export function chunkKindFromSectionLabel(
  sectionLabel?: string,
): EvidenceChunkKind {
  const section = normalizeEvidenceSectionLabel(sectionLabel);
  if (/^abstract$/.test(section)) return "abstract";
  if (/\bmethod|methods|methodology|approach|protocol|design\b/.test(section)) {
    return "methods";
  }
  if (/\bresult|finding|evaluation|experiment|analysis\b/.test(section)) {
    return "results";
  }
  if (/\bdiscussion\b/.test(section)) return "discussion";
  if (/\bconclusion\b/.test(section)) return "conclusion";
  if (/\breference|bibliography\b/.test(section)) return "references";
  return section ? "body" : "unknown";
}

type RankedEvidenceCandidate = {
  sectionLabel?: string;
  chunkKind?: string;
  chunkIndex?: number;
};

/** Candidates in `kinds` first, then by base score, then in paper order. */
export function compareEvidenceCandidatesForSections<
  T extends RankedEvidenceCandidate,
>(
  kinds: readonly EvidenceSectionKind[],
  getBaseScore?: (candidate: T) => number,
) {
  return (left: T, right: T): number => {
    const preferenceDelta =
      scoreSectionMatch(kinds, right.sectionLabel, right.chunkKind) -
      scoreSectionMatch(kinds, left.sectionLabel, left.chunkKind);
    if (preferenceDelta !== 0) return preferenceDelta;
    const scoreDelta =
      (getBaseScore?.(right) || 0) - (getBaseScore?.(left) || 0);
    if (scoreDelta !== 0) return scoreDelta;
    return (left.chunkIndex || 0) - (right.chunkIndex || 0);
  };
}

export function compareEvidenceCandidatesForQuestion<
  T extends RankedEvidenceCandidate,
>(query: string, getBaseScore?: (candidate: T) => number) {
  return compareEvidenceCandidatesForSections<T>(
    sectionCueKinds(query),
    getBaseScore,
  );
}
