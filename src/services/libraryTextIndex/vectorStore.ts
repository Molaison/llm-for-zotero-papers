/**
 * Vector layer storage for the library text index.
 *
 * Chunk embeddings are unit-normalized and quantized to int8 with one float32
 * scale per vector, then stored as one shard file per attachment under
 * `{dataDir}/llm-for-zotero-index/vectors/{namespaceHash}/{attachmentId}.bin`.
 * The namespace is the embedding cache key plus the dimension count, so a
 * provider or model change never mixes incompatible vectors.
 *
 * Shard layout (little-endian): 8-byte magic `LFZVEC01`, uint32 dims,
 * uint32 count, `count` float32 scales, then `count * dims` int8 values.
 *
 * `LibraryVectorMatrix` holds the loaded shards as one contiguous int8 matrix
 * for a brute-force scoped dot-product search.
 */

import { fnv1a32 } from "../../utils/fnv1a";
import { joinLocalPath } from "../../utils/localPath";

export type QuantizedVector = { q: Int8Array; scale: number };

export type VectorSearchHit = {
  attachmentId: number;
  chunkIndex: number;
  score: number;
};

const MAGIC = new TextEncoder().encode("LFZVEC01");
const HEADER_BYTES = 16;
const VECTOR_DIR = "llm-for-zotero-index";

// ── Quantization ─────────────────────────────────────────────────────────────

export function quantizeVector(vector: number[]): QuantizedVector {
  let norm = 0;
  for (const x of vector) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  let max = 0;
  const unit = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i += 1) {
    unit[i] = vector[i] / norm;
    max = Math.max(max, Math.abs(unit[i]));
  }
  const scale = max / 127 || 1;
  const q = new Int8Array(vector.length);
  for (let i = 0; i < vector.length; i += 1) {
    q[i] = Math.max(-127, Math.min(127, Math.round(unit[i] / scale)));
  }
  return { q, scale };
}

/** Dot product of two quantized unit vectors; approximates their cosine. */
export function dotQuantized(a: QuantizedVector, b: QuantizedVector): number {
  let sum = 0;
  const n = Math.min(a.q.length, b.q.length);
  for (let i = 0; i < n; i += 1) sum += a.q[i] * b.q[i];
  return sum * a.scale * b.scale;
}

// ── Paths ────────────────────────────────────────────────────────────────────

export function vectorNamespace(cacheKey: string, dims: number): string {
  return `${cacheKey}:${dims}`;
}

export function namespaceHash(namespace: string): string {
  return fnv1a32(namespace);
}

function getBaseDir(): string {
  // Same resolution as getLibraryTextIndexDbPath: the vectors directory sits
  // next to the index database in the Zotero data directory.
  const dir = (globalThis as { Zotero?: { DataDirectory?: { dir?: string } } })
    .Zotero?.DataDirectory?.dir;
  if (typeof dir !== "string" || !dir.trim()) {
    throw new Error("Cannot resolve data directory for vector shards");
  }
  return dir.trim();
}

function getNamespaceDir(namespace: string): string {
  return joinLocalPath(
    getBaseDir(),
    VECTOR_DIR,
    "vectors",
    namespaceHash(namespace),
  );
}

export function getVectorShardPath(
  namespace: string,
  attachmentId: number,
): string {
  return joinLocalPath(getNamespaceDir(namespace), `${attachmentId}.bin`);
}

// ── Gecko I/O helpers (mirrors retrieval/embeddingCache.ts) ─────────────────

type IOUtilsLike = {
  exists?: (path: string) => Promise<boolean>;
  read?: (path: string) => Promise<Uint8Array | ArrayBuffer>;
  makeDirectory?: (
    path: string,
    options?: { createAncestors?: boolean; ignoreExisting?: boolean },
  ) => Promise<void>;
  write?: (path: string, data: Uint8Array) => Promise<unknown>;
  remove?: (
    path: string,
    options?: { recursive?: boolean; ignoreAbsent?: boolean },
  ) => Promise<void>;
  getChildren?: (path: string) => Promise<string[]>;
  stat?: (path: string) => Promise<{ size?: number; type?: string }>;
};

type OSFileLike = {
  exists?: (path: string) => Promise<boolean>;
  read?: (path: string) => Promise<Uint8Array | ArrayBuffer>;
  makeDir?: (
    path: string,
    options?: { from?: string; ignoreExisting?: boolean },
  ) => Promise<void>;
  writeAtomic?: (path: string, data: Uint8Array) => Promise<void>;
  removeDir?: (
    path: string,
    options?: { ignoreAbsent?: boolean; ignorePermissions?: boolean },
  ) => Promise<void>;
};

function getIOUtils(): IOUtilsLike | undefined {
  return (globalThis as unknown as { IOUtils?: IOUtilsLike }).IOUtils;
}

function getOSFile(): OSFileLike | undefined {
  return (globalThis as { OS?: { File?: OSFileLike } }).OS?.File;
}

async function ensureDir(path: string): Promise<void> {
  const io = getIOUtils();
  if (io?.makeDirectory) {
    await io.makeDirectory(path, {
      createAncestors: true,
      ignoreExisting: true,
    });
    return;
  }
  const osFile = getOSFile();
  if (osFile?.makeDir) {
    await osFile.makeDir(path, { ignoreExisting: true });
  }
}

async function readFileBytes(path: string): Promise<Uint8Array | null> {
  const io = getIOUtils();
  if (io?.read) {
    try {
      const data = await io.read(path);
      return data instanceof Uint8Array
        ? data
        : new Uint8Array(data as ArrayBuffer);
    } catch {
      return null;
    }
  }
  const osFile = getOSFile();
  if (osFile?.read) {
    try {
      const data = await osFile.read(path);
      return data instanceof Uint8Array
        ? data
        : new Uint8Array(data as ArrayBuffer);
    } catch {
      return null;
    }
  }
  return null;
}

async function writeFileBytes(path: string, bytes: Uint8Array): Promise<void> {
  const io = getIOUtils();
  if (io?.write) {
    await io.write(path, bytes);
    return;
  }
  const osFile = getOSFile();
  if (osFile?.writeAtomic) {
    await osFile.writeAtomic(path, bytes);
  }
}

async function pathExists(path: string): Promise<boolean> {
  const io = getIOUtils();
  if (io?.exists) return io.exists(path);
  const osFile = getOSFile();
  if (osFile?.exists) return osFile.exists(path);
  return false;
}

// ── Shard files ──────────────────────────────────────────────────────────────

export async function writeVectorShard(
  namespace: string,
  attachmentId: number,
  vectors: QuantizedVector[],
  dims: number,
): Promise<{ path: string; bytes: number }> {
  const count = vectors.length;
  const bytes = new Uint8Array(HEADER_BYTES + count * 4 + count * dims);
  const view = new DataView(bytes.buffer);
  bytes.set(MAGIC, 0);
  view.setUint32(8, dims, true);
  view.setUint32(12, count, true);
  let offset = HEADER_BYTES;
  for (const v of vectors) {
    view.setFloat32(offset, v.scale, true);
    offset += 4;
  }
  for (const v of vectors) {
    if (v.q.length !== dims) {
      throw new Error(
        `Vector has ${v.q.length} dimensions; the shard expects ${dims}`,
      );
    }
    bytes.set(new Uint8Array(v.q.buffer, v.q.byteOffset, dims), offset);
    offset += dims;
  }
  const path = getVectorShardPath(namespace, attachmentId);
  await ensureDir(getNamespaceDir(namespace));
  await writeFileBytes(path, bytes);
  return { path, bytes: bytes.length };
}

/** Reads a shard; returns null when it is missing, corrupt or truncated. */
export async function readVectorShard(
  path: string,
): Promise<{ dims: number; vectors: QuantizedVector[] } | null> {
  const bytes = await readFileBytes(path);
  if (!bytes || bytes.length < HEADER_BYTES) return null;
  for (let i = 0; i < MAGIC.length; i += 1) {
    if (bytes[i] !== MAGIC[i]) return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dims = view.getUint32(8, true);
  const count = view.getUint32(12, true);
  if (bytes.length !== HEADER_BYTES + count * 4 + count * dims) return null;
  const vectors: QuantizedVector[] = [];
  let scaleOffset = HEADER_BYTES;
  let dataOffset = HEADER_BYTES + count * 4;
  for (let i = 0; i < count; i += 1) {
    const scale = view.getFloat32(scaleOffset, true);
    scaleOffset += 4;
    vectors.push({
      q: new Int8Array(bytes.slice(dataOffset, dataOffset + dims).buffer),
      scale,
    });
    dataOffset += dims;
  }
  return { dims, vectors };
}

export async function removeVectorNamespace(namespace: string): Promise<void> {
  const dir = getNamespaceDir(namespace);
  const io = getIOUtils();
  if (io?.remove) {
    await io.remove(dir, { recursive: true, ignoreAbsent: true });
    return;
  }
  const osFile = getOSFile();
  if (osFile?.removeDir) {
    await osFile.removeDir(dir, { ignoreAbsent: true });
  }
}

/** Total bytes of the shard files in one namespace directory. */
export async function measureVectorBytes(namespace: string): Promise<number> {
  const io = getIOUtils();
  if (!io?.getChildren) return 0;
  const dir = getNamespaceDir(namespace);
  if (!(await pathExists(dir))) return 0;
  let total = 0;
  for (const child of await io.getChildren(dir)) {
    if (io.stat) {
      total += Number((await io.stat(child)).size || 0);
    } else {
      total += (await readFileBytes(child))?.length ?? 0;
    }
  }
  return total;
}

// ── In-memory matrix ─────────────────────────────────────────────────────────

export class LibraryVectorMatrix {
  private data = new Int8Array(0);
  private scales = new Float32Array(0);
  private owner: number[] = []; // attachmentId per row
  private chunk: number[] = []; // chunkIndex per row
  private rowsByDoc = new Map<number, number[]>();

  constructor(readonly dims: number) {}

  get rows(): number {
    return this.owner.length;
  }

  has(attachmentId: number): boolean {
    return this.rowsByDoc.has(attachmentId);
  }

  /** Rows map to (attachmentId, chunkIndex = position in `vectors`). */
  addDocument(attachmentId: number, vectors: QuantizedVector[]): void {
    if (this.has(attachmentId)) this.removeDocument(attachmentId);
    const start = this.rows;
    const next = new Int8Array((start + vectors.length) * this.dims);
    next.set(this.data, 0);
    const nextScales = new Float32Array(start + vectors.length);
    nextScales.set(this.scales, 0);
    vectors.forEach((v, i) => {
      next.set(v.q.subarray(0, this.dims), (start + i) * this.dims);
      nextScales[start + i] = v.scale;
      this.owner.push(attachmentId);
      this.chunk.push(i);
    });
    this.data = next;
    this.scales = nextScales;
    this.rowsByDoc.set(
      attachmentId,
      vectors.map((_, i) => start + i),
    );
  }

  /** O(rows); runs on deletes and re-indexes only, never on the query path. */
  removeDocument(attachmentId: number): void {
    const keep: number[] = [];
    for (let r = 0; r < this.rows; r += 1) {
      if (this.owner[r] !== attachmentId) keep.push(r);
    }
    const next = new Int8Array(keep.length * this.dims);
    const nextScales = new Float32Array(keep.length);
    const owner: number[] = [];
    const chunk: number[] = [];
    keep.forEach((r, i) => {
      next.set(
        this.data.subarray(r * this.dims, (r + 1) * this.dims),
        i * this.dims,
      );
      nextScales[i] = this.scales[r];
      owner.push(this.owner[r]);
      chunk.push(this.chunk[r]);
    });
    this.data = next;
    this.scales = nextScales;
    this.owner = owner;
    this.chunk = chunk;
    this.rowsByDoc = new Map();
    owner.forEach((id, r) => {
      const rows = this.rowsByDoc.get(id) || [];
      rows.push(r);
      this.rowsByDoc.set(id, rows);
    });
  }

  search(
    query: QuantizedVector,
    scope: ReadonlySet<number>,
    topK: number,
  ): VectorSearchHit[] {
    const hits: VectorSearchHit[] = [];
    const n = Math.min(this.dims, query.q.length);
    for (let r = 0; r < this.rows; r += 1) {
      if (!scope.has(this.owner[r])) continue;
      let sum = 0;
      const base = r * this.dims;
      for (let i = 0; i < n; i += 1) sum += this.data[base + i] * query.q[i];
      hits.push({
        attachmentId: this.owner[r],
        chunkIndex: this.chunk[r],
        score: sum * this.scales[r] * query.scale,
      });
    }
    hits.sort(
      (a, b) =>
        b.score - a.score ||
        a.attachmentId - b.attachmentId ||
        a.chunkIndex - b.chunkIndex,
    );
    return hits.slice(0, Math.max(1, topK));
  }
}
