/**
 * The one owner of extracted paper text held in memory.
 *
 * Backed by the existing `pdfTextCache` and `pdfTextLoadingTasks` instances,
 * so code (and tests) that seed those maps directly keep working. Extraction
 * itself stays in `pdfContext.ts`: `load` and `loadNote` take the extractor,
 * which fills the entry through its load-owned writer.
 *
 * Reading and dropping text have distinct rules, so each rule is its own
 * named operation:
 * - `peek` reads whatever is cached and ignores source mode.
 * - `invalidate` is the full clean-up after the text changed.
 * - `invalidateMineruRuntimeText` is the MinerU clean-up, which never queues
 *   a re-index.
 * - `discardEmptyEntry` drops an entry without text so it can be retried.
 * - `borrow` lets a caller evict only what it loaded itself.
 */
import { appLogger } from "../../core/logging";
import type { PaperContentSourceMode } from "../../shared/types";
import { invalidateRetrievalCandidates } from "../retrieval/cacheInvalidation";
import { clearEmbeddingCache } from "../retrieval/embeddingCache";
import type { TextAttachmentSourceMode } from "./contextAttachmentTypes";
import {
  notifyPdfContextLoaded,
  pdfTextCache,
  pdfTextLoadingTasks,
} from "./contextCache";
import type { PdfContext } from "./types";

export type PaperTextLoadOptions = {
  sourceMode?: PaperContentSourceMode;
  preferFulltextCache?: boolean;
  /** Background index loads: fill the cache without firing the write-through hook. */
  silentLoad?: boolean;
  /** Explicit borrow owner; silence alone does not grant eviction rights. */
  borrowedBy?: () => void;
};

/** A load-owned writer ignores results after its task was invalidated. */
export type PaperTextWriter = (context: PdfContext) => void;

/** Extracts one item's text and commits it through the supplied writer. */
export type PaperTextExtractor = (
  item: Zotero.Item,
  options: PaperTextLoadOptions | undefined,
  write: PaperTextWriter,
) => Promise<void>;

export function sourceTypeForTextAttachment(
  mode: TextAttachmentSourceMode,
): PdfContext["sourceType"] {
  return `attachment-${mode}` as PdfContext["sourceType"];
}

let cacheGeneration = 0;

type TextBorrow = {
  itemId: number;
  generation: number;
  released: boolean;
  loads: Set<TextLoadOwner>;
};

type TextLoadOwner = {
  itemId: number;
  generation: number;
  borrowers: Set<TextBorrow>;
  adopted: boolean;
  context?: PdfContext;
};

// Weak keys follow the existing task and cache-object lifetime, not item IDs.
const borrows = new WeakMap<() => void, TextBorrow>();
const taskOwners = new WeakMap<Promise<void>, TextLoadOwner>();
const entryOwners = new WeakMap<PdfContext, TextLoadOwner>();
// External adoption can precede the first load-owned publication of an object.
const adoptedContexts = new WeakSet<PdfContext>();

function useLoad(owner: TextLoadOwner | undefined, borrow?: TextBorrow): void {
  if (!owner) return; // An externally seeded entry is never borrow-owned.
  if (borrow) {
    owner.borrowers.add(borrow);
    borrow.loads.add(owner);
  } else {
    owner.adopted = true;
  }
}

function releaseUnusedText(owner: TextLoadOwner): void {
  const context = owner.context;
  if (
    !owner.adopted &&
    owner.borrowers.size === 0 &&
    owner.generation === cacheGeneration &&
    context &&
    entryOwners.get(context) === owner &&
    pdfTextCache.get(owner.itemId) === context
  ) {
    pdfTextCache.delete(owner.itemId);
  }
}

function cachedContextMatchesSourceMode(
  cached: PdfContext,
  sourceMode?: PaperContentSourceMode,
): boolean {
  if (!sourceMode) return true;
  if (sourceMode === "pdf") return true;
  if (sourceMode === "mineru") return cached.sourceType === "mineru";
  if (sourceMode === "text") return cached.sourceType !== "mineru";
  if (
    sourceMode === "markdown" ||
    sourceMode === "html" ||
    sourceMode === "txt" ||
    sourceMode === "docx"
  ) {
    return cached.sourceType === sourceTypeForTextAttachment(sourceMode);
  }
  return true;
}

function entryText(itemId: number): string {
  const cached = pdfTextCache.get(itemId);
  return Array.isArray(cached?.chunks) ? cached.chunks.join("\n\n") : "";
}

/**
 * Drops an entry another source mode produced. The reload changes the chunks,
 * so the retrieval candidates built from the old chunks go too. The on-disk
 * embeddings stay: their chunk-hash check invalidates them when the chunks
 * really changed. The in-progress load (if any) is left for its waiters.
 */
function dropMismatchedEntry(itemId: number): void {
  pdfTextCache.delete(itemId);
  invalidateRetrievalCandidates(itemId);
}

async function load(
  item: Zotero.Item,
  options: PaperTextLoadOptions | undefined,
  extract: PaperTextExtractor,
): Promise<void> {
  while (true) {
    const borrowToken = options?.borrowedBy;
    const borrow = borrowToken ? borrows.get(borrowToken) : undefined;
    if (borrowToken !== undefined) {
      // A cleared generation still rejects, even if its borrower also released.
      if (borrow && borrow.generation !== cacheGeneration) {
        throw new Error(`Paper text load cleared for item ${item.id}`);
      }
      // A released/invalid background caller is not a foreground adopter. This
      // also stops a woken joiner or invalidated task from starting a new load.
      if (!borrow || borrow.released || borrow.itemId !== item.id) return;
    }
    const cached = pdfTextCache.get(item.id);
    if (cached && cachedContextMatchesSourceMode(cached, options?.sourceMode)) {
      useLoad(entryOwners.get(cached), borrow);
      return;
    }
    const existingTask = pdfTextLoadingTasks.get(item.id);
    if (existingTask) {
      // Adopt before awaiting: a foreground waiter can join a silent index load.
      useLoad(taskOwners.get(existingTask), borrow);
      await existingTask;
      // Another waiter may already have started the next source-mode load.
      continue;
    }
    if (cached) dropMismatchedEntry(item.id);

    // Defer extraction until ownership is installed, including synchronous
    // extractors. Invalidation revokes this writer without cancelling its I/O.
    const generation = cacheGeneration;
    const owner: TextLoadOwner = {
      itemId: item.id,
      generation,
      borrowers: new Set(),
      adopted: false,
    };
    useLoad(owner, borrow);
    const task: Promise<void> = Promise.resolve().then(async () => {
      try {
        await extract(item, options, (context) => {
          if (pdfTextLoadingTasks.get(item.id) === task) {
            // A shared object that was already adopted must stay adopted.
            const previousOwner = entryOwners.get(context);
            if (previousOwner?.adopted || adoptedContexts.has(context)) {
              owner.adopted = true;
            }
            owner.context = context;
            entryOwners.set(context, owner);
            pdfTextCache.set(item.id, context);
          }
        });
        if (pdfTextLoadingTasks.get(item.id) !== task) {
          if (generation !== cacheGeneration) {
            throw new Error(`Paper text load cleared for item ${item.id}`);
          }
          // A MinerU restore can invalidate its own extraction. Reload from
          // the fresh source (or join its new owner), never publish old text.
          return load(item, options, extract);
        }
        const loaded = pdfTextCache.get(item.id);
        if (loaded && loaded.chunks.length && !options?.silentLoad) {
          notifyPdfContextLoaded(item.id);
        }
      } finally {
        if (pdfTextLoadingTasks.get(item.id) === task) {
          pdfTextLoadingTasks.delete(item.id);
        }
        releaseUnusedText(owner);
      }
    });
    taskOwners.set(task, owner);
    pdfTextLoadingTasks.set(item.id, task);
    return task;
  }
}

async function loadNote(
  item: Zotero.Item,
  extract: (item: Zotero.Item, write: PaperTextWriter) => Promise<void>,
): Promise<void> {
  return load(item, { silentLoad: true }, (note, _options, write) =>
    extract(note, write),
  );
}

function invalidate(itemId: number): void {
  if (!Number.isFinite(itemId) || itemId <= 0) return;
  const normalizedItemId = Math.floor(itemId);
  pdfTextCache.delete(normalizedItemId);
  pdfTextLoadingTasks.delete(normalizedItemId);
  // Cached candidates carry stale chunk text and scores after a MinerU refresh.
  invalidateRetrievalCandidates(normalizedItemId);
  // Re-index the new text. Lazy import: indexer.ts imports this module.
  void import("../libraryTextIndex/scheduler")
    .then(({ libraryTextIndexScheduler }) =>
      libraryTextIndexScheduler.enqueue([normalizedItemId], "textInvalidated"),
    )
    .catch((error) =>
      appLogger.debug("LLM index: re-index enqueue failed", error),
    );
  // Clear embedding cache — chunks will change when MinerU content is refreshed,
  // so cached embeddings are stale. Do NOT delete MinerU files themselves:
  // this is called right after writeMineruCacheFiles(), so deleting the
  // MinerU directory would destroy the freshly written content.
  void clearEmbeddingCache(normalizedItemId).catch((error) => {
    appLogger.warn("Embedding cache invalidation failed:", error);
  });
}

function invalidateMineruRuntimeText(attachmentId: number): void {
  pdfTextCache.delete(attachmentId);
  pdfTextLoadingTasks.delete(attachmentId);
  invalidateRetrievalCandidates(attachmentId);
  void clearEmbeddingCache(attachmentId).catch(() => {});
}

function discardEmptyEntry(itemId: number): void {
  if (!entryText(itemId).trim() && pdfTextCache.has(itemId)) {
    pdfTextCache.delete(itemId);
  }
}

function borrow(itemId: number): () => void {
  const state: TextBorrow = {
    itemId,
    generation: cacheGeneration,
    released: false,
    loads: new Set(),
  };
  const release = () => {
    if (state.released) return;
    state.released = true;
    for (const owner of state.loads) {
      owner.borrowers.delete(state);
      releaseUnusedText(owner);
    }
    state.loads.clear();
  };
  borrows.set(release, state);
  return release;
}

export const paperTextStore = {
  /** The cached entry, whatever source mode produced it. */
  peek(itemId: number): PdfContext | undefined {
    return pdfTextCache.get(itemId);
  },
  has(itemId: number): boolean {
    return pdfTextCache.has(itemId);
  },
  /** True when text is cached or a load for it is in progress. */
  isCachedOrLoading(itemId: number): boolean {
    return pdfTextCache.has(itemId) || pdfTextLoadingTasks.has(itemId);
  },
  /** Direct seeding; asynchronous extractors use their load-owned writer. */
  write(itemId: number, context: PdfContext): void {
    adoptedContexts.add(context);
    useLoad(entryOwners.get(context));
    pdfTextCache.set(itemId, context);
  },
  forEach(fn: (context: PdfContext, itemId: number) => void): void {
    pdfTextCache.forEach(fn);
  },
  /**
   * Ensures text for `item` is cached. A cached entry is reused only when it
   * matches `options.sourceMode`; a mismatched one is dropped and reloaded.
   * Concurrent callers share one in-progress load. Listeners hear only a
   * fresh, non-silent load that produced chunks.
   */
  load,
  /** Ensures note text is cached. Any cached entry is reused as is. */
  loadNote,
  /**
   * Full clean-up after an item's text changed: the entry, its in-progress
   * load, retrieval candidates, and the embedding cache, then a re-index.
   * Ignores ids that are not positive numbers and floors the rest.
   */
  invalidate,
  /**
   * MinerU runtime clean-up: the same steps as `invalidate` except that it
   * never queues a re-index.
   */
  invalidateMineruRuntimeText,
  /**
   * Drops an entry whose chunks hold no text, so the next load retries the
   * extraction. Leaves the in-progress load and every other cache alone.
   */
  discardEmptyEntry,
  /**
   * Pass the returned release as load's `borrowedBy` option. Release is
   * idempotent and evicts only that load's exact object, after its last
   * borrower leaves, unless a non-borrowed load or write adopted it.
   */
  borrow,
  /** Drops every entry and every in-progress load (plugin shutdown). */
  clear(): void {
    cacheGeneration += 1;
    pdfTextCache.clear();
    pdfTextLoadingTasks.clear();
  },
};
