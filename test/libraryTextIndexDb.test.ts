import { assert } from "chai";
import { installLibraryTextIndexSqlite } from "./helpers/libraryTextIndexDb";
import {
  ensureLibraryTextIndexSchema,
  openLibraryTextIndexDb,
} from "../src/services/libraryTextIndex/db";
import { LIBRARY_TEXT_INDEX_SCHEMA_VERSION } from "../src/services/libraryTextIndex/constants";

describe("library text index db", function () {
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
});
