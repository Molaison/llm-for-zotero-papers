/**
 * Batches a run's thinking deltas into a bounded number of repaints.
 *
 * Providers stream reasoning in deltas of a few characters, hundreds per
 * second, and each one used to ask for a repaint of the whole agent trace.
 * The text itself is recorded as it arrives; only the repaint waits, until
 * the oldest waiting delta is `maxWaitMs` old or the waiting text reaches
 * `maxChars`. Anything else the run reports flushes the wait first, so the
 * reader never sees a later event before the thinking that preceded it.
 */
export type ReasoningRefreshCoalescer = {
  /** Record one delta's text; repaints when the wait is over. */
  push: (delta: string) => void;
  /** Repaint now if any delta is waiting. */
  flushNow: () => void;
  /** Drop whatever is waiting without repainting. */
  cancel: () => void;
  hasPending: () => boolean;
};

export type ReasoningRefreshCoalescerOptions = {
  /** Receives the text that waited, in arrival order. */
  onFlush: (text: string) => void;
  maxWaitMs?: number;
  maxChars?: number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (timer: unknown) => void;
};

export const REASONING_REFRESH_MAX_WAIT_MS = 120;
export const REASONING_REFRESH_MAX_CHARS = 400;

export function createReasoningRefreshCoalescer(
  options: ReasoningRefreshCoalescerOptions,
): ReasoningRefreshCoalescer {
  const maxWaitMs = options.maxWaitMs ?? REASONING_REFRESH_MAX_WAIT_MS;
  const maxChars = options.maxChars ?? REASONING_REFRESH_MAX_CHARS;
  const setTimer =
    options.setTimer ??
    ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const clearTimer =
    options.clearTimer ??
    ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let pending = false;
  let pendingText = "";
  let timer: unknown = null;

  const clearPendingTimer = () => {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  };

  const flushNow = () => {
    clearPendingTimer();
    if (!pending) return;
    const text = pendingText;
    pending = false;
    pendingText = "";
    options.onFlush(text);
  };

  return {
    push(delta: string): void {
      pendingText += delta || "";
      if (!pending) {
        pending = true;
        // The wait is measured from the oldest delta, so a steady stream
        // still repaints every `maxWaitMs`.
        if (maxWaitMs > 0)
          timer = setTimer(() => {
            timer = null;
            flushNow();
          }, maxWaitMs);
      }
      if (pendingText.length >= maxChars || maxWaitMs <= 0) flushNow();
    },
    flushNow,
    cancel(): void {
      clearPendingTimer();
      pending = false;
      pendingText = "";
    },
    hasPending: () => pending,
  };
}
