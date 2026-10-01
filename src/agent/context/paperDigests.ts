/**
 * The per-paper results of a long job: what the turn's reads returned for
 * each paper, kept with the paper's id, its anchors (section, page, quote
 * anchor) and handles to the full results, within the paper's share of the
 * input budget. When the host ends a page it replaces the page's raw reads
 * with these digests, so the final answer sees every paper's results
 * without the context growing with the job.
 *
 * Pure: reads only the tool messages it is given.
 */
import {
  estimateTextTokens,
  sliceTextToTokenBudget,
} from "../../utils/modelInputCap";
import type { AgentModelMessage } from "../types";
import { PAPER_RETRIEVAL_TOOL_NAMES } from "./toolNames";

export type PaperExcerpt = {
  text: string;
  section?: string;
  page?: string;
  /** A quote anchor the answer can cite. */
  quoteId?: string;
};

/** What the reads in a set of tool messages returned for one paper. */
export type PaperEvidence = {
  title?: string;
  excerpts: PaperExcerpt[];
  /** A read reported the paper has no readable text, and none returned any. */
  noText: boolean;
  /** The tool calls whose results hold it. */
  calls: Array<{ name: string; callId: string }>;
};

export type PaperDigest = {
  itemId: number;
  title?: string;
  /** In reading order, as many as the paper's share holds. */
  excerpts: PaperExcerpt[];
  /** Excerpts left out to fit the share; the handles hold them. */
  omitted?: number;
  noText?: true;
  /** For context_read source:'tool_result'. */
  handles: string[];
};

type Row = Record<string, unknown>;

function record(value: unknown): Row | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : null;
}

function rows(value: unknown): Row[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => (record(entry) ? [entry as Row] : []))
    : [];
}

function positive(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/\s+/g, " ").trim();
  return clean || undefined;
}

function pageOf(row: Row): string | undefined {
  const label = text(row.pageLabel);
  if (label) return label;
  const index = Number(row.pageIndex);
  return Number.isInteger(index) && index >= 0 ? String(index + 1) : undefined;
}

function paperOf(row: Row): { itemId?: number; title?: string } {
  const paper = record(row.paperContext) || record(row.target);
  return {
    itemId: positive(paper?.itemId ?? row.itemId ?? row.itemID),
    title: text(paper?.title) ?? text(row.title),
  };
}

function excerpt(row: Row, body: string | undefined): PaperExcerpt | null {
  if (!body) return null;
  const section =
    text(row.sectionLabel) ??
    (String(row.sourceKind || "") === "abstract" ? "Abstract" : undefined);
  const page = pageOf(row);
  const quoteId = text(row.quoteCitationId);
  return {
    text: body,
    ...(section ? { section } : {}),
    ...(page ? { page } : {}),
    ...(quoteId ? { quoteId } : {}),
  };
}

type Found = {
  itemId: number;
  title?: string;
  excerpt?: PaperExcerpt;
  noText?: boolean;
};

/** Every paper excerpt one read result holds, by the paper it names. */
function foundIn(content: Row): Found[] {
  const found: Found[] = [];
  const add = (row: Row, entry: Omit<Found, "itemId" | "title">) => {
    const paper = paperOf(row);
    if (paper.itemId)
      found.push({ itemId: paper.itemId, title: paper.title, ...entry });
  };
  for (const row of rows(content.papers)) {
    const passages = ["passages", "snippets", "chunks"].flatMap((key) =>
      rows(row[key]),
    );
    if (!passages.length) {
      const body = excerpt(row, text(row.text ?? row.content ?? row.body));
      add(row, body ? { excerpt: body } : {});
    }
    for (const passage of passages) {
      const body = excerpt(passage, text(passage.text ?? passage.snippet));
      if (body) add(row, { excerpt: body });
    }
  }
  for (const row of rows(content.results)) {
    if (
      row.backend === "zotero_metadata" ||
      row.sourceKind === "zotero_metadata"
    ) {
      add(row, { noText: true });
      continue;
    }
    const body = excerpt(
      row,
      text(row.text ?? row.content ?? row.body ?? row.snippet),
    );
    if (body) add(row, { excerpt: body });
  }
  for (const row of rows(content.snippets)) {
    if (String(row.sourceKind || "") === "metadata") continue;
    const body = excerpt(row, text(row.snippet ?? row.text));
    if (body) add(row, { excerpt: body });
  }
  // A quote anchor the result offers for a passage it returned.
  const quotes = rows(content.quoteCitations);
  for (const entry of found) {
    if (!entry.excerpt || entry.excerpt.quoteId) continue;
    const quote = quotes.find(
      (candidate) =>
        positive(candidate.itemId) === entry.itemId &&
        Boolean(text(candidate.quoteText)) &&
        entry.excerpt!.text.includes(text(candidate.quoteText)!),
    );
    const id = quote ? text(quote.id) : undefined;
    if (id) entry.excerpt = { ...entry.excerpt, quoteId: id };
  }
  return found;
}

function parse(message: AgentModelMessage): Row | null {
  if (message.role !== "tool") return null;
  try {
    return record(JSON.parse(message.content));
  } catch {
    return null;
  }
}

/** What the read results among `messages` hold for each paper. */
export function collectPaperEvidence(
  messages: readonly AgentModelMessage[],
): Map<number, PaperEvidence> {
  const evidence = new Map<number, PaperEvidence & { reported: boolean }>();
  for (const message of messages) {
    if (
      message.role !== "tool" ||
      !PAPER_RETRIEVAL_TOOL_NAMES.has(message.name)
    )
      continue;
    const content = parse(message);
    if (!content) continue;
    for (const found of foundIn(content)) {
      const entry = evidence.get(found.itemId) || {
        excerpts: [],
        noText: false,
        reported: false,
        calls: [],
      };
      if (!entry.title && found.title) entry.title = found.title;
      if (found.noText) entry.reported = true;
      if (
        found.excerpt &&
        !entry.excerpts.some(
          (known) =>
            known.text === found.excerpt!.text &&
            known.section === found.excerpt!.section,
        )
      ) {
        entry.excerpts.push(found.excerpt);
      }
      if (!entry.calls.some((call) => call.callId === message.tool_call_id)) {
        entry.calls.push({ name: message.name, callId: message.tool_call_id });
      }
      evidence.set(found.itemId, entry);
    }
  }
  return new Map(
    [...evidence].map(([itemId, { reported, ...entry }]) => [
      itemId,
      {
        ...(entry.title ? { title: entry.title } : {}),
        excerpts: entry.excerpts,
        noText: reported && !entry.excerpts.length,
        calls: entry.calls,
      },
    ]),
  );
}

function tokensOf(value: unknown): number {
  return estimateTextTokens(JSON.stringify(value));
}

/**
 * One paper's digest within `maxTokens`: its id, title and handles always,
 * then its excerpts in reading order while they fit; the first one is cut to
 * fit when it alone does not.
 */
export function buildPaperDigest(
  itemId: number,
  evidence: PaperEvidence,
  handles: readonly string[],
  maxTokens: number,
): PaperDigest {
  const digest: PaperDigest = {
    itemId,
    ...(evidence.title ? { title: evidence.title } : {}),
    excerpts: [],
    ...(evidence.noText ? { noText: true as const } : {}),
    handles: [...handles],
  };
  for (const [index, candidate] of evidence.excerpts.entries()) {
    const next = { ...digest, excerpts: [...digest.excerpts, candidate] };
    if (tokensOf(next) <= maxTokens) {
      digest.excerpts.push(candidate);
      continue;
    }
    if (index === 0) {
      const room =
        maxTokens -
        tokensOf({ ...digest, excerpts: [{ ...candidate, text: "" }] });
      const cut = sliceTextToTokenBudget(candidate.text, room - 1).trimEnd();
      if (cut) digest.excerpts.push({ ...candidate, text: `${cut}…` });
    }
    break;
  }
  const omitted = evidence.excerpts.length - digest.excerpts.length;
  if (omitted > 0) digest.omitted = omitted;
  return digest;
}

/**
 * The digests a job recorded, read back from where it stored them (a
 * `long_job_results` handle), so a resumed job carries them forward. An
 * entry that is not a digest is left out, and an excerpt without text
 * dropped; nothing is invented.
 */
export function readStoredPaperDigests(value: unknown): PaperDigest[] {
  return rows(value).flatMap((row): PaperDigest[] => {
    const itemId = positive(row.itemId);
    if (!itemId || !Array.isArray(row.excerpts)) return [];
    const excerpts = rows(row.excerpts).flatMap((entry): PaperExcerpt[] =>
      typeof entry.text === "string" && entry.text
        ? [
            {
              text: entry.text,
              ...(typeof entry.section === "string"
                ? { section: entry.section }
                : {}),
              ...(typeof entry.page === "string" ? { page: entry.page } : {}),
              ...(typeof entry.quoteId === "string"
                ? { quoteId: entry.quoteId }
                : {}),
            },
          ]
        : [],
    );
    const omitted = positive(row.omitted);
    return [
      {
        itemId,
        ...(typeof row.title === "string" ? { title: row.title } : {}),
        excerpts,
        ...(omitted ? { omitted } : {}),
        ...(row.noText === true ? { noText: true as const } : {}),
        handles: Array.isArray(row.handles)
          ? row.handles.filter(
              (handle): handle is string => typeof handle === "string",
            )
          : [],
      },
    ];
  });
}

function excerptLine(excerpt: PaperExcerpt): string {
  const anchor = [excerpt.section, excerpt.page ? `p. ${excerpt.page}` : ""]
    .filter(Boolean)
    .join(", ");
  return `  - ${anchor ? `${anchor}: ` : ""}"${excerpt.text}"${
    excerpt.quoteId ? ` (anchor ${excerpt.quoteId})` : ""
  }`;
}

/** The digests as the model reads them: one entry per paper. */
export function renderPaperDigests(digests: readonly PaperDigest[]): string {
  return digests
    .map((digest) =>
      [
        [
          `itemId=${digest.itemId}`,
          digest.title,
          digest.noText ? "no readable text" : "",
          digest.handles.length ? `handle ${digest.handles.join(", ")}` : "",
        ]
          .filter(Boolean)
          .join(" · "),
        ...digest.excerpts.map(excerptLine),
        ...(digest.omitted
          ? [`  - ${digest.omitted} more excerpts in the handle`]
          : []),
      ].join("\n"),
    )
    .join("\n");
}
