import type { QuoteCitation } from "../../shared/types";
import { DEEP_SYNTHESIS_MAX_PAPERS } from "../../shared/libraryChatReadStrategy";
import { estimateTextTokens } from "../../utils/modelInputCap";
import type {
  LibraryRetrieveInput,
  LibraryRetrievePaperMatch,
  LibraryRetrieveResult,
  LibraryRetrieveSnippet,
} from "./libraryRetrieveService";

/**
 * What the model reads of a library_retrieve result, sized to the question.
 *
 * The service reads comprehensively; the answer needs only part of it. The
 * intent says which part:
 * - verify: every exact passage, and the papers it comes from;
 * - enumerate: every matching paper by id and title, with its best passage;
 * - summarize: the top papers read in depth (all their passages), as many
 *   as a bounded synthesis reads (DEEP_SYNTHESIS_MAX_PAPERS).
 * The caller's own perPaperTopK and maxSnippetPapers override the per-paper
 * and paper counts. The model's room caps the whole: past it, passages leave
 * from the lowest-ranked paper up, then ledger rows without a passage.
 *
 * Rows keep the fields an answer uses; the chunk text, scores and match
 * diagnostics, the candidate shortlist, the query plan and the text
 * renderings of the ledger stay in the stored result, whose row arrays list
 * the rows shown first. `omitted` counts the rows left out, and the papers
 * the synthesis digest covers: it restates the ledger and passages shown,
 * one line per shortlisted paper.
 */

const PAPER_FIELDS = [
  "itemId",
  "title",
  "matchStatus",
  "returnedSnippetCount",
] as const;
// contextItemId names the attachment a passage came from: paper_read's
// target, and the source its evidence ref covers.
const PASSAGE_FIELDS = [
  "snippetId",
  "itemId",
  "contextItemId",
  "citationLabel",
  "sectionLabel",
  "pageLabel",
  "snippet",
  "quoteCitationId",
  "leadingPassage",
] as const;

type Row = Record<string, unknown>;

export type LibraryRetrieveModelView = {
  content: Row;
  stored: Row;
};

function pick(row: object, fields: readonly string[]): Row {
  const source = row as Row;
  const out: Row = {};
  for (const field of fields) {
    if (source[field] !== undefined) out[field] = source[field];
  }
  return out;
}

/** `rows` with `shown` first, in the order shown, then the rest in order. */
function shownFirst<T>(rows: readonly T[], shown: readonly T[]): T[] {
  const inView = new Set(shown);
  return [...shown, ...rows.filter((row) => !inView.has(row))];
}

function tokens(value: unknown): number {
  return estimateTextTokens(JSON.stringify(value));
}

export function buildLibraryRetrieveModelView(params: {
  input: Pick<
    LibraryRetrieveInput,
    "perPaperTopK" | "maxSnippetPapers" | "maxFullTextPapers"
  >;
  result: LibraryRetrieveResult & { guidance?: string };
  /** The largest view, in tokens, the model's input budget makes room for. */
  roomTokens: number;
}): LibraryRetrieveModelView | null {
  const { input, result } = params;
  if (!Array.isArray(result?.paperMatches) || !Array.isArray(result.snippets))
    return null;
  const passagesByPaper = new Map<string, LibraryRetrieveSnippet[]>();
  for (const snippet of result.snippets) {
    const list = passagesByPaper.get(snippet.itemId) || [];
    list.push(snippet);
    passagesByPaper.set(snippet.itemId, list);
  }
  const hasPassages = (paper: LibraryRetrievePaperMatch) =>
    passagesByPaper.has(paper.itemId);
  const matched = (paper: LibraryRetrievePaperMatch) =>
    paper.matchStatus !== "not_enough_evidence";
  const perPaperOverride = input.perPaperTopK;
  const paperCountOverride = input.maxSnippetPapers ?? input.maxFullTextPapers;
  let papers: LibraryRetrievePaperMatch[];
  let perPaper: number;
  if (result.intent === "verify") {
    papers = result.paperMatches.filter(hasPassages);
    perPaper = perPaperOverride ?? Number.POSITIVE_INFINITY;
  } else if (result.intent === "summarize") {
    // A bounded synthesis plans every paper in scope, so a paper nothing
    // matched is still read; elsewhere such a paper is a fallback lead.
    const planned =
      result.answerContract?.resolvedStrategy === "deep_synthesis";
    papers = result.paperMatches
      .filter((paper) => hasPassages(paper) && (planned || matched(paper)))
      .slice(0, paperCountOverride ?? DEEP_SYNTHESIS_MAX_PAPERS);
    perPaper = perPaperOverride ?? Number.POSITIVE_INFINITY;
  } else {
    papers = result.paperMatches.filter(matched);
    perPaper = perPaperOverride ?? 1;
  }
  const passages = papers.flatMap((paper) =>
    [...(passagesByPaper.get(paper.itemId) || [])]
      // A passage that matched comes before the paper's leading passage.
      .sort(
        (left, right) =>
          Number(Boolean(left.leadingPassage)) -
          Number(Boolean(right.leadingPassage)),
      )
      .slice(0, perPaper),
  );

  const paperRow = (paper: LibraryRetrievePaperMatch) =>
    pick(paper, PAPER_FIELDS);
  const passageRow = (passage: LibraryRetrieveSnippet) =>
    pick(passage, PASSAGE_FIELDS);
  const { unreadableReasons, coverageFrontier, ...answerContract } =
    result.answerContract || ({} as LibraryRetrieveResult["answerContract"]);
  void unreadableReasons;
  void coverageFrontier;
  const build = () => {
    const quoteIds = new Set(
      passages.map((passage) => passage.quoteCitationId).filter(Boolean),
    );
    const quoteCitations = (result.quoteCitations || []).filter(
      (citation: QuoteCitation) => quoteIds.has(citation.id),
    );
    const omitted: Record<string, number> = {
      paperMatches: result.paperMatches.length - papers.length,
      snippets: result.snippets.length - passages.length,
      candidates: result.candidates?.length || 0,
      synthesisDigest: (result.synthesisDigest?.match(/^- Paper /gm) || [])
        .length,
    };
    for (const key of Object.keys(omitted)) {
      if (!omitted[key]) delete omitted[key];
    }
    return {
      ...(result.guidance ? { guidance: result.guidance } : {}),
      intent: result.intent,
      depth: result.depth,
      methodsUsed: result.methodsUsed,
      resourcePool: result.resourcePool,
      answerContract,
      frontier: result.frontier,
      warnings: result.warnings,
      paperMatches: papers.map(paperRow),
      snippets: passages.map(passageRow),
      ...(quoteCitations.length ? { quoteCitations } : {}),
      ...(Object.keys(omitted).length ? { omitted } : {}),
    };
  };

  // Past the room, passages leave from the lowest-ranked paper up (the best
  // one stays), then ledger rows whose paper shows no passage.
  let total = tokens(build());
  while (total > params.roomTokens && passages.length > 1) {
    total -= tokens(passageRow(passages.pop()!));
  }
  const withPassage = new Set(passages.map((passage) => passage.itemId));
  for (
    let index = papers.length - 1;
    index >= 0 && total > params.roomTokens && papers.length > 1;
    index -= 1
  ) {
    if (withPassage.has(papers[index].itemId)) continue;
    total -= tokens(paperRow(papers[index]));
    papers.splice(index, 1);
  }

  return {
    content: build(),
    stored: {
      ...result,
      paperMatches: shownFirst(result.paperMatches, papers),
      snippets: shownFirst(result.snippets, passages),
    },
  };
}
