import type { AgentEvent } from "../types";

/** One run event row, as the trace store inserts it. */
export type RunEventRow = { seq: number; event: AgentEvent; createdAt: number };

export type RunEventWriter = {
  /** Buffers the row for a later write. Never throws, never awaits. */
  enqueue(row: RunEventRow): void;
  /** Writes everything buffered; resolves once it and every earlier batch is written. */
  flush(): Promise<void>;
  /** A final flush, after which `enqueue` is a no-op. */
  close(): Promise<void>;
};

const DEFAULT_FLUSH_INTERVAL_MS = 250;
const DEFAULT_MAX_BUFFERED = 64;

/**
 * Takes a run's event rows off the stream's critical path.
 *
 * Rows wait in a buffer until a timer (`flushIntervalMs` after the first
 * buffered row), the size cap (`maxBuffered` rows) or an explicit `flush`
 * writes them. Batches are written one at a time on a single promise chain,
 * so rows reach the store in the order they were enqueued; a crash loses at
 * most the rows still buffered. A failed batch is reported (the first failure
 * only, so a locked database cannot flood the log) and dropped; later batches
 * still go through.
 */
export function createRunEventWriter(params: {
  persist: (rows: readonly RunEventRow[]) => Promise<void>;
  flushIntervalMs?: number;
  maxBuffered?: number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  onError: (error: unknown) => void;
}): RunEventWriter {
  const flushIntervalMs = params.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const maxBuffered = Math.max(1, params.maxBuffered ?? DEFAULT_MAX_BUFFERED);
  let buffer: RunEventRow[] = [];
  let timer: unknown = undefined;
  let timerArmed = false;
  let closed = false;
  let reported = false;
  let draining: Promise<void> = Promise.resolve();

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

  const report = (error: unknown) => {
    if (reported) return;
    reported = true;
    try {
      params.onError(error);
    } catch {
      // Reporting is best effort.
    }
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
        } catch (error) {
          report(error);
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
      report(error);
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
      return drain();
    },
    close() {
      if (closed) return draining;
      closed = true;
      return drain();
    },
  };
}
