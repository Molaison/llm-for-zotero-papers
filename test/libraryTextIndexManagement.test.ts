import { assert } from "chai";
import { DatabaseSync } from "node:sqlite";
import {
  clearLibraryTextIndex,
  getLibraryTextIndexOverview,
  rebuildLibraryTextIndex,
  startLibraryTextIndex,
  stopLibraryTextIndex,
} from "../src/services/libraryTextIndex";
import {
  getLibraryTextIndexDbPath,
  openLibraryTextIndexDb,
  setLibraryTextIndexDbForTests,
} from "../src/services/libraryTextIndex/db";
import { resetLibraryTextIndexStoreForTests } from "../src/services/libraryTextIndex/store";
import { setUserIdleForTests } from "../src/services/libraryTextIndex/userIdle";
import { setAppLogSinkForTests } from "../src/core/logging";
import { resetVectorIndexerForTests } from "../src/services/libraryTextIndex/vectorIndexer";
import type { LibraryIndexSnapshot } from "../src/services/libraryIndex/contracts";
import { setupMemoryIO, type MemoryIO } from "./helpers/retrievalCorpus";

const DATA_DIR = "/tmp/zotero";
const VECTORS_DIR = `${DATA_DIR}/llm-for-zotero-index/vectors`;

function toZoteroRow(row: Record<string, unknown>) {
  return new Proxy(row, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && !(prop in target)) {
        throw new Error(`Column '${prop}' not present in this row`);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

/**
 * A `Zotero.DBConnection` stand-in whose database "file" lives in the memory
 * IO: constructing it over a path that has no file creates a new, empty
 * database and writes the file; over an existing file it reopens the same
 * database. Deleting the file therefore really loses the data.
 */
function installFakeConnection(io: MemoryIO, log: string[]) {
  const disk = new Map<string, DatabaseSync>();
  const bindable = (params?: unknown[]) =>
    (params || []).map((v) => (v === undefined ? null : v)) as never[];
  class FakeConnection {
    private readonly db: DatabaseSync;
    constructor(path: string) {
      log.push("open");
      if (!io.files.has(path) || !disk.has(path)) {
        disk.set(path, new DatabaseSync(":memory:"));
        io.files.set(path, new Uint8Array([1]));
      }
      this.db = disk.get(path)!;
    }
    async queryAsync(sql: string, params?: unknown[]) {
      const head = sql.trimStart().slice(0, 8).toUpperCase();
      const stmt = this.db.prepare(sql);
      if (head.startsWith("SELECT") || head.startsWith("PRAGMA")) {
        return (stmt.all(...bindable(params)) as Record<string, unknown>[]).map(
          toZoteroRow,
        );
      }
      stmt.run(...bindable(params));
      return [];
    }
    async executeTransaction<T>(fn: () => Promise<T>): Promise<T> {
      this.db.exec("BEGIN");
      try {
        const out = await fn();
        this.db.exec("COMMIT");
        return out;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
    async closeDatabase() {
      log.push("close");
    }
  }
  return { FakeConnection, disk };
}

function emptySnapshot(): LibraryIndexSnapshot {
  return {
    pdfAttachmentIdsByItemId: new Map(),
    attachmentById: new Map(),
    itemById: new Map(),
  } as unknown as LibraryIndexSnapshot;
}

describe("library text index management", function () {
  const scope = globalThis as unknown as Record<string, unknown>;
  const previousZotero = scope.Zotero;
  const previousIO = scope.IOUtils;
  let io: MemoryIO;
  let log: string[];
  let prefs: Record<string, unknown>;
  let disk: Map<string, DatabaseSync>;

  beforeEach(function () {
    io = setupMemoryIO();
    log = [];
    prefs = {};
    const fake = installFakeConnection(io, log);
    disk = fake.disk;
    scope.Zotero = {
      DBConnection: fake.FakeConnection,
      DataDirectory: { dir: DATA_DIR },
      Libraries: { userLibraryID: 1, getAll: () => [{ libraryID: 1 }] },
      Items: { get: () => false },
      Prefs: {
        get: (key: string) => {
          const name = key.split(".").pop() as string;
          if (name in prefs) return prefs[name];
          return name === "enableSemanticSearch" ? false : undefined;
        },
      },
    };
    setLibraryTextIndexDbForTests(null);
    resetLibraryTextIndexStoreForTests();
    resetVectorIndexerForTests();
    setUserIdleForTests(false);
  });

  afterEach(async function () {
    await stopLibraryTextIndex();
    setLibraryTextIndexDbForTests(null);
    resetLibraryTextIndexStoreForTests();
    resetVectorIndexerForTests();
    setUserIdleForTests(null);
    scope.Zotero = previousZotero;
    if (previousIO === undefined) delete scope.IOUtils;
    else scope.IOUtils = previousIO;
  });

  it("clear stops the index first, deletes the database files and the vectors directory, and restarts on a fresh schema", async function () {
    await startLibraryTextIndex({ getSnapshot: async () => emptySnapshot() });
    const dbPath = getLibraryTextIndexDbPath();
    const oldDb = disk.get(dbPath)!;
    oldDb.exec(
      `INSERT INTO index_meta (key, value) VALUES ('marker', 'before-clear')`,
    );
    io.files.set(`${dbPath}-wal`, new Uint8Array([2]));
    io.files.set(`${dbPath}-shm`, new Uint8Array([3]));
    // External databases use a rollback journal, not WAL.
    io.files.set(`${dbPath}-journal`, new Uint8Array([5]));
    io.files.set(`${VECTORS_DIR}/abc123/7.bin`, new Uint8Array([4]));
    io.dirs.add(`${VECTORS_DIR}/abc123`);
    const remove = (
      scope.IOUtils as {
        remove: (path: string, options?: unknown) => Promise<void>;
      }
    ).remove;
    (scope.IOUtils as { remove: unknown }).remove = async (
      path: string,
      options?: unknown,
    ) => {
      log.push(`remove:${path}`);
      await remove(path, options);
    };
    log.length = 0;

    await clearLibraryTextIndex();

    assert.deepEqual(log.slice(0, 6), [
      "close",
      `remove:${dbPath}`,
      `remove:${dbPath}-wal`,
      `remove:${dbPath}-shm`,
      `remove:${dbPath}-journal`,
      `remove:${VECTORS_DIR}`,
    ]);
    assert.isFalse(io.files.has(`${dbPath}-wal`));
    assert.isFalse(io.files.has(`${dbPath}-shm`));
    assert.isFalse(io.files.has(`${dbPath}-journal`));
    assert.isFalse(await (scope.IOUtils as any).exists(VECTORS_DIR));
    assert.isFalse(io.files.has(`${VECTORS_DIR}/abc123/7.bin`));
    // The index was enabled, so it restarted and reopened a new database.
    assert.include(log.slice(6), "open");
    assert.isTrue(io.files.has(dbPath), "the restarted index recreated it");
    const db = await openLibraryTextIndexDb();
    const marker = (await db!.queryAsync(
      `SELECT value FROM index_meta WHERE key = 'marker'`,
    )) as unknown[];
    assert.lengthOf(marker, 0, "the old contents are gone");
    const version = (await db!.queryAsync(
      `SELECT value FROM index_meta WHERE key = 'schema_version'`,
    )) as unknown[];
    assert.lengthOf(version, 1, "a fresh schema was created");
    assert.notStrictEqual(disk.get(dbPath), oldDb);
  });

  it("no connection opens while the files are being deleted, so none is left on an unlinked file", async function () {
    await startLibraryTextIndex({ getSnapshot: async () => emptySnapshot() });
    const dbPath = getLibraryTextIndexDbPath();
    const remove = (
      scope.IOUtils as {
        remove: (path: string, options?: unknown) => Promise<void>;
      }
    ).remove;
    const racedOpens: unknown[] = [];
    (scope.IOUtils as { remove: unknown }).remove = async (
      path: string,
      options?: unknown,
    ) => {
      // A question's search asks for the index mid-delete.
      if (path === dbPath) racedOpens.push(await openLibraryTextIndexDb());
      log.push(`remove:${path}`);
      await remove(path, options);
    };
    log.length = 0;
    await clearLibraryTextIndex();
    assert.deepEqual(racedOpens, [null], "the raced open is refused");
    const firstOpen = log.indexOf("open");
    assert.isAbove(
      firstOpen,
      log.indexOf(`remove:${VECTORS_DIR}`),
      "the only open is the restart, after every delete",
    );
    assert.isOk(await openLibraryTextIndexDb(), "opens normally afterwards");
  });

  it("clear still restarts but rejects when a file could not be deleted, and the next clear runs", async function () {
    await startLibraryTextIndex({ getSnapshot: async () => emptySnapshot() });
    const dbPath = getLibraryTextIndexDbPath();
    const warnings: string[] = [];
    setAppLogSinkForTests((level) => {
      if (level === "warn") warnings.push(level);
    });
    const remove = (
      scope.IOUtils as {
        remove: (path: string, options?: unknown) => Promise<void>;
      }
    ).remove;
    let locked = true;
    (scope.IOUtils as { remove: unknown }).remove = async (
      path: string,
      options?: unknown,
    ) => {
      log.push(`remove:${path}`);
      if (locked && path === dbPath) throw new Error("file in use");
      await remove(path, options);
    };
    log.length = 0;
    try {
      let rejected: unknown = null;
      await clearLibraryTextIndex().catch((error) => {
        rejected = error;
      });
      assert.instanceOf(rejected, Error, "the failure reaches the caller");
      assert.include(
        log,
        `remove:${VECTORS_DIR}`,
        "the other deletion was still attempted",
      );
      assert.equal(log[log.length - 1], "open", "the index restarted anyway");
      assert.isAtMost(warnings.length, 1, "one warning at most");
      locked = false;
      await clearLibraryTextIndex(); // the serialization tail is not poisoned
      assert.isFalse(io.files.has(`${dbPath}-wal`));
    } finally {
      setAppLogSinkForTests(null);
    }
  });

  it("a stored budget below 50 MB falls back to the default, as the settings pane does", async function () {
    for (const [stored, expectedMb] of [
      [10, 500],
      [49, 500],
      [50, 50],
      [800, 800],
    ] as const) {
      prefs.libraryTextIndexBudgetMB = stored;
      const overview = await getLibraryTextIndexOverview({
        getSnapshot: async () => emptySnapshot(),
      });
      assert.equal(overview.budgetBytes, expectedMb * 1024 * 1024, `${stored}`);
    }
  });

  it("clear when nothing exists resolves without throwing", async function () {
    prefs.libraryTextIndexEnabled = false;
    await clearLibraryTextIndex();
    assert.isFalse(io.files.has(`${DATA_DIR}/llm-for-zotero-index.sqlite`));
    assert.notInclude(log, "open", "a disabled index is never recreated");
    await clearLibraryTextIndex();
  });

  it("rebuild after clear leaves the queue empty and nothing indexed", async function () {
    await startLibraryTextIndex({ getSnapshot: async () => emptySnapshot() });
    const oldDb = disk.get(getLibraryTextIndexDbPath())!;
    oldDb.exec(
      `INSERT INTO queue (attachment_id, library_id, priority, reason, enqueued_at) VALUES (42, 1, 10, 'writeThrough', 0)`,
    );
    oldDb.exec(
      `INSERT INTO documents (attachment_id, attachment_key, library_id, parent_item_id, title, source_type, source_fingerprint, chunker_version, chunk_count, total_tokens, indexed_at) VALUES (42, 'K', 1, NULL, 't', 'pdf', 'f', 1, 1, 1, 0)`,
    );
    await clearLibraryTextIndex();
    await rebuildLibraryTextIndex();
    const overview = await getLibraryTextIndexOverview({
      getSnapshot: async () => emptySnapshot(),
    });
    assert.isTrue(overview.enabled);
    assert.equal(overview.queued, 0);
    assert.equal(overview.indexed, 0);
    assert.equal(overview.failed, 0);
  });

  it("overview returns zeros and never opens the database when the index is off", async function () {
    prefs.libraryTextIndexEnabled = false;
    let snapshots = 0;
    const overview = await getLibraryTextIndexOverview({
      getSnapshot: async () => {
        snapshots += 1;
        return emptySnapshot();
      },
    });
    assert.isFalse(overview.enabled);
    assert.equal(overview.indexed, 0);
    assert.equal(overview.eligible, 0);
    assert.equal(overview.queued, 0);
    assert.equal(overview.usedBytes, 0);
    assert.equal(overview.dbBytes, 0);
    assert.isFalse(overview.building);
    assert.notInclude(log, "open");
    assert.equal(snapshots, 0);
    assert.isFalse(io.files.has(`${DATA_DIR}/llm-for-zotero-index.sqlite`));
  });

  it("overview reports eligible papers from the library snapshot and index counts from the scheduler", async function () {
    prefs.libraryTextIndexBudgetMB = 200;
    const snapshot = {
      pdfAttachmentIdsByItemId: new Map([
        [10, [11, 12]],
        [20, [21]],
      ]),
      attachmentById: new Map([
        [11, { isContextEligiblePdf: true }],
        [12, { isContextEligiblePdf: false }],
        [21, { isContextEligiblePdf: true }],
      ]),
      itemById: new Map(),
    } as unknown as LibraryIndexSnapshot;
    const overview = await getLibraryTextIndexOverview({
      getSnapshot: async () => snapshot,
    });
    assert.isTrue(overview.enabled);
    assert.equal(overview.eligible, 2);
    assert.equal(overview.indexed, 0);
    assert.equal(overview.budgetBytes, 200 * 1024 * 1024);
    assert.isFalse(overview.vectorsEnabled);
    assert.isFalse(overview.semanticAvailable);
    assert.isNull(overview.vectorNamespace);
  });

  it("overview never throws: a failing snapshot reports zeros", async function () {
    const overview = await getLibraryTextIndexOverview({
      getSnapshot: async () => {
        throw new Error("boom");
      },
    });
    assert.equal(overview.eligible, 0);
    assert.isTrue(overview.enabled);
  });

  it("two concurrent clears run one after the other", async function () {
    await startLibraryTextIndex({ getSnapshot: async () => emptySnapshot() });
    const dbPath = getLibraryTextIndexDbPath();
    const remove = (
      scope.IOUtils as {
        remove: (path: string, options?: unknown) => Promise<void>;
      }
    ).remove;
    (scope.IOUtils as { remove: unknown }).remove = async (
      path: string,
      options?: unknown,
    ) => {
      log.push(`remove:${path}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await remove(path, options);
    };
    log.length = 0;
    await Promise.all([clearLibraryTextIndex(), clearLibraryTextIndex()]);
    const steps = log.filter((entry) => entry !== "close");
    const oneClear = [
      `remove:${dbPath}`,
      `remove:${dbPath}-wal`,
      `remove:${dbPath}-shm`,
      `remove:${dbPath}-journal`,
      `remove:${VECTORS_DIR}`,
      "open",
    ];
    assert.deepEqual(steps, [...oneClear, ...oneClear]);
  });
});
