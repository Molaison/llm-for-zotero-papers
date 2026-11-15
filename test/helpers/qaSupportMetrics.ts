/** Test-side support and grounding metrics. Deliberately independent of the
 * product's claim-anchoring code so before/after runs are scored identically. */
export type EvalSentence = { text: string; start: number; end: number };

const ABBREVIATIONS =
  /(?:\b(?:fig|figs|eq|eqs|et al|e\.g|i\.e|vs|cf|ref|refs|approx|dr|prof)|\b[A-Z])\.$/i;
const TOKEN_RE = /\[\[quote:([A-Za-z0-9._:-]+)\]\]/g;
/** A run of quote tokens opening a span: they cite what came before them. */
const LEADING_TOKENS = /^\s*(?:\[\[quote:[A-Za-z0-9._:-]+\]\]\s*)+/;
/** Closing marks a sentence may end on, after its terminator. */
const CLOSERS = /^["'”’)\]」』》]+/;
const STOPWORDS = new Set(
  "a an the and or of to in on at by for with from as is are was were be been it its this that these those we they he she their our not no than then which who whom whose what when where how also into over under between during after before about".split(
    " ",
  ),
);

export function splitSentencesForEval(text: string): EvalSentence[] {
  const out: EvalSentence[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const terminal =
      ch === "." ||
      ch === "!" ||
      ch === "?" ||
      ch === "。" ||
      ch === "！" ||
      ch === "？";
    if (!terminal) continue;
    const next = text[i + 1];
    const decimal =
      ch === "." && /\d/.test(text[i - 1] || "") && /\d/.test(next || "");
    if (decimal) continue;
    // A quotation mark or bracket closing after the terminator belongs to the
    // sentence it ends: `… by day 10." Next sentence.`
    const closing = CLOSERS.exec(text.slice(i + 1))?.[0] || "";
    const end = i + 1 + closing.length;
    const after = text[end];
    // A quote token written straight onto the sentence ends it too.
    const boundary =
      after === undefined ||
      /\s/.test(after) ||
      text.startsWith("[[quote:", end) ||
      /[。！？]/.test(ch);
    if (!boundary) continue;
    const candidate = text.slice(start, end).trim();
    const terminated = closing
      ? candidate.slice(0, -closing.length)
      : candidate;
    if (ch === "." && ABBREVIATIONS.test(terminated)) continue;
    if (candidate) out.push({ text: candidate, start, end });
    start = end;
  }
  const tail = text.slice(start).trim();
  if (tail) out.push({ text: tail, start, end: text.length });
  return out;
}

export function tokensForEval(text: string): Set<string> {
  const cleaned = text.replace(TOKEN_RE, " ").toLowerCase();
  const out = new Set<string>();
  for (const match of cleaned.matchAll(
    /[\p{L}\p{N}]+(?:[.'’-][\p{L}\p{N}]+)*/gu,
  )) {
    const token = match[0];
    if (/^[㐀-鿿]+$/u.test(token)) {
      for (let i = 0; i + 1 < token.length; i++) out.add(token.slice(i, i + 2));
      if (token.length === 1) out.add(token);
      continue;
    }
    if (token.length < 2 || STOPWORDS.has(token)) continue;
    out.add(token);
  }
  return out;
}

/** One non-blank line of the answer: prose, a whole blockquote block, or a line
 * no claim can live in (code, heading, table, HTML). Blank lines are dropped,
 * so "the next non-blank line" is simply the next block. */
type DocumentBlock =
  | { kind: "prose"; text: string }
  | { kind: "quote"; text: string; ids: string[] }
  | { kind: "other" };

function tokenIds(text: string): string[] {
  return [...text.matchAll(TOKEN_RE)].map((m) => m[1]);
}

function documentBlocks(markdown: string): DocumentBlock[] {
  const blocks: DocumentBlock[] = [];
  let inFence = false;
  let quoted: string[] | null = null;
  const flushQuote = () => {
    if (!quoted) return;
    const joined = quoted.join(" ");
    quoted = null;
    blocks.push({
      kind: "quote",
      text: cleanClaim(joined),
      ids: tokenIds(joined),
    });
  };
  for (const line of markdown.split("\n")) {
    if (/^\s*```/.test(line)) {
      flushQuote();
      inFence = !inFence;
      blocks.push({ kind: "other" });
      continue;
    }
    if (inFence) {
      blocks.push({ kind: "other" });
      continue;
    }
    if (!line.trim()) {
      flushQuote();
      continue;
    }
    if (/^\s*>/.test(line)) {
      (quoted ||= []).push(line.replace(/^\s*(?:>\s?)+/, ""));
      continue;
    }
    flushQuote();
    const stripped = line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "");
    if (/^\s*(#{1,6}\s|\||<)/.test(line) || !stripped.trim()) {
      blocks.push({ kind: "other" });
      continue;
    }
    blocks.push({ kind: "prose", text: stripped });
  }
  flushQuote();
  return blocks;
}

/** The sentence text a reader sees, without the quote tokens. */
const cleanClaim = (text: string) =>
  text
    .replace(TOKEN_RE, "")
    .replace(/\s+([.!?。！？])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

/** Sentences of one prose line, with each quote token bound to the sentence it
 * supports. A token written after the terminal punctuation, or alone in its own
 * span, belongs to the sentence before it, not to the one that follows. */
function boundSentences(text: string): EvalSentence[] {
  const out: EvalSentence[] = [];
  for (const span of splitSentencesForEval(text)) {
    const previous = out[out.length - 1];
    const lead = LEADING_TOKENS.exec(text.slice(span.start, span.end));
    if (!lead || !previous) {
      out.push({ ...span });
      continue;
    }
    const cut = span.start + lead[0].length;
    previous.end = cut;
    previous.text = text.slice(previous.start, cut).trim();
    const rest = text.slice(cut, span.end).trim();
    if (rest) out.push({ text: rest, start: cut, end: span.end });
  }
  return out;
}

type Claim = { text: string; ids: string[] };

/** Fewer than this many non-numeric content tokens is a citation label rather
 * than a claim: "(Orion, 2025)" is 1, "Source: (Orion, 2025)" is 2. A bare
 * number carries no claim of its own, so years and figures do not count. */
const MIN_CLAIM_TOKENS = 3;

function claimWeight(text: string): number {
  let weight = 0;
  for (const token of tokensForEval(text))
    if (!/^\p{N}+$/u.test(token)) weight++;
  return weight;
}

/** Sentences of one prose line as claims, tokens attached. */
function lineClaims(text: string): Claim[] {
  return boundSentences(text).map((sentence) => ({
    text: cleanClaim(sentence.text),
    ids: tokenIds(sentence.text),
  }));
}

/** Every prose sentence of the answer with the quote tokens it carries,
 * including tokens written after it or alone on the next prose line.
 * Blockquotes are not sentences of the answer, so they are not claims here;
 * this is what the grounding ratio counts. */
function answerClaims(markdown: string): Claim[] {
  const claims: Claim[] = [];
  for (const block of documentBlocks(markdown)) {
    if (block.kind !== "prose") continue;
    if (!cleanClaim(block.text)) {
      // A token-only line cites the sentence before it rather than standing
      // as a claim of its own.
      const previous = claims[claims.length - 1];
      if (previous) previous.ids.push(...tokenIds(block.text));
      else claims.push({ text: "", ids: tokenIds(block.text) });
      continue;
    }
    claims.push(...lineClaims(block.text));
  }
  return claims;
}

/** What each quote token claims, for support scoring only.
 *
 * A quoted block is the claim its own tokens support, and it also collects the
 * tokens of the lead-in sentence that introduces it ("… states: [[quote:q1]]")
 * and of a bare token line written after it. Everything else keeps the prose
 * sentence rule. Tokens appear in the order they are written. */
function supportClaims(markdown: string): Claim[] {
  const blocks = documentBlocks(markdown);
  const claims: Claim[] = [];
  /** The claim a bare token line or a trailing token binds to. */
  let previous: Claim | undefined;
  /** Lead-in tokens waiting for the quoted block they introduce. */
  let pending: string[] = [];
  blocks.forEach((block, index) => {
    if (block.kind === "other") return;
    if (block.kind === "quote") {
      previous = { text: block.text, ids: [...pending, ...block.ids] };
      pending = [];
      claims.push(previous);
      return;
    }
    if (!cleanClaim(block.text)) {
      const ids = tokenIds(block.text);
      if (previous) previous.ids.push(...ids);
      else claims.push({ text: "", ids });
      return;
    }
    const sentences = lineClaims(block.text);
    const introduces = blocks[index + 1]?.kind === "quote";
    // The block this line sits under, if any: `previous` is still that block's
    // claim until the first sentence of this line replaces it.
    const quotedAbove =
      blocks[index - 1]?.kind === "quote" ? previous : undefined;
    sentences.forEach((claim, position) => {
      if (
        introduces &&
        position === sentences.length - 1 &&
        /[:：]$/.test(claim.text)
      ) {
        pending.push(...claim.ids);
        claim.ids = [];
      } else if (quotedAbove && claimWeight(claim.text) < MIN_CLAIM_TOKENS) {
        // Too thin to be a claim of its own: it attributes the block above it.
        quotedAbove.ids.push(...claim.ids);
        claim.ids = [];
      }
      claims.push(claim);
      previous = claim;
    });
  });
  return claims;
}

export function measureSupport(
  answer: string,
  citations: Array<{ id: string; quoteText?: string; anchorMatch?: string }>,
) {
  const byId = new Map(citations.map((c) => [c.id, c]));
  const tokens: Array<{
    id: string;
    claimSentence: string;
    quoteText: string;
    overlap: number;
    anchorMatch?: string;
  }> = [];
  for (const claim of supportClaims(answer)) {
    const claimTokens = tokensForEval(claim.text);
    for (const id of claim.ids) {
      const citation = byId.get(id);
      if (!citation) continue;
      const quoteTokens = tokensForEval(citation.quoteText || "");
      let shared = 0;
      for (const token of claimTokens) if (quoteTokens.has(token)) shared++;
      tokens.push({
        id,
        claimSentence: claim.text,
        quoteText: citation.quoteText || "",
        overlap: claimTokens.size ? shared / claimTokens.size : 0,
        anchorMatch: citation.anchorMatch,
      });
    }
  }
  const overlaps = tokens.map((t) => t.overlap).sort((a, b) => a - b);
  const median = overlaps.length
    ? overlaps[Math.floor((overlaps.length - 1) / 2)]
    : null;
  return {
    tokens,
    medianOverlap: median,
    lowOverlapTokens: tokens.filter((t) => t.overlap < 0.2).length,
    anchorMatchClaim: tokens.filter((t) => t.anchorMatch === "claim").length,
    anchorMatchPassage: tokens.filter((t) => t.anchorMatch === "passage")
      .length,
  };
}

export function measureGrounding(answer: string, citationIds: Set<string>) {
  let sentences = 0;
  let cited = 0;
  for (const claim of answerClaims(answer)) {
    if (tokensForEval(claim.text).size < 6) continue;
    sentences++;
    if (claim.ids.some((id) => citationIds.has(id))) cited++;
  }
  if (!sentences || !citationIds.size) return null;
  return { sentences, cited };
}

export type EvalCitation = {
  id: string;
  quoteText: string;
  anchorMatch?: string;
};

/** Quote citations a tool result carries, wherever its payload nests them.
 * Depth-limited and cycle-safe: the content is provider-shaped, not trusted. */
export function collectEvalCitations(content: unknown): EvalCitation[] {
  const out: EvalCitation[] = [];
  const seen = new Set<unknown>();
  const visit = (node: any, depth: number) => {
    if (!node || typeof node !== "object" || depth > 8 || seen.has(node))
      return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry, depth + 1);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "quoteCitations" && Array.isArray(value)) {
        for (const citation of value)
          if (
            citation &&
            typeof citation === "object" &&
            typeof citation.id === "string" &&
            typeof citation.quoteText === "string"
          )
            out.push(citation as EvalCitation);
        continue;
      }
      visit(value, depth + 1);
    }
  };
  visit(content, 0);
  return out;
}

/** The citations an answer is scored against: the ones the finished answer
 * carries when it carries any, otherwise the ones its tools delivered. Shared
 * by the live harness and the recompute script so they cannot disagree. */
export function citationsFromEvents(events: any[]): {
  citations: EvalCitation[];
  finalCount: number;
} {
  const final = events.find((e) => e?.type === "final");
  const fromFinal: EvalCitation[] = Array.isArray(final?.quoteCitations)
    ? final.quoteCitations
    : [];
  const fromTools = events
    .filter((e) => e?.type === "tool_result" && e.ok)
    .flatMap((e) => collectEvalCitations(e.content));
  return {
    citations: fromFinal.length ? fromFinal : fromTools,
    finalCount: fromFinal.length,
  };
}
