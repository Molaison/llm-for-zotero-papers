import { assert } from "chai";
import {
  createRunEventWriter,
  type RunEventRow,
} from "../src/agent/store/runEventWriter";

/**
 * The run's event writer takes each event off the stream's critical path:
 * deltas wait in a buffer that a timer, a size cap or an explicit flush
 * persists, one batch at a time and in sequence order.
 */
describe("run event writer", function () {
  function delta(seq: number, text = "x"): RunEventRow {
    return { seq, event: { type: "message_delta", text }, createdAt: seq };
  }

  it("buffers deltas and flushes on the timer, the size cap, or an explicit flush, in seq order", async function () {
    const batches: RunEventRow[][] = [];
    let timer: (() => void) | null = null;
    const writer = createRunEventWriter({
      persist: async (rows) => {
        batches.push([...rows]);
      },
      flushIntervalMs: 250,
      maxBuffered: 3,
      setTimeout: (fn) => {
        timer = fn;
        return 1;
      },
      clearTimeout: () => {
        timer = null;
      },
      onError: () => undefined,
    });
    writer.enqueue(delta(1, "a"));
    writer.enqueue(delta(2, "b"));
    assert.lengthOf(batches, 0, "nothing is written while the buffer waits");
    assert.isFunction(timer, "the first buffered row arms the timer");
    timer!();
    await writer.flush();
    assert.deepEqual(
      batches.map((batch) => batch.map((row) => row.seq)),
      [[1, 2]],
    );
    for (const seq of [3, 4, 5]) writer.enqueue(delta(seq));
    // The cap starts a write without waiting for the timer.
    await writer.flush();
    assert.deepEqual(
      batches.at(-1)!.map((row) => row.seq),
      [3, 4, 5],
    );
    await writer.close();
    writer.enqueue(delta(6, "late"));
    await writer.flush();
    assert.isFalse(batches.flat().some((row) => row.seq === 6));
  });

  it("starts a write at the size cap without a timer or a flush", async function () {
    const batches: number[][] = [];
    const writer = createRunEventWriter({
      persist: async (rows) => {
        batches.push(rows.map((row) => row.seq));
      },
      maxBuffered: 2,
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      onError: () => undefined,
    });
    writer.enqueue(delta(1));
    writer.enqueue(delta(2));
    writer.enqueue(delta(3));
    // Let the drain the cap scheduled run.
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(batches[0], [1, 2]);
    await writer.close();
    assert.deepEqual(batches, [[1, 2], [3]]);
  });

  it("writes one batch at a time: a flush during a slow write waits for it, and order holds", async function () {
    const order: string[] = [];
    let release: () => void = () => undefined;
    let first = true;
    const writer = createRunEventWriter({
      persist: async (rows) => {
        const seqs = rows.map((row) => row.seq).join(",");
        order.push(`start ${seqs}`);
        if (first) {
          first = false;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        order.push(`end ${seqs}`);
      },
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      onError: () => undefined,
    });
    writer.enqueue(delta(1));
    const firstFlush = writer.flush();
    writer.enqueue(delta(2));
    const secondFlush = writer.flush();
    await Promise.resolve();
    assert.deepEqual(order, ["start 1"]);
    release();
    await secondFlush;
    await firstFlush;
    assert.deepEqual(order, ["start 1", "end 1", "start 2", "end 2"]);
  });

  it("a failing persist reports each failed batch, keeps later batches flowing, and the flush names the lost rows", async function () {
    const errors: unknown[] = [];
    const lost: number[][] = [];
    const written: number[][] = [];
    let failures = 2;
    const writer = createRunEventWriter({
      persist: async (rows) => {
        if (failures > 0) {
          failures -= 1;
          throw new Error("database is locked");
        }
        written.push(rows.map((row) => row.seq));
      },
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      onError: (error) => errors.push(error),
      onBatchFailed: (rows) => lost.push(rows.map((row) => row.seq)),
    });
    writer.enqueue(delta(1));
    const first = await writer.flush();
    assert.deepEqual(first, {
      written: 0,
      failed: [{ seq: 1, type: "message_delta" }],
    });
    writer.enqueue(delta(2));
    writer.enqueue({
      seq: 3,
      event: { type: "final", text: "Done." },
      createdAt: 3,
    });
    const second = await writer.flush();
    assert.deepEqual(second.failed, [
      { seq: 2, type: "message_delta" },
      { seq: 3, type: "final" },
    ]);
    writer.enqueue(delta(4));
    assert.deepEqual(await writer.flush(), { written: 1, failed: [] });
    writer.enqueue(delta(5));
    assert.deepEqual(await writer.close(), { written: 1, failed: [] });
    assert.lengthOf(errors, 2, "every failed batch is reported");
    assert.match(String(errors[0]), /database is locked/);
    assert.deepEqual(lost, [[1], [2, 3]]);
    assert.deepEqual(written, [[4], [5]]);
  });

  it("reports at most five failed batches a run, so a locked database cannot flood the log", async function () {
    const errors: unknown[] = [];
    const lost: number[] = [];
    const writer = createRunEventWriter({
      persist: async () => {
        throw new Error("database is locked");
      },
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      onError: (error) => errors.push(error),
      onBatchFailed: (rows) => lost.push(...rows.map((row) => row.seq)),
    });
    for (let seq = 1; seq <= 7; seq += 1) {
      writer.enqueue(delta(seq));
      await writer.flush();
    }
    assert.lengthOf(errors, 5);
    assert.deepEqual(lost, [1, 2, 3, 4, 5, 6, 7], "every loss is announced");
  });

  it("never throws from enqueue, even when the timer cannot be armed", function () {
    const writer = createRunEventWriter({
      persist: async () => undefined,
      setTimeout: () => {
        throw new Error("no timers here");
      },
      clearTimeout: () => undefined,
      onError: () => undefined,
    });
    assert.doesNotThrow(() => writer.enqueue(delta(1)));
  });
});
