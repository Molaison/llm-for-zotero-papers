import { DEEP_SYNTHESIS_MAX_PAPERS } from "../../shared/libraryChatReadStrategy";
import { estimateTextTokens } from "../../utils/modelInputCap";
import type {
  QueryLibraryInclude,
  QueryLibraryItemResult,
} from "./libraryQueryService";

/**
 * What the model reads of a library_search list, sized to the request.
 *
 * A list answers "what is here": every row by id, title, first creator and
 * year. The fields `include` asked for (metadata, abstracts, attachments,
 * tags, collections) come with the top rows only, as many as a bounded
 * synthesis reads in depth. The model's room caps the whole: past it, rows
 * lose their fields from the bottom up, then brief rows leave from the end.
 * A whole row drops what says nothing: an unset metadata field, and an
 * attachment or tag list `include` did not ask for.
 *
 * The stored result keeps every row whole and in order, so the rows shown
 * brief, or not at all, start at the number of rows shown whole.
 * `omitted.results` counts them.
 */
export const LIBRARY_LIST_FULL_ROWS = DEEP_SYNTHESIS_MAX_PAPERS;

const BRIEF_FIELDS = [
  "itemId",
  "title",
  "firstCreator",
  "year",
  "noteKind",
] as const;

type Row = Record<string, unknown>;

type ListResult = {
  results: QueryLibraryItemResult[];
} & Row;

export type LibraryListModelView = {
  content: Row;
  stored: Row;
};

function briefRow(row: QueryLibraryItemResult): Row {
  const source = row as unknown as Row;
  const out: Row = {};
  for (const field of BRIEF_FIELDS) {
    if (source[field] !== undefined && source[field] !== "") {
      out[field] = source[field];
    }
  }
  return out;
}

function wholeRow(
  row: QueryLibraryItemResult,
  include: readonly QueryLibraryInclude[],
): Row {
  const { attachments, tags, metadata, ...rest } = row;
  const out: Row = { ...rest };
  if (include.includes("attachments")) out.attachments = attachments;
  if (include.includes("tags")) out.tags = tags;
  if (metadata) {
    const fields = Object.fromEntries(
      Object.entries(metadata.fields || {}).filter(
        ([, value]) => value !== "" && value !== undefined && value !== null,
      ),
    );
    // The row already names the item, its type and title.
    out.metadata = {
      fields,
      ...(metadata.creators?.length ? { creators: metadata.creators } : {}),
    };
  } else if (metadata === null) {
    out.metadata = null;
  }
  return out;
}

function tokens(value: unknown): number {
  return estimateTextTokens(JSON.stringify(value));
}

export function buildLibraryListModelView(params: {
  input: { include?: QueryLibraryInclude[] };
  result: ListResult;
  /** The largest view, in tokens, the model's input budget makes room for. */
  roomTokens: number;
}): LibraryListModelView | null {
  const { result } = params;
  // An empty list has nothing to size.
  if (!Array.isArray(result?.results) || !result.results.length) return null;
  const include = params.input.include || [];
  const rows = result.results;
  let wholeCount = Math.min(LIBRARY_LIST_FULL_ROWS, rows.length);
  let briefCount = rows.length - wholeCount;
  const build = () => {
    const omitted = rows.length - wholeCount;
    const { results: _results, ...rest } = result;
    void _results;
    return {
      ...rest,
      results: rows.slice(0, wholeCount).map((row) => wholeRow(row, include)),
      ...(briefCount
        ? {
            moreResults: rows
              .slice(wholeCount, wholeCount + briefCount)
              .map(briefRow),
          }
        : {}),
      ...(omitted ? { omitted: { results: omitted } } : {}),
    };
  };

  // Past the room, rows lose their fields from the bottom up (the top row
  // stays whole), then brief rows leave from the end.
  let total = tokens(build());
  while (total > params.roomTokens && wholeCount > 1) {
    const row = rows[wholeCount - 1];
    total -= tokens(wholeRow(row, include)) - tokens(briefRow(row));
    wholeCount -= 1;
    briefCount += 1;
  }
  while (total > params.roomTokens && briefCount > 0) {
    total -= tokens(briefRow(rows[wholeCount + briefCount - 1]));
    briefCount -= 1;
  }

  return { content: build(), stored: result };
}
