/**
 * The persisted form of a big tool result.
 *
 * A successful tool result whose content serializes above
 * `PERSISTED_TOOL_RESULT_MAX_BYTES` (and that carries no action receipts) is
 * stored in the run's trace as this marker; its content lives under `handle`
 * in the tool-result handle store. Events persisted before the marker existed
 * keep their content whole.
 */
export const PERSISTED_TOOL_RESULT_MAX_BYTES = 32 * 1024;

export type TruncatedToolResultContent = {
  truncated: true;
  /** The trh_ handle holding the whole content, when one was stored. */
  handle?: string;
  /** Length of the content's JSON, in UTF-16 code units. */
  bytes: number;
  /**
   * A bounded copy of the content for the trace row (`buildToolResultPreview`):
   * its JSON fits `PREVIEW_MAX_BYTES`. Absent on markers written before it
   * existed, or when no copy fits.
   */
  preview?: unknown;
};

export const PREVIEW_STRING_MAX_CHARS = 200;
/** The shorter cut taken when shortening the leaf arrays was not enough. */
export const PREVIEW_SHORT_STRING_MAX_CHARS = 60;
export const PREVIEW_ARRAY_MIN_ENTRIES = 3;
/** Leaves room for the marker's own fields under 8 KB. */
export const PREVIEW_MAX_BYTES = 8 * 1024 - 256;
const PREVIEW_MAX_DEPTH = 32;

function shortenStrings(
  value: unknown,
  maxChars: number,
  depth: number,
): unknown {
  if (typeof value === "string")
    return value.length > maxChars ? `${value.slice(0, maxChars)}…` : value;
  if (!value || typeof value !== "object") return value;
  if (depth > PREVIEW_MAX_DEPTH) return undefined;
  if (Array.isArray(value))
    return value.map(
      (entry) => shortenStrings(entry, maxChars, depth + 1) ?? null,
    );
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const shortened = shortenStrings(entry, maxChars, depth + 1);
    if (shortened !== undefined) out[key] = shortened;
  }
  return out;
}

function jsonLength(value: unknown): number {
  return JSON.stringify(value ?? null).length;
}

function containsArray(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return Object.values(value).some(
    (entry) => Array.isArray(entry) || containsArray(entry),
  );
}

/** Arrays longer than the minimum; with `leavesOnly`, those holding no array. */
function shortenableArrays(
  value: unknown,
  leavesOnly: boolean,
  out: unknown[][] = [],
): unknown[][] {
  if (!value || typeof value !== "object") return out;
  if (
    Array.isArray(value) &&
    value.length > PREVIEW_ARRAY_MIN_ENTRIES &&
    (!leavesOnly || !containsArray(value))
  )
    out.push(value);
  for (const entry of Object.values(value))
    shortenableArrays(entry, leavesOnly, out);
  return out;
}

/** Drops the last entries of the largest arrays, down to their first few. */
function shortenArrays(preview: unknown, leavesOnly: boolean): number {
  let size = jsonLength(preview);
  while (size > PREVIEW_MAX_BYTES) {
    const arrays = shortenableArrays(preview, leavesOnly);
    if (!arrays.length) break;
    let largest = arrays[0];
    let largestSize = jsonLength(largest);
    for (const array of arrays.slice(1)) {
      const arraySize = jsonLength(array);
      if (arraySize > largestSize) {
        largest = array;
        largestSize = arraySize;
      }
    }
    while (
      largest.length > PREVIEW_ARRAY_MIN_ENTRIES &&
      size > PREVIEW_MAX_BYTES
    ) {
      size -= jsonLength(largest.pop()) + 1;
    }
    size = jsonLength(preview);
  }
  return size;
}

/**
 * The bounded copy of a tool result a truncated marker keeps, or undefined
 * when even the shortest copy does not fit. Keys and scalar fields survive
 * (a result's `mode`, receipts, labels, counts). In order, until the JSON
 * fits: every string is cut to 200 characters; the largest arrays that hold
 * no array (passage ids, citation lists) lose their last entries; strings
 * are cut to 60 characters; then any array loses its last entries. No array
 * is cut below its first three entries.
 */
export function buildToolResultPreview(content: unknown): unknown {
  try {
    let preview = shortenStrings(content, PREVIEW_STRING_MAX_CHARS, 0);
    if (shortenArrays(preview, true) <= PREVIEW_MAX_BYTES) return preview;
    preview = shortenStrings(preview, PREVIEW_SHORT_STRING_MAX_CHARS, 0);
    if (jsonLength(preview) <= PREVIEW_MAX_BYTES) return preview;
    return shortenArrays(preview, false) <= PREVIEW_MAX_BYTES
      ? preview
      : undefined;
  } catch {
    return undefined;
  }
}

/** The content a trace row reads: a stored result's preview, else the content. */
export function toolResultContentForDisplay(content: unknown): unknown {
  return isTruncatedToolResultContent(content) ? content.preview : content;
}

export function isTruncatedToolResultContent(
  value: unknown,
): value is TruncatedToolResultContent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.truncated === true &&
    typeof record.bytes === "number" &&
    Number.isFinite(record.bytes) &&
    (record.handle === undefined || typeof record.handle === "string")
  );
}
