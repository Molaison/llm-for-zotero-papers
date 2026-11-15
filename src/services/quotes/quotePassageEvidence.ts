import {
  buildQuoteTextIndex,
  findQuoteSourceSpansAllowingLayoutArtifacts,
  normalizeAcademicMathContent,
} from "./quoteTextNormalization";

type MathRange = { start: number; end: number; text: string };
export type QuotePassageEvidence =
  | "supported"
  | "conflict"
  | "incomplete"
  | "unmatched";

/** Locate presentation-marked formulae without classifying ordinary prose as math. */
function mathRanges(text: string): MathRange[] {
  const ranges: MathRange[] = [];
  for (let cursor = 0; cursor < text.length; cursor += 1) {
    let end = -1;
    if (text[cursor] === "$" && text[cursor - 1] !== "\\") {
      const delimiter = text[cursor + 1] === "$" ? "$$" : "$";
      const close = text.indexOf(delimiter, cursor + delimiter.length);
      if (close >= 0) end = close + delimiter.length;
    } else if (text.startsWith("\\(", cursor)) {
      const close = text.indexOf("\\)", cursor + 2);
      if (close >= 0) end = close + 2;
    } else if (text[cursor] === "(") {
      let depth = 1;
      for (
        let next = cursor + 1;
        next < text.length && next - cursor < 512;
        next += 1
      ) {
        if (text[next] === "(") depth += 1;
        if (text[next] === ")") depth -= 1;
        if (depth === 0) {
          end = next + 1;
          break;
        }
      }
      if (end > 0) {
        const content = text.slice(cursor, end);
        const withoutCommands = content.replace(/\\[A-Za-z]+/g, " ");
        if (!/[=<>≤≥≠]/u.test(content) || /\p{L}{3,}/u.test(withoutCommands))
          end = -1;
      }
    }
    if (end <= cursor) continue;
    ranges.push({ start: cursor, end, text: text.slice(cursor, end) });
    cursor = end - 1;
  }
  return ranges;
}

/** A one-token placeholder retains source offsets and the ordered prose skeleton. */
function maskMath(text: string, ranges: MathRange[]): string {
  let out = "";
  let cursor = 0;
  for (const range of ranges) {
    out += text.slice(cursor, range.start);
    out += `q${" ".repeat(range.end - range.start - 1)}`;
    cursor = range.end;
  }
  return out + text.slice(cursor);
}

function scriptedIdentifiers(displayedMath: string): string[] {
  return Array.from(
    displayedMath.matchAll(
      /(\\[A-Za-z]+|\p{L})(?:[⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉]|[_^]\s*\{?\s*\d)/gu,
    ),
    (match) => normalizeAcademicMathContent(match[1]),
  );
}

function mathKey(text: string, scripts: string[]): string {
  let key = normalizeAcademicMathContent(text)
    .replace(/\$/g, "")
    .replace(/\\[()]/g, "");
  // PDF extraction can place a numeric script inside the following index
  // parentheses: χ²₍₁,N=89₎ becomes χ(21,N=89), or F₂,₆₈ becomes F(268).
  // Only identifiers explicitly scripted by the displayed quote qualify.
  // Ordinary function/algebra parentheses and all operators remain intact.
  for (const base of scripts) {
    const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    key = key.replace(
      new RegExp(
        `(?<![\\p{L}\\p{N}])${escaped}(\\d*)\\((\\d[\\p{L}\\p{N},;=.]*?)\\)`,
        "gu",
      ),
      (_match, exponent: string, index: string) =>
        `${base}${exponent}${index.replace(/,/g, "")}`,
    );
    key = key.replace(
      new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(\\d+(?:,\\d+)+)`, "gu"),
      (_match, index: string) => `${base}${index.replace(/,/g, "")}`,
    );
  }
  return key;
}

function compareMathRanges(
  source: MathRange[],
  displayed: MathRange[],
): QuotePassageEvidence {
  if (!displayed.length || source.length !== displayed.length)
    return "incomplete";
  for (let i = 0; i < source.length; i += 1) {
    const scripts = scriptedIdentifiers(displayed[i].text);
    if (
      mathKey(source[i].text, scripts) === mathKey(displayed[i].text, scripts)
    )
      continue;
    if (/[ðÞ�]/u.test(source[i].text)) return "incomplete";
    return "conflict";
  }
  return "supported";
}

/** Compare formulae only after a caller has located the corresponding passage. */
export function assessQuoteMathCompatibility(
  sourceText: string,
  quoteText: string,
): QuotePassageEvidence {
  return compareMathRanges(mathRanges(sourceText), mathRanges(quoteText));
}

/**
 * Reuse a unique source anchor to check the surrounding passage, independent
 * of how much of the quote the anchor occupies. No new PDF extraction/search
 * is performed. Every prose token must align in order, including intervening
 * source words; only presentation-marked math is compared separately.
 */
export function assessAnchoredQuotePassage(params: {
  sourceText: string;
  quoteText: string;
  anchorText: string;
}): QuotePassageEvidence {
  const displayedMath = mathRanges(params.quoteText);
  if (!displayedMath.length) return "incomplete";
  const anchorStart = params.sourceText.indexOf(params.anchorText);
  if (anchorStart < 0) return "incomplete";
  const windowSize = Math.min(2048, params.quoteText.length * 3 + 128);
  const windowStart = Math.max(0, anchorStart - windowSize);
  const source = params.sourceText.slice(
    windowStart,
    anchorStart + params.anchorText.length + windowSize,
  );
  const sourceMath = mathRanges(source);
  if (!sourceMath.length) return "incomplete";
  const sourceProjection = maskMath(source, sourceMath);
  const quoteProjection = maskMath(params.quoteText, displayedMath);
  const spans = findQuoteSourceSpansAllowingLayoutArtifacts(
    buildQuoteTextIndex(sourceProjection),
    quoteProjection,
  );
  const localAnchorStart = anchorStart - windowStart;
  const localAnchorEnd = localAnchorStart + params.anchorText.length;
  for (const span of spans) {
    const expressions = sourceMath.filter(
      (range) =>
        range.start >= span.sourceStart && range.start < span.sourceEnd,
    );
    const spanEnd = Math.max(span.sourceEnd, expressions.at(-1)?.end || 0);
    if (
      span.sourceStart > localAnchorStart ||
      spanEnd < localAnchorEnd ||
      expressions.length !== displayedMath.length
    )
      continue;
    return compareMathRanges(expressions, displayedMath);
  }
  return "unmatched";
}
