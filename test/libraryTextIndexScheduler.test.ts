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
  LIBRARY_TEXT_INDEX_CHUNKER_VERSION,
  INDEX_DRAIN_GAP_MS,
  INDEX_PRIORITY,
  INDEX_RETRY_BACKOFF_MS,
  INDEX_STOP_GRACE_MS,
  INDEX_URGENT_ADD_BATCH_MAX,
} from "../src/services/libraryTextIndex/constants";
import {
  embedDocumentVectors,
  loadVectorMatrix,
  resetVectorIndexerForTests,
} from "../src/services/libraryTextIndex/vectorIndexer";
import { getVectorShardPath } from "../src/services/libraryTextIndex/vectorStore";
import {
  restoreTestGlobals,
  setupMemoryIO,
  snapshotTestGlobals,
  type TestGlobalSnapshot,
} from "./helpers/retrievalCorpus";
import { setAppLogSinkForTests, type AppLogLevel } from "../src/core/logging";

/** Runs `fn` with the app logger captured; returns the warn messages. */
async function captureWarns(fn: () => Promise<void>): Promise<string[]> {
  const warns: string[] = [];
  setAppLogSinkForTests((level: AppLogLevel, args) => {
    if (level === "warn") warns.push(args.map(String).join(" "));
  });
  try {
    await fn();
  } finally {
    setAppLogSinkForTests(null);
  }
  return warns;
}

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
  chunkerVersion: LIBRARY_TEXT_INDEX_CHUNKER_VERSION,
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

  it("startup reconcile never loads a group library Zotero has not loaded and the index does not hold", async function () {
    const snapshotCalls: number[] = [];
    const env = (scheduler as any).env;
    env.listLibraryIds = () => [1, 2, 3, 4];
    env.getSnapshot = async (libraryID: number) => {
      snapshotCalls.push(libraryID);
      return fakeSnapshot([]);
    };
    // Group 2 is loaded; group 3 is not loaded but has index rows (a paper
    // read by an earlier question); group 4 is neither.
    env.isLibraryDataLoaded = (libraryID: number) => libraryID === 2;
    await store.upsertDocument(docRow(30, { libraryID: 3 }));
    await scheduler.reconcileAll();
    assert.deepEqual(snapshotCalls, [1, 2, 3]);
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

  it("reconcile re-queues a row recorded without a file stat once the file exists", async function () {
    // Written before its file was on disk (e.g. a no-text row from a sync
    // that ran ahead of the download): no recorded size or mtime.
    await store.upsertDocument(
      docRow(1, {
        sourceType: "none",
        sourceMtime: null,
        sourceSize: null,
      }),
    );
    snapshotIds = [1];
    const result = await scheduler.reconcile(1);
    assert.equal(result.stale, 1);
    assert.equal((await store.dequeueNext({ now: clock }))?.reason, "stale");
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
    const warns = await captureWarns(async () => {
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
    });
    assert.lengthOf(warns, 1, "one session summary");
    assert.match(warns[0], /1 attachment\(s\) could not be indexed/);
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
    assert.equal(
      (await store.dequeueNext({ now: clock }))?.reason,
      "added",
      "a modify on an already-queued attachment leaves its row alone",
    );
    await store.removeFromQueue([2]);
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

  it("stop() waits for the in-flight job, and a job finishing after stop() does not reschedule", async function () {
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
    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });
    await new Promise((r) => setImmediate(r));
    assert.isFalse(stopped, "stop() must not resolve under a running job");
    finish();
    await stopping;
    const armed = timers.filter((t) => !t.cleared);
    assert.lengthOf(armed, 0, "no timer armed after stop");
  });

  it("stop() gives up waiting for a stuck job after the grace period", async function () {
    (scheduler as any).env.indexOne = () => new Promise(() => undefined);
    await scheduler.enqueue([1], "added");
    scheduler.start();
    await runDueTimers();
    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });
    clock += INDEX_STOP_GRACE_MS - 1;
    await runDueTimers();
    assert.isFalse(stopped);
    clock += 1;
    await runDueTimers();
    await stopping;
    assert.isTrue(stopped);
    await scheduler.stop(); // an abandoned job is not waited for twice
  });

  it("a backoff timer does not delay newer work", async function () {
    (scheduler as any).env.indexOne = async ({ item, lane }: any) => {
      if (item.id === 1) throw new Error("extract failed");
      indexed.push({ id: item.id, lane });
      return {
        status: "indexed",
        attachmentId: item.id,
        chunkCount: 0,
        elapsedMs: 1,
      };
    };
    await scheduler.enqueue([1], "added");
    scheduler.start();
    await drainAll(2); // 1 fails; the loop parks on a 60 s backoff timer
    await scheduler.enqueue([2], "writeThrough");
    await drainAll(2);
    assert.deepEqual(indexed, [{ id: 2, lane: "urgent" }]);
  });

  it("modify never promotes a queued prefetch row or resurrects a parked row", async function () {
    await store.enqueue([
      {
        attachmentId: 1,
        libraryID: 1,
        priority: INDEX_PRIORITY.prefetch,
        reason: "prefetch",
      },
      {
        attachmentId: 2,
        libraryID: 1,
        priority: INDEX_PRIORITY.prefetch,
        reason: "prefetch",
      },
    ]);
    for (let i = 0; i < 3; i += 1)
      await store.markQueueAttempt(2, "permanent", clock);
    await scheduler.handleChange({
      event: "modify",
      type: "item",
      ids: [1, 2],
      extraData: {},
      receivedAt: 0,
    });
    const rows = harness.rows(
      "SELECT attachment_id, priority, attempts FROM queue ORDER BY attachment_id",
    );
    assert.deepEqual(
      rows.map((r) => [r.attachment_id, r.priority, r.attempts]),
      [
        [1, INDEX_PRIORITY.prefetch, 0],
        [2, INDEX_PRIORITY.prefetch, 3],
      ],
    );
    // A modify on an attachment with no document and no queue row is enqueued.
    await scheduler.handleChange({
      event: "modify",
      type: "item",
      ids: [3],
      extraData: {},
      receivedAt: 0,
    });
    assert.equal(
      harness.rows("SELECT reason FROM queue WHERE attachment_id = 3")[0]
        ?.reason,
      "modified",
    );
    // A real file change re-queues an indexed paper even with a parked row.
    await store.upsertDocument(docRow(2));
    fileStates.set(2, { path: "/p.pdf", size: 999, mtime: 1000 });
    await scheduler.handleChange({
      event: "modify",
      type: "file",
      ids: [2],
      extraData: {},
      receivedAt: 0,
    });
    assert.equal(
      harness.rows("SELECT attempts FROM queue WHERE attachment_id = 2")[0]
        ?.attempts,
      0,
    );
  });

  it("enqueues a large notifier add batch at prefetch priority and a small one as urgent", async function () {
    const big = Array.from(
      { length: INDEX_URGENT_ADD_BATCH_MAX + 1 },
      (_, i) => 100 + i,
    );
    await scheduler.handleChange({
      event: "add",
      type: "item",
      ids: big,
      extraData: {},
      receivedAt: 0,
    });
    const priorities = harness
      .rows("SELECT DISTINCT priority FROM queue")
      .map((r) => r.priority);
    assert.deepEqual(
      priorities,
      [INDEX_PRIORITY.prefetch],
      "an initial sync must not flood the urgent lane",
    );
    const small = Array.from(
      { length: INDEX_URGENT_ADD_BATCH_MAX },
      (_, i) => 500 + i,
    );
    await scheduler.handleChange({
      event: "add",
      type: "item",
      ids: small,
      extraData: {},
      receivedAt: 0,
    });
    assert.lengthOf(
      harness.rows("SELECT * FROM queue WHERE priority = ?", [
        INDEX_PRIORITY.added,
      ]),
      INDEX_URGENT_ADD_BATCH_MAX,
    );
  });

  it("routes a large modify batch of never-indexed papers like a large add: prefetch, and none above the soft budget", async function () {
    const big = Array.from(
      { length: INDEX_URGENT_ADD_BATCH_MAX + 1 },
      (_, i) => 100 + i,
    );
    const modify = (ids: number[]) =>
      scheduler.handleChange({
        event: "modify",
        type: "item",
        ids,
        extraData: {},
        receivedAt: 0,
      });
    await modify(big);
    assert.deepEqual(
      harness
        .rows("SELECT DISTINCT priority FROM queue")
        .map((r) => r.priority),
      [INDEX_PRIORITY.prefetch],
      "a sync touching thousands of unindexed papers must not flood the urgent lane",
    );
    assert.lengthOf(harness.rows("SELECT * FROM queue"), big.length);
    // A small batch is still urgent.
    await modify([500, 501]);
    assert.lengthOf(
      harness.rows("SELECT * FROM queue WHERE priority = ?", [
        INDEX_PRIORITY.modified,
      ]),
      2,
    );
    // At the soft budget, a large batch is left to reconcile.
    await store.removeFromQueue(
      harness
        .rows("SELECT attachment_id FROM queue")
        .map((r) => r.attachment_id),
    );
    budget = 1000; // soft limit 900
    await store.upsertDocument(docRow(9, { byteEstimate: 950 }));
    await modify(big.map((id) => id + 1000));
    assert.lengthOf(harness.rows("SELECT * FROM queue"), 0);
    // The same rule for add.
    await scheduler.handleChange({
      event: "add",
      type: "item",
      ids: big.map((id) => id + 2000),
      extraData: {},
      receivedAt: 0,
    });
    assert.lengthOf(harness.rows("SELECT * FROM queue"), 0);
  });

  it("takes no prefetch job above the soft budget, but still runs urgent jobs", async function () {
    budget = 1000; // soft limit 900
    await store.upsertDocument(docRow(9, { byteEstimate: 950 }));
    await scheduler.enqueue([1], "prefetch");
    await scheduler.enqueue([2], "added");
    scheduler.start();
    await drainAll(4);
    assert.deepEqual(indexed, [{ id: 2, lane: "urgent" }]);
  });

  it("does nothing, and never opens the index, when disabled", async function () {
    (scheduler as any).env.isEnabled = () => false;
    let opened = 0;
    (scheduler as any).env.getStore = async () => {
      opened += 1;
      return store;
    };
    await scheduler.enqueue([1], "added");
    await scheduler.handleChange({
      event: "add",
      type: "item",
      ids: [2],
      extraData: {},
      receivedAt: 0,
    });
    await scheduler.reconcileAll();
    assert.equal(await scheduler.enforceBudget(), 0);
    scheduler.start();
    await drainAll(2);
    assert.isTrue(await scheduler.waitForIdle(1000));
    assert.deepEqual(indexed, []);
    assert.isFalse((await scheduler.getStatus(1)).enabled);
    assert.equal(
      opened,
      0,
      "a disabled index never opens (or creates) its database",
    );
  });

  describe("vector stage", function () {
    let embedded: number[];
    const withChunk = (id: number) =>
      docRow(id, {
        chunks: [
          {
            chunkIndex: 0,
            text: `paper ${id}`,
            tokenCount: 2,
            meta: {},
            tf: { paper: 1 },
          },
        ],
      });
    const env = () => (scheduler as any).env;

    beforeEach(function () {
      embedded = [];
      env().indexOne = async ({ item, lane }: any) => {
        indexed.push({ id: item.id, lane });
        await store.upsertDocument(withChunk(item.id));
        return {
          status: "indexed",
          attachmentId: item.id,
          chunkCount: 1,
          elapsedMs: 1,
        };
      };
      env().currentVectorNamespace = () => ({ namespace: "t:4", dims: 4 });
      env().embedOne = async ({ attachmentId, namespace }: any) => {
        embedded.push(attachmentId);
        const doc = (await store.getDocument(attachmentId))!;
        await store.upsertVectorDocument({
          attachmentId,
          namespace,
          dims: 4,
          chunkCount: 1,
          path: `/v/${attachmentId}.bin`,
          sourceFingerprint: doc.sourceFingerprint,
        });
        return { status: "embedded", chunkCount: 1, dims: 4 };
      };
    });

    it("embeds each indexed document once, after the text lanes drain", async function () {
      await scheduler.enqueue([1, 2, 3], "prefetch");
      scheduler.start();
      await drainAll(10);
      assert.sameMembers(embedded, [1, 2, 3]);
      assert.lengthOf(embedded, 3, "each document is embedded exactly once");
      assert.lengthOf(indexed, 3);
      const status = await scheduler.getStatus(1);
      assert.equal(status.vectorNamespace, "t:4");
      assert.equal(status.vectorIndexed, 3);
    });

    it("never embeds while text work is runnable, the user is active or a retrieval is in flight", async function () {
      await store.upsertDocument(withChunk(1));
      await scheduler.enqueue([2], "added");
      userIdle = false;
      scheduler.start();
      await drainAll(4);
      assert.deepEqual(
        indexed.map((i) => i.id),
        [2],
        "urgent text still runs",
      );
      assert.deepEqual(embedded, [], "the vector stage is prefetch-only");
      userIdle = true;
      const end = beginRetrievalActivity();
      try {
        scheduler.kick();
        await drainAll(3);
        assert.deepEqual(embedded, []);
      } finally {
        end();
      }
      await drainAll(4);
      assert.sameMembers(embedded, [1, 2]);
    });

    it("does not embed above the soft budget", async function () {
      budget = 1000; // soft limit 900
      await store.upsertDocument({ ...withChunk(1), byteEstimate: 950 });
      scheduler.start();
      await drainAll(3);
      assert.deepEqual(embedded, []);
    });

    it("never calls embedOne when no vector namespace is active", async function () {
      env().currentVectorNamespace = () => null;
      await scheduler.enqueue([1, 2], "prefetch");
      scheduler.start();
      await drainAll(6);
      assert.lengthOf(indexed, 2);
      assert.deepEqual(embedded, []);
      const status = await scheduler.getStatus(1);
      assert.isNull(status.vectorNamespace);
      assert.equal(status.vectorIndexed, 0);
    });

    it("records a vector failure, skips that document for the session, and keeps going", async function () {
      const ok = env().embedOne;
      env().embedOne = async (params: any) => {
        if (params.attachmentId === 1) {
          embedded.push(1);
          throw new Error("embedding 503");
        }
        return ok(params);
      };
      for (const id of [1, 2, 3]) await store.upsertDocument(withChunk(id));
      scheduler.start();
      await drainAll(8);
      assert.equal(embedded.filter((id) => id === 1).length, 1);
      assert.sameMembers(embedded, [1, 2, 3]);
      assert.match((await scheduler.getStatus(1)).lastError || "", /503/);
    });

    it("pauses the vector stage for the session after consecutive failures", async function () {
      let calls = 0;
      env().embedOne = async () => {
        calls += 1;
        throw new Error("no embedding provider");
      };
      for (const id of [1, 2, 3, 4, 5, 6])
        await store.upsertDocument(withChunk(id));
      scheduler.start();
      const warns = await captureWarns(() => drainAll(10));
      assert.equal(calls, 3);
      assert.lengthOf(warns, 1);
      assert.match(warns[0], /vector indexing paused for this session/);
    });

    it("skips a document whose embed reports skipped instead of retrying it forever", async function () {
      let calls = 0;
      env().embedOne = async () => {
        calls += 1;
        return { status: "skipped", chunkCount: 0, dims: 0 };
      };
      await store.upsertDocument(withChunk(1));
      scheduler.start();
      await drainAll(6);
      assert.equal(calls, 1);
    });

    describe("with a data directory", function () {
      let globals: TestGlobalSnapshot;
      let files: Map<string, Uint8Array>;
      beforeEach(function () {
        globals = snapshotTestGlobals();
        files = setupMemoryIO().files;
        (globalThis as any).Zotero = { DataDirectory: { dir: "/tmp/zotero" } };
        resetVectorIndexerForTests();
      });
      afterEach(function () {
        resetVectorIndexerForTests();
        restoreTestGlobals(globals);
      });
      const embedReal = (attachmentId: number, namespace = "t:4") =>
        embedDocumentVectors({
          store,
          attachmentId,
          namespace,
          embed: async (texts) => texts.map(() => [1, 0, 0, 0]),
        });

      it("reconcile prunes the rows and shard files of other namespaces", async function () {
        await store.upsertDocument(withChunk(1));
        await embedReal(1, "old:4");
        await embedReal(1, "t:4");
        snapshotIds = [1];
        await scheduler.reconcile(1);
        assert.deepEqual(await store.listVectorNamespaces(), ["t:4"]);
        assert.isFalse(files.has(getVectorShardPath("old:4", 1)));
        assert.isTrue(files.has(getVectorShardPath("t:4", 1)));
        env().currentVectorNamespace = () => null;
        await embedReal(1, "other:4");
        await scheduler.reconcile(1);
        assert.deepEqual(
          await store.listVectorNamespaces(),
          ["other:4", "t:4"],
          "no pruning while vectors are off",
        );
      });

      it("keeps a namespace's rows when its files cannot be removed", async function () {
        await store.upsertDocument(withChunk(1));
        await embedReal(1, "old:4");
        (globalThis as any).Zotero = {}; // no data directory: removal throws
        snapshotIds = [1];
        const warns = await captureWarns(async () => {
          await scheduler.reconcile(1); // does not throw
        });
        assert.lengthOf(warns, 1);
        assert.match(warns[0], /could not remove vector namespace files/);
        assert.deepEqual(
          await store.listVectorNamespaces(),
          ["old:4"],
          "rows survive so the next reconcile retries",
        );
      });

      for (const [label, drop] of [
        [
          "budget eviction",
          async () => {
            budget = 1;
            await store.touchDocuments([1], clock - 3 * 60 * 60 * 1000);
            await scheduler.enforceBudget();
          },
        ],
        [
          "a notifier delete",
          () =>
            scheduler.handleChange({
              event: "delete",
              type: "item",
              ids: [1],
              extraData: {},
              receivedAt: 0,
            }),
        ],
        [
          "reconcile removal",
          async () => {
            snapshotIds = [2];
            await scheduler.reconcile(1);
          },
        ],
      ] as Array<[string, () => Promise<unknown>]>) {
        it(`${label} removes the paper's vector row, shard file and matrix rows`, async function () {
          await store.upsertDocument(withChunk(1));
          await store.upsertDocument(withChunk(2));
          await store.touchDocuments([2], clock);
          await embedReal(1);
          await embedReal(2);
          const matrix = (await loadVectorMatrix(store, "t:4"))!;
          assert.equal(matrix.rows, 2);
          await drop();
          assert.isNull(await store.getDocument(1));
          assert.isNull(await store.getVectorDocument(1, "t:4"));
          assert.isFalse(files.has(getVectorShardPath("t:4", 1)));
          assert.isTrue(files.has(getVectorShardPath("t:4", 2)));
          assert.equal(matrix.rows, 1);
          assert.isFalse(matrix.has(1));
        });
      }
    });
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
    // Release the stuck job so afterEach's stop() does not wait on it.
    const stopping = scheduler.stop();
    clock += INDEX_STOP_GRACE_MS;
    await runDueTimers();
    await stopping;
  });
});
