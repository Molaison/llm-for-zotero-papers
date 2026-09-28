import { RRF_K } from "../retrieval/constants";
import { tokenizeRetrievalQuery } from "../retrieval/retrievalTokenizer";
import { MAX_QUERY_TERMS } from "./constants";
import type { LibraryTextIndexStore, StoredChunkMeta } from "./store";

export type IndexCoverage = {
  scopeAttachments: number;
  indexed: number;
  unindexed: number[];
  failed: number[];
  stale: number[];
  vectorIndexed?: number;
};
export type IndexedChunkHit = {
  attachmentId: number;
  parentItemId: number | null;
  chunkIndex: number;
  text: string;
  title: string;
  meta: StoredChunkMeta;
  bm25Score: number;
  vectorScore?: number;
  hybridScore: number;
  rank: number;
  evidenceScore: number;
  matchedTerms: string[];
};
export type IndexedPaperHit = {
  attachmentId: number;
  parentItemId: number | null;
  score: number;
  matchingChunks: number;
  bestChunkIndex: number;
  rank: number;
};
export type LibraryTextIndexSearchParams = {
  store: LibraryTextIndexStore;
  scopeAttachmentIds: number[];
  queries: string[];
  maxPapers: number;
  perPaperTopK: number;
  maxChunks?: number;
};
export type LibraryTextIndexSearchResult = {
  chunks: IndexedChunkHit[];
  papers: IndexedPaperHit[];
  coverage: IndexCoverage;
  queryTerms: string[];
  timings: Record<string, number>;
};

// Same constants as scoreChunkBM25 in pdfContext.ts; the parity test pins them.
const BM25_K1 = 1.2;
const BM25_B = 0.75;
const PAPER_BREADTH_WEIGHT = 0.2;

/** One term's BM25 contribution; the same formula as `scoreChunkBM25`. */
export function scoreBm25(
  tf: number,
  tokenCount: number,
  df: number,
  chunkCount: number,
  avgTokens: number,
): number {
  if (!tf || !tokenCount) return 0;
  const idf = Math.log(1 + (chunkCount - df + 0.5) / (df + 0.5));
  const norm =
    (tf * (BM25_K1 + 1)) /
    (tf + BM25_K1 * (1 - BM25_B + (BM25_B * tokenCount) / avgTokens));
  return idf * norm;
}

/** Union of the query variants' terms in first-seen order, capped at MAX_QUERY_TERMS. */
export function collectQueryTerms(queries: string[]): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const query of queries) {
    for (const term of tokenizeRetrievalQuery(query || "")) {
      if (seen.has(term)) continue;
      seen.add(term);
      terms.push(term);
      if (terms.length >= MAX_QUERY_TERMS) return terms;
    }
  }
  return terms;
}

type ChunkAccumulator = {
  score: number;
  tokenCount: number;
  terms: Set<string>;
};
type PaperAccumulator = {
  best: number;
  bestChunk: number;
  count: number;
  chunks: Array<{ chunkIndex: number; score: number; terms: string[] }>;
};

export async function searchLibraryTextIndex(
  params: LibraryTextIndexSearchParams,
): Promise<LibraryTextIndexSearchResult> {
  const timings: Record<string, number> = {};
  const started = Date.now();
  const mark = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const t = Date.now();
    try {
      return await fn();
    } finally {
      timings[name] = (timings[name] || 0) + (Date.now() - t);
    }
  };
  const scope = new Set(params.scopeAttachmentIds);
  const coverageRaw = await mark("coverage", () =>
    params.store.getCoverage([...scope]),
  );
  const coverage: IndexCoverage = {
    scopeAttachments: scope.size,
    indexed: coverageRaw.indexed.size,
    unindexed: coverageRaw.missing,
    failed: coverageRaw.failed,
    stale: [],
  };
  const queryTerms = collectQueryTerms(params.queries);
  if (!queryTerms.length || !coverage.indexed) {
    timings.total = Date.now() - started;
    return { chunks: [], papers: [], coverage, queryTerms, timings };
  }
  const [postings, df, stats] = await mark("postings", () =>
    Promise.all([
      params.store.getPostings(queryTerms),
      params.store.getDocumentFrequencies(queryTerms),
      params.store.getCorpusStats(),
    ]),
  );
  const byChunk = new Map<string, ChunkAccumulator>();
  await mark("score", async () => {
    for (const posting of postings) {
      if (!scope.has(posting.attachmentId)) continue;
      const termDf = df.get(posting.term) || 0;
      for (const [chunkIndex, tf, tokenCount] of posting.hits) {
        const key = `${posting.attachmentId}:${chunkIndex}`;
        const acc = byChunk.get(key) || {
          score: 0,
          tokenCount,
          terms: new Set<string>(),
        };
        acc.score += scoreBm25(
          tf,
          tokenCount,
          termDf,
          stats.chunkCount,
          stats.avgTokens || 1,
        );
        acc.terms.add(posting.term);
        byChunk.set(key, acc);
      }
    }
  });
  const byPaper = new Map<number, PaperAccumulator>();
  for (const [key, acc] of byChunk) {
    if (acc.score <= 0) continue;
    const [attachmentId, chunkIndex] = key.split(":").map(Number);
    const paper = byPaper.get(attachmentId) || {
      best: 0,
      bestChunk: chunkIndex,
      count: 0,
      chunks: [],
    };
    paper.count += 1;
    if (
      acc.score > paper.best ||
      (acc.score === paper.best && chunkIndex < paper.bestChunk)
    ) {
      paper.best = acc.score;
      paper.bestChunk = chunkIndex;
    }
    paper.chunks.push({ chunkIndex, score: acc.score, terms: [...acc.terms] });
    byPaper.set(attachmentId, paper);
  }
  const papers: IndexedPaperHit[] = [...byPaper.entries()]
    .map(([attachmentId, p]) => ({
      attachmentId,
      parentItemId: null as number | null,
      score: p.best + PAPER_BREADTH_WEIGHT * Math.log1p(p.count),
      matchingChunks: p.count,
      bestChunkIndex: p.bestChunk,
      rank: 0,
    }))
    .sort((a, b) => b.score - a.score || a.attachmentId - b.attachmentId)
    .slice(0, Math.max(1, params.maxPapers));
  papers.forEach((p, i) => {
    p.rank = i + 1;
  });
  const selected: Array<{
    attachmentId: number;
    chunkIndex: number;
    score: number;
    terms: string[];
  }> = [];
  for (const paper of papers) {
    const rows = byPaper
      .get(paper.attachmentId)!
      .chunks.sort((a, b) => b.score - a.score || a.chunkIndex - b.chunkIndex)
      .slice(0, Math.max(1, params.perPaperTopK));
    for (const row of rows)
      selected.push({ attachmentId: paper.attachmentId, ...row });
  }
  selected.sort(
    (a, b) =>
      b.score - a.score ||
      a.attachmentId - b.attachmentId ||
      a.chunkIndex - b.chunkIndex,
  );
  const limited = params.maxChunks
    ? selected.slice(0, params.maxChunks)
    : selected;
  // Always fetch each shortlisted paper's best chunk too, so its parent item
  // resolves even when maxChunks cut that paper's chunks from the answer.
  const refs = new Map<string, { attachmentId: number; chunkIndex: number }>();
  for (const s of limited)
    refs.set(`${s.attachmentId}:${s.chunkIndex}`, {
      attachmentId: s.attachmentId,
      chunkIndex: s.chunkIndex,
    });
  for (const p of papers)
    refs.set(`${p.attachmentId}:${p.bestChunkIndex}`, {
      attachmentId: p.attachmentId,
      chunkIndex: p.bestChunkIndex,
    });
  const stored = await mark("chunks", () =>
    params.store.getChunks([...refs.values()]),
  );
  const storedByKey = new Map(
    stored.map((c) => [`${c.attachmentId}:${c.chunkIndex}`, c]),
  );
  const chunks: IndexedChunkHit[] = [];
  for (const s of limited) {
    const c = storedByKey.get(`${s.attachmentId}:${s.chunkIndex}`);
    if (!c) continue;
    const rank = chunks.length + 1;
    chunks.push({
      attachmentId: c.attachmentId,
      parentItemId: c.parentItemId,
      chunkIndex: c.chunkIndex,
      text: c.text,
      title: c.title,
      meta: c.meta,
      bm25Score: s.score,
      hybridScore: s.score,
      rank,
      evidenceScore: 1 / (RRF_K + rank),
      matchedTerms: s.terms,
    });
  }
  for (const paper of papers)
    paper.parentItemId =
      storedByKey.get(`${paper.attachmentId}:${paper.bestChunkIndex}`)
        ?.parentItemId ?? null;
  timings.total = Date.now() - started;
  // LRU bookkeeping for the byte budget (Task 7 eviction): fire-and-forget,
  // never on the answer path.
  if (papers.length)
    void params.store
      .touchDocuments(papers.map((p) => p.attachmentId))
      .catch(() => undefined);
  return { chunks, papers, coverage, queryTerms, timings };
}
