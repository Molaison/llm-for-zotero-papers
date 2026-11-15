import { assert } from "chai";
import { installLibraryTextIndexSqlite } from "./helpers/libraryTextIndexDb";
import {
  getLibraryTextIndexStore,
  LibraryTextIndexStore,
  type IndexDocumentInput,
} from "../src/services/libraryTextIndex/store";
import {
  openLibraryTextIndexDb,
  type LibraryTextIndexDb,
} from "../src/services/libraryTextIndex/db";
import {
  LIBRARY_TEXT_INDEX_CHUNKER_VERSION,
  LIBRARY_TEXT_INDEX_TOKENIZER_VERSION,
  TOKENIZER_VERSION_META_KEY,
} from "../src/services/libraryTextIndex/constants";
import { estimateDocumentBytes } from "../src/services/libraryTextIndex/indexer";
import { searchLibraryTextIndex } from "../src/services/libraryTextIndex/search";
import { runTokenizerUpgradeSlice } from "../src/services/libraryTextIndex/tokenizerUpgrade";
import { buildChunkIndex } from "../src/services/paperContent/pdfContext";
import { tokenizeRetrievalText } from "../src/services/retrieval/retrievalTokenizer";

function doc(
  attachmentId: number,
  texts: string[],
  overrides: Partial<IndexDocumentInput> = {},
): IndexDocumentInput {
  return {
    attachmentId,
    attachmentKey: `KEY${attachmentId}`,
    libraryID: 1,
    parentItemId: attachmentId * 10,
    title: `Paper ${attachmentId}`,
    sourceType: "mineru",
    sourceFingerprint: `fp-${attachmentId}`,
    sourceMtime: 1000,
    sourceSize: 2048,
    chunkerVersion: 1,
    byteEstimate: texts.join("").length,
    chunks: texts.map((text, chunkIndex) => {
      const tokens = text.toLowerCase().split(/\s+/);
      const tf: Record<string, number> = {};
      for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
      return {
        chunkIndex,
        text,
        tokenCount: tokens.length,
        meta: { chunkKind: "body" as const, sectionLabel: "Results" },
        tf,
      };
    }),
    ...overrides,
  };
}

describe("library text index store", function () {
  let harness: ReturnType<typeof installLibraryTextIndexSqlite>;
  let store: LibraryTextIndexStore;
  beforeEach(async function () {
    harness = installLibraryTextIndexSqlite();
    store = new LibraryTextIndexStore((await openLibraryTextIndexDb())!);
  });
  afterEach(function () {
    harness.close();
  });

  it("upserts a document with chunks and (term, attachment) postings", async function () {
    await store.upsertDocument(doc(1, ["alpha beta beta", "gamma alpha"]));
    const row = await store.getDocument(1);
    assert.equal(row?.chunkCount, 2);
    assert.equal(row?.totalTokens, 5);
    const postings = await store.getPostings(["alpha", "beta", "zzz"]);
    const alpha = postings.find((p) => p.term === "alpha")!;
    assert.deepEqual(alpha.hits, [
      [0, 1, 3],
      [1, 1, 2],
    ]);
    assert.deepEqual(postings.find((p) => p.term === "beta")!.hits, [
      [0, 2, 3],
    ]);
    assert.isUndefined(postings.find((p) => p.term === "zzz"));
    const chunks = await store.getChunks([{ attachmentId: 1, chunkIndex: 1 }]);
    assert.equal(chunks[0].text, "gamma alpha");
    assert.equal(chunks[0].meta.sectionLabel, "Results");
    assert.equal(chunks[0].title, "Paper 1");
  });

  it("replaces an existing document atomically and leaves no stale postings", async function () {
    await store.upsertDocument(doc(1, ["alpha beta"]));
    await store.upsertDocument(doc(1, ["gamma"]));
    assert.lengthOf(await store.getPostings(["alpha", "beta"]), 0);
    assert.lengthOf(await store.getPostings(["gamma"]), 1);
    assert.lengthOf(
      harness.rows("SELECT * FROM chunks WHERE attachment_id = 1"),
      1,
    );
  });

  it("deletes documents with their chunks, postings, queue and vector rows", async function () {
    await store.upsertDocument(doc(1, ["alpha"]));
    await store.upsertDocument(doc(2, ["alpha"]));
    await store.enqueue([
      { attachmentId: 1, libraryID: 1, priority: 1, reason: "test" },
    ]);
    harness.exec("INSERT INTO vector_documents VALUES (1,'ns',4,1,'p','fp',0)");
    await store.deleteDocuments([1]);
    assert.isNull(await store.getDocument(1));
    assert.lengthOf(await store.getPostings(["alpha"]), 1);
    assert.lengthOf(harness.rows("SELECT * FROM queue"), 0);
    assert.lengthOf(harness.rows("SELECT * FROM vector_documents"), 0);
  });

  it("computes document frequencies as chunk counts across papers", async function () {
    await store.upsertDocument(doc(1, ["alpha beta", "alpha"]));
    await store.upsertDocument(doc(2, ["alpha"]));
    const df = await store.getDocumentFrequencies(["alpha", "beta", "none"]);
    assert.equal(df.get("alpha"), 3);
    assert.equal(df.get("beta"), 1);
    assert.isUndefined(df.get("none"));
    assert.deepEqual(await store.getCorpusStats(), {
      chunkCount: 3,
      avgTokens: 4 / 3,
      documentCount: 2,
    });
  });

  it("reports coverage for a scope", async function () {
    await store.upsertDocument(doc(1, ["alpha"]));
    const coverage = await store.getCoverage([1, 2, 3]);
    assert.deepEqual([...coverage.indexed], [1]);
    assert.deepEqual(coverage.missing, [2, 3]);
  });

  it("dequeues by priority then age, counts failures at the attempt cap", async function () {
    await store.enqueue([
      { attachmentId: 1, libraryID: 1, priority: 0, reason: "reconcile" },
      { attachmentId: 2, libraryID: 1, priority: 5, reason: "added" },
    ]);
    assert.equal((await store.dequeueNext())?.attachmentId, 2);
    await store.markQueueAttempt(2, "boom");
    await store.markQueueAttempt(2, "boom");
    await store.markQueueAttempt(2, "boom");
    assert.equal((await store.dequeueNext())?.attachmentId, 1);
    assert.deepEqual(await store.countQueue(1), { queued: 1, failed: 1 });
    await store.removeFromQueue([1]);
    assert.deepEqual(await store.countQueue(1), { queued: 0, failed: 1 });
  });

  it("backs off failed jobs and honours the lane's minimum priority", async function () {
    await store.enqueue([
      { attachmentId: 1, libraryID: 1, priority: 0, reason: "prefetch" },
      { attachmentId: 2, libraryID: 1, priority: 9, reason: "added" },
    ]);
    assert.isNull(
      await store.dequeueNext({ now: 0, minPriority: 10 }),
      "nothing at write-through priority",
    );
    assert.equal(
      (await store.dequeueNext({ now: 0, minPriority: 5 }))?.attachmentId,
      2,
      "urgent lane sees the added paper",
    );
    await store.markQueueAttempt(2, "boom", 1000);
    assert.equal(
      (await store.dequeueNext({ now: 1000, minPriority: 5 }))?.attachmentId ??
        null,
      null,
      "backing off",
    );
    assert.equal(
      (await store.dequeueNext({ now: 1000 }))?.attachmentId,
      1,
      "prefetch lane still drains",
    );
    assert.equal(
      (await store.dequeueNext({ now: 1000 + 60_000 }))?.attachmentId,
      2,
      "first retry after one minute",
    );
    await store.resetAttempts([2]);
    const row = await store.dequeueNext({ now: 1000 });
    assert.equal(row?.attachmentId, 2);
    assert.equal(row?.attempts, 0);
  });

  it("reports parked failures inside coverage", async function () {
    await store.upsertDocument(doc(1, ["alpha"]));
    await store.enqueue([
      { attachmentId: 3, libraryID: 1, priority: 0, reason: "prefetch" },
    ]);
    for (let i = 0; i < 3; i += 1)
      await store.markQueueAttempt(3, "no text", 0);
    const coverage = await store.getCoverage([1, 2, 3]);
    assert.deepEqual(coverage.missing, [2, 3]);
    assert.deepEqual(coverage.failed, [3]);
  });

  it("tracks last use and byte estimates for eviction", async function () {
    await store.upsertDocument(doc(1, ["alpha beta"]));
    await store.upsertDocument(doc(2, ["gamma delta epsilon"]));
    assert.equal(
      await store.sumByteEstimates(),
      "alpha beta".length + "gamma delta epsilon".length,
    );
    assert.isAbove(
      (await store.getDocument(1))!.lastUsedAt,
      0,
      "a fresh upsert starts protected",
    );
    await store.touchDocuments([1], 1000);
    await store.touchDocuments([2], 5000);
    const lru = await store.listLeastRecentlyUsed(10, 4000);
    assert.deepEqual(
      lru.map((r) => r.attachmentId),
      [1],
      "documents used after notUsedSince are protected",
    );
    assert.equal((await store.getDocument(2))?.lastUsedAt, 5000);
  });

  it("re-enqueueing an existing row raises its priority and resets attempts", async function () {
    await store.enqueue([
      { attachmentId: 1, libraryID: 1, priority: 0, reason: "reconcile" },
    ]);
    await store.markQueueAttempt(1, "x");
    await store.enqueue([
      { attachmentId: 1, libraryID: 1, priority: 9, reason: "modified" },
    ]);
    const row = await store.dequeueNext();
    assert.equal(row?.priority, 9);
    assert.equal(row?.attempts, 0);
    assert.equal(row?.reason, "modified");
  });
  it("lists the attachment ids that already have a queue row, parked or pending, per library", async function () {
    await store.enqueue([
      { attachmentId: 1, libraryID: 1, priority: 0, reason: "prefetch" },
      { attachmentId: 2, libraryID: 1, priority: 9, reason: "added" },
      { attachmentId: 3, libraryID: 2, priority: 0, reason: "prefetch" },
    ]);
    for (let i = 0; i < 3; i += 1) await store.markQueueAttempt(1, "boom");
    assert.deepEqual(
      [...(await store.listQueuedAttachmentIds(1))].sort(),
      [1, 2],
      "a parked row is still a queue row",
    );
    assert.deepEqual([...(await store.listQueuedAttachmentIds(2))], [3]);
    assert.equal((await store.listQueuedAttachmentIds(9)).size, 0);
  });
  it("the shared store follows the current connection instead of outliving it", async function () {
    const first = await getLibraryTextIndexStore();
    assert.strictEqual(await getLibraryTextIndexStore(), first, "cached");
    const second = installLibraryTextIndexSqlite();
    try {
      const rebound = await getLibraryTextIndexStore();
      assert.notStrictEqual(
        rebound,
        first,
        "a new connection gets a new store",
      );
      await rebound!.enqueue([
        { attachmentId: 5, libraryID: 1, priority: 0, reason: "prefetch" },
      ]);
      assert.lengthOf(second.rows("SELECT * FROM queue"), 1);
    } finally {
      second.close();
    }
  });
  it("updates only a document's file state", async function () {
    await store.upsertDocument(doc(1, ["alpha beta"]));
    const before = (await store.getDocument(1))!;
    await store.updateFileState(1, { mtime: 7777, size: null });
    const after = (await store.getDocument(1))!;
    assert.equal(after.sourceMtime, 7777);
    assert.isNull(after.sourceSize);
    assert.deepEqual(
      {
        ...after,
        sourceMtime: before.sourceMtime,
        sourceSize: before.sourceSize,
      },
      before,
      "nothing else changes",
    );
  });
  it("never offers a zero-byte (no-text) document for eviction", async function () {
    await store.upsertDocument(
      doc(1, [], { sourceType: "none", byteEstimate: 0 }),
    );
    await store.upsertDocument(doc(2, ["alpha"]));
    await store.touchDocuments([1, 2], 1000);
    const lru = await store.listLeastRecentlyUsed(10, 5000);
    assert.deepEqual(
      lru.map((r) => r.attachmentId),
      [2],
    );
  });
});

/**
 * The schema a build before stemming created (db.ts at 7212d8f8): no
 * document_tokenizer table. Its postings hold surface tokens.
 */
const PRE_STEMMING_SCHEMA = [
  `CREATE TABLE index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE documents (
     attachment_id INTEGER PRIMARY KEY,
     attachment_key TEXT NOT NULL,
     library_id INTEGER NOT NULL,
     parent_item_id INTEGER,
     title TEXT NOT NULL,
     source_type TEXT NOT NULL,
     source_fingerprint TEXT NOT NULL,
     source_mtime INTEGER,
     source_size INTEGER,
     chunker_version INTEGER NOT NULL,
     chunk_count INTEGER NOT NULL,
     total_tokens INTEGER NOT NULL,
     byte_estimate INTEGER NOT NULL DEFAULT 0,
     last_used_at INTEGER NOT NULL DEFAULT 0,
     indexed_at INTEGER NOT NULL
   )`,
  `CREATE INDEX documents_library_idx ON documents (library_id)`,
  `CREATE INDEX documents_last_used_idx ON documents (last_used_at)`,
  `CREATE TABLE chunks (
     attachment_id INTEGER NOT NULL,
     chunk_index INTEGER NOT NULL,
     text TEXT NOT NULL,
     token_count INTEGER NOT NULL,
     meta_json TEXT NOT NULL,
     PRIMARY KEY (attachment_id, chunk_index)
   )`,
  `CREATE TABLE postings (
     term TEXT NOT NULL,
     attachment_id INTEGER NOT NULL,
     hits_json TEXT NOT NULL,
     hit_count INTEGER NOT NULL,
     PRIMARY KEY (term, attachment_id)
   )`,
  `CREATE INDEX postings_attachment_idx ON postings (attachment_id)`,
  `CREATE TABLE queue (
     attachment_id INTEGER PRIMARY KEY,
     library_id INTEGER NOT NULL,
     priority INTEGER NOT NULL,
     reason TEXT NOT NULL,
     enqueued_at INTEGER NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0,
     next_attempt_at INTEGER NOT NULL DEFAULT 0,
     last_error TEXT
   )`,
  `CREATE TABLE vector_documents (
     attachment_id INTEGER NOT NULL,
     namespace TEXT NOT NULL,
     dims INTEGER NOT NULL,
     chunk_count INTEGER NOT NULL,
     path TEXT NOT NULL,
     source_fingerprint TEXT NOT NULL,
     indexed_at INTEGER NOT NULL,
     PRIMARY KEY (attachment_id, namespace)
   )`,
];

const PRE_STEMMING_PAPERS: Array<{ id: number; chunks: string[] }> = [
  {
    id: 101,
    chunks: [
      "Results. The calibration error stayed below one percent.",
      "Methods. The gauges were cooled overnight.",
    ],
  },
  { id: 102, chunks: ["Readout errors grew with temperature."] },
  { id: 103, chunks: ["Encoding of place fields drifted across sessions."] },
  { id: 104, chunks: ["The model encodes errors in its readout."] },
  { id: 105, chunks: ["An error budget for the gauge."] },
  { id: 106, chunks: ["The housing was machined from aluminium."] },
];

describe("library text index tokenizer upgrade on a pre-stemming database", function () {
  let harness: ReturnType<typeof installLibraryTextIndexSqlite>;
  let db: LibraryTextIndexDb;
  let store: LibraryTextIndexStore;

  /** What a build before stemming wrote: surface-token postings. */
  function seedPreStemmingIndex(): void {
    for (const sql of PRE_STEMMING_SCHEMA) harness.exec(sql);
    harness.exec(
      `INSERT INTO index_meta (key, value) VALUES ('schema_version', '1')`,
    );
    for (const paper of PRE_STEMMING_PAPERS) {
      const tokenized = paper.chunks.map((text) => tokenizeRetrievalText(text));
      harness.exec(
        `INSERT INTO documents (attachment_id, attachment_key, library_id, parent_item_id, title, source_type, source_fingerprint, source_mtime, source_size, chunker_version, chunk_count, total_tokens, byte_estimate, last_used_at, indexed_at)
         VALUES (?,?,1,?,?,'mineru',?,NULL,NULL,2,?,?,?,0,1234)`,
        [
          paper.id,
          `K${paper.id}`,
          paper.id * 10,
          `Paper ${paper.id}`,
          `fp${paper.id}`,
          paper.chunks.length,
          tokenized.reduce((sum, tokens) => sum + tokens.length, 0),
          999,
        ],
      );
      const byTerm = new Map<string, Array<[number, number, number]>>();
      paper.chunks.forEach((text, chunkIndex) => {
        harness.exec(
          `INSERT INTO chunks (attachment_id, chunk_index, text, token_count, meta_json) VALUES (?,?,?,?,?)`,
          [
            paper.id,
            chunkIndex,
            text,
            tokenized[chunkIndex].length,
            JSON.stringify({ chunkKind: "body" }),
          ],
        );
        const tf: Record<string, number> = {};
        for (const token of tokenized[chunkIndex])
          tf[token] = (tf[token] || 0) + 1;
        for (const [term, count] of Object.entries(tf)) {
          const hits = byTerm.get(term) || [];
          hits.push([chunkIndex, count, tokenized[chunkIndex].length]);
          byTerm.set(term, hits);
        }
      });
      for (const [term, hits] of byTerm)
        harness.exec(
          `INSERT INTO postings (term, attachment_id, hits_json, hit_count) VALUES (?,?,?,?)`,
          [term, paper.id, JSON.stringify(hits), hits.length],
        );
    }
    harness.exec(
      `INSERT INTO vector_documents (attachment_id, namespace, dims, chunk_count, path, source_fingerprint, indexed_at) VALUES (101, 'ns', 4, 2, 'vectors/ns/101.bin', 'fp101', 77)`,
    );
  }

  const postingTerms = (attachmentId: number) =>
    harness
      .rows(`SELECT term FROM postings WHERE attachment_id = ? ORDER BY term`, [
        attachmentId,
      ])
      .map((row) => String(row.term));
  const markers = () =>
    Object.fromEntries(
      harness
        .rows(
          `SELECT attachment_id, tokenizer_version FROM document_tokenizer ORDER BY attachment_id`,
        )
        .map((row) => [
          Number(row.attachment_id),
          Number(row.tokenizer_version),
        ]),
    );
  const find = async (query: string) =>
    (
      await searchLibraryTextIndex({
        store,
        scopeAttachmentIds: [...PRE_STEMMING_PAPERS.map((p) => p.id), 107],
        queries: [query],
        maxPapers: 10,
        perPaperTopK: 3,
      })
    ).papers
      .map((paper) => paper.attachmentId)
      .sort((a, b) => a - b);

  beforeEach(async function () {
    harness = installLibraryTextIndexSqlite();
    seedPreStemmingIndex();
    db = (await openLibraryTextIndexDb())!;
    store = new LibraryTextIndexStore(db);
  });
  afterEach(function () {
    harness.close();
  });

  it("opens the old shape without dropping it, and every document waits for the pass", async function () {
    const meta = harness.rows(`SELECT key, value FROM index_meta`);
    assert.deepEqual(meta, [{ key: "schema_version", value: "1" }]);
    assert.equal(
      harness.rows(`SELECT COUNT(*) AS n FROM documents`)[0].n,
      PRE_STEMMING_PAPERS.length,
    );
    assert.deepEqual(markers(), {});
    assert.isFalse(await store.isTokenizerVersionCurrent());
    assert.deepEqual(
      await store.listDocumentsNeedingRepost(
        LIBRARY_TEXT_INDEX_TOKENIZER_VERSION,
        100,
      ),
      PRE_STEMMING_PAPERS.map((p) => p.id),
    );
    // Before the pass a query asks for the index term and the surface term:
    // "errors" finds the surface postings "error" (101, 105) and "errors"
    // (102, 104); "encoding" still finds its surface form.
    assert.deepEqual(await find("errors"), [101, 102, 104, 105]);
    assert.deepEqual(await find("encoding"), [103]);
  });

  it("re-posts from stored chunk text one document per transaction, resumes after an interruption without redoing work, and records the version last", async function () {
    const before = {
      chunks: harness.rows(
        `SELECT attachment_id, chunk_index, text, token_count, meta_json FROM chunks ORDER BY attachment_id, chunk_index`,
      ),
      documents: harness.rows(
        `SELECT attachment_id, source_fingerprint, chunker_version, chunk_count, total_tokens, indexed_at FROM documents ORDER BY attachment_id`,
      ),
      vectors: harness.rows(`SELECT * FROM vector_documents`),
    };

    // Interrupt inside the fourth document's transaction, after its old
    // postings were deleted and its new ones written.
    const interrupting = new LibraryTextIndexStore({
      ...db,
      queryAsync: (sql, params, options) => {
        if (
          /INSERT OR REPLACE INTO document_tokenizer/.test(sql) &&
          (params as unknown[])[0] === 104
        )
          return Promise.reject(new Error("Zotero quit mid-pass"));
        return db.queryAsync(sql, params, options);
      },
    });
    let failure: unknown = null;
    try {
      await runTokenizerUpgradeSlice(interrupting, { sliceMs: 60_000 });
    } catch (error) {
      failure = error;
    }
    assert.match(String(failure), /quit mid-pass/);
    assert.deepEqual(markers(), { 101: 2, 102: 2, 103: 2 });
    assert.isNull(await store.getIndexMeta(TOKENIZER_VERSION_META_KEY));
    assert.include(postingTerms(102), "error");
    assert.notInclude(postingTerms(102), "errors");
    // The interrupted document rolled back to its surface postings, whole.
    assert.includeMembers(postingTerms(104), ["errors", "encodes", "readout"]);
    assert.notInclude(postingTerms(104), "error");
    // Mixed state: re-posted papers match by stem, waiting ones by surface.
    assert.deepEqual(await find("errors"), [101, 102, 104, 105]);
    assert.deepEqual(await find("encoding"), [103]);

    // A paper indexed fresh while the pass waits gets stemmed postings and
    // its marker directly.
    const freshText = "Sensor errors were corrected offline.";
    const fresh = buildChunkIndex([freshText]).chunkStats[0];
    await store.upsertDocument({
      attachmentId: 107,
      attachmentKey: "K107",
      libraryID: 1,
      parentItemId: 1070,
      title: "Paper 107",
      sourceType: "mineru",
      sourceFingerprint: "fp107",
      sourceMtime: null,
      sourceSize: null,
      chunkerVersion: LIBRARY_TEXT_INDEX_CHUNKER_VERSION,
      byteEstimate: 10,
      chunks: [
        {
          chunkIndex: 0,
          text: freshText,
          tokenCount: fresh.length,
          meta: { chunkKind: "body" },
          tf: fresh.tf,
        },
      ],
    });
    assert.equal(markers()[107], 2);

    // Resume, one document per slice; the version is written only at the end.
    const reposted: number[] = [];
    const original = store.repostDocument.bind(store);
    store.repostDocument = (attachmentId, version, rebuild) => {
      reposted.push(attachmentId);
      return original(attachmentId, version, rebuild);
    };
    let clock = 0;
    let slice = await runTokenizerUpgradeSlice(store, {
      sliceMs: 1,
      now: () => (clock += 1),
    });
    let slices = 1;
    while (!slice.done) {
      assert.isNull(await store.getIndexMeta(TOKENIZER_VERSION_META_KEY));
      slice = await runTokenizerUpgradeSlice(store, {
        sliceMs: 1,
        now: () => (clock += 1),
      });
      slices += 1;
    }
    assert.deepEqual(reposted, [104, 105, 106], "finished documents are kept");
    assert.isAtLeast(slices, 3);
    assert.equal(
      await store.getIndexMeta(TOKENIZER_VERSION_META_KEY),
      String(LIBRARY_TEXT_INDEX_TOKENIZER_VERSION),
    );
    assert.isTrue(await store.isTokenizerVersionCurrent());
    assert.deepEqual(markers(), {
      101: 2,
      102: 2,
      103: 2,
      104: 2,
      105: 2,
      106: 2,
      107: 2,
    });

    // Every document's postings are what a fresh index writes.
    for (const paper of PRE_STEMMING_PAPERS) {
      const stats = buildChunkIndex(paper.chunks).chunkStats;
      const expected = new Map<string, Array<[number, number, number]>>();
      for (const stat of stats)
        for (const [term, tf] of Object.entries(stat.tf)) {
          const hits = expected.get(term) || [];
          hits.push([stat.index, tf, stat.length]);
          expected.set(term, hits);
        }
      const rows = harness.rows(
        `SELECT term, hits_json FROM postings WHERE attachment_id = ? ORDER BY term`,
        [paper.id],
      );
      assert.deepEqual(
        rows.map((row) => [row.term, JSON.parse(String(row.hits_json))]),
        [...expected.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
        `postings of ${paper.id}`,
      );
      assert.equal(
        harness.rows(
          `SELECT byte_estimate FROM documents WHERE attachment_id = ?`,
          [paper.id],
        )[0].byte_estimate,
        estimateDocumentBytes({
          chunks: paper.chunks.map((text, i) => ({ text, tf: stats[i].tf })),
        }),
      );
    }
    // Chunk rows, document identity and vectors are untouched.
    assert.deepEqual(
      harness.rows(
        `SELECT attachment_id, chunk_index, text, token_count, meta_json FROM chunks WHERE attachment_id <> 107 ORDER BY attachment_id, chunk_index`,
      ),
      before.chunks,
    );
    assert.deepEqual(
      harness.rows(
        `SELECT attachment_id, source_fingerprint, chunker_version, chunk_count, total_tokens, indexed_at FROM documents WHERE attachment_id <> 107 ORDER BY attachment_id`,
      ),
      before.documents.map((row) => ({ ...row, chunker_version: 3 })),
      "the pass records chunker version 3; nothing else changes",
    );
    assert.deepEqual(
      harness
        .rows(`SELECT DISTINCT chunker_version FROM documents`)
        .map((row) => Number(row.chunker_version)),
      [LIBRARY_TEXT_INDEX_CHUNKER_VERSION],
    );
    assert.deepEqual(
      harness.rows(`SELECT * FROM vector_documents`),
      before.vectors,
    );

    assert.deepEqual(await find("errors"), [101, 102, 104, 105, 107]);
    assert.deepEqual(await find("encoding"), [103, 104], "'encodes' too");
    const again = await runTokenizerUpgradeSlice(store, { sliceMs: 50 });
    assert.deepEqual(again, { reposted: 0, done: true });
  });

  it("lists a chunker-2 document for re-posting even when its marker is current, and leaves other chunker versions at their value", async function () {
    await runTokenizerUpgradeSlice(store, { sliceMs: 60_000 });
    harness.exec(
      `UPDATE documents SET chunker_version = 2 WHERE attachment_id = 103`,
    );
    harness.exec(
      `UPDATE documents SET chunker_version = 1 WHERE attachment_id = 104`,
    );
    store = new LibraryTextIndexStore(db);
    assert.deepEqual(
      await store.listDocumentsNeedingRepost(
        LIBRARY_TEXT_INDEX_TOKENIZER_VERSION,
        100,
      ),
      [103],
    );
    await runTokenizerUpgradeSlice(store, { sliceMs: 60_000 });
    const versions = Object.fromEntries(
      harness
        .rows(
          `SELECT attachment_id, chunker_version FROM documents WHERE attachment_id IN (103, 104)`,
        )
        .map((row) => [row.attachment_id, Number(row.chunker_version)]),
    );
    assert.deepEqual(versions, { 103: 3, 104: 1 });
  });

  it("deleting a document mid-pass removes its marker with it", async function () {
    await runTokenizerUpgradeSlice(store, { sliceMs: 0 });
    assert.deepEqual(markers(), { 101: 2 });
    await store.deleteDocuments([101]);
    assert.deepEqual(markers(), {});
    assert.isFalse(
      await store.repostDocument(101, 2, () => ({ tf: [], byteEstimate: 0 })),
    );
    assert.deepEqual(markers(), {});
  });

  it("re-posts a document that an older build re-indexed after the pass finished", async function () {
    let slice = await runTokenizerUpgradeSlice(store, { sliceMs: 60_000 });
    assert.isTrue(slice.done);
    assert.equal(
      await store.getIndexMeta(TOKENIZER_VERSION_META_KEY),
      String(LIBRARY_TEXT_INDEX_TOKENIZER_VERSION),
    );

    // An older build re-indexes document 102: surface-token postings and a
    // new indexed_at; the marker row and the global row stay as they were.
    const surface = tokenizeRetrievalText(PRE_STEMMING_PAPERS[1].chunks[0]);
    harness.exec(`DELETE FROM postings WHERE attachment_id = 102`);
    const counts: Record<string, number> = {};
    for (const token of surface) counts[token] = (counts[token] || 0) + 1;
    for (const [term, count] of Object.entries(counts))
      harness.exec(
        `INSERT INTO postings (term, attachment_id, hits_json, hit_count) VALUES (?,?,?,?)`,
        [term, 102, JSON.stringify([[0, count, surface.length]]), 1],
      );
    harness.exec(
      `UPDATE documents SET indexed_at = 99999, chunker_version = 2 WHERE attachment_id = 102`,
    );

    // A new plugin start: a fresh store instance, same storage.
    store = new LibraryTextIndexStore(db);
    assert.equal(
      await store.getIndexMeta(TOKENIZER_VERSION_META_KEY),
      String(LIBRARY_TEXT_INDEX_TOKENIZER_VERSION),
    );
    assert.isFalse(await store.isTokenizerVersionCurrent());
    assert.deepEqual(
      await store.listDocumentsNeedingRepost(
        LIBRARY_TEXT_INDEX_TOKENIZER_VERSION,
        100,
      ),
      [102],
    );

    const reposted: number[] = [];
    const original = store.repostDocument.bind(store);
    store.repostDocument = (attachmentId, version, rebuild) => {
      reposted.push(attachmentId);
      return original(attachmentId, version, rebuild);
    };
    slice = await runTokenizerUpgradeSlice(store, { sliceMs: 60_000 });
    assert.deepEqual(slice, { reposted: 1, done: true });
    assert.deepEqual(reposted, [102]);
    assert.equal(
      harness.rows(
        `SELECT indexed_at FROM documents WHERE attachment_id = 102`,
      )[0].indexed_at,
      99999,
      "repost keeps indexed_at",
    );
    assert.isTrue(await store.isTokenizerVersionCurrent());
    assert.deepEqual(
      await store.listDocumentsNeedingRepost(
        LIBRARY_TEXT_INDEX_TOKENIZER_VERSION,
        100,
      ),
      [],
    );
    assert.include(await find("errors"), 102);
    assert.deepEqual(await find("errors"), [101, 102, 104, 105]);
  });
});
