import { assert } from "chai";
import { installLibraryTextIndexSqlite } from "./helpers/libraryTextIndexDb";
import {
  closeLibraryTextIndexDb,
  ensureLibraryTextIndexSchema,
  getLibraryTextIndexDbPath,
  openLibraryTextIndexDb,
  setLibraryTextIndexDbForTests,
} from "../src/services/libraryTextIndex/db";
import { LIBRARY_TEXT_INDEX_SCHEMA_VERSION } from "../src/services/libraryTextIndex/constants";
import { setAppLogSinkForTests } from "../src/core/logging";

describe("library text index db", function () {
  // db.ts keeps module state (connection, pending open, test override); start
  // and end every test without any, whatever ran before.
  beforeEach(function () {
    setLibraryTextIndexDbForTests(null);
  });
  afterEach(function () {
    setLibraryTextIndexDbForTests(null);
  });

  it("creates every table and records the schema version", async function () {
    const harness = installLibraryTextIndexSqlite();
    try {
      const db = await openLibraryTextIndexDb();
      assert.isOk(db);
      const names = harness
        .rows(
          "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        )
        .map((r) => r.name);
      assert.deepEqual(names, [
        "chunks",
        "documents",
        "index_meta",
        "postings",
        "queue",
        "vector_documents",
      ]);
      const [meta] = harness.rows(
        "SELECT value FROM index_meta WHERE key = 'schema_version'",
      );
      assert.equal(meta.value, String(LIBRARY_TEXT_INDEX_SCHEMA_VERSION));
    } finally {
      harness.close();
    }
  });

  it("drops and recreates the tables when the recorded schema version differs", async function () {
    const harness = installLibraryTextIndexSqlite();
    try {
      const db = (await openLibraryTextIndexDb())!;
      harness.exec(
        "INSERT INTO documents (attachment_id, attachment_key, library_id, title, source_type, source_fingerprint, chunker_version, chunk_count, total_tokens, indexed_at) VALUES (1,'K',1,'t','mineru','f',1,0,0,0)",
      );
      harness.exec(
        "UPDATE index_meta SET value = '0' WHERE key = 'schema_version'",
      );
      await ensureLibraryTextIndexSchema(db);
      assert.lengthOf(harness.rows("SELECT * FROM documents"), 0);
      assert.equal(
        harness.rows(
          "SELECT value FROM index_meta WHERE key = 'schema_version'",
        )[0].value,
        String(LIBRARY_TEXT_INDEX_SCHEMA_VERSION),
      );
    } finally {
      harness.close();
    }
  });

  it("never touches Zotero.DB while opening or migrating the index database", async function () {
    const harness = installLibraryTextIndexSqlite();
    const previous = (globalThis as any).Zotero;
    const calls: string[] = [];
    (globalThis as any).Zotero = {
      ...(previous || {}),
      DB: {
        executeTransaction: async () => {
          calls.push("executeTransaction");
        },
        queryAsync: async () => {
          calls.push("queryAsync");
          return [];
        },
      },
    };
    try {
      const db = (await openLibraryTextIndexDb())!;
      harness.exec(
        "UPDATE index_meta SET value = '0' WHERE key = 'schema_version'",
      );
      await ensureLibraryTextIndexSchema(db);
      assert.deepEqual(
        calls,
        [],
        "index schema work must stay off Zotero's storage thread (#485)",
      );
    } finally {
      (globalThis as any).Zotero = previous;
      harness.close();
    }
  });

  it("returns null and logs when no Zotero DB connection can be opened", async function () {
    const previous = (globalThis as any).Zotero;
    (globalThis as any).Zotero = {};
    try {
      assert.isNull(await openLibraryTextIndexDb());
    } finally {
      (globalThis as any).Zotero = previous;
    }
  });
  it("close waits for an open in flight and closes that handle without deleting the file", async function () {
    const previous = (globalThis as any).Zotero;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const closes: unknown[][] = [];
    class FakeConnection {
      async queryAsync(sql: string) {
        await gate;
        return sql.startsWith("SELECT") ? [] : undefined;
      }
      async executeTransaction<T>(fn: () => Promise<T>) {
        return fn();
      }
      async closeDatabase(...args: unknown[]) {
        closes.push(args);
      }
    }
    (globalThis as any).Zotero = {
      DBConnection: FakeConnection,
      DataDirectory: { dir: "/tmp" },
    };
    try {
      const opening = openLibraryTextIndexDb();
      const closing = closeLibraryTextIndexDb();
      release();
      assert.isOk(await opening);
      await closing;
      assert.lengthOf(closes, 1, "the handle opened during shutdown is closed");
      assert.notEqual(closes[0][0], true, "never close with permanent=true");
    } finally {
      (globalThis as any).Zotero = previous;
    }
  });
  it("opens the index by absolute path, so Zotero treats it as an external database", async function () {
    // A bare name makes Zotero run its main-database routine on open: after an
    // unclean shutdown it shows the pane-wide "checking database integrity"
    // meter and never clears it (Zotero.locked swallows every keystroke), and it
    // schedules idle-time .bak backups. An absolute path skips both.
    const previous = (globalThis as any).Zotero;
    const constructed: string[] = [];
    class FakeConnection {
      constructor(nameOrPath: string) {
        constructed.push(nameOrPath);
      }
      async queryAsync(sql: string) {
        return sql.startsWith("SELECT") ? [] : undefined;
      }
      async executeTransaction<T>(fn: () => Promise<T>) {
        return fn();
      }
    }
    (globalThis as any).Zotero = {
      DBConnection: FakeConnection,
      DataDirectory: { dir: "/data/zotero" },
    };
    try {
      assert.isOk(await openLibraryTextIndexDb());
      assert.deepEqual(constructed, [getLibraryTextIndexDbPath()]);
      assert.equal(constructed[0], "/data/zotero/llm-for-zotero-index.sqlite");
    } finally {
      (globalThis as any).Zotero = previous;
    }
  });
  it("caches a missing Zotero.DBConnection as null for the session without a warning", async function () {
    const previous = (globalThis as any).Zotero;
    const emitted: string[] = [];
    setAppLogSinkForTests((level) => emitted.push(level));
    (globalThis as any).Zotero = { DataDirectory: { dir: "/tmp" } };
    try {
      assert.isNull(await openLibraryTextIndexDb());
      assert.isNull(await openLibraryTextIndexDb());
      assert.notInclude(
        emitted,
        "warn",
        "an unavailable connection is not a failure",
      );
    } finally {
      setAppLogSinkForTests(null);
      (globalThis as any).Zotero = previous;
    }
  });
});
