import { assert } from "chai";
import { installLibraryTextIndexSqlite } from "./helpers/libraryTextIndexDb";
import { LibraryTextIndexStore } from "../src/services/libraryTextIndex/store";
import { openLibraryTextIndexDb } from "../src/services/libraryTextIndex/db";
import {
  LibraryTextIndexScheduler,
  beginRetrievalActivity,
} from "../src/services/libraryTextIndex/scheduler";
import {
  INDEX_DRAIN_GAP_BUSY_MS,
  INDEX_DRAIN_GAP_MS,
  INDEX_PRIORITY,
  INDEX_RETRY_BACKOFF_MS,
} from "../src/services/libraryTextIndex/constants";

type Timer = { cb: () => void; at: number; cleared: boolean };

function fakeSnapshot(attachmentIds: number[]) {
  return {
    pdfAttachmentIdsByItemId: new Map(
      attachmentIds.map((id) => [id * 10, [id]]),
    ),
    attachmentById: new Map(
      attachmentIds.map((id) => [
        id,
        { attachmentId: id, isContextEligiblePdf: true },
      ]),
    ),
    itemById: new Map(
      attachmentIds.map((id) => [id * 10, { itemId: id * 10, addedAt: id }]),
    ),
  } as any;
}
const docRow = (id: number, extra: Record<string, unknown> = {}) => ({
  attachmentId: id,
  attachmentKey: `K${id}`,
  libraryID: 1,
  parentItemId: id * 10,
  title: "t",
  sourceType: "mineru",
  sourceFingerprint: `fp${id}`,
  sourceMtime: 1000,
  sourceSize: 500,
  chunkerVersion: 1,
  byteEstimate: 100,
  chunks: [],
  ...extra,
});

describe("library text index scheduler", function () {
  let harness: ReturnType<typeof installLibraryTextIndexSqlite>;
  let store: LibraryTextIndexStore;
  let clock: number;
  let timers: Timer[];
  let indexed: Array<{ id: number; lane: string }>;
  let snapshotIds: number[];
  let userIdle: boolean;
  let fileStates: Map<
    number,
    { path: string; size: number | null; mtime: number | null } | null
  >;
  let mineru: Set<number>;
  let budget: number;
  let scheduler: LibraryTextIndexScheduler;

  const runDueTimers = async () => {
    for (const t of timers.splice(0)) {
      if (!t.cleared && t.at <= clock) {
        t.cb();
        await new Promise((r) => setImmediate(r));
      } else if (!t.cleared) timers.push(t);
    }
  };
  const drainAll = async (rounds = 12) => {
    for (let i = 0; i < rounds; i += 1) {
      clock += INDEX_DRAIN_GAP_BUSY_MS;
      await runDueTimers();
    }
  };

  beforeEach(async function () {
    harness = installLibraryTextIndexSqlite();
    store = new LibraryTextIndexStore((await openLibraryTextIndexDb())!);
    clock = 10 * 60 * 60 * 1000; // 10 h: above the one-hour protection window
    timers = [];
    indexed = [];
    snapshotIds = [1, 2, 3];
    userIdle = true;
    budget = 1_000_000;
    fileStates = new Map();
    mineru = new Set();
    scheduler = new LibraryTextIndexScheduler({
      now: () => clock,
      setTimer: (cb, ms) => {
        const t = { cb, at: clock + ms, cleared: false };
        timers.push(t);
        return t;
      },
      clearTimer: (t) => {
        (t as Timer).cleared = true;
      },
      getStore: async () => store,
      getItem: (id) =>
        ({
          id,
          key: `K${id}`,
          parentID: id * 10,
          libraryID: 1,
          isAttachment: () => true,
        }) as any,
      getSnapshot: async () => fakeSnapshot(snapshotIds),
      listLibraryIds: () => [1],
      isEnabled: () => true,
      isUserIdle: () => userIdle,
      budgetBytes: () => budget,
      readFileState: async (item) =>
        fileStates.get((item as any).id) ?? {
          path: "/p.pdf",
          size: 500,
          mtime: 1000,
        },
      hasMineruCache: async (id) => mineru.has(id),
      isIndexable: () => true,
      indexOne: async ({ item, lane }) => {
        indexed.push({ id: item.id, lane });
        await store.upsertDocument(docRow(item.id));
        return {
          status: "indexed",
          attachmentId: item.id,
          chunkCount: 0,
          elapsedMs: 1,
        };
      },
    });
  });
  afterEach(async function () {
    await scheduler.stop();
    harness.close();
  });

  it("reconcile enqueues eligible attachments as prefetch and removes rows that left the library", async function () {
    await store.upsertDocument(docRow(9, { title: "gone" }));
    const result = await scheduler.reconcile(1);
    assert.deepEqual(result, {
      enqueued: 3,
      removed: 1,
      stale: 0,
      skippedForBudget: 0,
    });
    assert.isNull(await store.getDocument(9));
    assert.equal(
      (await store.dequeueNext({ now: clock }))?.priority,
      INDEX_PRIORITY.prefetch,
    );
  });

  it("reconcile re-queues a document whose file size or mtime changed and resets attempts", async function () {
    await store.upsertDocument(docRow(1));
    await store.enqueue([
      { attachmentId: 1, libraryID: 1, priority: 0, reason: "prefetch" },
    ]);
    for (let i = 0; i < 3; i += 1)
      await store.markQueueAttempt(1, "old failure", clock);
    fileStates.set(1, { path: "/p.pdf", size: 999, mtime: 1000 });
    const result = await scheduler.reconcile(1);
    assert.equal(result.stale, 1);
    const row = await store.dequeueNext({
      now: clock,
      minPriority: INDEX_PRIORITY.stale,
    });
    assert.equal(row?.attachmentId, 1);
    assert.equal(
      row?.attempts,
      0,
      "a changed file gets a fresh set of attempts",
    );
  });

  it("reconcile leaves a document alone when its file cannot be stat'ed", async function () {
    await store.upsertDocument(docRow(1));
    fileStates.set(1, null); // linked file never downloaded
    snapshotIds = [1];
    const result = await scheduler.reconcile(1);
    assert.deepEqual(result, {
      enqueued: 0,
      removed: 0,
      stale: 0,
      skippedForBudget: 0,
    });
    assert.isNull(await store.dequeueNext({ now: clock }));
  });

  it("reconcile re-queues a pdf.js-indexed paper that gained a MinerU cache", async function () {
    await store.upsertDocument(
      docRow(2, { sourceType: "zotero-fulltext-cache" }),
    );
    mineru.add(2);
    snapshotIds = [2];
    const result = await scheduler.reconcile(1);
    assert.equal(result.stale, 1);
    assert.equal(
      (await store.dequeueNext({ now: clock }))?.reason,
      "mineruUpgrade",
    );
  });

  it("reconcile stops enqueueing prefetch above the soft budget", async function () {
    budget = 1000; // soft limit 900
    await store.upsertDocument(docRow(1, { byteEstimate: 950 }));
    snapshotIds = [1, 2, 3];
    const result = await scheduler.reconcile(1);
    assert.equal(result.enqueued, 0);
    assert.equal(result.skippedForBudget, 2);
  });

  it("reconcile does not resurrect a parked row or reset a pending one", async function () {
    await store.enqueue([
      { attachmentId: 2, libraryID: 1, priority: 0, reason: "prefetch" },
      {
        attachmentId: 3,
        libraryID: 1,
        priority: INDEX_PRIORITY.added,
        reason: "added",
      },
    ]);
    for (let i = 0; i < 3; i += 1)
      await store.markQueueAttempt(2, "permanent failure", clock);
    await store.markQueueAttempt(3, "transient", clock);
    const result = await scheduler.reconcile(1);
    assert.equal(
      result.enqueued,
      1,
      "only the attachment with no queue row is enqueued",
    );
    assert.deepEqual(
      (await store.countQueue(1)).failed,
      1,
      "the parked row stays parked",
    );
    const pending = harness.rows(
      "SELECT attempts, priority FROM queue WHERE attachment_id = 3",
    )[0];
    assert.equal(pending.attempts, 1, "a backing-off row keeps its attempts");
    assert.equal(pending.priority, INDEX_PRIORITY.added, "and its priority");
  });

  it("drains urgent jobs while the user is active and prefetch only when idle", async function () {
    userIdle = false;
    await scheduler.enqueue([1, 2], "prefetch");
    await scheduler.enqueue([3], "added");
    scheduler.start();
    await drainAll(4);
    assert.deepEqual(
      indexed,
      [{ id: 3, lane: "urgent" }],
      "prefetch waits for idle",
    );
    scheduler.onUserIdleChange(true);
    userIdle = true;
    await drainAll(4);
    assert.deepEqual(
      indexed.map((i) => i.id),
      [3, 1, 2],
    );
    assert.equal((await store.countQueue(1)).queued, 0);
  });

  it("does not take a prefetch job while a retrieval is in flight, even when the user is idle", async function () {
    await scheduler.enqueue([1], "prefetch");
    const end = beginRetrievalActivity();
    try {
      scheduler.start();
      await drainAll(3);
      assert.deepEqual(indexed, [], "prefetch yields to the question path");
    } finally {
      end();
    }
    scheduler.kick();
    await drainAll(2);
    assert.deepEqual(indexed, [{ id: 1, lane: "prefetch" }]);
  });

  it("uses the busy gap while a retrieval is in flight and the idle gap otherwise", async function () {
    await scheduler.enqueue([1, 2], "added");
    const end = beginRetrievalActivity();
    scheduler.start();
    await runDueTimers();
    assert.equal(timers[0].at - clock, INDEX_DRAIN_GAP_BUSY_MS);
    end();
    clock += INDEX_DRAIN_GAP_BUSY_MS;
    await runDueTimers();
    assert.equal(timers[0].at - clock, INDEX_DRAIN_GAP_MS);
  });

  it("write-through enqueues at the top priority without awaiting the store", async function () {
    let resolveStore!: (s: LibraryTextIndexStore) => void;
    (scheduler as any).env.getStore = () =>
      new Promise<LibraryTextIndexStore>((r) => {
        resolveStore = r;
      });
    scheduler.start();
    scheduler.handleContextLoaded(7); // returns synchronously
    resolveStore(store);
    await new Promise((r) => setImmediate(r));
    const row = await store.dequeueNext({
      now: clock,
      minPriority: INDEX_PRIORITY.writeThrough,
    });
    assert.equal(row?.attachmentId, 7);
    assert.equal(row?.reason, "writeThrough");
  });

  it("records a failure, backs off, retries up to the cap, then parks the row and logs one session summary", async function () {
    let calls = 0;
    (scheduler as any).env.indexOne = async () => {
      calls += 1;
      throw new Error("extract failed");
    };
    await scheduler.enqueue([1], "added");
    scheduler.start();
    await drainAll(2);
    assert.equal(calls, 1, "no immediate retry");
    clock += INDEX_RETRY_BACKOFF_MS[0];
    await drainAll(2);
    assert.equal(calls, 2);
    clock += INDEX_RETRY_BACKOFF_MS[1];
    await drainAll(2);
    assert.equal(calls, 3);
    clock += INDEX_RETRY_BACKOFF_MS[2];
    await drainAll(2);
    assert.equal(calls, 3, "parked after the cap");
    const status = await scheduler.getStatus(1);
    assert.equal(status.failed, 1);
    assert.match(status.lastError || "", /extract failed/);
    assert.equal((scheduler as any).sessionSummaryLogged, true);
  });

  it("enforces the byte budget by evicting least-recently-searched documents, protecting recent ones", async function () {
    budget = 250;
    await store.upsertDocument(docRow(1, { byteEstimate: 100 }));
    await store.upsertDocument(docRow(2, { byteEstimate: 100 }));
    await store.upsertDocument(docRow(3, { byteEstimate: 100 }));
    // upsertDocument stamps last_used_at with the real clock; pin every row to the test clock.
    await store.touchDocuments([1], clock - 3 * 60 * 60 * 1000);
    await store.touchDocuments([2], clock - 2 * 60 * 60 * 1000);
    await store.touchDocuments([3], clock); // searched just now → protected
    const evicted = await scheduler.enforceBudget();
    assert.equal(evicted, 1);
    assert.isNull(await store.getDocument(1), "oldest unused goes first");
    assert.isOk(await store.getDocument(2));
    assert.isOk(await store.getDocument(3));
    assert.equal((await scheduler.getStatus(1)).evictedThisSession, 1);
  });

  it("handles notifier events: add/modify/file enqueue urgent, delete/trash remove", async function () {
    await scheduler.handleChange({
      event: "add",
      type: "item",
      ids: [2],
      extraData: {},
      receivedAt: 0,
    });
    assert.equal(
      (await store.dequeueNext({ now: clock }))?.priority,
      INDEX_PRIORITY.added,
    );
    await scheduler.handleChange({
      event: "modify",
      type: "file",
      ids: [2],
      extraData: {},
      receivedAt: 0,
    });
    assert.equal((await store.dequeueNext({ now: clock }))?.reason, "modified");
    await store.upsertDocument(docRow(2));
    await scheduler.handleChange({
      event: "trash",
      type: "item",
      ids: [2],
      extraData: {},
      receivedAt: 0,
    });
    assert.isNull(await store.getDocument(2));
    assert.equal((await store.countQueue(1)).queued, 0);
  });

  it("never queues an item that is not an indexable PDF, such as an edited note", async function () {
    (scheduler as any).env.isIndexable = (item: any) => item.id !== 4;
    let opened = 0;
    (scheduler as any).env.getStore = async () => {
      opened += 1;
      return store;
    };
    await scheduler.enqueue([4], "textInvalidated");
    assert.equal(opened, 0, "a note never opens the index database");
    await scheduler.enqueue([4, 1], "textInvalidated");
    assert.deepEqual(
      harness
        .rows("SELECT attachment_id FROM queue")
        .map((r) => r.attachment_id),
      [1],
    );
  });

  it("drops a queued attachment that is not an indexable PDF without extracting it", async function () {
    (scheduler as any).env.isIndexable = (item: any) => item.id !== 4;
    // A row written before the item stopped being indexable (or by another path).
    await store.enqueue([
      {
        attachmentId: 4,
        libraryID: 1,
        priority: INDEX_PRIORITY.writeThrough,
        reason: "writeThrough",
      },
    ]);
    await scheduler.enqueue([1], "writeThrough");
    scheduler.start();
    await drainAll(3);
    assert.deepEqual(
      indexed.map((i) => i.id),
      [1],
    );
    assert.equal((await store.countQueue(1)).queued, 0);
  });

  it("a job finishing after stop() does not reschedule", async function () {
    let finish!: () => void;
    (scheduler as any).env.indexOne = () =>
      new Promise<any>((r) => {
        finish = () =>
          r({
            status: "indexed",
            attachmentId: 1,
            chunkCount: 0,
            elapsedMs: 1,
          });
      });
    await scheduler.enqueue([1], "added");
    scheduler.start();
    await runDueTimers();
    await scheduler.stop();
    timers.length = 0;
    finish();
    await new Promise((r) => setImmediate(r));
    assert.lengthOf(timers, 0, "no timer armed after stop");
  });

  it("does nothing when disabled", async function () {
    (scheduler as any).env.isEnabled = () => false;
    await scheduler.enqueue([1], "added");
    scheduler.start();
    await drainAll(2);
    assert.deepEqual(indexed, []);
    assert.isFalse((await scheduler.getStatus(1)).enabled);
  });

  it("waitForIdle resolves true once both lanes are drained and false on timeout", async function () {
    await scheduler.enqueue([1], "added");
    scheduler.start();
    const pending = scheduler.waitForIdle(10_000);
    await drainAll(2);
    assert.isTrue(await pending);
    await scheduler.enqueue([2], "added");
    (scheduler as any).env.indexOne = () => new Promise(() => undefined); // never resolves
    const stuck = scheduler.waitForIdle(100);
    clock += 200;
    await runDueTimers();
    assert.isFalse(await stuck);
  });
});
