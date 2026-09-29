import { assert } from "chai";
import { installLibraryTextIndexSqlite } from "./helpers/libraryTextIndexDb";
import {
  setupMemoryIO,
  setupZoteroGlobals,
  restoreTestGlobals,
  snapshotTestGlobals,
  buildFixturePdfContext,
  type MemoryIO,
  type TestGlobalSnapshot,
} from "./helpers/retrievalCorpus";
import { LibraryTextIndexStore } from "../src/services/libraryTextIndex/store";
import { openLibraryTextIndexDb } from "../src/services/libraryTextIndex/db";
import { buildIndexDocumentFromPdfContext } from "../src/services/libraryTextIndex/indexer";
import {
  currentVectorNamespace,
  embedDocumentVectors,
  getLoadedVectorMatrix,
  loadVectorDims,
  loadVectorMatrix,
  pruneVectorNamespaces,
  removeDocumentVectors,
  resetVectorIndexerForTests,
} from "../src/services/libraryTextIndex/vectorIndexer";
import {
  getVectorShardPath,
  namespaceHash,
} from "../src/services/libraryTextIndex/vectorStore";
import { pdfTextCache } from "../src/services/paperContent/contextCache";
import { setAppLogSinkForTests, type AppLogLevel } from "../src/core/logging";

const PREFIX = "extensions.zotero.llmforzotero.";

describe("library vector indexer", function () {
  let globals: TestGlobalSnapshot;
  let harness: ReturnType<typeof installLibraryTextIndexSqlite>;
  let store: LibraryTextIndexStore;
  let io: MemoryIO;
  before(function () {
    globals = snapshotTestGlobals();
  });
  after(function () {
    restoreTestGlobals(globals);
  });
  beforeEach(async function () {
    setupMemoryIO();
    setupZoteroGlobals();
    resetVectorIndexerForTests();
    harness = installLibraryTextIndexSqlite();
    store = new LibraryTextIndexStore((await openLibraryTextIndexDb())!);
    const ctx = await buildFixturePdfContext("bioSingleHash", 9001);
    await store.upsertDocument(
      buildIndexDocumentFromPdfContext({
        attachmentId: 9001,
        attachmentKey: "A",
        libraryID: 1,
        parentItemId: 100,
        sourceMtime: null,
        ctx,
      }),
    );
    io = setupMemoryIO(); // shards land in a fresh in-memory file system
  });
  afterEach(function () {
    harness.close();
    pdfTextCache.clear();
    resetVectorIndexerForTests();
  });

  it("embeds every chunk in batches of 16, writes one shard, records the row, and is idempotent", async function () {
    const batches: number[] = [];
    const embed = async (texts: string[]) => {
      batches.push(texts.length);
      return texts.map((_, i) => [1, i % 3, 0, 1]);
    };
    const first = await embedDocumentVectors({
      store,
      attachmentId: 9001,
      namespace: "test:4",
      embed,
    });
    assert.equal(first.status, "embedded");
    assert.equal(first.dims, 4);
    assert.isTrue(batches.every((n) => n <= 16));
    assert.equal(
      batches.reduce((a, b) => a + b, 0),
      first.chunkCount,
    );
    const rows = harness.rows(
      "SELECT * FROM vector_documents WHERE attachment_id = 9001",
    );
    assert.lengthOf(rows, 1);
    assert.equal(rows[0].namespace, "test:4");
    assert.isTrue(io.files.has(getVectorShardPath("test:4", 9001)));
    const again = await embedDocumentVectors({
      store,
      attachmentId: 9001,
      namespace: "test:4",
      embed,
    });
    assert.equal(again.status, "unchanged");
  });

  it("splits a long document into batches of 16 with at most three in flight", async function () {
    await store.upsertDocument({
      ...(await store.getDocument(9001))!,
      attachmentId: 9003,
      chunks: Array.from({ length: 40 }, (_, i) => ({
        chunkIndex: i,
        text: `chunk ${i}`,
        tokenCount: 2,
        meta: {} as never,
        tf: { chunk: 1 },
      })),
    });
    const sizes: number[] = [];
    let inFlight = 0;
    let peak = 0;
    const embed = async (texts: string[]) => {
      sizes.push(texts.length);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      return texts.map((t) => [Number(t.split(" ")[1]) + 1, 0, 0, 0]);
    };
    const result = await embedDocumentVectors({
      store,
      attachmentId: 9003,
      namespace: "test:4",
      embed,
    });
    assert.equal(result.chunkCount, 40);
    assert.sameMembers(sizes, [16, 16, 8]);
    assert.isAtMost(peak, 3);
    const matrix = (await loadVectorMatrix(store, "test:4"))!;
    assert.equal(matrix.rows, 40);
  });

  it("re-embeds when the document fingerprint changed", async function () {
    const embed = async (texts: string[]) => texts.map(() => [1, 0, 0, 0]);
    await embedDocumentVectors({
      store,
      attachmentId: 9001,
      namespace: "test:4",
      embed,
    });
    harness.exec(
      "UPDATE documents SET source_fingerprint = 'changed' WHERE attachment_id = 9001",
    );
    assert.deepEqual(
      await store.listDocumentsMissingVectors(1, "test:4"),
      [9001],
    );
    const result = await embedDocumentVectors({
      store,
      attachmentId: 9001,
      namespace: "test:4",
      embed,
    });
    assert.equal(result.status, "embedded");
    assert.deepEqual(await store.listDocumentsMissingVectors(1, "test:4"), []);
  });

  it("loads a matrix from the shards listed for a namespace", async function () {
    const embed = async (texts: string[]) =>
      texts.map((_, i) => [i === 0 ? 1 : 0, 1, 0, 0]);
    await embedDocumentVectors({
      store,
      attachmentId: 9001,
      namespace: "test:4",
      embed,
    });
    const matrix = (await loadVectorMatrix(store, "test:4"))!;
    assert.isTrue(matrix.has(9001));
    assert.equal(matrix.rows, (await store.getDocument(9001))!.chunkCount);
    assert.strictEqual(getLoadedVectorMatrix("test:4"), matrix);
  });

  it("prunes other namespaces' rows and files", async function () {
    const embed = async (texts: string[]) => texts.map(() => [1, 0, 0, 0]);
    await embedDocumentVectors({
      store,
      attachmentId: 9001,
      namespace: "old:4",
      embed,
    });
    await embedDocumentVectors({
      store,
      attachmentId: 9001,
      namespace: "new:4",
      embed,
    });
    assert.deepEqual(await store.listVectorNamespaces(), ["new:4", "old:4"]);
    await loadVectorMatrix(store, "old:4");
    const removed = await pruneVectorNamespaces(store, "new:4");
    assert.deepEqual(removed, ["old:4"]);
    assert.deepEqual(await store.listVectorNamespaces(), ["new:4"]);
    assert.isFalse(io.files.has(getVectorShardPath("old:4", 9001)));
    assert.isTrue(io.files.has(getVectorShardPath("new:4", 9001)));
    assert.isNull(getLoadedVectorMatrix("old:4"));
  });

  it("keeps a namespace's rows when its directory cannot be removed, and still prunes the others", async function () {
    const embed = async (texts: string[]) => texts.map(() => [1, 0, 0, 0]);
    for (const namespace of ["keep:4", "old1:4", "old2:4"])
      await embedDocumentVectors({
        store,
        attachmentId: 9001,
        namespace,
        embed,
      });
    const ioUtils = (globalThis as any).IOUtils;
    const remove = ioUtils.remove;
    const locked = namespaceHash("old1:4");
    ioUtils.remove = async (path: string, options: unknown) => {
      if (path.includes(locked)) throw new Error("file is locked");
      return remove(path, options);
    };
    const warns: string[] = [];
    setAppLogSinkForTests((level: AppLogLevel, args) => {
      if (level === "warn") warns.push(args.map(String).join(" "));
    });
    let removed: string[];
    try {
      removed = await pruneVectorNamespaces(store, "keep:4");
    } finally {
      setAppLogSinkForTests(null);
    }
    assert.lengthOf(warns, 1);
    assert.match(warns[0], /could not remove vector namespace files/);
    assert.deepEqual(removed, ["old2:4"]);
    assert.deepEqual(await store.listVectorNamespaces(), ["keep:4", "old1:4"]);
    assert.isTrue(io.files.has(getVectorShardPath("old1:4", 9001)));
    assert.isFalse(io.files.has(getVectorShardPath("old2:4", 9001)));
    // Once the lock is gone, the next prune removes the survivor.
    ioUtils.remove = remove;
    assert.deepEqual(await pruneVectorNamespaces(store, "keep:4"), ["old1:4"]);
    assert.deepEqual(await store.listVectorNamespaces(), ["keep:4"]);
  });

  it("removes a document's shard at the path derived from its namespace, never at a stored path elsewhere", async function () {
    const embed = async (texts: string[]) => texts.map(() => [1, 0, 0, 0]);
    await embedDocumentVectors({
      store,
      attachmentId: 9001,
      namespace: "t:4",
      embed,
    });
    const shard = getVectorShardPath("t:4", 9001);
    const outside = "/tmp/zotero/storage/ABCD1234/paper.pdf";
    io.files.set(outside, new Uint8Array([1]));
    // A corrupted or tampered row: its path points outside the vectors root.
    await removeDocumentVectors([
      { attachmentId: 9001, namespace: "t:4", path: outside },
    ]);
    assert.isTrue(io.files.has(outside), "a stored path is never trusted");
    assert.isFalse(io.files.has(shard), "the derived shard path is removed");
  });

  it("deleteVectorNamespacesExcept returns the removed namespaces", async function () {
    const embed = async (texts: string[]) => texts.map(() => [1, 0, 0, 0]);
    await embedDocumentVectors({
      store,
      attachmentId: 9001,
      namespace: "old:4",
      embed,
    });
    await embedDocumentVectors({
      store,
      attachmentId: 9001,
      namespace: "new:4",
      embed,
    });
    assert.deepEqual(await store.deleteVectorNamespacesExcept("new:4"), [
      "old:4",
    ]);
    assert.deepEqual(await store.listVectorNamespaces(), ["new:4"]);
  });

  it("adds a freshly embedded document to the loaded matrix", async function () {
    await store.upsertDocument({
      ...(await store.getDocument(9001))!,
      attachmentId: 9002,
      chunks: [
        {
          chunkIndex: 0,
          text: "second paper",
          tokenCount: 2,
          meta: {} as never,
          tf: { second: 1, paper: 1 },
        },
      ],
    });
    const embed = async (texts: string[]) => texts.map(() => [0, 1, 0, 0]);
    await embedDocumentVectors({
      store,
      attachmentId: 9001,
      namespace: "test:4",
      embed,
    });
    const matrix = (await loadVectorMatrix(store, "test:4"))!;
    const before = matrix.rows;
    await embedDocumentVectors({
      store,
      attachmentId: 9002,
      namespace: "test:4",
      embed,
    });
    assert.isTrue(matrix.has(9002));
    assert.equal(matrix.rows, before + 1);
  });

  it("drops a truncated shard's row at load so the document is re-embedded", async function () {
    const embed = async (texts: string[]) => texts.map(() => [1, 0, 0, 0]);
    await embedDocumentVectors({
      store,
      attachmentId: 9001,
      namespace: "test:4",
      embed,
    });
    const path = getVectorShardPath("test:4", 9001);
    io.files.set(path, io.files.get(path)!.slice(0, 20));
    assert.isNull(await loadVectorMatrix(store, "test:4"));
    assert.deepEqual(
      await store.listDocumentsMissingVectors(1, "test:4"),
      [9001],
    );
  });

  it("skips a document with no chunks and rejects a short embedding response", async function () {
    assert.equal(
      (
        await embedDocumentVectors({
          store,
          attachmentId: 4242,
          namespace: "test:4",
          embed: async () => [],
        })
      ).status,
      "skipped",
    );
    let error: unknown = null;
    try {
      await embedDocumentVectors({
        store,
        attachmentId: 9001,
        namespace: "test:4",
        embed: async (texts) => texts.slice(1).map(() => [1, 0, 0, 0]),
      });
    } catch (e) {
      error = e;
    }
    assert.match(String(error), /vectors for/);
    assert.lengthOf(harness.rows("SELECT * FROM vector_documents"), 0);
  });

  it("rewrites an :auto namespace to the measured dimensions and remembers them in index_meta", async function () {
    const embed = async (texts: string[]) => texts.map(() => [1, 0, 0]);
    const result = await embedDocumentVectors({
      store,
      attachmentId: 9001,
      namespace: "prov:model:auto",
      embed,
    });
    assert.equal(result.status, "embedded");
    assert.equal(result.namespace, "prov:model:3");
    assert.deepEqual(await store.listVectorNamespaces(), ["prov:model:3"]);
    assert.deepEqual(
      harness.rows(
        "SELECT value FROM index_meta WHERE key = 'vector_dims:prov:model'",
      )[0]?.value,
      "3",
    );
    // A later :auto call (e.g. after a restart) resolves through index_meta.
    resetVectorIndexerForTests();
    const again = await embedDocumentVectors({
      store,
      attachmentId: 9001,
      namespace: "prov:model:auto",
      embed,
    });
    assert.equal(again.status, "unchanged");
    assert.equal(again.namespace, "prov:model:3");
  });

  it("rejects vectors whose length contradicts the namespace dimensions", async function () {
    let error: unknown = null;
    try {
      await embedDocumentVectors({
        store,
        attachmentId: 9001,
        namespace: "test:4",
        embed: async (texts) => texts.map(() => [1, 0, 0]),
      });
    } catch (e) {
      error = e;
    }
    assert.match(String(error), /dimensions/);
  });

  describe("currentVectorNamespace", function () {
    let prefs: Record<string, unknown>;
    beforeEach(function () {
      prefs = {
        libraryTextIndexVectors: true,
        enableSemanticSearch: true,
        embeddingProvider: "custom",
        embeddingApiBase: "http://localhost:11434/v1",
        embeddingModel: "nomic",
      };
      (globalThis as any).Zotero.Prefs.get = (key: string) =>
        key.startsWith(PREFIX) ? prefs[key.slice(PREFIX.length)] : undefined;
    });

    it("is null while the vectors pref is off (the default) or semantic search is off", function () {
      prefs.libraryTextIndexVectors = undefined;
      assert.isNull(currentVectorNamespace());
      prefs.libraryTextIndexVectors = false;
      assert.isNull(currentVectorNamespace());
      prefs.libraryTextIndexVectors = true;
      prefs.enableSemanticSearch = false;
      assert.isNull(currentVectorNamespace());
    });

    it("is :auto until the dimensions are known, then the concrete namespace", async function () {
      const auto = currentVectorNamespace()!;
      assert.match(auto.namespace, /:nomic:auto$/);
      assert.isNull(auto.dims);
      const cacheKey = auto.namespace.slice(0, -":auto".length);
      await store.setIndexMeta(`vector_dims:${cacheKey}`, "768");
      assert.isNull(currentVectorNamespace()!.dims, "not hydrated yet");
      await loadVectorDims(store);
      assert.deepEqual(currentVectorNamespace(), {
        namespace: `${cacheKey}:768`,
        dims: 768,
      });
    });
  });
});
