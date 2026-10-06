import { assert } from "chai";
import {
  createBlockStreamCoalescer,
  type BlockStreamFlushReason,
} from "../src/modules/contextPanel/blockStreamCoalescer";

describe("blockStreamCoalescer", function () {
  it("coalesces adjacent tiny deltas until an event boundary", function () {
    const blocks: Array<{ text: string; reason: BlockStreamFlushReason }> = [];
    const coalescer = createBlockStreamCoalescer({
      maxWaitMs: 0,
      onBlock: (text, reason) => blocks.push({ text, reason }),
    });

    coalescer.pushText("Hello");
    coalescer.pushText(" ");
    coalescer.pushText("world");

    assert.deepEqual(blocks, []);
    coalescer.flushNow("event");

    assert.deepEqual(blocks, [{ text: "Hello world", reason: "event" }]);
    assert.equal(coalescer.getFullText(), "Hello world");
  });

  it("flushes at Markdown block boundaries once the pending text is large enough", function () {
    const blocks: Array<{ text: string; reason: BlockStreamFlushReason }> = [];
    const coalescer = createBlockStreamCoalescer({
      minBoundaryChars: 10,
      targetChars: 100,
      maxWaitMs: 0,
      onBlock: (text, reason) => blocks.push({ text, reason }),
    });

    coalescer.pushText("First paragraph.");
    assert.deepEqual(blocks, []);

    coalescer.pushText("\n\n");
    assert.deepEqual(blocks, [
      { text: "First paragraph.\n\n", reason: "boundary" },
    ]);
  });

  for (const { label, options, limit } of [
    { label: "default", options: {}, limit: 800 },
    { label: "custom", options: { hardCapChars: 8 }, limit: 8 },
  ]) {
    it(`flushes uninterrupted text at the ${label} hard cap`, function () {
      const blocks: Array<{ text: string; reason: BlockStreamFlushReason }> =
        [];
      const coalescer = createBlockStreamCoalescer({
        ...options,
        maxWaitMs: 0,
        onBlock: (text, reason) => blocks.push({ text, reason }),
      });

      coalescer.pushText("x".repeat(limit - 1));
      assert.deepEqual(blocks, []);

      coalescer.pushText("x");
      assert.deepEqual(blocks, [
        { text: "x".repeat(limit), reason: "hard-cap" },
      ]);
    });
  }

  it("flushes by timer when no natural boundary arrives", function () {
    const blocks: Array<{ text: string; reason: BlockStreamFlushReason }> = [];
    let timerCallback: (() => void) | null = null;
    const coalescer = createBlockStreamCoalescer({
      maxWaitMs: 700,
      setTimer: (callback) => {
        timerCallback = callback;
        return "timer";
      },
      clearTimer: () => {
        timerCallback = null;
      },
      onBlock: (text, reason) => blocks.push({ text, reason }),
    });

    coalescer.pushText("");
    assert.isNull(timerCallback, "empty input does not schedule a timer");

    coalescer.pushText("partial");
    assert.deepEqual(blocks, []);
    assert.isFunction(timerCallback);

    timerCallback?.();
    assert.deepEqual(blocks, [{ text: "partial", reason: "timer" }]);
  });

  it("cancels pending output and its timer while retaining all streamed text", function () {
    const blocks: string[] = [];
    const pendingTimers = new Map<unknown, () => void>();
    const coalescer = createBlockStreamCoalescer({
      onBlock: (text) => blocks.push(text),
      setTimer: (callback) => {
        const timer = {};
        pendingTimers.set(timer, callback);
        return timer;
      },
      clearTimer: (timer) => {
        pendingTimers.delete(timer);
      },
    });

    coalescer.pushText("released ");
    coalescer.flushNow("event");
    assert.deepEqual(blocks, ["released "]);
    assert.equal(pendingTimers.size, 0, "flushing clears the pending timer");

    coalescer.pushText("pending");
    assert.equal(
      pendingTimers.size,
      1,
      "the pending tail has a timer to clear",
    );
    coalescer.cancel();
    assert.equal(
      pendingTimers.size,
      0,
      "cancellation clears the pending timer",
    );

    coalescer.pushText("after cancellation");
    coalescer.flushNow("final");

    assert.deepEqual(blocks, ["released "]);
    assert.equal(coalescer.getFullText(), "released pending");
    assert.equal(
      pendingTimers.size,
      0,
      "later deltas cannot restart the timer",
    );
  });
});
