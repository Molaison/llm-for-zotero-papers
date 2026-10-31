import { createElement } from "../../../../utils/domHelpers";
import { sanitizeText } from "../../../../utils/textSanitization";
import { marked, type Token, type Tokens } from "marked";
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import type { ConversationHistoryEntry } from "./conversationHistoryController";
import { formatHistoryRowDisplayTitle } from "./conversationHistoryController";

export type HistorySearchTextCandidate = {
  kind: "title" | "message";
  text: string;
  normalizedText: string;
};

export type HistorySearchDocument = {
  conversationKey: number;
  candidates: HistorySearchTextCandidate[];
};

export type HistorySearchRange = {
  start: number;
  end: number;
};

export type HistorySearchResult = {
  entry: ConversationHistoryEntry;
  matchCount: number;
  titleRanges: HistorySearchRange[];
  previewText: string;
  previewRanges: HistorySearchRange[];
};

type HistorySearchMessage = {
  text?: unknown;
};

export function createHistorySearchDocumentFingerprint(
  entry: ConversationHistoryEntry,
): string {
  const conversationKey = Number.isFinite(entry.conversationKey)
    ? Math.floor(entry.conversationKey)
    : 0;
  const lastActivityAt = Number.isFinite(entry.lastActivityAt)
    ? Math.floor(entry.lastActivityAt)
    : 0;
  return JSON.stringify([
    conversationKey,
    entry.kind === "paper" ? "paper" : "global",
    entry.sourceState,
    normalizeHistorySearchText(entry.title),
    normalizeHistorySearchText(entry.sectionTitle),
    lastActivityAt,
  ]);
}

export function normalizeHistorySearchQuery(value: string): string {
  return sanitizeText(value || "")
    .trim()
    .toLocaleLowerCase();
}

export function normalizeHistorySearchText(value: unknown): string {
  return sanitizeText(typeof value === "string" ? value : String(value || ""))
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenizeHistorySearchQuery(normalizedQuery: string): string[] {
  return Array.from(
    new Set(
      normalizedQuery
        .split(/\s+/)
        .map((token) => token.trim())
        .filter(Boolean),
    ),
  );
}

function countHistorySearchTokenOccurrences(
  normalizedText: string,
  token: string,
): { count: number; firstIndex: number } {
  if (!normalizedText || !token) {
    return { count: 0, firstIndex: -1 };
  }
  let count = 0;
  let firstIndex = -1;
  let cursor = 0;
  while (cursor < normalizedText.length) {
    const index = normalizedText.indexOf(token, cursor);
    if (index < 0) break;
    count += 1;
    if (firstIndex < 0) {
      firstIndex = index;
    }
    cursor = index + token.length;
  }
  return { count, firstIndex };
}

export function collectHistorySearchRanges(
  text: string,
  searchTokens: string[],
): HistorySearchRange[] {
  if (!text || !searchTokens.length) return [];
  const normalizedText = text.toLocaleLowerCase();
  const ranges: HistorySearchRange[] = [];
  for (const token of searchTokens) {
    let cursor = 0;
    while (cursor < normalizedText.length) {
      const index = normalizedText.indexOf(token, cursor);
      if (index < 0) break;
      ranges.push({
        start: index,
        end: index + token.length,
      });
      cursor = index + token.length;
    }
  }
  if (!ranges.length) return [];
  ranges.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    return a.end - b.end;
  });
  const merged: HistorySearchRange[] = [ranges[0]];
  for (const range of ranges.slice(1)) {
    const previous = merged[merged.length - 1];
    if (range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
      continue;
    }
    merged.push({ ...range });
  }
  return merged;
}

export function appendHistorySearchHighlightedText(
  container: HTMLElement,
  text: string,
  ranges: HistorySearchRange[],
): void {
  container.textContent = "";
  if (!ranges.length) {
    container.textContent = text;
    return;
  }
  const ownerDoc = container.ownerDocument;
  if (!ownerDoc) {
    container.textContent = text;
    return;
  }
  let cursor = 0;
  for (const range of ranges) {
    const start = Math.max(0, Math.min(text.length, range.start));
    const end = Math.max(start, Math.min(text.length, range.end));
    if (start > cursor) {
      container.appendChild(ownerDoc.createTextNode(text.slice(cursor, start)));
    }
    const mark = createElement(
      ownerDoc,
      "mark",
      "llm-history-search-highlight",
      {
        textContent: text.slice(start, end),
      },
    );
    container.appendChild(mark);
    cursor = end;
  }
  if (cursor < text.length) {
    container.appendChild(ownerDoc.createTextNode(text.slice(cursor)));
  }
}

function scoreHistorySearchCandidate(
  candidate: HistorySearchTextCandidate,
  searchTokens: string[],
): { matchCount: number; firstIndex: number } {
  let matchCount = 0;
  let firstIndex = -1;
  for (const token of searchTokens) {
    const occurrence = countHistorySearchTokenOccurrences(
      candidate.normalizedText,
      token,
    );
    matchCount += occurrence.count;
    if (
      occurrence.firstIndex >= 0 &&
      (firstIndex < 0 || occurrence.firstIndex < firstIndex)
    ) {
      firstIndex = occurrence.firstIndex;
    }
  }
  return { matchCount, firstIndex };
}

/** Presentation only: searchable candidates and their scores stay untouched. */
function historyPreviewPlainText(source: string): string {
  const literals: string[] = [];
  let marker = "LLMFORZOTEROMATH";
  while (source.includes(marker)) marker += "X";
  const protectedSource = source.replace(
    /\$\$[\s\S]*?\$\$|\$[^\n$]+\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]/g,
    (literal) => `${marker}${literals.push(literal) - 1}END`,
  );
  const htmlText = (value: string): string => {
    const read = (node: DefaultTreeAdapterMap["node"]): string => {
      if ("value" in node) return node.value;
      if ("tagName" in node && /^(script|style|template)$/.test(node.tagName)) {
        return "";
      }
      const text =
        "childNodes" in node ? node.childNodes.map(read).join("") : "";
      return "tagName" in node && /^(br|p|div|li|tr)$/.test(node.tagName)
        ? `${text} `
        : text;
    };
    return read(parseFragment(value));
  };
  const readTokens = (tokens: Token[]): string =>
    tokens
      .map((token) => {
        if (token.type === "code") return `${token.text} `;
        if (token.type === "codespan") return token.text;
        if (
          token.type === "space" ||
          token.type === "br" ||
          token.type === "hr"
        ) {
          return " ";
        }
        if (token.type === "def") return "";
        if (token.type === "list") return readTokens(token.items);
        if (token.type === "table") {
          const table = token as Tokens.Table;
          return [table.header, ...table.rows]
            .map((row) => row.map((cell) => readTokens(cell.tokens)).join(" "))
            .join(" ");
        }
        const children = "tokens" in token ? token.tokens : undefined;
        const text = Array.isArray(children)
          ? readTokens(children)
          : htmlText(
              "text" in token && typeof token.text === "string"
                ? token.text
                : token.raw,
            );
        return /^(paragraph|heading|blockquote|list_item)$/.test(token.type)
          ? `${text} `
          : text;
      })
      .join("");
  try {
    const text = readTokens(marked.lexer(protectedSource));
    return text.replace(
      new RegExp(`${marker}(\\d+)END`, "g"),
      (_match, index) => literals[Number(index)] ?? _match,
    );
  } catch {
    return source;
  }
}

export function buildHistorySearchPreview(
  text: string,
  searchTokens: string[],
): { previewText: string; previewRanges: HistorySearchRange[] } {
  const rawText = normalizeHistorySearchText(text);
  const plainText = normalizeHistorySearchText(historyPreviewPlainText(text));
  // A query for a URL or literal Markdown syntax should still explain its
  // raw-text match even when that syntax has no plain-text representation.
  const normalizedText = collectHistorySearchRanges(plainText, searchTokens)
    .length
    ? plainText
    : rawText;
  if (!normalizedText) {
    return { previewText: "", previewRanges: [] };
  }
  const ranges = collectHistorySearchRanges(normalizedText, searchTokens);
  if (!ranges.length) {
    return { previewText: "", previewRanges: [] };
  }
  const firstRange = ranges[0];
  const beforeContext = 14;
  const afterContext = 52;
  const minimumSnippetLength = 72;
  let start = Math.max(0, firstRange.start - beforeContext);
  let end = Math.min(normalizedText.length, firstRange.end + afterContext);
  if (end - start < minimumSnippetLength) {
    const deficit = minimumSnippetLength - (end - start);
    const shiftLeft = Math.min(start, Math.ceil(deficit / 2));
    start -= shiftLeft;
    end = Math.min(normalizedText.length, end + (deficit - shiftLeft));
  }
  const prefix = start > 0 ? "... " : "";
  const suffix = end < normalizedText.length ? " ..." : "";
  const snippet = normalizedText.slice(start, end);
  const snippetRanges = ranges
    .filter((range) => range.end > start && range.start < end)
    .map((range) => ({
      start: prefix.length + Math.max(0, range.start - start),
      end: prefix.length + Math.min(end, range.end) - start,
    }));
  return {
    previewText: `${prefix}${snippet}${suffix}`,
    previewRanges: snippetRanges,
  };
}

export function createHistorySearchDocument(
  entry: ConversationHistoryEntry,
  messages: ReadonlyArray<HistorySearchMessage>,
): HistorySearchDocument {
  const titleText = normalizeHistorySearchText(entry.title);
  const candidates: HistorySearchTextCandidate[] = [];
  if (titleText) {
    candidates.push({
      kind: "title",
      text: titleText,
      normalizedText: titleText.toLocaleLowerCase(),
    });
  }
  const sectionText = normalizeHistorySearchText(entry.sectionTitle);
  if (sectionText && sectionText !== titleText) {
    candidates.push({
      kind: "title",
      text: sectionText,
      normalizedText: sectionText.toLocaleLowerCase(),
    });
  }
  for (const message of messages) {
    const text = normalizeHistorySearchText(message.text);
    if (!text) continue;
    candidates.push({
      kind: "message",
      text,
      normalizedText: text.toLocaleLowerCase(),
    });
  }
  return {
    conversationKey: entry.conversationKey,
    candidates,
  };
}

export function buildHistorySearchResults(
  entries: ConversationHistoryEntry[],
  normalizedQuery: string,
  documentCache: ReadonlyMap<number, HistorySearchDocument>,
): HistorySearchResult[] {
  const searchTokens = tokenizeHistorySearchQuery(normalizedQuery);
  if (!searchTokens.length) return [];
  const results: HistorySearchResult[] = [];
  for (const entry of entries) {
    const document = documentCache.get(entry.conversationKey);
    if (!document) continue;
    let matchCount = 0;
    let bestPreviewCandidate: HistorySearchTextCandidate | null = null;
    let bestPreviewScore = 0;
    let bestPreviewIndex = Number.POSITIVE_INFINITY;
    for (const candidate of document.candidates) {
      const score = scoreHistorySearchCandidate(candidate, searchTokens);
      if (score.matchCount <= 0) continue;
      matchCount += score.matchCount;
      if (
        candidate.kind === "message" &&
        (score.matchCount > bestPreviewScore ||
          (score.matchCount === bestPreviewScore &&
            score.firstIndex >= 0 &&
            score.firstIndex < bestPreviewIndex))
      ) {
        bestPreviewCandidate = candidate;
        bestPreviewScore = score.matchCount;
        bestPreviewIndex =
          score.firstIndex >= 0 ? score.firstIndex : bestPreviewIndex;
      }
    }
    if (matchCount <= 0) continue;
    const displayTitle = formatHistoryRowDisplayTitle(entry.title);
    const titleRanges = collectHistorySearchRanges(displayTitle, searchTokens);
    const preview = bestPreviewCandidate
      ? buildHistorySearchPreview(bestPreviewCandidate.text, searchTokens)
      : { previewText: "", previewRanges: [] };
    results.push({
      entry,
      matchCount,
      titleRanges,
      previewText: preview.previewText,
      previewRanges: preview.previewRanges,
    });
  }
  results.sort((a, b) => {
    if (b.matchCount !== a.matchCount) {
      return b.matchCount - a.matchCount;
    }
    if (b.entry.lastActivityAt !== a.entry.lastActivityAt) {
      return b.entry.lastActivityAt - a.entry.lastActivityAt;
    }
    return b.entry.conversationKey - a.entry.conversationKey;
  });
  return results;
}
