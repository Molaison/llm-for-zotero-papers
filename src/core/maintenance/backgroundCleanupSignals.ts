type BackgroundCleanupListener = () => void;

const listeners = new Set<BackgroundCleanupListener>();

/**
 * Signal that attachment and trace files may now be collectible. The signal
 * is process-local and intentionally carries no state: durable attachment and
 * trace tables remain the authoritative crash-recovery record.
 */
export function notifyBackgroundCleanupNeeded(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // A maintenance observer must not break the transaction's caller.
    }
  }
}

export function onBackgroundCleanupNeeded(
  listener: BackgroundCleanupListener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
