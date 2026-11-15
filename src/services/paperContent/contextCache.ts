import { TTLMap } from "../../utils/ttlMap";
import type { PdfContext } from "./types";

// Sized above multi-paper retrieval caps so a folder or tag synthesis does not
// evict source text while its evidence pack is still being assembled.
export const pdfTextCache = new TTLMap<number, PdfContext>(30 * 60 * 1000, 100);
export const pdfTextLoadingTasks = new Map<number, Promise<void>>();

/**
 * Fired after `ensurePDFTextCached` finishes a fresh load (never on a cache
 * hit). Listeners run synchronously and must only schedule work: the library
 * text index write-through enqueues here and never runs store SQL inline.
 */
export type PdfContextLoadedListener = (itemId: number) => void;
const pdfContextLoadedListeners = new Set<PdfContextLoadedListener>();

export function onPdfContextLoaded(
  listener: PdfContextLoadedListener,
): () => void {
  pdfContextLoadedListeners.add(listener);
  return () => {
    pdfContextLoadedListeners.delete(listener);
  };
}

export function notifyPdfContextLoaded(itemId: number): void {
  for (const listener of pdfContextLoadedListeners) {
    try {
      listener(itemId);
    } catch {
      // A listener bug must never break extraction.
    }
  }
}
