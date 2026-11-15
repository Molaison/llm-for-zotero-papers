import {
  extractQuoteCitationsFromToolContent,
  mergeQuoteCitations,
} from "../../services/quotes/quoteCitations";
import type { QuoteCitation } from "../../shared/types";

const MAX_PASSAGE_CHARS = 8000;
const MAX_WALK_DEPTH = 8;

function readableText(value: unknown): string {
  return typeof value === "string" && value.trim() ? value : "";
}

/**
 * The passage a citation was cut from, read the way the model read it.
 *
 * `text` (paper_read) and `snippet` (library_retrieve) are what the model was
 * given: the snippet is the window around the exact match. `surroundingText`
 * is a different region of the same chunk — its head — so it can easily lack
 * the matched sentence entirely. Leading with it used to re-anchor an answer
 * to a sentence the model never received, so it now only follows the read
 * text as extra context, and is dropped first when the bound bites.
 */
function passageTextOf(record: Record<string, unknown>): string | undefined {
  const read = readableText(record.text) || readableText(record.snippet);
  const surrounding = readableText(record.surroundingText);
  if (!read) return surrounding || undefined;
  if (!surrounding || surrounding.trim() === read.trim()) return read;
  return `${read}\n\n${surrounding}`;
}

/**
 * Gathers, per run, every citation a tool delivered and the passage text it
 * was cut from, so the final answer can be re-anchored to its claims.
 *
 * A tool result carries two halves of the same evidence: the passage a reader
 * would see (`text`, `snippet`, `surroundingText`) and the citation ids cut
 * from it (`quoteCitationIds`, `quoteCitationId`). Only the pair lets the
 * answer's claim be matched back against the whole passage rather than the
 * one sentence the tool happened to pick.
 */
export class PassageCitationCollector {
  quoteCitations: QuoteCitation[] = [];
  readonly passageTextByCitationId = new Map<string, string>();

  collect(content: unknown, artifacts?: unknown): void {
    const citations = mergeQuoteCitations(
      extractQuoteCitationsFromToolContent(content),
      extractQuoteCitationsFromToolContent(artifacts),
    );
    if (citations.length) {
      this.quoteCitations = mergeQuoteCitations(this.quoteCitations, citations);
    }
    this.walk(content, new WeakSet());
    this.walk(artifacts, new WeakSet());
  }

  private walk(value: unknown, seen: WeakSet<object>, depth = 0): void {
    if (!value || typeof value !== "object") return;
    if (depth > MAX_WALK_DEPTH || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const entry of value) this.walk(entry, seen, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    const text = passageTextOf(record);
    const ids = [
      ...(Array.isArray(record.quoteCitationIds)
        ? record.quoteCitationIds
        : []),
      ...(typeof record.quoteCitationId === "string"
        ? [record.quoteCitationId]
        : []),
    ].filter(
      (id): id is string => typeof id === "string" && id.trim().length > 0,
    );
    if (text && ids.length) {
      const bounded =
        text.length > MAX_PASSAGE_CHARS
          ? text.slice(0, MAX_PASSAGE_CHARS)
          : text;
      for (const id of ids) {
        if (!this.passageTextByCitationId.has(id)) {
          this.passageTextByCitationId.set(id, bounded);
        }
      }
    }
    for (const key of Object.keys(record)) {
      // The citation list itself is evidence metadata, not passage text; its
      // quoteText would masquerade as the passage it was cut from.
      if (key === "quoteCitations") continue;
      this.walk(record[key], seen, depth + 1);
    }
  }
}
