import { assert } from "chai";
import {
  setupMemoryIO,
  setupZoteroGlobals,
  restoreTestGlobals,
  snapshotTestGlobals,
  type TestGlobalSnapshot,
} from "./helpers/retrievalCorpus";
import {
  LibraryVectorMatrix,
  dotQuantized,
  getVectorShardPath,
  measureVectorBytes,
  quantizeVector,
  readVectorShard,
  removeVectorNamespace,
  vectorNamespace,
  writeVectorShard,
} from "../src/services/libraryTextIndex/vectorStore";

const unit = (v: number[]) => {
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
};
const cosine = (a: number[], b: number[]) => {
  const ua = unit(a),
    ub = unit(b);
  return ua.reduce((s, x, i) => s + x * ub[i], 0);
};

describe("library vector store", function () {
  let globals: TestGlobalSnapshot;
  before(function () {
    globals = snapshotTestGlobals();
    setupMemoryIO();
    setupZoteroGlobals();
  });
  after(function () {
    restoreTestGlobals(globals);
  });

  it("quantizes to int8 with cosine error under 0.02 on random 256-d vectors", function () {
    let worst = 0;
    for (let trial = 0; trial < 50; trial += 1) {
      const a = Array.from({ length: 256 }, () => Math.random() - 0.5);
      const b = Array.from({ length: 256 }, () => Math.random() - 0.5);
      worst = Math.max(
        worst,
        Math.abs(
          cosine(a, b) - dotQuantized(quantizeVector(a), quantizeVector(b)),
        ),
      );
    }
    assert.isBelow(worst, 0.02);
    assert.closeTo(
      dotQuantized(quantizeVector([1, 2, 3]), quantizeVector([1, 2, 3])),
      1,
      0.02,
    );
  });

  it("round-trips a shard through the file layout", async function () {
    const vectors = [
      quantizeVector([1, 0, 0, 0]),
      quantizeVector([0, 1, 1, 0]),
    ];
    const ns = vectorNamespace(
      "openai:https://api.openai.com/v1:text-embedding-3-small",
      4,
    );
    const written = await writeVectorShard(ns, 77, vectors, 4);
    assert.equal(written.path, getVectorShardPath(ns, 77));
    assert.equal(written.bytes, 8 + 4 + 4 + 2 * 4 + 2 * 4);
    const read = (await readVectorShard(written.path))!;
    assert.equal(read.dims, 4);
    assert.deepEqual(Array.from(read.vectors[1].q), Array.from(vectors[1].q));
    assert.closeTo(read.vectors[1].scale, vectors[1].scale, 1e-7);
    assert.equal(await measureVectorBytes(ns), written.bytes);
    await removeVectorNamespace(ns);
    assert.isNull(await readVectorShard(written.path));
  });

  it("returns null for a corrupt or truncated shard", async function () {
    const ns = vectorNamespace("x", 4);
    const { path } = await writeVectorShard(
      ns,
      1,
      [quantizeVector([1, 1, 1, 1])],
      4,
    );
    const io = (
      globalThis as unknown as {
        IOUtils: {
          read: (path: string) => Promise<Uint8Array>;
          write: (path: string, data: Uint8Array) => Promise<void>;
        };
      }
    ).IOUtils;
    const bytes: Uint8Array = await io.read(path);
    await io.write(path, bytes.slice(0, bytes.length - 3));
    assert.isNull(await readVectorShard(path));
  });

  it("matrix search ranks by dot product inside the scope only", function () {
    const m = new LibraryVectorMatrix(3);
    m.addDocument(1, [quantizeVector([1, 0, 0]), quantizeVector([0, 1, 0])]);
    m.addDocument(2, [quantizeVector([0.9, 0.1, 0])]);
    const hits = m.search(quantizeVector([1, 0, 0]), new Set([1, 2]), 2);
    assert.deepEqual(
      hits.map((h) => [h.attachmentId, h.chunkIndex]),
      [
        [1, 0],
        [2, 0],
      ],
    );
    const scoped = m.search(quantizeVector([1, 0, 0]), new Set([2]), 5);
    assert.deepEqual(
      scoped.map((h) => h.attachmentId),
      [2],
    );
    m.removeDocument(1);
    assert.isFalse(m.has(1));
    assert.equal(m.rows, 1);
  });
});
