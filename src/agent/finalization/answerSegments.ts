/**
 * Text a model streams before it calls a tool is either a lead-in ("I'll
 * start by reading the papers…"), which the host rolls back, or deliverable
 * content (per-paper summaries, a table, a list of findings), which stays in
 * the answer. This module tells the two apart; it is pure.
 */

/** Unstructured text at least this long is deliverable content. */
export const SUBSTANTIVE_ANSWER_MIN_CHARS = 400;
/**
 * Headings, lists and bold numbered lines count only from this length: a
 * short plan ("## Plan\nRead first.", "I'll do two things:\n- …\n- …") is a
 * lead-in in markdown.
 */
export const STRUCTURED_ANSWER_MIN_CHARS = 160;

export type StreamedTextReason =
  | "length"
  | "heading"
  | "list"
  | "table"
  | "bold_numbered"
  | "lead_in";

const HEADING = /^#{1,6}\s+\S/m;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+\S/gm;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/m;
const BOLD_NUMBERED = /^\s*\*\*\s*\d+[.)]?\s+[^*\n]{2,}\*\*/m;

/**
 * Classification detail for logs and tests. Structure is checked before
 * length, so the reason names the most specific signal. A table counts at
 * any length; a heading, two list items or a bold numbered line count from
 * STRUCTURED_ANSWER_MIN_CHARS; anything else from SUBSTANTIVE_ANSWER_MIN_CHARS.
 */
export function classifyStreamedText(text: string): {
  substantive: boolean;
  reason: StreamedTextReason;
} {
  const trimmed = (text || "").trim();
  if (!trimmed) return { substantive: false, reason: "lead_in" };
  if (TABLE_SEPARATOR.test(trimmed))
    return { substantive: true, reason: "table" };
  if (trimmed.length >= STRUCTURED_ANSWER_MIN_CHARS) {
    if (HEADING.test(trimmed)) return { substantive: true, reason: "heading" };
    if ((trimmed.match(LIST_ITEM) || []).length >= 2)
      return { substantive: true, reason: "list" };
    if (BOLD_NUMBERED.test(trimmed))
      return { substantive: true, reason: "bold_numbered" };
  }
  if (trimmed.length >= SUBSTANTIVE_ANSWER_MIN_CHARS)
    return { substantive: true, reason: "length" };
  return { substantive: false, reason: "lead_in" };
}

/** True when streamed text is deliverable content rather than a lead-in. */
export function isSubstantiveAnswerText(text: string): boolean {
  return classifyStreamedText(text).substantive;
}

const REPEAT_SKIPPABLE = /\[\[(?:quote|cite):[^\]\n]*\]\]|\s+/gy;

/**
 * Comparison key of `text` -- runs of whitespace collapsed to one space,
 * `[[quote:…]]` / `[[cite:…]]` tokens dropped -- with, for each key
 * character, the offset in `text` just after the character it came from.
 */
function repeatKey(text: string): { key: string; ends: number[] } {
  let key = "";
  const ends: number[] = [];
  let index = 0;
  while (index < text.length) {
    REPEAT_SKIPPABLE.lastIndex = index;
    const match = REPEAT_SKIPPABLE.exec(text);
    if (match) {
      if (/^\s/.test(match[0]) && key && !key.endsWith(" ")) {
        key += " ";
        ends.push(index + match[0].length);
      }
      index += match[0].length;
      continue;
    }
    key += text[index];
    index += 1;
    ends.push(index);
  }
  return { key, ends };
}

/**
 * `text` without a leading repeat of `prefix`. The repeat is matched on
 * the comparison key, so a model that re-emits text it already wrote with
 * different line breaks or with citation tokens added is still caught; the
 * cut falls after the last character the repeat came from.
 */
export function withoutLeadingRepeat(text: string, prefix: string): string {
  if (!prefix || !text) return text;
  if (text.startsWith(prefix)) return text.slice(prefix.length);
  const wanted = repeatKey(prefix).key.trimEnd();
  if (!wanted) return text;
  const { key, ends } = repeatKey(text);
  if (!key.startsWith(wanted)) return text;
  return text
    .slice(ends[wanted.length - 1])
    .replace(/^(?:\s|\[\[(?:quote|cite):[^\]\n]*\]\])+/, "");
}
