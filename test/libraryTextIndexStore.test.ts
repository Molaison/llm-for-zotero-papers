import { assert } from "chai";
import { installLibraryTextIndexSqlite } from "./helpers/libraryTextIndexDb";
import {
  getLibraryTextIndexStore,
  LibraryTextIndexStore,
  type IndexDocumentInput,
} from "../src/services/libraryTextIndex/store";
import { openLibraryTextIndexDb } from "../src/services/libraryTextIndex/db";

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
});
