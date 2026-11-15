/** In-process invalidation only; the durable outbox remains authoritative. */
const listeners = new Map<string, Set<() => void>>();

export function subscribeDocumentPublication(
  documentId: string,
  listener: () => void,
): () => void {
  const subscribers = listeners.get(documentId) || new Set<() => void>();
  subscribers.add(listener);
  listeners.set(documentId, subscribers);
  return () => {
    subscribers.delete(listener);
    if (!subscribers.size) listeners.delete(documentId);
  };
}

export function notifyDocumentPublication(documentId: string): void {
  for (const listener of listeners.get(documentId) || []) {
    try {
      listener();
    } catch (error) {
      Zotero.logError(error as Error);
    }
  }
}
