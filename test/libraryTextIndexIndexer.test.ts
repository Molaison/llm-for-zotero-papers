import { assert } from "chai";
import { installLibraryTextIndexSqlite } from "./helpers/libraryTextIndexDb";
import {
  buildFixturePdfContext,
  mockPdfAttachment,
  restoreTestGlobals,
  setupMemoryIO,
  setupZoteroGlobals,
  snapshotTestGlobals,
  type TestGlobalSnapshot,
} from "./helpers/retrievalCorpus";
import { LibraryTextIndexStore } from "../src/services/libraryTextIndex/store";
import { openLibraryTextIndexDb } from "../src/services/libraryTextIndex/db";
import {
  buildIndexDocumentFromPdfContext,
  computeChunkerFingerprint,
  estimateDocumentBytes,
  indexAttachment,
} from "../src/services/libraryTextIndex/indexer";
import { LIBRARY_TEXT_INDEX_CHUNKER_VERSION } from "../src/services/libraryTextIndex/constants";
import {
  onPdfContextLoaded,
  pdfTextCache,
} from "../src/services/paperContent/contextCache";
import { buildChunkIndex } from "../src/services/paperContent/pdfContext";

describe("library text indexer", function () {
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

  it("builds a document whose postings reproduce buildChunkIndex term stats, with file state and a byte estimate", async function () {
    const ctx = await buildFixturePdfContext("bioSingleHash", 9001);
    const doc = buildIndexDocumentFromPdfContext({
      attachmentId: 9001,
      attachmentKey: "K9001",
      libraryID: 1,
      parentItemId: 100,
      fileState: { path: "/x.pdf", size: 4096, mtime: 1234 },
      ctx,
    });
    const expected = buildChunkIndex(ctx.chunks);
    assert.equal(doc.chunks.length, ctx.chunks.length);
    doc.chunks.forEach((chunk, i) => {
      assert.deepEqual(chunk.tf, expected.chunkStats[i].tf);
      assert.equal(chunk.tokenCount, expected.chunkStats[i].length);
      assert.equal(chunk.meta.sectionLabel, ctx.chunkMeta[i].sectionLabel);
    });
    assert.equal(doc.sourceType, "mineru");
    assert.equal(doc.sourceFingerprint, ctx.chunkMeta[0].sourceFingerprint);
    assert.equal(doc.chunkerVersion, LIBRARY_TEXT_INDEX_CHUNKER_VERSION);
    assert.equal(doc.sourceMtime, 1234);
    assert.equal(doc.sourceSize, 4096);
    assert.equal(doc.byteEstimate, estimateDocumentBytes(doc));
    assert.isAbove(doc.byteEstimate, ctx.chunks.join("").length);
  });

  it("indexes an attachment in the urgent lane, persists it, evicts only what it loaded, and skips an unchanged rewrite", async function () {
    const item = mockPdfAttachment(9001);
    await buildFixturePdfContext("bioSingleHash", 9001);
    pdfTextCache.clear();
    const result = await indexAttachment({
      item,
      libraryID: 1,
      store,
      lane: "urgent",
    });
    assert.equal(result.status, "indexed");
    assert.isAbove(result.chunkCount, 3);
    assert.isFalse(
      pdfTextCache.has(9001),
      "indexing must not grow the TTL cache",
    );
    const row = await store.getDocument(9001);
    assert.equal(row?.chunkCount, result.chunkCount);
    const again = await indexAttachment({
      item,
      libraryID: 1,
      store,
      lane: "urgent",
    });
    assert.equal(
      again.status,
      "unchanged",
      "same fingerprint skips the rewrite",
    );
  });

  it("records a new file stat on an unchanged re-index so reconcile stops flagging it stale", async function () {
    const item = Object.assign(mockPdfAttachment(9001), {
      getFilePathAsync: async () => "/storage/K9001/paper.pdf",
    }) as unknown as Zotero.Item;
    await buildFixturePdfContext("bioSingleHash", 9001);
    pdfTextCache.clear();
    const io = (globalThis as any).IOUtils;
    let lastModified = 1000;
    io.stat = async () => ({ size: 4096, lastModified });
    const first = await indexAttachment({
      item,
      libraryID: 1,
      store,
      lane: "urgent",
    });
    assert.equal(first.status, "indexed");
    assert.equal((await store.getDocument(9001))?.sourceMtime, 1000);
    lastModified = 2000; // file sync re-downloaded identical bytes
    const second = await indexAttachment({
      item,
      libraryID: 1,
      store,
      lane: "urgent",
    });
    assert.equal(second.status, "unchanged");
    const row = await store.getDocument(9001);
    assert.equal(row?.sourceMtime, 2000);
    assert.equal(row?.sourceSize, 4096);
  });

  it("keeps a context the question path already loaded (write-through never evicts the agent's paper)", async function () {
    const item = mockPdfAttachment(9001);
    await buildFixturePdfContext("bioSingleHash", 9001);
    assert.isTrue(pdfTextCache.has(9001));
    const result = await indexAttachment({
      item,
      libraryID: 1,
      store,
      lane: "urgent",
    });
    assert.equal(result.status, "indexed");
    assert.isTrue(
      pdfTextCache.has(9001),
      "a pre-existing context stays cached",
    );
  });

  it("prefers Zotero's full-text cache over PDFWorker in the prefetch lane and upgrades later", async function () {
    // 9002 has no MinerU cache; the fixture host exposes a full-text cache file and a PDFWorker.
    const item = mockPdfAttachment(9002);
    const host = globals as unknown as {
      fulltextCacheText?: Map<number, string>;
      pdfWorkerCalls?: number[];
    };
    // Fixture support: retrievalCorpus.setupZoteroGlobals() exposes Zotero.Fulltext.getItemCacheFile and Zotero.PDFWorker.getFullText
    // backed by two maps on the snapshot; add them there if missing (see Step 7 note).
    host.fulltextCacheText!.set(
      9002,
      "Abstract. The quorvex coefficient was 0.37 in every trial. Methods. We measured it twice.",
    );
    host.pdfWorkerCalls!.length = 0;
    const prefetch = await indexAttachment({
      item,
      libraryID: 1,
      store,
      lane: "prefetch",
    });
    assert.equal(prefetch.status, "indexed");
    assert.equal(prefetch.sourceType, "zotero-fulltext-cache");
    assert.deepEqual(host.pdfWorkerCalls, [], "prefetch never ran pdf.js");
    pdfTextCache.clear();
    const urgent = await indexAttachment({
      item,
      libraryID: 1,
      store,
      lane: "urgent",
    });
    assert.equal(
      urgent.status,
      "indexed",
      "the urgent lane's better source replaces the full-text-cache row",
    );
    assert.equal(urgent.sourceType, "zotero-worker");
    assert.deepEqual(host.pdfWorkerCalls, [9002]);
  });

  it("reports no_text for an attachment with no extractable text", async function () {
    const item = mockPdfAttachment(9999);
    const result = await indexAttachment({
      item,
      libraryID: 1,
      store,
      lane: "prefetch",
    });
    assert.equal(result.status, "no_text");
    // A zero-chunk row, so a scanned PDF is not re-extracted every session;
    // reconcile's stat and MinerU-upgrade checks still re-queue it on change.
    const row = await store.getDocument(9999);
    assert.equal(row?.sourceType, "none");
    assert.equal(row?.chunkCount, 0);
    assert.equal(row?.byteEstimate, 0);
    assert.deepEqual((await store.getCoverage([9999])).missing, []);
  });

  it("records the file state on a no_text row so a changed file is re-queued", async function () {
    const item = Object.assign(mockPdfAttachment(9999), {
      getFilePathAsync: async () => "/storage/K9999/scan.pdf",
    }) as unknown as Zotero.Item;
    (globalThis as any).IOUtils.stat = async () => ({
      size: 777,
      lastModified: 4242,
    });
    const result = await indexAttachment({
      item,
      libraryID: 1,
      store,
      lane: "prefetch",
    });
    assert.equal(result.status, "no_text");
    const row = await store.getDocument(9999);
    assert.equal(row?.sourceMtime, 4242);
    assert.equal(row?.sourceSize, 777);
  });

  it("pins the chunker output so a chunking change forces a version bump", async function () {
    const bio = await buildFixturePdfContext("bioSingleHash", 9001);
    const math = await buildFixturePdfContext("mathDoubleHash", 9002);
    // Update BOTH constants below in the same commit when chunking changes:
    // the fingerprint here and LIBRARY_TEXT_INDEX_CHUNKER_VERSION in constants.ts.
    assert.equal(
      `${computeChunkerFingerprint(bio)}:${computeChunkerFingerprint(math)}`,
      "2644aa73:bb6e3130",
    );
    assert.equal(LIBRARY_TEXT_INDEX_CHUNKER_VERSION, 1);
  });
  it("never triggers a write-through listener, in either lane", async function () {
    await buildFixturePdfContext("bioSingleHash", 9001);
    pdfTextCache.clear();
    globals.fulltextCacheText.set(
      9002,
      "Abstract. The quorvex coefficient was 0.37.",
    );
    const seen: number[] = [];
    const off = onPdfContextLoaded((id) => seen.push(id));
    try {
      const urgent = await indexAttachment({
        item: mockPdfAttachment(9001),
        libraryID: 1,
        store,
        lane: "urgent",
      });
      const prefetch = await indexAttachment({
        item: mockPdfAttachment(9002),
        libraryID: 1,
        store,
        lane: "prefetch",
      });
      assert.equal(urgent.status, "indexed");
      assert.equal(prefetch.status, "indexed");
      assert.deepEqual(seen, []);
    } finally {
      off();
    }
  });
});
