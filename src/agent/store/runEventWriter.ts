import type { AgentEvent } from "../types";

/** One run event row, as the trace store inserts it. */
export type RunEventRow = { seq: number; event: AgentEvent; createdAt: number };

/**
 * What the batches settled since the last report did: how many rows were
 * written, and which rows were lost with a failed batch.
 */
export type RunEventFlushReport = {
  written: number;
  failed: Array<{ seq: number; type: AgentEvent["type"] }>;
};

export type RunEventWriter = {
  /** Buffers the row for a later write. Never throws, never awaits. */
  enqueue(row: RunEventRow): void;
  /**
   * Writes everything buffered; resolves once it and every earlier batch is
   * settled, with what the batches settled since the last report did.
   */
  flush(): Promise<RunEventFlushReport>;
  /** A final flush, after which `enqueue` is a no-op. */
  close(): Promise<RunEventFlushReport>;
};

const DEFAULT_FLUSH_INTERVAL_MS = 250;
const DEFAULT_MAX_BUFFERED = 64;
/** Failures a run logs; later ones are still announced to `onBatchFailed`. */
const MAX_REPORTED_FAILURES = 5;

/**
 * Takes a run's event rows off the stream's critical path.
 *
 * Rows wait in a buffer until a timer (`flushIntervalMs` after the first
 * buffered row), the size cap (`maxBuffered` rows) or an explicit `flush`
 * writes them. Batches are written one at a time on a single promise chain,
 * so rows reach the store in the order they were enqueued; a crash loses at
 * most the rows still buffered. A failed batch is dropped and later batches
 * still go through. Every failed batch is announced to `onBatchFailed` with
 * its rows and named in the next flush report; `onError` logs the first five
 * failures of a run, so a locked database cannot flood the log.
 */
export function createRunEventWriter(params: {
  persist: (rows: readonly RunEventRow[]) => Promise<void>;
  flushIntervalMs?: number;
  maxBuffered?: number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  onError: (error: unknown) => void;
  /** A batch that failed, with its rows; called before its flush resolves. */
  onBatchFailed?: (rows: readonly RunEventRow[], error: unknown) => void;
}): RunEventWriter {
  const flushIntervalMs = params.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const maxBuffered = Math.max(1, params.maxBuffered ?? DEFAULT_MAX_BUFFERED);
  let buffer: RunEventRow[] = [];
  let timer: unknown = undefined;
  let timerArmed = false;
  let closed = false;
  let reported = 0;
  let draining: Promise<void> = Promise.resolve();
  let report: RunEventFlushReport = { written: 0, failed: [] };

  const disarm = () => {
    if (!timerArmed) return;
    timerArmed = false;
    try {
      params.clearTimeout(timer);
    } catch {
      // A timer that cannot be cleared fires into an empty buffer.
    }
    timer = undefined;
  };

  const logError = (error: unknown) => {
    if (reported >= MAX_REPORTED_FAILURES) return;
    reported += 1;
    try {
      params.onError(error);
    } catch {
      // Reporting is best effort.
    }
  };

  const takeReport = (): RunEventFlushReport => {
    const taken = report;
    report = { written: 0, failed: [] };
    return taken;
  };

  /** Moves the buffer onto the write chain; returns the chain's tail. */
  const drain = (): Promise<void> => {
    disarm();
    if (buffer.length) {
      const rows = buffer;
      buffer = [];
      draining = draining.then(async () => {
        try {
          await params.persist(rows);
          report.written += rows.length;
        } catch (error) {
          report.failed.push(
            ...rows.map((row) => ({ seq: row.seq, type: row.event.type })),
          );
          logError(error);
          try {
            params.onBatchFailed?.(rows, error);
          } catch {
            // The owner's bookkeeping must not break the write chain.
          }
        }
      });
    }
    return draining;
  };

  const arm = () => {
    if (timerArmed) return;
    try {
      timer = params.setTimeout(() => {
        timerArmed = false;
        timer = undefined;
        void drain();
      }, flushIntervalMs);
      timerArmed = true;
    } catch (error) {
      // Without a timer the rows wait for the cap or an explicit flush.
      logError(error);
    }
  };

  return {
    enqueue(row) {
      if (closed) return;
      buffer.push(row);
      if (buffer.length >= maxBuffered) void drain();
      else arm();
    },
    flush() {
      return drain().then(takeReport);
    },
    close() {
      closed = true;
      return drain().then(takeReport);
    },
  };
}
