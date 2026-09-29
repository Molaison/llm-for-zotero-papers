/**
 * An in-memory `node:sqlite` database standing in for the plugin's separate
 * library text index connection. Rows go through the same column-throwing
 * proxy as `usageLedgerDb.ts`, because Zotero rows throw on absent columns.
 */

import { DatabaseSync } from "node:sqlite";
import {
  setLibraryTextIndexDbForTests,
  type LibraryTextIndexDb,
} from "../../src/services/libraryTextIndex/db";
import { resetLibraryTextIndexStoreForTests } from "../../src/services/libraryTextIndex/store";

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

export function installLibraryTextIndexSqlite() {
  const db = new DatabaseSync(":memory:");
  const bindable = (params?: unknown[]) =>
    (params || []).map((v) => (v === undefined ? null : v)) as never[];
  const adapter: LibraryTextIndexDb = {
    async queryAsync(sql, params) {
      const head = sql.trimStart().slice(0, 8).toUpperCase();
      const stmt = db.prepare(sql);
      if (
        head.startsWith("SELECT") ||
        head.startsWith("PRAGMA") ||
        head.startsWith("WITH")
      ) {
        return (stmt.all(...bindable(params)) as Record<string, unknown>[]).map(
          toZoteroRow,
        );
      }
      stmt.run(...bindable(params));
      return [];
    },
    async executeTransaction(fn) {
      db.exec("BEGIN");
      try {
        const out = await fn();
        db.exec("COMMIT");
        return out;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  setLibraryTextIndexDbForTests(adapter);
  return {
    db,
    exec: (sql: string, params?: unknown[]) => {
      db.prepare(sql).run(...bindable(params));
    },
    rows: (sql: string, params?: unknown[]) =>
      db.prepare(sql).all(...bindable(params)) as Record<string, unknown>[],
    close: () => {
      setLibraryTextIndexDbForTests(null);
      // Never leave a shared store bound to the closed DatabaseSync.
      resetLibraryTextIndexStoreForTests();
      db.close();
    },
  };
}

/**
 * `Zotero.DBConnection` stand-in over `node:sqlite` with Zotero's close
 * semantics (xpcom/db.js): `closeDatabase()` without `permanent` sets the
 * connection to null and the next query silently reopens it;
 * `closeDatabase(true)` makes every later query throw
 * "Database permanently closed; not re-opening".
 */
export function installZoteroDbConnectionFake(
  options: { beforeQuery?: (sql: string) => Promise<void> } = {},
) {
  const instances: Array<{
    closes: unknown[];
    reopens: number;
    permanentlyClosed: boolean;
  }> = [];
  class FakeZoteroDBConnection {
    private db: DatabaseSync | null = new DatabaseSync(":memory:");
    private readonly state = {
      closes: [] as unknown[],
      reopens: 0,
      permanentlyClosed: false,
    };
    constructor(_path: string) {
      instances.push(this.state);
    }
    private connection(): DatabaseSync {
      if (this.state.permanentlyClosed)
        throw new Error("Database permanently closed; not re-opening");
      if (!this.db) {
        this.state.reopens += 1;
        this.db = new DatabaseSync(":memory:");
      }
      return this.db;
    }
    async queryAsync(sql: string, params?: unknown[]) {
      await options.beforeQuery?.(sql);
      const db = this.connection();
      const bound = (params || []).map((v) =>
        v === undefined ? null : v,
      ) as never[];
      const stmt = db.prepare(sql);
      if (/^\s*(SELECT|PRAGMA|WITH)/i.test(sql))
        return (stmt.all(...bound) as Record<string, unknown>[]).map(
          toZoteroRow,
        );
      stmt.run(...bound);
      return [];
    }
    async executeTransaction<T>(fn: () => Promise<T>): Promise<T> {
      const db = this.connection();
      db.exec("BEGIN");
      try {
        const out = await fn();
        db.exec("COMMIT");
        return out;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    async closeDatabase(permanent?: boolean) {
      this.state.closes.push(permanent);
      this.db?.close();
      this.db = null;
      if (permanent) this.state.permanentlyClosed = true;
    }
  }
  return { FakeZoteroDBConnection, instances };
}
