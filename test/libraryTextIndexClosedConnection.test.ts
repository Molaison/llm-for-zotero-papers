import { assert } from "chai";
import { installZoteroDbConnectionFake } from "./helpers/libraryTextIndexDb";
import { setAppLogSinkForTests, type AppLogLevel } from "../src/core/logging";
import {
  closeLibraryTextIndexDb,
  setLibraryTextIndexDbForTests,
} from "../src/services/libraryTextIndex/db";
import { libraryTextIndex } from "../src/services/libraryTextIndex";
import { LibraryTextIndexScheduler } from "../src/services/libraryTextIndex/scheduler";
import {
  getLibraryTextIndexStore,
  resetLibraryTextIndexStoreForTests,
} from "../src/services/libraryTextIndex/store";
import { searchLibraryTextIndex } from "../src/services/libraryTextIndex/search";

/**
 * Work that races a stop or a Clear (an in-flight search, a fire-and-forget
 * LRU touch, the startup reconcile) meets a permanently closed connection.
 * It must degrade quietly: no warning per late query.
 */
describe("library text index after a permanent close", function () {
  let previousZotero: unknown;
  let levels: AppLogLevel[];
  let gate: Promise<void> | null;
  let release: () => void;
  let armed: RegExp | null;

  const doc = (attachmentId: number) => ({
    attachmentId,
    attachmentKey: `K${attachmentId}`,
    libraryID: 1,
    parentItemId: attachmentId * 10,
    title: "Paper",
    sourceType: "mineru",
    sourceFingerprint: `fp${attachmentId}`,
    sourceMtime: 1,
    sourceSize: 1,
    chunkerVersion: 1,
    byteEstimate: 10,
    chunks: [
      {
        chunkIndex: 0,
        text: "alpha beta gamma",
        tokenCount: 3,
        meta: { chunkKind: "body" } as never,
        tf: { alpha: 1, beta: 1, gamma: 1 },
      },
    ],
  });

  beforeEach(async function () {
    previousZotero = (globalThis as any).Zotero;
    setLibraryTextIndexDbForTests(null);
    resetLibraryTextIndexStoreForTests();
    levels = [];
    gate = null;
    armed = null;
    const fake = installZoteroDbConnectionFake({
      beforeQuery: async (sql) => {
        if (gate && armed?.test(sql)) await gate;
      },
    });
    (globalThis as any).Zotero = {
      DBConnection: fake.FakeZoteroDBConnection,
      DataDirectory: { dir: "/tmp" },
    };
    const store = await getLibraryTextIndexStore();
    await store!.upsertDocument(doc(1));
    setAppLogSinkForTests((level) => levels.push(level));
  });
  afterEach(async function () {
    setAppLogSinkForTests(null);
    await closeLibraryTextIndexDb();
    resetLibraryTextIndexStoreForTests();
    (globalThis as any).Zotero = previousZotero;
  });

  const holdQueriesMatching = (pattern: RegExp) => {
    armed = pattern;
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  };

  it("an in-flight search degrades to null without a warning", async function () {
    holdQueriesMatching(/FROM postings/);
    const searching = libraryTextIndex.search({
      scopeAttachmentIds: [1],
      queries: ["alpha"],
      maxPapers: 5,
      perPaperTopK: 2,
    });
    await new Promise((r) => setTimeout(r, 5));
    await closeLibraryTextIndexDb();
    release();
    assert.isNull(await searching);
    assert.notInclude(levels, "warn");
  });

  it("an in-flight leading-chunk read degrades to null without a warning", async function () {
    holdQueriesMatching(/FROM chunks/);
    const reading = libraryTextIndex.leadingChunks(1, 2);
    await new Promise((r) => setTimeout(r, 5));
    await closeLibraryTextIndexDb();
    release();
    assert.isNull(await reading);
    assert.notInclude(levels, "warn");
  });

  it("a fire-and-forget LRU touch after close is swallowed", async function () {
    const store = (await getLibraryTextIndexStore())!;
    holdQueriesMatching(/UPDATE documents SET last_used_at/);
    const result = await searchLibraryTextIndex({
      store,
      scopeAttachmentIds: [1],
      queries: ["alpha"],
      maxPapers: 5,
      perPaperTopK: 2,
    });
    assert.lengthOf(result.papers, 1);
    await closeLibraryTextIndexDb();
    release();
    await new Promise((r) => setTimeout(r, 5));
    assert.notInclude(levels, "warn");
  });

  it("a startup reconcile racing the close logs no warning", async function () {
    const store = (await getLibraryTextIndexStore())!;
    const scheduler = new LibraryTextIndexScheduler({
      getStore: async () => store,
      getSnapshot: async () =>
        ({
          pdfAttachmentIdsByItemId: new Map([[10, [1]]]),
          attachmentById: new Map([
            [1, { attachmentId: 1, isContextEligiblePdf: true }],
          ]),
          itemById: new Map(),
        }) as any,
      listLibraryIds: () => [1],
      isEnabled: () => true,
      currentVectorNamespace: () => null,
    });
    await closeLibraryTextIndexDb();
    await scheduler.reconcileAll();
    assert.notInclude(levels, "warn");
  });
});
