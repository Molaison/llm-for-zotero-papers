import { assert } from "chai";
import {
  onPdfContextLoaded,
  pdfTextCache,
} from "../src/services/paperContent/contextCache";
import { ensurePDFTextCached } from "../src/services/paperContent/pdfContext";
import {
  buildFixturePdfContext,
  mockPdfAttachment,
  restoreTestGlobals,
  snapshotTestGlobals,
  type TestGlobalSnapshot,
} from "./helpers/retrievalCorpus";

describe("pdf context write-through hook", function () {
  let globals: TestGlobalSnapshot;
  before(function () {
    globals = snapshotTestGlobals();
  });
  after(function () {
    restoreTestGlobals(globals);
  });
  afterEach(function () {
    pdfTextCache.clear();
  });

  it("notifies listeners once per fresh load, synchronously after the cache is filled, and not on cache hits", async function () {
    await buildFixturePdfContext("bioSingleHash", 9001); // writes the MinerU fixture files
    pdfTextCache.clear();
    const seen: Array<{ id: number; cached: boolean }> = [];
    const off = onPdfContextLoaded((id) =>
      seen.push({ id, cached: pdfTextCache.has(id) }),
    );
    try {
      const item = mockPdfAttachment(9001);
      await ensurePDFTextCached(item);
      await ensurePDFTextCached(item);
      assert.deepEqual(seen, [{ id: 9001, cached: true }]);
    } finally {
      off();
    }
  });

  it("the write-through hook only enqueues and never touches the store synchronously", async function () {
    // A throwing listener must not break extraction, and no listener may run store SQL: the
    // scheduler's listener (Task 7) calls enqueue() which is fire-and-forget.
    await buildFixturePdfContext("bioSingleHash", 9001);
    pdfTextCache.clear();
    const off = onPdfContextLoaded(() => {
      throw new Error("listener bug");
    });
    try {
      await ensurePDFTextCached(mockPdfAttachment(9001));
      assert.isTrue(
        pdfTextCache.has(9001),
        "extraction survives a throwing listener",
      );
    } finally {
      off();
    }
  });
  it("a silent load notifies nobody, and a later normal load of the cached item is a cache hit", async function () {
    await buildFixturePdfContext("bioSingleHash", 9001);
    pdfTextCache.clear();
    const seen: number[] = [];
    const off = onPdfContextLoaded((id) => seen.push(id));
    try {
      const item = mockPdfAttachment(9001);
      await ensurePDFTextCached(item, { silentLoad: true });
      assert.isTrue(pdfTextCache.has(9001), "the silent load filled the cache");
      await ensurePDFTextCached(item);
      assert.deepEqual(seen, []);
    } finally {
      off();
    }
  });

  it("does not notify for an attachment that yields no text", async function () {
    await buildFixturePdfContext("bioSingleHash", 9001);
    pdfTextCache.clear();
    const seen: number[] = [];
    const off = onPdfContextLoaded((id) => seen.push(id));
    try {
      await ensurePDFTextCached(mockPdfAttachment(9999));
      assert.isTrue(pdfTextCache.has(9999), "an empty context is still cached");
      assert.deepEqual(seen, []);
    } finally {
      off();
    }
  });
});
