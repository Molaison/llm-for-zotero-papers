/**
 * Compare the library text index against today's per-paper ranking on a real
 * Zotero data directory's MinerU caches, outside Zotero.
 *
 *   npx tsx scripts/library-index-benchmark.ts --data-dir <zotero data dir> --ids 4458,1187,... \
 *       --queries queries.txt        # one query per line
 *       [--expected expected.txt]    # optional: per query line, the attachment
 *                                    # ids a reader would accept as top paper
 *
 * Prints, per query: wall ms for each path, overlap@8 of (paper, chunk) pairs,
 * the top paper of each path, and whether they agree; with `--expected`, also
 * how often each path's top paper is one the reader expected. Read-only on the data
 * directory (same overlay as retrieval-benchmark.ts); the index lives in an
 * in-memory SQLite database.
 *
 * Today's path has no cross-paper full-text score: each paper ranks its own
 * chunks with BM25 over that paper's chunks (`buildPaperRetrievalCandidates`),
 * and `evidenceScore` is a per-paper rank reciprocal, equal across papers. The
 * baseline therefore orders every paper's candidates by their raw per-paper
 * `bm25Score`; its top paper is the paper holding the highest-scoring chunk.
 * The index scores the same chunks with library-wide document frequencies.
 */
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { ensurePDFTextCached } from "../src/services/paperContent/pdfContext";
import { pdfTextCache } from "../src/services/paperContent/contextCache";
import {
  mockPdfAttachment,
  rankChunksForQuery,
} from "../test/helpers/retrievalCorpus";
import {
  setLibraryTextIndexDbForTests,
  openLibraryTextIndexDb,
  type LibraryTextIndexDb,
} from "../src/services/libraryTextIndex/db";
import { LibraryTextIndexStore } from "../src/services/libraryTextIndex/store";
import { buildIndexDocumentFromPdfContext } from "../src/services/libraryTextIndex/indexer";
import { searchLibraryTextIndex } from "../src/services/libraryTextIndex/search";
import type { PaperContextRef } from "../src/modules/contextPanel/types";
import type { PdfContext } from "../src/services/paperContent/types";
import { installBenchmarkGlobals } from "./retrieval-benchmark";

const TOP_K = 8;

function parseArgs(argv: string[]) {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dataDir = get("--data-dir");
  const ids = (get("--ids") || "")
    .split(",")
    .map((entry) => Number(entry.trim()))
    .filter((entry) => Number.isFinite(entry) && entry > 0);
  const queriesPath = get("--queries");
  const expectedPath = get("--expected");
  if (!dataDir || !ids.length || !queriesPath) {
    console.error(
      "usage: npx tsx scripts/library-index-benchmark.ts --data-dir <dir> --ids a,b,c --queries file.txt",
    );
    process.exit(2);
  }
  const readLines = (file: string) =>
    fs
      .readFileSync(file, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  const queries = readLines(queriesPath);
  const expected = expectedPath
    ? readLines(expectedPath).map(
        (line) =>
          new Set(
            line
              .split(",")
              .map((entry) => Number(entry.trim()))
              .filter((entry) => Number.isFinite(entry) && entry > 0),
          ),
      )
    : null;
  if (expected && expected.length !== queries.length) {
    console.error("--expected needs one line per query");
    process.exit(2);
  }
  return { dataDir, ids, queries, expected };
}

function sqliteAdapter(): LibraryTextIndexDb {
  const db = new DatabaseSync(":memory:");
  const bind = (params?: unknown[]) =>
    (params || []).map((value) =>
      value === undefined ? null : value,
    ) as never[];
  return {
    async queryAsync(sql, params) {
      const stmt = db.prepare(sql);
      const head = sql.trimStart().slice(0, 6).toUpperCase();
      if (
        head.startsWith("SELECT") ||
        head.startsWith("PRAGMA") ||
        head.startsWith("WITH")
      ) {
        return stmt.all(...bind(params));
      }
      stmt.run(...bind(params));
      return [];
    },
    async executeTransaction(fn) {
      db.exec("BEGIN");
      try {
        const result = await fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

type Pair = { attachmentId: number; chunkIndex: number; score: number };

async function main(): Promise<void> {
  const { dataDir, ids, queries, expected } = parseArgs(process.argv.slice(2));
  const { overlayDir } = installBenchmarkGlobals(dataDir);
  console.log(`data dir: ${dataDir} (read-only; writes go to ${overlayDir})`);
  setLibraryTextIndexDbForTests(sqliteAdapter());
  const db = await openLibraryTextIndexDb();
  if (!db) throw new Error("index database did not open");
  const store = new LibraryTextIndexStore(db);

  const papers = new Map<
    number,
    { ref: PaperContextRef; ctx: PdfContext; title: string }
  >();
  const buildStart = performance.now();
  for (const id of ids) {
    pdfTextCache.clear();
    await ensurePDFTextCached(mockPdfAttachment(id));
    const ctx = pdfTextCache.get(id);
    if (!ctx || !ctx.chunks.length) {
      console.log(`id ${id}: no context, skipped`);
      continue;
    }
    const title = ctx.title || `Paper ${id}`;
    papers.set(id, {
      ref: {
        itemId: 100,
        contextItemId: id,
        title,
        firstCreator: "Benchmark",
        year: "2026",
      },
      ctx,
      title,
    });
    await store.upsertDocument(
      buildIndexDocumentFromPdfContext({
        attachmentId: id,
        attachmentKey: `K${id}`,
        libraryID: 1,
        parentItemId: id,
        fileState: null,
        ctx,
      }),
    );
  }
  const chunkTotal = [...papers.values()].reduce(
    (sum, p) => sum + p.ctx.chunks.length,
    0,
  );
  console.log(
    `indexed ${papers.size} papers (${chunkTotal} chunks) in ${Math.round(performance.now() - buildStart)} ms`,
  );

  let agreeTop = 0;
  let overlapSum = 0;
  let expectedHitsToday = 0;
  let expectedHitsIndex = 0;
  const rows: string[] = [];
  for (const [queryIndex, query] of queries.entries()) {
    const t0 = performance.now();
    const baseline: Pair[] = [];
    for (const [id, { ref, ctx }] of papers) {
      const ranked = await rankChunksForQuery({
        paperRef: ref,
        ctx,
        query,
        topK: TOP_K,
      });
      for (const row of ranked) {
        if (row.bm25Score > 0) {
          baseline.push({
            attachmentId: id,
            chunkIndex: row.chunkIndex,
            score: row.bm25Score,
          });
        }
      }
    }
    baseline.sort(
      (a, b) =>
        b.score - a.score ||
        a.attachmentId - b.attachmentId ||
        a.chunkIndex - b.chunkIndex,
    );
    const t1 = performance.now();
    const index = await searchLibraryTextIndex({
      store,
      scopeAttachmentIds: [...papers.keys()],
      queries: [query],
      maxPapers: TOP_K,
      perPaperTopK: TOP_K,
    });
    const t2 = performance.now();
    const key = (p: { attachmentId: number; chunkIndex: number }) =>
      `${p.attachmentId}:${p.chunkIndex}`;
    const baseTop = baseline.slice(0, TOP_K);
    const indexTop = index.chunks.slice(0, TOP_K);
    const baseKeys = new Set(baseTop.map(key));
    const overlap = indexTop.filter((c) => baseKeys.has(key(c))).length / TOP_K;
    const topBase = baseTop[0]?.attachmentId;
    const topIndex = index.papers[0]?.attachmentId;
    const agree = topBase !== undefined && topBase === topIndex;
    if (agree) agreeTop += 1;
    overlapSum += overlap;
    const wanted = expected?.[queryIndex];
    const todayExpected = Boolean(
      wanted && topBase !== undefined && wanted.has(topBase),
    );
    const indexExpected = Boolean(
      wanted && topIndex !== undefined && wanted.has(topIndex),
    );
    if (todayExpected) expectedHitsToday += 1;
    if (indexExpected) expectedHitsIndex += 1;
    const mark = (hit: boolean) => (wanted ? (hit ? " (expected)" : "") : "");
    const distinctPapers = (list: Array<{ attachmentId: number }>) => [
      ...new Set(list.map((p) => p.attachmentId)),
    ];
    const titleOf = (id?: number) =>
      id === undefined ? "-" : (papers.get(id)?.title || "").slice(0, 60);
    console.log(
      `\n"${query}"\n  today: ${Math.round(t1 - t0)} ms, top paper ${topBase}${mark(todayExpected)} ${titleOf(topBase)}\n    top-8 papers ${distinctPapers(baseTop).join(",")}\n  index: ${Math.round(t2 - t1)} ms, top paper ${topIndex}${mark(indexExpected)} ${titleOf(topIndex)}\n    top-8 papers ${distinctPapers(indexTop).join(",")}; paper ranking ${index.papers.map((p) => p.attachmentId).join(",")}\n  overlap@8 ${overlap.toFixed(2)}  top-paper ${agree ? "agree" : "DIFFER"}`,
    );
    rows.push(
      `| ${query} | ${Math.round(t1 - t0)} | ${Math.round(t2 - t1)} | ${topBase ?? "-"}${mark(todayExpected)} | ${topIndex ?? "-"}${mark(indexExpected)} | ${wanted ? [...wanted].join(",") : "-"} | ${agree ? "agree" : "DIFFER"} | ${overlap.toFixed(2)} |`,
    );
  }
  console.log(
    `\nsummary: top-paper agreement ${agreeTop}/${queries.length}, mean overlap@8 ${(overlapSum / queries.length).toFixed(2)}`,
  );
  if (expected) {
    console.log(
      `expected top paper: today ${expectedHitsToday}/${queries.length}, index ${expectedHitsIndex}/${queries.length}`,
    );
  }
  console.log(
    "\n| query | today ms | index ms | today top | index top | expected | top paper | overlap@8 |\n|---|---|---|---|---|---|---|---|",
  );
  for (const row of rows) console.log(row);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
