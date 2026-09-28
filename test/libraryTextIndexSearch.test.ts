import { assert } from "chai";
import { installLibraryTextIndexSqlite } from "./helpers/libraryTextIndexDb";
import {
  buildFixturePdfContext,
  restoreTestGlobals,
  setupMemoryIO,
  setupZoteroGlobals,
  snapshotTestGlobals,
  type TestGlobalSnapshot,
} from "./helpers/retrievalCorpus";
import { setAppLogSinkForTests, type AppLogLevel } from "../src/core/logging";
import { LibraryTextIndexStore } from "../src/services/libraryTextIndex/store";
import { openLibraryTextIndexDb } from "../src/services/libraryTextIndex/db";
import { buildIndexDocumentFromPdfContext } from "../src/services/libraryTextIndex/indexer";
import { searchLibraryTextIndex } from "../src/services/libraryTextIndex/search";
import { libraryTextIndex } from "../src/services/libraryTextIndex";
import {
  buildChunkIndex,
  scoreChunkBM25,
} from "../src/services/paperContent/pdfContext";
import { tokenizeRetrievalQuery } from "../src/services/retrieval/retrievalTokenizer";
import { pdfTextCache } from "../src/services/paperContent/contextCache";

describe("library text index search", function () {
  let globals: TestGlobalSnapshot;
  let harness: ReturnType<typeof installLibraryTextIndexSqlite>;
  let store: LibraryTextIndexStore;
  before(function () {
    globals = snapshotTestGlobals();
  });
  after(function () {
    restoreTestGlobals(globals);
  });
  beforeEach(async function () {
    // Fresh fixture host per test, so no test depends on files an earlier one wrote.
    setupMemoryIO();
    setupZoteroGlobals();
    harness = installLibraryTextIndexSqlite();
    store = new LibraryTextIndexStore((await openLibraryTextIndexDb())!);
  });
  afterEach(function () {
    harness.close();
    pdfTextCache.clear();
  });

  it("ranks a single paper's chunks exactly like the in-memory BM25", async function () {
    const ctx = await buildFixturePdfContext("bioSingleHash", 9001);
    await store.upsertDocument(
      buildIndexDocumentFromPdfContext({
        attachmentId: 9001,
        attachmentKey: "K",
        libraryID: 1,
        parentItemId: 100,
        fileState: null,
        ctx,
      }),
    );
    const query = "place field stability sleep restriction";
    const terms = tokenizeRetrievalQuery(query);
    const local = buildChunkIndex(ctx.chunks);
    const expected = local.chunkStats
      .map((stat) => ({
        chunkIndex: stat.index,
        score: scoreChunkBM25(
          stat,
          terms,
          local.docFreq,
          ctx.chunks.length,
          local.avgChunkLength,
        ),
      }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || a.chunkIndex - b.chunkIndex);
    assert.isAbove(expected.length, 1, "the query must hit several chunks");
    const result = await searchLibraryTextIndex({
      store,
      scopeAttachmentIds: [9001],
      queries: [query],
      maxPapers: 1,
      perPaperTopK: 99,
    });
    assert.deepEqual(
      result.chunks.map((c) => c.chunkIndex),
      expected.map((r) => r.chunkIndex),
    );
    result.chunks.forEach((c, i) =>
      assert.closeTo(c.bm25Score, expected[i].score, 1e-9),
    );
  });

  it("shortlists across papers, respects scope, and reports coverage", async function () {
    const bio = await buildFixturePdfContext("bioSingleHash", 9001);
    const math = await buildFixturePdfContext("mathDoubleHash", 9002);
    await store.upsertDocument(
      buildIndexDocumentFromPdfContext({
        attachmentId: 9001,
        attachmentKey: "A",
        libraryID: 1,
        parentItemId: 100,
        fileState: null,
        ctx: bio,
      }),
    );
    await store.upsertDocument(
      buildIndexDocumentFromPdfContext({
        attachmentId: 9002,
        attachmentKey: "B",
        libraryID: 1,
        parentItemId: 101,
        fileState: null,
        ctx: math,
      }),
    );
    const all = await searchLibraryTextIndex({
      store,
      scopeAttachmentIds: [9001, 9002, 9003],
      queries: ["kinematic condition contact line"],
      maxPapers: 2,
      perPaperTopK: 3,
    });
    assert.equal(
      all.papers[0].attachmentId,
      9002,
      "the math paper wins its own vocabulary",
    );
    assert.equal(all.papers[0].parentItemId, 101);
    assert.deepEqual(all.coverage, {
      scopeAttachments: 3,
      indexed: 2,
      unindexed: [9003],
      failed: [],
      stale: [],
    });
    assert.isAtMost(
      all.chunks.filter((c) => c.attachmentId === 9002).length,
      3,
    );
    const duplicated = await searchLibraryTextIndex({
      store,
      scopeAttachmentIds: [9001, 9001, 9002, 9003, 9003],
      queries: ["kinematic condition contact line"],
      maxPapers: 2,
      perPaperTopK: 3,
    });
    assert.deepEqual(duplicated.coverage, all.coverage);
    assert.equal(
      duplicated.coverage.indexed + duplicated.coverage.unindexed.length,
      duplicated.coverage.scopeAttachments,
    );
    const scoped = await searchLibraryTextIndex({
      store,
      scopeAttachmentIds: [9001],
      queries: ["kinematic condition contact line"],
      maxPapers: 2,
      perPaperTopK: 3,
    });
    assert.isTrue(scoped.chunks.every((c) => c.attachmentId === 9001));
    // Each hit carries its document's source, so snippets can label it.
    assert.isNotEmpty(all.chunks);
    for (const c of all.chunks) {
      assert.equal(
        c.sourceType,
        c.attachmentId === 9001 ? bio.sourceType : math.sourceType,
      );
    }
  });

  it("unions terms across query variants, caps them, and returns nothing for an empty query", async function () {
    const bio = await buildFixturePdfContext("bioSingleHash", 9001);
    await store.upsertDocument(
      buildIndexDocumentFromPdfContext({
        attachmentId: 9001,
        attachmentKey: "A",
        libraryID: 1,
        parentItemId: 100,
        fileState: null,
        ctx: bio,
      }),
    );
    const result = await searchLibraryTextIndex({
      store,
      scopeAttachmentIds: [9001],
      queries: ["place cells", "hippocampus recording"],
      maxPapers: 1,
      perPaperTopK: 2,
    });
    assert.includeMembers(result.queryTerms, [
      "place",
      "cells",
      "hippocampus",
      "recording",
    ]);
    assert.isAtMost(result.queryTerms.length, 32);
    const empty = await searchLibraryTextIndex({
      store,
      scopeAttachmentIds: [9001],
      queries: ["   "],
      maxPapers: 1,
      perPaperTopK: 2,
    });
    assert.deepEqual(empty.chunks, []);
    assert.equal(empty.coverage.indexed, 1);
  });

  it("assigns evidenceScore by final rank and records phase timings", async function () {
    const bio = await buildFixturePdfContext("bioSingleHash", 9001);
    await store.upsertDocument(
      buildIndexDocumentFromPdfContext({
        attachmentId: 9001,
        attachmentKey: "A",
        libraryID: 1,
        parentItemId: 100,
        fileState: null,
        ctx: bio,
      }),
    );
    const result = await searchLibraryTextIndex({
      store,
      scopeAttachmentIds: [9001],
      queries: ["place field"],
      maxPapers: 1,
      perPaperTopK: 3,
    });
    assert.closeTo(result.chunks[0].evidenceScore, 1 / 61, 1e-12);
    assert.closeTo(result.chunks[1].evidenceScore, 1 / 62, 1e-12);
    assert.containsAllKeys(result.timings, [
      "postings",
      "score",
      "chunks",
      "total",
    ]);
  });

  it("searches through the facade, and returns null when the index is disabled", async function () {
    const bio = await buildFixturePdfContext("bioSingleHash", 9001);
    await store.upsertDocument(
      buildIndexDocumentFromPdfContext({
        attachmentId: 9001,
        attachmentKey: "A",
        libraryID: 1,
        parentItemId: 100,
        fileState: null,
        ctx: bio,
      }),
    );
    const params = {
      scopeAttachmentIds: [9001],
      queries: ["place field"],
      maxPapers: 1,
      perPaperTopK: 3,
    };
    assert.isTrue(libraryTextIndex.isEnabled());
    const enabled = await libraryTextIndex.search(params);
    assert.isAbove(enabled?.chunks.length ?? 0, 0);
    const prefs = (
      globalThis as unknown as {
        Zotero: { Prefs: { get: (key: string) => unknown } };
      }
    ).Zotero.Prefs;
    const originalGet = prefs.get;
    prefs.get = (key: string) =>
      key.endsWith(".libraryTextIndexEnabled") ? false : originalGet(key);
    try {
      assert.isFalse(libraryTextIndex.isEnabled());
      assert.isNull(await libraryTextIndex.search(params));
    } finally {
      prefs.get = originalGet;
    }
  });

  it("degrades to null through the facade when the index SQL throws", async function () {
    const bio = await buildFixturePdfContext("bioSingleHash", 9001);
    await store.upsertDocument(
      buildIndexDocumentFromPdfContext({
        attachmentId: 9001,
        attachmentKey: "A",
        libraryID: 1,
        parentItemId: 100,
        fileState: null,
        ctx: bio,
      }),
    );
    const emitted: Array<{ level: AppLogLevel; args: readonly unknown[] }> = [];
    const originalGetPostings = LibraryTextIndexStore.prototype.getPostings;
    LibraryTextIndexStore.prototype.getPostings = async function () {
      throw new Error("database is locked");
    };
    setAppLogSinkForTests((level, args) => emitted.push({ level, args }));
    try {
      const result = await libraryTextIndex.search({
        scopeAttachmentIds: [9001],
        queries: ["place field"],
        maxPapers: 1,
        perPaperTopK: 3,
      });
      assert.isNull(result);
    } finally {
      setAppLogSinkForTests(null);
      LibraryTextIndexStore.prototype.getPostings = originalGetPostings;
    }
    const warns = emitted.filter((e) => e.level === "warn");
    assert.lengthOf(warns, 1);
    assert.include(String(warns[0].args[0]), "search failed");
  });
});
