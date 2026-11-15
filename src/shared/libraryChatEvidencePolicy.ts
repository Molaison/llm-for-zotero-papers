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
    /\b(?:method|methods|methodology|approach|protocol|design|implementation|experiments?|ablation)\b/,
  results:
    /\b(?:result|results|finding|findings|evaluation|experiments?|analysis|discussion)\b/,
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

/** Letters only, so a heading and the paper's title compare alike through
 * line numbers, punctuation and spacing. */
function titleKey(value?: string): string {
  return normalizeText(value)
    .replace(/[^\p{L}]+/gu, " ")
    .trim();
}

/** A section label that is the paper's own title names no section. */
function sectionLabelUnlessTitle(
  sectionLabel?: string,
  paperTitle?: string,
): string | undefined {
  const key = titleKey(sectionLabel);
  return key && key === titleKey(paperTitle) ? undefined : sectionLabel;
}

/** How a chunk's enclosing section and its own title are joined in one label. */
const SECTION_LABEL_SEPARATOR = " › ";

/**
 * A chunk's section as one label: "Methods › Data analysis" for a subsection
 * its standard section encloses, the one name when the two are the same, and
 * nothing for the paper's own title.
 */
export function renderSectionLabel(
  sectionLabel?: string,
  enclosingSection?: string,
  paperTitle?: string,
): string | undefined {
  const own = sectionLabelUnlessTitle(sectionLabel?.trim(), paperTitle);
  const enclosing = enclosingSection?.trim();
  if (!enclosing) return own || undefined;
  if (!own || titleKey(own) === titleKey(enclosing)) return enclosing;
  return `${enclosing}${SECTION_LABEL_SEPARATOR}${own}`;
}

/** The enclosing section and own title a rendered label joins. */
export function sectionLabelParts(label?: string): {
  sectionLabel?: string;
  enclosingSection?: string;
} {
  if (!label) return {};
  const at = label.indexOf(SECTION_LABEL_SEPARATOR);
  return at < 0
    ? { sectionLabel: label }
    : {
        enclosingSection: label.slice(0, at),
        sectionLabel: label.slice(at + SECTION_LABEL_SEPARATOR.length),
      };
}

/**
 * Whether a chunk lies in one of `kinds`: by the standard section enclosing
 * it when it has one ("Materials and methods" for a "Data analysis"
 * subsection), else by its own section label, unless that label is the
 * paper's title.
 */
export function isInSectionKinds(
  kinds: readonly EvidenceSectionKind[],
  sectionLabel?: string,
  chunkKind?: string,
  enclosingSection?: string,
  paperTitle?: string,
): boolean {
  const section = normalizeEvidenceSectionLabel(
    enclosingSection || sectionLabelUnlessTitle(sectionLabel, paperTitle),
  );
  return kinds.some((kind) =>
    kind === "figure-caption" || kind === "table-caption"
      ? chunkKind === kind
      : Boolean(section) && SECTION_LABEL_PATTERNS[kind].test(section),
  );
}

/**
 * Whether a chunk competes for body-evidence slots: body text, or a section
 * the request names, such as the abstract. A reference list never does.
 */
export function admitsAsBodyEvidence(
  kinds: readonly EvidenceSectionKind[],
  sectionLabel?: string,
  chunkKind?: EvidenceChunkKind,
  enclosingSection?: string,
  paperTitle?: string,
): boolean {
  return (
    isBodyEvidenceSection(sectionLabel, chunkKind) ||
    (chunkKind !== "references" &&
      isInSectionKinds(
        kinds,
        sectionLabel,
        chunkKind,
        enclosingSection,
        paperTitle,
      ))
  );
}

function scoreSectionMatch(
  kinds: readonly EvidenceSectionKind[],
  sectionLabel?: string,
  chunkKind?: string,
  enclosingSection?: string,
  paperTitle?: string,
): number {
  if (
    isInSectionKinds(
      kinds,
      sectionLabel,
      chunkKind,
      enclosingSection,
      paperTitle,
    )
  )
    return 2;
  const section = normalizeEvidenceSectionLabel(
    enclosingSection || sectionLabel,
  );
  if (!section) return 0;
  return isFrontMatterSection(section) ? 0 : 0.25;
}

/**
 * The one chunk kind a section label names, first match wins. Words count
 * whole; introduction comes last, so a label any other kind claims keeps it.
 */
const SECTION_LABEL_KINDS: ReadonlyArray<readonly [EvidenceChunkKind, RegExp]> =
  [
    ["abstract", /^abstract$/],
    [
      "methods",
      /\b(?:methods?|methodolog(?:y|ies|ical)|approach(?:es)?|protocols?|design)\b/,
    ],
    [
      "results",
      /\b(?:results?|findings?|evaluations?|experiments?|analysis)\b/,
    ],
    ["discussion", /\bdiscussion\b/],
    ["conclusion", /\b(?:conclusions?|concluding remarks)\b/],
    ["references", /\b(?:references?|bibliography)\b/],
    [
      "introduction",
      /\b(?:introduction|background|related work|literature review)\b/,
    ],
  ];

export function chunkKindFromSectionLabel(
  sectionLabel?: string,
): EvidenceChunkKind {
  const section = normalizeEvidenceSectionLabel(sectionLabel);
  if (!section) return "unknown";
  return (
    SECTION_LABEL_KINDS.find(([, pattern]) => pattern.test(section))?.[0] ||
    "body"
  );
}

type RankedEvidenceCandidate = {
  sectionLabel?: string;
  enclosingSection?: string;
  chunkKind?: string;
  chunkIndex?: number;
  /** The paper's title: a section label equal to it names no section. */
  title?: string;
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
      scoreSectionMatch(
        kinds,
        right.sectionLabel,
        right.chunkKind,
        right.enclosingSection,
        right.title,
      ) -
      scoreSectionMatch(
        kinds,
        left.sectionLabel,
        left.chunkKind,
        left.enclosingSection,
        left.title,
      );
    if (preferenceDelta !== 0) return preferenceDelta;
    const scoreDelta =
      (getBaseScore?.(right) || 0) - (getBaseScore?.(left) || 0);
    if (scoreDelta !== 0) return scoreDelta;
    return (left.chunkIndex || 0) - (right.chunkIndex || 0);
  };
}
