import { unzipSync, zipSync } from "fflate";
import { joinLocalPath } from "../../utils/localPath";
import {
  buildMineruPageRanges,
  validateMineruChunk,
  type MineruChunk,
  type MineruPageRange,
} from "../../utils/mineruChunking";

export type MineruProgress = {
  completedPages: number;
  totalPages: number;
  completedChunks: number;
  totalChunks: number;
};
type SavedChunk = { index: number; hash: string };
type Checkpoint = {
  version: 1;
  identity: string;
  pageCount: number;
  chunks: SavedChunk[];
};
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function hashMineruBytes(bytes: Uint8Array): Promise<string> {
  const crypto =
    (globalThis as { crypto?: Crypto }).crypto ||
    (Zotero.getMainWindow() as unknown as Window).crypto;
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(bytes).buffer,
  );
  return Array.from(new Uint8Array(hash), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

export function getMineruCheckpointDir(attachmentId: number): string {
  if (!Number.isSafeInteger(attachmentId) || attachmentId <= 0)
    throw new Error("Invalid MinerU attachment ID");
  return joinLocalPath(getMineruCheckpointRoot(), String(attachmentId));
}
export function getMineruCheckpointRoot(): string {
  const base =
    (Zotero as any).DataDirectory?.dir || (Zotero as any).Profile?.dir;
  if (!base) throw new Error("Cannot resolve MinerU checkpoint directory");
  return joinLocalPath(base, "llm-for-zotero-mineru-progress");
}

function io() {
  return (globalThis as any).IOUtils;
}
function indexPath(root: string) {
  return joinLocalPath(root, "checkpoint.json");
}
function chunkPath(root: string, index: number) {
  return joinLocalPath(root, `chunk-${index + 1}.zip`);
}
async function readIndex(root: string): Promise<Checkpoint | null> {
  try {
    const value = JSON.parse(
      decoder.decode(await io().read(indexPath(root))),
    ) as Checkpoint;
    if (
      value.version !== 1 ||
      !/^[a-f0-9]{64}$/.test(value.identity) ||
      !Number.isSafeInteger(value.pageCount) ||
      value.pageCount <= 0 ||
      !Array.isArray(value.chunks)
    )
      return null;
    const total = buildMineruPageRanges(value.pageCount).length;
    const seen = new Set<number>();
    for (const chunk of value.chunks) {
      if (
        !Number.isInteger(chunk.index) ||
        chunk.index < 0 ||
        chunk.index >= total ||
        seen.has(chunk.index) ||
        !/^[a-f0-9]{64}$/.test(chunk.hash)
      )
        return null;
      seen.add(chunk.index);
    }
    return value;
  } catch {
    return null;
  }
}
async function writeIndex(root: string, value: Checkpoint) {
  const path = indexPath(root);
  await io().write(path, encoder.encode(JSON.stringify(value)), {
    tmpPath: `${path}.tmp`,
    flush: true,
  });
}
function progress(value: Checkpoint): MineruProgress {
  const ranges = buildMineruPageRanges(value.pageCount);
  return {
    totalPages: value.pageCount,
    totalChunks: ranges.length,
    completedChunks: value.chunks.length,
    completedPages: value.chunks.reduce(
      (sum, c) => sum + ranges[c.index].endPage - ranges[c.index].startPage + 1,
      0,
    ),
  };
}
export async function getMineruCheckpointProgress(
  attachmentId: number,
): Promise<MineruProgress | null> {
  try {
    const value = await readIndex(getMineruCheckpointDir(attachmentId));
    return value?.chunks.length ? progress(value) : null;
  } catch {
    return null;
  }
}
export async function deleteMineruCheckpoint(
  attachmentId: number,
): Promise<void> {
  await io().remove(getMineruCheckpointDir(attachmentId), {
    recursive: true,
    ignoreAbsent: true,
  });
}

/** Each archive is durable before its atomic index entry becomes visible. */
export async function openMineruCheckpoint(
  attachmentId: number,
  identity: string,
  pageCount: number,
) {
  const root = getMineruCheckpointDir(attachmentId);
  let value = await readIndex(root);
  if (!value || value.identity !== identity || value.pageCount !== pageCount) {
    await io().remove(root, { recursive: true, ignoreAbsent: true });
    await io().makeDirectory(root, {
      createAncestors: true,
      ignoreExisting: true,
    });
    value = { version: 1, identity, pageCount, chunks: [] };
    await writeIndex(root, value);
  }
  const checkpoint = value;
  return {
    progress: () => progress(checkpoint),
    async read(range: MineruPageRange): Promise<MineruChunk | null> {
      const record = checkpoint.chunks.find((c) => c.index === range.index);
      if (!record) return null;
      try {
        const bytes = new Uint8Array(
          await io().read(chunkPath(root, range.index)),
        );
        if ((await hashMineruBytes(bytes)) !== record.hash)
          throw new Error("Checkpoint checksum mismatch");
        const archive = unzipSync(bytes);
        const metadata = JSON.parse(decoder.decode(archive["result.json"]));
        const chunk: MineruChunk = {
          range,
          result: {
            mdContent: metadata.mdContent,
            files: metadata.paths.map((relativePath: string, i: number) => ({
              relativePath,
              data: archive[`files/${i}`],
            })),
          },
        };
        validateMineruChunk(chunk);
        return chunk;
      } catch {
        checkpoint.chunks = checkpoint.chunks.filter(
          (c) => c.index !== range.index,
        );
        await writeIndex(root, checkpoint);
        return null;
      }
    },
    async save(chunk: MineruChunk): Promise<void> {
      validateMineruChunk(chunk);
      const archive: Record<string, Uint8Array> = {
        "result.json": encoder.encode(
          JSON.stringify({
            mdContent: chunk.result.mdContent,
            paths: chunk.result.files.map((f) => f.relativePath),
          }),
        ),
      };
      chunk.result.files.forEach((file, i) => {
        archive[`files/${i}`] = file.data;
      });
      const bytes = zipSync(archive);
      const path = chunkPath(root, chunk.range.index);
      await io().write(path, bytes, { tmpPath: `${path}.tmp`, flush: true });
      const hash = await hashMineruBytes(bytes);
      if (
        (await hashMineruBytes(new Uint8Array(await io().read(path)))) !== hash
      )
        throw new Error("MinerU checkpoint write verification failed");
      const chunks = checkpoint.chunks.filter(
        (c) => c.index !== chunk.range.index,
      );
      chunks.push({ index: chunk.range.index, hash });
      chunks.sort((a, b) => a.index - b.index);
      await writeIndex(root, { ...checkpoint, chunks });
      // Progress describes the durable index, not an index write that failed.
      checkpoint.chunks = chunks;
    },
  };
}
