/**
 * A real SQLite ledger behind a fake `Zotero`, for the usage tests.
 *
 * The usage read layer is SQL, so testing it against hand-written stub rows
 * would test the stubs. `node:sqlite` runs the same statements the plugin
 * ships, and the row proxy reproduces the one Zotero behaviour that catches
 * mistakes: reading a column the SELECT did not name THROWS, where a plain
 * node row would quietly answer `undefined`.
 */

import { DatabaseSync } from "node:sqlite";

export type FakeLibraryItem = {
  title?: string;
  firstCreator?: string;
  date?: string;
};

export type UsageLedgerHarness = {
  db: DatabaseSync;
  /** Run a statement directly, for fixtures the write path cannot express. */
  exec: (sql: string, params?: unknown[]) => void;
  /** The library `Zotero.Items.get` answers from. */
  setItems: (items: Map<number, FakeLibraryItem>) => void;
  /** Every SELECT the code under test has run, in order. */
  reads: string[];
  /** Close the database and put the previous `Zotero` back. */
  close: () => void;
};

/**
 * Zotero hands back rows that THROW when code reads a column the SELECT did
 * not include; node:sqlite would quietly return undefined. The proxy keeps the
 * suite honest about column aliases.
 */
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

export function installUsageLedgerZotero(): UsageLedgerHarness {
  const globalScope = globalThis as typeof globalThis & {
    Zotero?: Record<string, unknown>;
  };
  const previousZotero = globalScope.Zotero;
  const db = new DatabaseSync(":memory:");
  const reads: string[] = [];
  let items = new Map<number, FakeLibraryItem>();
  const bindable = (params: unknown[] | undefined) =>
    (Array.isArray(params) ? params : params === undefined ? [] : [params]).map(
      (value) => (value === undefined ? null : value),
    ) as never[];
  const queryAsync = async (sql: string, params?: unknown[]) => {
    const head = sql.trimStart().slice(0, 8).toUpperCase();
    const isRead =
      head.startsWith("SELECT") ||
      head.startsWith("PRAGMA") ||
      head.startsWith("WITH");
    const stmt = db.prepare(sql);
    if (isRead) {
      reads.push(sql);
      return (stmt.all(...bindable(params)) as Record<string, unknown>[]).map(
        toZoteroRow,
      );
    }
    stmt.run(...bindable(params));
    return [];
  };
  globalScope.Zotero = {
    ...(previousZotero || {}),
    Libraries: { userLibraryID: 1 },
    Items: {
      get: (id: number) => {
        const item = items.get(Number(id));
        if (!item) return false;
        return {
          id: Number(id),
          getField: (field: string) =>
            (item as Record<string, string | undefined>)[field] || "",
        };
      },
    },
    debug: () => undefined,
    DB: {
      queryAsync,
      executeTransaction: async (task: () => Promise<unknown>) => await task(),
    },
  };
  return {
    db,
    exec: (sql, params) => {
      db.prepare(sql).run(...((params || []) as never[]));
    },
    setItems: (next) => {
      items = next;
    },
    reads,
    close: () => {
      db.close();
      globalScope.Zotero = previousZotero;
    },
  };
}
