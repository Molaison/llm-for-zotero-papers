/**
 * The per-paper task ledger: what the agent read from each paper in a task's
 * scope, and where the final answer cites it.
 *
 * This is a UI ledger, not model memory. `coverageLedger.ts` remembers a
 * capped, hashed digest for the model; this ledger keeps a bounded, readable
 * record for the Task progress view, fed from the same tool payloads the host
 * attests in `readObservation.ts`. The two switches below and there
 * cover the same tools; a unit test fails when they drift apart.
 *
 * Everything here is pure: no DOM, no Zotero globals. A host that can resolve
 * an attachment to its parent item passes `resolvePaper`; without it a row
 * that names only an attachment is skipped rather than guessed.
 */
import type { QuoteCitation } from "../../shared/types";

/** Monotone reading state of one paper, weakest first. */
export type TaskPaperState =
  | "listed"
  | "matched"
  | "skimmed"
  | "read"
  | "cited";

export const TASK_PAPER_STATES: readonly TaskPaperState[] = [
  "listed",
  "matched",
  "skimmed",
  "read",
  "cited",
];

/** Where the paper's text comes from, most specific first. */
export type TaskPaperTextSource =
  | "mineru"
  | "pdf_text"
  | "indexed"
  | "pdf"
  | "none"
  | "unknown";

const TEXT_SOURCE_RANK: Record<TaskPaperTextSource, number> = {
  unknown: 0,
  none: 1,
  pdf: 2,
  indexed: 3,
  pdf_text: 4,
  mineru: 5,
};

export type TaskPaperReadGranularity =
  | "metadata"
  | "abstract"
  | "outline"
  | "section"
  | "passage"
  | "full"
  | "figure"
  | "page";

/** One thing the agent read from one paper during one tool call. */
export type TaskPaperReadEvent = {
  /** `libraryID:itemId` of the paper this read belongs to. */
  key: string;
  callId: string;
  runId?: string;
  /** Set when the delta is applied; a derived delta may not know its turn. */
  turnIndex?: number;
  toolName: string;
  granularity: TaskPaperReadGranularity;
  /** How the host found it: bm25, metadata, exact, overview, targeted, ... */
  method?: string;
  /** Section or page label, when the payload names one. */
  label?: string;
  /** At most `TASK_PAPER_SNIPPET_MAX_CHARS` characters. */
  snippet?: string;
  /** At most `TASK_PAPER_WHY_MATCHED_MAX_CHARS` characters. */
  whyMatched?: string;
};

export type TaskPaperCitation = {
  citationId: string;
  turnIndex: number;
  /** At most `TASK_PAPER_CITATION_QUOTE_MAX_CHARS` characters. */
  quote?: string;
  label?: string;
  sectionLabel?: string;
  pageLabel?: string;
};

export type TaskPaperDeltaPaper = {
  key: string;
  libraryID: number;
  itemId: number;
  contextItemId?: number;
  title?: string;
  year?: string;
  creator?: string;
  text?: TaskPaperTextSource;
  state: TaskPaperState;
};

/** What one successful read tool call added to the ledger. */
export type TaskPaperLedgerDelta = {
  version: 1;
  callId: string;
  runId?: string;
  turnIndex?: number;
  toolName: string;
  papers: TaskPaperDeltaPaper[];
  reads: TaskPaperReadEvent[];
  /** Reads beyond the per-paper cap, dropped before emission. */
  droppedReads?: number;
};

export type TaskPaperTurnRecord = {
  /** Strongest state this turn earned: its reads, then its citations. */
  state: TaskPaperState;
  /**
   * Strongest state this turn's reads earned, never `cited`. A citation
   * dropped when the turn's answer is re-applied falls back to it.
   */
  readState: TaskPaperState;
  reads: TaskPaperReadEvent[];
  droppedReads: number;
  citations: TaskPaperCitation[];
  droppedCitations: number;
};

export type TaskPaperLedgerEntry = {
  key: string;
  libraryID: number;
  itemId: number;
  contextItemIds: number[];
  title?: string;
  year?: string;
  creator?: string;
  text: TaskPaperTextSource;
  /** Strongest state over every turn. */
  state: TaskPaperState;
  /** Latest turn that touched this paper. */
  latestTurn: number;
  turns: Record<number, TaskPaperTurnRecord>;
};

export type TaskPaperLedger = {
  version: 1;
  /** Insertion order of `papers`. */
  order: string[];
  papers: Record<string, TaskPaperLedgerEntry>;
  /** `runId:callId` of every delta already applied. */
  appliedCalls: Record<string, true>;
  /** Papers refused by the per-conversation cap. */
  droppedPapers: number;
  lastLibraryID?: number;
};

export const TASK_PAPER_MAX_READS_PER_TURN = 12;
export const TASK_PAPER_MAX_CITATIONS_PER_TURN = 8;
export const TASK_PAPER_MAX_PAPERS = 5000;
export const TASK_PAPER_SNIPPET_MAX_CHARS = 280;
export const TASK_PAPER_WHY_MATCHED_MAX_CHARS = 120;
export const TASK_PAPER_CITATION_QUOTE_MAX_CHARS = 160;

/**
 * Tools whose payloads this ledger reads. Kept equal to the tools
 * `createTrustedReadObservations` attests.
 */
export const TASK_PAPER_LEDGER_TOOL_NAMES: ReadonlySet<string> = new Set([
  "library_search",
  "library_read",
  "library_retrieve",
  "paper_read",
  "read_attachment",
]);

export function taskPaperKey(libraryID: number, itemId: number): string {
  return `${libraryID}:${itemId}`;
}

export function stateRank(state: TaskPaperState): number {
  return TASK_PAPER_STATES.indexOf(state);
}

function strongerState(a: TaskPaperState, b: TaskPaperState): TaskPaperState {
  return stateRank(a) >= stateRank(b) ? a : b;
}

function strongerText(
  a: TaskPaperTextSource | undefined,
  b: TaskPaperTextSource | undefined,
): TaskPaperTextSource {
  const left = a || "unknown";
  const right = b || "unknown";
  return TEXT_SOURCE_RANK[left] >= TEXT_SOURCE_RANK[right] ? left : right;
}

// ---------------------------------------------------------------------------
// Payload readers (mirroring readObservation's tolerant field access)
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function record(value: unknown): Row | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : null;
}

function positive(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function nonNegative(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function hasText(value: unknown, keys: readonly string[]): boolean {
  const input = record(value);
  return Boolean(input && keys.some((key) => text(input[key])));
}

function firstText(value: unknown, keys: readonly string[]): string {
  const input = record(value);
  if (!input) return "";
  for (const key of keys) {
    const found = text(input[key]);
    if (found) return found;
  }
  return "";
}

function hasRows(value: unknown, keys: readonly string[]): boolean {
  const input = record(value);
  return Boolean(
    input &&
    keys.some((key) => Array.isArray(input[key]) && input[key].length > 0),
  );
}

function rowsAt(result: unknown, key: string): unknown[] {
  const output = record(result);
  if (!output) return [];
  const value = output[key];
  if (Array.isArray(value)) return value;
  return record(value) ? Object.values(value as Row) : [];
}

function directRows(result: unknown): unknown[] {
  return ["results", "papers", "paperMatches", "items", "snippets"].flatMap(
    (key) => rowsAt(result, key),
  );
}

/** Collapse whitespace and cut to `max` characters with an ellipsis. */
export function clipTaskPaperText(
  value: unknown,
  max: number,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/\s+/g, " ").trim();
  if (!clean) return undefined;
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

type PaperRef = {
  itemId?: number;
  contextItemId?: number;
  libraryID?: number;
  title?: string;
  year?: string;
  creator?: string;
};

function paperRef(value: unknown): PaperRef | null {
  const input = record(value);
  if (!input) return null;
  const paper = record(input.paperContext);
  const parent = record(input.parentItem);
  const ref: PaperRef = {
    itemId: positive(
      paper?.itemId ?? input.itemId ?? input.itemID ?? parent?.itemId,
    ),
    contextItemId: positive(
      paper?.contextItemId ?? input.contextItemId ?? input.contextItemID,
    ),
    libraryID: positive(paper?.libraryID ?? input.libraryID),
    title: text(paper?.title) || text(input.title) || text(parent?.title),
    year:
      text(String(paper?.year ?? "")) ||
      text(String(input.year ?? "")) ||
      text(String(parent?.year ?? "")),
    creator:
      text(paper?.firstCreator) ||
      text(input.firstCreator) ||
      text(parent?.firstCreator) ||
      (Array.isArray(input.creators) ? text(input.creators[0]) : undefined),
  };
  return ref.itemId || ref.contextItemId ? ref : null;
}

function inputRefs(input: unknown): PaperRef[] {
  const args = record(input) || {};
  const direct = [
    args.target,
    ...(Array.isArray(args.targets) ? args.targets : []),
  ]
    .map(paperRef)
    .filter((entry): entry is PaperRef => Boolean(entry));
  const itemIds = Array.isArray(args.itemIds)
    ? args.itemIds.map(positive).filter((id): id is number => Boolean(id))
    : [];
  return [
    ...direct,
    ...itemIds.map((itemId) => ({ itemId })),
    ...(positive(args.itemId) ? [{ itemId: positive(args.itemId)! }] : []),
  ];
}

type ReadSeed = Omit<
  TaskPaperReadEvent,
  "key" | "callId" | "runId" | "turnIndex" | "toolName"
>;

type Seed = {
  ref: PaperRef;
  state: TaskPaperState;
  text?: TaskPaperTextSource;
  read?: ReadSeed;
};

function readSeed(fields: {
  granularity: TaskPaperReadGranularity;
  method?: string;
  label?: unknown;
  snippet?: unknown;
  whyMatched?: unknown;
}): ReadSeed {
  const seed: ReadSeed = { granularity: fields.granularity };
  if (fields.method) seed.method = fields.method;
  const label = clipTaskPaperText(fields.label, 120);
  if (label) seed.label = label;
  const snippet = clipTaskPaperText(
    fields.snippet,
    TASK_PAPER_SNIPPET_MAX_CHARS,
  );
  if (snippet) seed.snippet = snippet;
  const whyMatched = clipTaskPaperText(
    fields.whyMatched,
    TASK_PAPER_WHY_MATCHED_MAX_CHARS,
  );
  if (whyMatched) seed.whyMatched = whyMatched;
  return seed;
}

function pageLabelFor(row: Row): string | undefined {
  const label = text(row.pageLabel);
  if (label) return `p. ${label}`;
  const index = nonNegative(row.pageIndex);
  return index === undefined ? undefined : `p. ${index + 1}`;
}

/** Granularity and label of one retrieved passage. */
function passageReadSeed(row: Row, method: string): ReadSeed {
  const chunkKind = text(row.chunkKind);
  const sectionLabel = text(row.sectionLabel);
  if (chunkKind === "page") {
    return readSeed({
      granularity: "page",
      method,
      label: sectionLabel || pageLabelFor(row),
      snippet: row.text,
    });
  }
  return readSeed({
    granularity: sectionLabel ? "section" : "passage",
    method,
    label: sectionLabel || pageLabelFor(row),
    snippet: row.snippet ?? row.text ?? row.surroundingText,
    whyMatched: row.whyMatched,
  });
}

function textSourceFromKind(value: unknown): TaskPaperTextSource | undefined {
  const kind = String(value || "").toLowerCase();
  if (kind === "mineru") return "mineru";
  if (kind === "pdf_text" || kind === "raw_pdf_text") return "pdf_text";
  return undefined;
}

function textSourceFromResourceState(
  value: unknown,
): TaskPaperTextSource | undefined {
  const states = Array.isArray(value) ? value.map(String) : [];
  if (states.includes("text_indexed")) return "indexed";
  if (states.includes("text_available")) return "pdf";
  if (states.includes("unsupported")) return "none";
  return undefined;
}

// ---------------------------------------------------------------------------
// Per-tool state rules
// ---------------------------------------------------------------------------

function libraryRetrieveSeeds(result: unknown): Seed[] {
  const output = record(result) || {};
  const pool = record(output.resourcePool);
  const scopeLibraryID = positive(record(pool?.scope)?.libraryID);
  const withLibrary = (ref: PaperRef | null): PaperRef | null =>
    ref ? { ...ref, libraryID: ref.libraryID ?? scopeLibraryID } : null;
  const seeds: Seed[] = [];
  const candidateIds = new Set<number>();
  for (const row of rowsAt(result, "candidates")) {
    const value = record(row);
    const ref = withLibrary(paperRef(row));
    if (!value || !ref) continue;
    if (ref.itemId) candidateIds.add(ref.itemId);
    const queryState = Array.isArray(value.queryState)
      ? value.queryState.map(String)
      : [];
    seeds.push({
      ref,
      state: "matched",
      text: textSourceFromResourceState(value.resourceState),
      read: readSeed({
        granularity: "metadata",
        method: queryState.includes("matched_bm25")
          ? "bm25"
          : queryState.includes("matched_metadata")
            ? "metadata"
            : "shortlist",
        whyMatched: value.whyMatched,
      }),
    });
  }
  for (const row of rowsAt(result, "paperMatches")) {
    const value = record(row);
    const ref = withLibrary(paperRef(row));
    if (!value || !ref) continue;
    seeds.push({
      ref,
      state: "matched",
      ...(ref.itemId && candidateIds.has(ref.itemId)
        ? {}
        : {
            read: readSeed({
              granularity: "metadata",
              method: "metadata",
              whyMatched: value.whyMatched,
            }),
          }),
    });
  }
  for (const row of rowsAt(result, "snippets")) {
    const value = record(row);
    const ref = withLibrary(paperRef(row));
    if (!value || !ref) continue;
    if (!hasText(value, ["snippet", "surroundingText", "text"])) continue;
    const sourceKind = String(value.sourceKind || "").toLowerCase();
    const method = text(value.matchMethod) || "retrieve";
    if (sourceKind === "abstract") {
      seeds.push({
        ref,
        state: "skimmed",
        read: readSeed({
          granularity: "abstract",
          method,
          snippet: value.snippet ?? value.text,
          whyMatched: value.whyMatched,
        }),
      });
      continue;
    }
    if (sourceKind === "metadata") {
      seeds.push({
        ref,
        state: "matched",
        read: readSeed({
          granularity: "metadata",
          method,
          snippet: value.snippet ?? value.text,
          whyMatched: value.whyMatched,
        }),
      });
      continue;
    }
    seeds.push({
      ref,
      state: "read",
      text: textSourceFromKind(sourceKind),
      read: passageReadSeed(value, method),
    });
  }
  return seeds;
}

function metadataListSeeds(input: unknown, result: unknown): Seed[] {
  const mode = text(record(input)?.mode) || "search";
  return directRows(result).flatMap((row) => {
    const ref = paperRef(row);
    return ref
      ? [
          {
            ref,
            state: "matched" as const,
            read: readSeed({ granularity: "metadata", method: mode }),
          },
        ]
      : [];
  });
}

function libraryReadSeeds(result: unknown): Seed[] {
  return directRows(result).flatMap((row): Seed[] => {
    const ref = paperRef(row);
    const value = record(row);
    if (!ref || !value) return [];
    const metadata = record(value.metadata);
    const abstract =
      firstText(metadata, ["abstract", "abstractNote"]) ||
      firstText(value, ["abstract", "abstractNote"]);
    const body =
      hasText(value, ["content", "text", "body", "fullText"]) ||
      hasRows(value, ["passages", "snippets", "chunks", "notes"]);
    if (body) {
      return [
        {
          ref,
          state: "read",
          read: readSeed({
            granularity: hasRows(value, ["passages", "snippets", "chunks"])
              ? "passage"
              : "full",
            method: "library_read",
            snippet: firstText(value, ["content", "text", "body", "fullText"]),
          }),
        },
      ];
    }
    if (abstract) {
      return [
        {
          ref,
          state: "skimmed",
          read: readSeed({
            granularity: "abstract",
            method: "library_read",
            snippet: abstract,
          }),
        },
      ];
    }
    if (metadata && Object.keys(metadata).length) {
      return [
        {
          ref,
          state: "matched",
          read: readSeed({ granularity: "metadata", method: "library_read" }),
        },
      ];
    }
    return [];
  });
}

function paperReadOverviewSeed(row: Row, ref: PaperRef): Seed | null {
  if (row.ok === false) return null;
  const backend = String(row.backend || "").toLowerCase();
  const sourceKind = String(row.sourceKind || "").toLowerCase();
  if (backend === "zotero_metadata" || sourceKind === "zotero_metadata") {
    const abstractMatch = /(?:^|\n)Abstract:\s*(\S[\s\S]*)/i.exec(
      String(row.text || ""),
    );
    const abstract =
      firstText(row, ["abstract", "abstractNote"]) || abstractMatch?.[1];
    return abstract
      ? {
          ref,
          state: "skimmed",
          text: "none",
          read: readSeed({
            granularity: "abstract",
            method: "overview",
            snippet: abstract,
          }),
        }
      : {
          ref,
          state: "matched",
          text: "none",
          read: readSeed({ granularity: "metadata", method: "overview" }),
        };
  }
  if (!hasText(row, ["text", "content", "body"])) return null;
  const complete = String(row.coverage || "") === "complete";
  return {
    ref,
    state: complete ? "read" : "skimmed",
    text:
      backend === "mineru"
        ? "mineru"
        : backend === "raw_pdf_text"
          ? "pdf_text"
          : undefined,
    read: readSeed({
      granularity: complete ? "full" : "passage",
      method: "overview",
      snippet: firstText(row, ["text", "content", "body"]),
    }),
  };
}

function paperReadSeeds(input: unknown, result: unknown): Seed[] {
  const args = record(input) || {};
  const output = record(result) || {};
  const mode = text(args.mode) || text(output.mode) || "overview";
  if (mode === "figures" && Array.isArray(output.figures)) {
    return rowsAt(result, "figures").flatMap((row): Seed[] => {
      const value = record(row);
      const ref = paperRef(row);
      if (!value || !ref || !hasText(value, ["cropPath"])) return [];
      return [
        {
          ref,
          state: "read",
          read: readSeed({
            granularity: "figure",
            method: "figures",
            label: [text(value.label), pageLabelFor(value)]
              .filter(Boolean)
              .join(" · "),
            snippet: value.caption,
          }),
        },
      ];
    });
  }
  if (mode === "overview") {
    const rows = directRows(result);
    if (!rows.length) {
      // An aggregate payload speaks for its paper only when there is one.
      const refs = inputRefs(input);
      const seed =
        refs.length === 1 ? paperReadOverviewSeed(output, refs[0]) : null;
      return seed ? [seed] : [];
    }
    return rows.flatMap((row): Seed[] => {
      const value = record(row);
      const ref = paperRef(row);
      const seed = value && ref ? paperReadOverviewSeed(value, ref) : null;
      return seed ? [seed] : [];
    });
  }
  if (mode === "outline") {
    return rowsAt(result, "papers").flatMap((row): Seed[] => {
      const value = record(row);
      const ref = paperRef(row);
      const sections = rowsAt(record(value?.outline), "sections");
      if (!value || !ref || !sections.length) return [];
      return [
        {
          ref,
          // Headings only: the paper's text was not read.
          state: "skimmed",
          read: readSeed({
            granularity: "outline",
            method: "outline",
            label: sections
              .map((section) => text(record(section)?.title))
              .filter(Boolean)
              .slice(0, 6)
              .join(" · "),
          }),
        },
      ];
    });
  }
  if (["figures", "visual", "capture"].includes(mode)) {
    return renderedPageSeeds(input, result);
  }
  // targeted, full, and explicit page reads. Grouped papers carry the same
  // passages as the flat results, so they win when present.
  const groups = rowsAt(result, "papers").filter((row) => paperRef(row));
  const rows = groups.length ? groups : directRows(result);
  if (rows.length) {
    return rows.flatMap((row): Seed[] => {
      const value = record(row);
      const ref = paperRef(row);
      return value && ref ? bodyRowSeeds(value, ref, mode) : [];
    });
  }
  // An aggregate payload speaks for its paper only when there is one.
  const refs = inputRefs(input);
  if (
    refs.length === 1 &&
    (hasText(output, BODY_KEYS) ||
      hasRows(output, ["passages", "snippets", "chunks"]))
  ) {
    return [
      {
        ref: refs[0],
        state: "read",
        read: readSeed({
          granularity: mode === "full" ? "full" : "passage",
          method: mode,
          snippet: firstText(output, BODY_KEYS),
        }),
      },
    ];
  }
  return [];
}

const BODY_KEYS = ["content", "text", "body", "fullText", "snippet"] as const;

/** The body reads one targeted/full result row carries. */
function bodyRowSeeds(row: Row, ref: PaperRef, mode: string): Seed[] {
  const passages = ["passages", "snippets", "chunks"]
    .flatMap((key) => rowsAt(row, key))
    .flatMap((passage) => {
      const value = record(passage);
      return value && hasText(value, ["text", "snippet"]) ? [value] : [];
    });
  if (passages.length) {
    return passages.map((passage) => ({
      ref,
      state: "read" as const,
      read: passageReadSeed(passage, mode),
    }));
  }
  const processed = Number(row.processedChunks) || 0;
  if (processed > 0 || hasRows(row, ["exactEvidence"])) {
    const total = Number(row.totalChunks) || 0;
    return [
      {
        ref,
        state: "read",
        read: readSeed({
          granularity: "full",
          method: mode,
          label: total ? `${processed}/${total} chunks` : undefined,
        }),
      },
    ];
  }
  if (hasText(row, BODY_KEYS)) {
    return [{ ref, state: "read", read: passageReadSeed(row, mode) }];
  }
  return [];
}

/** One page-level read of `ref`, from the page rows `container` lists. */
function pageSeed(ref: PaperRef, container: Row): Seed | null {
  const pageRows = [
    ...rowsAt(container, "results"),
    ...rowsAt(container, "pages"),
  ].flatMap((row) => {
    const value = record(row);
    const label = value ? pageLabelFor(value) : undefined;
    return label ? [label] : [];
  });
  const captured =
    nonNegative(container.capturedPageIndex) !== undefined
      ? pageLabelFor({
          pageLabel: container.pageLabel,
          pageIndex: container.capturedPageIndex,
        })
      : undefined;
  const own =
    container.pageIndex !== undefined ? pageLabelFor(container) : undefined;
  const labels = [
    ...new Set([
      ...pageRows,
      ...(captured ? [captured] : []),
      ...(own ? [own] : []),
    ]),
  ];
  const hasVisual =
    pageRows.length > 0 ||
    Boolean(captured) ||
    hasRows(container, ["images", "artifacts", "figures", "pages"]);
  if (!hasVisual) return null;
  return {
    ref,
    state: "read",
    read: readSeed({
      granularity: "page",
      method: "view_pages",
      label: labels.slice(0, 8).join(", "),
      snippet: text(container.pageText),
    }),
  };
}

function renderedPageSeeds(input: unknown, result: unknown): Seed[] {
  const output = record(result) || {};
  // Rows that name their own paper speak for it; otherwise the payload's
  // target (or the call's single target) owns the rendered pages.
  const identified = directRows(result).flatMap((row) => {
    const value = record(row);
    const ref = paperRef(row);
    return value && ref ? [{ value, ref }] : [];
  });
  if (identified.length) {
    return identified.flatMap(({ value, ref }) => {
      const seed = pageSeed(ref, value);
      return seed ? [seed] : [];
    });
  }
  const ref =
    paperRef(output.target) || paperRef(output) || inputRefs(input)[0];
  const seed = ref ? pageSeed(ref, output) : null;
  return seed ? [seed] : [];
}

function readAttachmentSeeds(input: unknown, result: unknown): Seed[] {
  const output = record(result) || {};
  const rows = directRows(result);
  if (rows.length) {
    return rows.flatMap((row): Seed[] => {
      const ref = paperRef(row);
      const body = firstText(row, ["content", "text", "body", "textContent"]);
      return ref && body
        ? [
            {
              ref,
              state: "read",
              read: readSeed({
                granularity: "full",
                method: "attachment",
                snippet: body,
              }),
            },
          ]
        : [];
    });
  }
  const body = firstText(output, ["content", "text", "body", "textContent"]);
  if (!body) return [];
  const ref = paperRef(output) || inputRefs(input)[0];
  if (!ref) return [];
  return [
    {
      ref,
      state: "read",
      read: readSeed({
        granularity: "full",
        method: "attachment",
        label: text(output.attachmentTitle) || text(output.title),
        snippet: body,
      }),
    },
  ];
}

function seedsFor(toolName: string, input: unknown, result: unknown): Seed[] {
  switch (toolName) {
    case "library_retrieve":
      return libraryRetrieveSeeds(result);
    case "library_search":
      return metadataListSeeds(input, result);
    case "library_read":
      return libraryReadSeeds(result);
    case "paper_read":
      return paperReadSeeds(input, result);
    case "read_attachment":
      return readAttachmentSeeds(input, result);
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Delta derivation
// ---------------------------------------------------------------------------

export type TaskPaperResolvedRef = { itemId: number; libraryID?: number };

export type DeriveTaskPaperLedgerDeltaParams = {
  toolName: string;
  callId: string;
  input: unknown;
  /** The tool's original content, never a handle-replaced copy. */
  content: unknown;
  /** Library the call ran against; used when a row names none. */
  libraryID?: number;
  turnIndex?: number;
  runId?: string;
  /**
   * Host lookup from a row's ids to its bibliographic item and library.
   * Without it, a row that names only an attachment is skipped.
   */
  resolvePaper?: (ref: {
    itemId?: number;
    contextItemId?: number;
  }) => TaskPaperResolvedRef | null | undefined;
};

/**
 * What one successful read call adds to the ledger, or `null` when the tool
 * is not a paper read or its payload names no paper.
 */
export function deriveTaskPaperLedgerDelta(
  params: DeriveTaskPaperLedgerDeltaParams,
): TaskPaperLedgerDelta | null {
  if (!TASK_PAPER_LEDGER_TOOL_NAMES.has(params.toolName)) return null;
  const seeds = seedsFor(params.toolName, params.input, params.content);
  if (!seeds.length) return null;
  const papers = new Map<string, TaskPaperDeltaPaper>();
  const readsByKey = new Map<string, TaskPaperReadEvent[]>();
  const readIdentity = new Set<string>();
  let droppedReads = 0;
  for (const seed of seeds) {
    const resolved = resolveRef(seed.ref, params);
    if (!resolved) continue;
    const key = taskPaperKey(resolved.libraryID, resolved.itemId);
    const existing = papers.get(key);
    if (existing) {
      existing.state = strongerState(existing.state, seed.state);
      existing.text = strongerText(existing.text, seed.text);
      // Only defined values: the delta is persisted as JSON, and a key that
      // holds `undefined` would make the live and replayed deltas differ.
      if (!existing.title && seed.ref.title) existing.title = seed.ref.title;
      if (!existing.year && seed.ref.year) existing.year = seed.ref.year;
      if (!existing.creator && seed.ref.creator) {
        existing.creator = seed.ref.creator;
      }
      if (!existing.contextItemId && seed.ref.contextItemId) {
        existing.contextItemId = seed.ref.contextItemId;
      }
      if (existing.text === "unknown") delete existing.text;
    } else {
      const paper: TaskPaperDeltaPaper = {
        key,
        libraryID: resolved.libraryID,
        itemId: resolved.itemId,
        state: seed.state,
      };
      if (seed.ref.contextItemId) paper.contextItemId = seed.ref.contextItemId;
      if (seed.ref.title) paper.title = seed.ref.title;
      if (seed.ref.year) paper.year = seed.ref.year;
      if (seed.ref.creator) paper.creator = seed.ref.creator;
      if (seed.text && seed.text !== "unknown") paper.text = seed.text;
      papers.set(key, paper);
    }
    if (!seed.read) continue;
    const identity = `${key}\u0000${JSON.stringify(seed.read)}`;
    if (readIdentity.has(identity)) continue;
    readIdentity.add(identity);
    const reads = readsByKey.get(key) || [];
    if (reads.length >= TASK_PAPER_MAX_READS_PER_TURN) {
      droppedReads += 1;
      continue;
    }
    const event: TaskPaperReadEvent = {
      key,
      callId: params.callId,
      toolName: params.toolName,
      ...seed.read,
    };
    if (params.runId) event.runId = params.runId;
    if (params.turnIndex !== undefined) event.turnIndex = params.turnIndex;
    reads.push(event);
    readsByKey.set(key, reads);
  }
  if (!papers.size) return null;
  const delta: TaskPaperLedgerDelta = {
    version: 1,
    callId: params.callId,
    toolName: params.toolName,
    papers: [...papers.values()].slice(0, TASK_PAPER_MAX_PAPERS),
    reads: [...readsByKey.values()].flat(),
  };
  if (params.runId) delta.runId = params.runId;
  if (params.turnIndex !== undefined) delta.turnIndex = params.turnIndex;
  if (droppedReads) delta.droppedReads = droppedReads;
  return delta;
}

function resolveRef(
  ref: PaperRef,
  params: DeriveTaskPaperLedgerDeltaParams,
): { itemId: number; libraryID: number } | null {
  // A row that already names its paper and library needs no lookup; a
  // 200-candidate retrieval would otherwise ask Zotero 200 times.
  if (ref.itemId && ref.libraryID) {
    return { itemId: ref.itemId, libraryID: ref.libraryID };
  }
  const resolved = params.resolvePaper?.({
    itemId: ref.itemId,
    contextItemId: ref.contextItemId,
  });
  const itemId = resolved?.itemId || ref.itemId;
  const libraryID =
    ref.libraryID || resolved?.libraryID || positive(params.libraryID);
  if (!itemId || !libraryID) return null;
  return { itemId, libraryID };
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export function createTaskPaperLedger(): TaskPaperLedger {
  return {
    version: 1,
    order: [],
    papers: {},
    appliedCalls: {},
    droppedPapers: 0,
  };
}

function emptyTurn(): TaskPaperTurnRecord {
  return {
    state: "listed",
    readState: "listed",
    reads: [],
    droppedReads: 0,
    citations: [],
    droppedCitations: 0,
  };
}

function ensureEntry(
  ledger: TaskPaperLedger,
  paper: { key: string; libraryID: number; itemId: number },
): TaskPaperLedgerEntry | null {
  const existing = ledger.papers[paper.key];
  if (existing) return existing;
  if (ledger.order.length >= TASK_PAPER_MAX_PAPERS) {
    ledger.droppedPapers += 1;
    return null;
  }
  const entry: TaskPaperLedgerEntry = {
    key: paper.key,
    libraryID: paper.libraryID,
    itemId: paper.itemId,
    contextItemIds: [],
    text: "unknown",
    state: "listed",
    latestTurn: 0,
    turns: {},
  };
  ledger.papers[paper.key] = entry;
  ledger.order.push(paper.key);
  return entry;
}

function turnOf(entry: TaskPaperLedgerEntry, turnIndex: number) {
  const turn = entry.turns[turnIndex] || emptyTurn();
  entry.turns[turnIndex] = turn;
  entry.latestTurn = Math.max(entry.latestTurn, turnIndex);
  return turn;
}

function appliedCallKey(delta: TaskPaperLedgerDelta): string {
  return `${delta.runId || ""}:${delta.callId}`;
}

/**
 * Fold one delta into the ledger, in place, and return the ledger.
 *
 * Idempotent by `runId:callId`: a replayed delta changes nothing. States
 * only ever rise. `turnIndex` overrides the delta's own turn, for a store
 * that numbers turns from the conversation rather than from the event.
 */
export function applyTaskPaperLedgerDelta(
  ledger: TaskPaperLedger,
  delta: TaskPaperLedgerDelta,
  turnIndex?: number,
): TaskPaperLedger {
  const callKey = appliedCallKey(delta);
  if (ledger.appliedCalls[callKey]) return ledger;
  ledger.appliedCalls[callKey] = true;
  const turn = turnIndex ?? delta.turnIndex ?? 0;
  for (const paper of delta.papers) {
    const entry = ensureEntry(ledger, paper);
    if (!entry) continue;
    ledger.lastLibraryID = paper.libraryID;
    if (!entry.title && paper.title) entry.title = paper.title;
    if (!entry.year && paper.year) entry.year = paper.year;
    if (!entry.creator && paper.creator) entry.creator = paper.creator;
    entry.text = strongerText(entry.text, paper.text);
    if (
      paper.contextItemId &&
      !entry.contextItemIds.includes(paper.contextItemId)
    ) {
      entry.contextItemIds.push(paper.contextItemId);
    }
    entry.state = strongerState(entry.state, paper.state);
    const record = turnOf(entry, turn);
    record.state = strongerState(record.state, paper.state);
    record.readState = strongerState(record.readState, paper.state);
  }
  for (const read of delta.reads) {
    const entry = ledger.papers[read.key];
    if (!entry) continue;
    const record = turnOf(entry, turn);
    if (record.reads.length >= TASK_PAPER_MAX_READS_PER_TURN) {
      record.droppedReads += 1;
      continue;
    }
    record.reads.push({ ...read, turnIndex: turn });
  }
  return ledger;
}

/**
 * Mark the papers the final answer cites, in place, and return the ledger.
 *
 * Replaces that turn's citations exactly: applying the same answer twice is
 * a no-op, and a citation the new answer dropped no longer counts, so a
 * paper cited only by it falls back to the strongest state its reads earned.
 * Citations naming only an attachment attach to the paper already known to
 * own it; citations naming nothing known are dropped.
 */
export function applyFinalCitations(
  ledger: TaskPaperLedger,
  quoteCitations: readonly QuoteCitation[] | undefined,
  turnIndex: number,
  libraryID?: number,
): TaskPaperLedger {
  const touched = new Set<TaskPaperLedgerEntry>();
  for (const entry of Object.values(ledger.papers)) {
    const turn = entry.turns[turnIndex];
    if (!turn) continue;
    if (turn.citations.length || turn.droppedCitations) touched.add(entry);
    turn.citations = [];
    turn.droppedCitations = 0;
    turn.state = turn.readState;
  }
  const seen = new Set<string>();
  for (const citation of quoteCitations || []) {
    const entry = citationEntry(ledger, citation, libraryID);
    if (!entry) continue;
    const identity = `${entry.key}\u0000${citation.id}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    touched.add(entry);
    const turn = turnOf(entry, turnIndex);
    turn.state = "cited";
    if (turn.citations.length >= TASK_PAPER_MAX_CITATIONS_PER_TURN) {
      turn.droppedCitations += 1;
      continue;
    }
    const cited: TaskPaperCitation = { citationId: citation.id, turnIndex };
    const quote = clipTaskPaperText(
      citation.displayQuoteText || citation.quoteText,
      TASK_PAPER_CITATION_QUOTE_MAX_CHARS,
    );
    if (quote) cited.quote = quote;
    if (citation.citationLabel) cited.label = citation.citationLabel;
    if (citation.sourceSectionLabel) {
      cited.sectionLabel = citation.sourceSectionLabel;
    }
    if (citation.pageHintLabel) cited.pageLabel = citation.pageHintLabel;
    turn.citations.push(cited);
  }
  // A paper's state is the strongest over its turns.
  for (const entry of touched) {
    let state: TaskPaperState = "listed";
    for (const turn of Object.values(entry.turns)) {
      state = strongerState(state, turn.state);
    }
    entry.state = state;
  }
  return ledger;
}

function citationEntry(
  ledger: TaskPaperLedger,
  citation: QuoteCitation,
  libraryID?: number,
): TaskPaperLedgerEntry | null {
  const itemId = positive(citation.itemId);
  const contextItemId = positive(citation.contextItemId);
  if (itemId) {
    if (libraryID) {
      return (
        ledger.papers[taskPaperKey(libraryID, itemId)] ||
        ensureEntry(ledger, {
          key: taskPaperKey(libraryID, itemId),
          libraryID,
          itemId,
        })
      );
    }
    const known = Object.values(ledger.papers).find(
      (entry) => entry.itemId === itemId,
    );
    if (known) return known;
    const fallback = ledger.lastLibraryID;
    return fallback
      ? ensureEntry(ledger, {
          key: taskPaperKey(fallback, itemId),
          libraryID: fallback,
          itemId,
        })
      : null;
  }
  if (contextItemId) {
    return (
      Object.values(ledger.papers).find((entry) =>
        entry.contextItemIds.includes(contextItemId),
      ) || null
    );
  }
  return null;
}
