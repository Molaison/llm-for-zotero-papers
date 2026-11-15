import { appLogger } from "../../core/logging";
import {
  writeMineruCacheFiles,
  writeMineruSourceProvenanceForAttachment,
} from "./mineruCache";
import {
  parsePdfWithMineruSingle,
  getMineruParseSettings,
  MineruCancelledError,
  MineruRateLimitError,
  MineruPageLimitError,
  type MinerUResult,
  type MinerUProgressCallback,
} from "../../utils/mineruClient";
import {
  openPdfSplitter,
  PdfSplitterCancelledError,
} from "../../utils/pdfSplitter";
import {
  buildMineruPageRanges,
  mergeMineruChunkResults,
  MINERU_PAGE_CHUNK_SIZE,
  type MineruChunk,
} from "../../utils/mineruChunking";
import {
  openMineruCheckpoint,
  hashMineruBytes,
  deleteMineruCheckpoint,
} from "./mineruCheckpoint";
function getIOUtils(): any {
  return (globalThis as any).IOUtils;
}
function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new MineruCancelledError();
}
async function readPdfBytes(path: string): Promise<Uint8Array> {
  return new Uint8Array(await getIOUtils().read(path));
}
function getPathJoiner(): (...parts: string[]) => string {
  const pathUtils = (
    globalThis as {
      PathUtils?: { join?: (...parts: string[]) => string };
    }
  ).PathUtils;
  if (pathUtils?.join) return pathUtils.join;
  return (...parts: string[]) => parts.join("/").replace(/\/+/g, "/");
}

function getMineruTempDirectoryPath(): string | null {
  const tempDirectory = (Zotero as any).getTempDirectory?.()?.path;
  return typeof tempDirectory === "string" && tempDirectory.trim()
    ? tempDirectory.trim()
    : null;
}

async function createMineruChunkDirectory(): Promise<string> {
  const io = getIOUtils();
  if (!io?.makeDirectory) {
    throw new Error("Zotero IOUtils.makeDirectory is unavailable");
  }
  const tempDirectory = getMineruTempDirectoryPath();
  if (!tempDirectory) throw new Error("Zotero temp directory is unavailable");
  const join = getPathJoiner();
  const chunkDirectory = join(
    tempDirectory,
    `mineru-chunks-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await io.makeDirectory(chunkDirectory, {
    createAncestors: true,
    ignoreExisting: false,
  });
  return chunkDirectory;
}

async function cleanupMineruChunkDirectory(path: string): Promise<void> {
  try {
    await getIOUtils()?.remove?.(path, {
      recursive: true,
      ignoreAbsent: true,
    });
  } catch (error) {
    appLogger.warn("MinerU: failed to clean temporary chunk directory", error);
  }
}

export async function parsePdfWithMineru(
  pdfPath: string,
  onProgress?: MinerUProgressCallback,
  signal?: AbortSignal,
  options: { maxPages?: number; attachmentId?: number } = {},
): Promise<MinerUResult> {
  const report = (stage: string) => {
    appLogger.debug(`MinerU: ${stage}`);
    onProgress?.(stage);
  };

  try {
    throwIfAborted(signal);
    const settings = getMineruParseSettings();
    const pdfBytes = await readPdfBytes(pdfPath);
    if (!pdfBytes) throw new Error("Unable to read the PDF file.");
    report("Reading PDF page count…");
    const splitter = await openPdfSplitter(pdfBytes, signal);
    try {
      const pageCount = splitter.pageCount;
      if (
        options.maxPages &&
        options.maxPages > 0 &&
        pageCount > options.maxPages
      ) {
        throw new MineruPageLimitError(pageCount, options.maxPages);
      }
      const sourceHash = options.attachmentId
        ? await hashMineruBytes(pdfBytes)
        : undefined;

      const checkpoint = options.attachmentId
        ? await openMineruCheckpoint(
            options.attachmentId,
            await hashMineruBytes(
              new TextEncoder().encode(
                JSON.stringify({
                  source: sourceHash,
                  settings,
                  chunkSize: MINERU_PAGE_CHUNK_SIZE,
                  version: 1,
                }),
              ),
            ),
            pageCount,
          )
        : null;
      if (pageCount <= MINERU_PAGE_CHUNK_SIZE) {
        splitter.close();
        const result = await parsePdfWithMineruSingle(
          pdfPath,
          onProgress,
          signal,
          settings,
        );
        if (result?.pageCount !== undefined && result.pageCount !== pageCount)
          throw new Error("MinerU returned an incomplete PDF result");
        return result ? { ...result, pageCount, sourceHash } : null;
      }

      const ranges = buildMineruPageRanges(pageCount);
      const chunkDirectory = await createMineruChunkDirectory();
      const chunks: MineruChunk[] = [];
      const join = getPathJoiner();
      try {
        const io = getIOUtils();
        if (!io?.write) throw new Error("Zotero IOUtils.write is unavailable");
        for (const range of ranges) {
          throwIfAborted(signal);
          const saved = await checkpoint?.read(range);
          if (saved) {
            chunks.push(saved);
            report(
              `Restored MinerU chunk ${range.index + 1}/${ranges.length}: pages ${range.startPage}-${range.endPage}`,
            );
            continue;
          }
          const partName = `part-${String(range.index + 1).padStart(3, "0")}.pdf`;
          const partPath = join(chunkDirectory, partName);
          report(
            `Splitting PDF for MinerU: pages ${range.startPage}-${range.endPage} of ${pageCount}`,
          );
          const partBytes = await splitter.extractPages(
            range.startPage,
            range.endPage,
          );
          throwIfAborted(signal);
          await io.write(partPath, partBytes);
          report(
            `Uploading MinerU chunk ${range.index + 1}/${ranges.length}: pages ${range.startPage}-${range.endPage}`,
          );
          const chunkLabel = `MinerU chunk ${range.index + 1}/${ranges.length} (pages ${range.startPage}-${range.endPage})`;
          const result = await parsePdfWithMineruSingle(
            partPath,
            (stage) => report(`${chunkLabel}: ${stage}`),
            signal,
            settings,
          );
          if (!result) return null;
          if (
            result.pageCount !== undefined &&
            result.pageCount !== range.endPage - range.startPage + 1
          )
            throw new Error("MinerU returned an incomplete PDF chunk");
          const chunk = { range, result };
          await checkpoint?.save(chunk);
          chunks.push(chunk);
          report(
            `Saved MinerU checkpoint: ${checkpoint?.progress().completedPages ?? range.endPage}/${pageCount} pages`,
          );
          throwIfAborted(signal);
        }
        report(`Merging ${chunks.length} MinerU chunks in page order…`);
        throwIfAborted(signal);
        return { ...mergeMineruChunkResults(chunks), pageCount, sourceHash };
      } finally {
        await cleanupMineruChunkDirectory(chunkDirectory);
      }
    } finally {
      splitter.close();
    }
  } catch (error) {
    if (error instanceof PdfSplitterCancelledError)
      throw new MineruCancelledError();
    if (
      error instanceof MineruCancelledError ||
      error instanceof MineruRateLimitError ||
      error instanceof MineruPageLimitError
    ) {
      throw error;
    }
    report(`Error: ${(error as Error).message}`);
    return null;
  }
}

/** Publish only complete, verified output; keep checkpoints if any write fails. */
export async function publishMineruParsedResult(
  attachment: Zotero.Item,
  result: NonNullable<MinerUResult>,
  signal?: AbortSignal,
): Promise<void> {
  const validateSource = async () => {
    throwIfAborted(signal);
    const live = Zotero.Items.get(attachment.id);
    if (!live || live.deleted || live.key !== attachment.key)
      throw new MineruCancelledError();
    if (result.sourceHash) {
      const path = await attachment.getFilePathAsync();
      if (
        !path ||
        (await hashMineruBytes(await readPdfBytes(path))) !== result.sourceHash
      )
        throw new Error(
          "PDF changed while MinerU was processing it. Resume to parse the updated file.",
        );
    }
  };
  await validateSource();
  await writeMineruCacheFiles(attachment.id, result.mdContent, result.files, {
    pageCount: result.pageCount,
    signal,
    beforeCommit: async () => {
      await validateSource();
      await writeMineruSourceProvenanceForAttachment(attachment);
    },
  });
  try {
    await deleteMineruCheckpoint(attachment.id);
  } catch (error) {
    appLogger.debug(
      "MinerU: completed cache is available; checkpoint cleanup failed",
      error,
    );
  }
}
