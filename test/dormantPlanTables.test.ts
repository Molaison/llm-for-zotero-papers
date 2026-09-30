/**
 * The tables plan mode wrote stay in every profile, dormant: a fresh profile
 * still creates them exactly as plan mode did, nothing ever drops them, and
 * deleting a conversation still removes its rows from each of them.
 */
import { assert } from "chai";
import { DatabaseSync } from "node:sqlite";
import {
  clearDormantPlanRowsInTransaction,
  initDormantPlanTables,
} from "../src/agent/store/dormantPlanTables";

type Row = Record<string, unknown>;

function installSqliteZotero(): { db: DatabaseSync; restore: () => void } {
  const globalScope = globalThis as typeof globalThis & { Zotero?: unknown };
  const previous = globalScope.Zotero;
  const db = new DatabaseSync(":memory:");
  const bindable = (params: unknown[] | undefined) =>
    (params || []).map((value) =>
      value === undefined ? null : value,
    ) as never[];
  globalScope.Zotero = {
    DB: {
      queryAsync: async (sql: string, params?: unknown[]) => {
        const statement = db.prepare(sql);
        if (/^\s*(SELECT|PRAGMA|WITH)/i.test(sql))
          return statement.all(...bindable(params));
        statement.run(...bindable(params));
        return [];
      },
      executeTransaction: async (run: () => Promise<unknown>) => {
        db.exec("BEGIN");
        try {
          const result = await run();
          db.exec("COMMIT");
          return result;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
    },
  } as unknown as typeof Zotero;
  return {
    db,
    restore: () => {
      db.close();
      globalScope.Zotero = previous;
    },
  };
}

const COLUMNS: Record<string, string[]> = {
  llm_for_zotero_plan_artifacts: [
    "plan_id TEXT",
    "revision INTEGER",
    "conversation_key INTEGER",
    "provider TEXT",
    "status TEXT",
    "digest TEXT",
    "payload_json TEXT",
    "created_at INTEGER",
    "updated_at INTEGER",
  ],
  llm_for_zotero_plan_executions: [
    "execution_id TEXT",
    "plan_id TEXT",
    "revision INTEGER",
    "conversation_key INTEGER",
    "status TEXT",
    "active_task_id TEXT",
    "payload_json TEXT",
    "created_at INTEGER",
    "updated_at INTEGER",
    "completed_at INTEGER",
  ],
  llm_for_zotero_plan_execution_tasks: [
    "task_id TEXT",
    "execution_id TEXT",
    "plan_step_id TEXT",
    "parent_task_id TEXT",
    "task_order INTEGER",
    "status TEXT",
    "payload_json TEXT",
    "created_at INTEGER",
    "updated_at INTEGER",
  ],
  llm_for_zotero_plan_task_transitions: [
    "id INTEGER",
    "execution_id TEXT",
    "task_id TEXT",
    "from_status TEXT",
    "to_status TEXT",
    "payload_json TEXT",
    "created_at INTEGER",
  ],
  llm_for_zotero_plan_task_evidence: [
    "evidence_id TEXT",
    "execution_id TEXT",
    "task_id TEXT",
    "kind TEXT",
    "verified INTEGER",
    "payload_json TEXT",
    "created_at INTEGER",
  ],
  llm_for_zotero_plan_amendments: [
    "grant_id TEXT",
    "proposal_digest TEXT",
    "plan_id TEXT",
    "revision INTEGER",
    "execution_id TEXT",
    "conversation_key INTEGER",
    "kind TEXT",
    "authority TEXT",
    "status TEXT",
    "payload_json TEXT",
    "authorized_at INTEGER",
    "updated_at INTEGER",
  ],
  llm_for_zotero_plan_amendment_proposals: [
    "proposal_digest TEXT",
    "plan_id TEXT",
    "revision INTEGER",
    "execution_id TEXT",
    "conversation_key INTEGER",
    "kind TEXT",
    "status TEXT",
    "payload_json TEXT",
    "created_at INTEGER",
    "updated_at INTEGER",
  ],
};

const INDEXES: Record<string, string> = {
  llm_for_zotero_plan_artifacts_conversation_idx:
    "llm_for_zotero_plan_artifacts(conversation_key,updated_at)",
  llm_for_zotero_plan_executions_plan_idx:
    "llm_for_zotero_plan_executions(plan_id,revision,updated_at)",
  llm_for_zotero_plan_tasks_execution_idx:
    "llm_for_zotero_plan_execution_tasks(execution_id,task_order)",
  llm_for_zotero_plan_transitions_execution_idx:
    "llm_for_zotero_plan_task_transitions(execution_id,id)",
  llm_for_zotero_plan_evidence_task_idx:
    "llm_for_zotero_plan_task_evidence(execution_id,task_id,created_at)",
  llm_for_zotero_plan_amendments_execution_idx:
    "llm_for_zotero_plan_amendments(execution_id,authorized_at)",
};

function planTables(db: DatabaseSync): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'llm_for_zotero_plan_%' ORDER BY name",
      )
      .all() as Row[]
  ).map((row) => String(row.name));
}

function insertConversationRows(db: DatabaseSync, key: number): void {
  const execution = `execution-${key}`;
  const now = 1;
  db.prepare(
    "INSERT INTO llm_for_zotero_plan_artifacts VALUES (?, 1, ?, 'original', 'approved', 'd', '{}', ?, ?)",
  ).run(`plan-${key}`, key, now, now);
  db.prepare(
    "INSERT INTO llm_for_zotero_plan_executions VALUES (?, ?, 1, ?, 'interrupted', NULL, '{}', ?, ?, NULL)",
  ).run(execution, `plan-${key}`, key, now, now);
  db.prepare(
    "INSERT INTO llm_for_zotero_plan_execution_tasks VALUES (?, ?, 'step-1', NULL, 0, 'completed', '{}', ?, ?)",
  ).run(`${execution}:task-1`, execution, now, now);
  db.prepare(
    "INSERT INTO llm_for_zotero_plan_task_transitions (execution_id, task_id, from_status, to_status, payload_json, created_at) VALUES (?, ?, 'pending', 'completed', '{}', ?)",
  ).run(execution, `${execution}:task-1`, now);
  db.prepare(
    "INSERT INTO llm_for_zotero_plan_task_evidence VALUES (?, ?, ?, 'tool_result', 1, '{}', ?)",
  ).run(`evidence-${key}`, execution, `${execution}:task-1`, now);
  db.prepare(
    "INSERT INTO llm_for_zotero_plan_amendments VALUES (?, ?, ?, 1, ?, ?, 'scope', 'user', 'applied', '{}', ?, ?)",
  ).run(
    `grant-${key}`,
    `proposal-${key}`,
    `plan-${key}`,
    execution,
    key,
    now,
    now,
  );
  db.prepare(
    "INSERT INTO llm_for_zotero_plan_amendment_proposals VALUES (?, ?, 1, ?, ?, 'scope', 'applied', '{}', ?, ?)",
  ).run(`open-proposal-${key}`, `plan-${key}`, execution, key, now, now);
}

function rowCounts(db: DatabaseSync): Record<string, number> {
  return Object.fromEntries(
    Object.keys(COLUMNS).map((table) => [
      table,
      Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as Row).n),
    ]),
  );
}

describe("dormant plan tables", function () {
  let db: DatabaseSync;
  let restore: () => void;

  beforeEach(function () {
    ({ db, restore } = installSqliteZotero());
  });

  afterEach(function () {
    restore();
  });

  it("creates the seven plan tables and their indexes exactly as plan mode did", async function () {
    await initDormantPlanTables();
    assert.deepEqual(planTables(db), Object.keys(COLUMNS).sort());
    for (const [table, columns] of Object.entries(COLUMNS)) {
      const info = db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
      assert.deepEqual(
        info.map((column) => `${column.name} ${column.type}`),
        columns,
        table,
      );
    }
    const indexes = db
      .prepare(
        "SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name LIKE 'llm_for_zotero_plan_%' ORDER BY name",
      )
      .all() as Row[];
    assert.deepEqual(
      Object.fromEntries(
        indexes.map((index) => [
          index.name,
          `${index.tbl_name}(${(
            db.prepare(`PRAGMA index_info(${index.name})`).all() as Row[]
          )
            .map((column) => column.name)
            .join(",")})`,
        ]),
      ),
      INDEXES,
    );
    const triggers = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name LIKE 'llm_for_zotero_plan_%' AND tbl_name NOT LIKE 'llm_for_zotero_plan_document%' AND tbl_name NOT LIKE 'llm_for_zotero_plan_scope%'",
      )
      .all();
    assert.lengthOf(triggers, 0, "plan mode created no triggers");
  });

  it("keeps existing rows when a later start creates the tables again", async function () {
    await initDormantPlanTables();
    insertConversationRows(db, 7);
    await initDormantPlanTables();
    assert.deepEqual(Object.values(rowCounts(db)), [1, 1, 1, 1, 1, 1, 1]);
  });

  it("removes one conversation's rows from every plan table and keeps the others", async function () {
    await initDormantPlanTables();
    insertConversationRows(db, 7);
    insertConversationRows(db, 8);
    await (
      globalThis as unknown as typeof globalThis & { Zotero: typeof Zotero }
    ).Zotero.DB.executeTransaction(() => clearDormantPlanRowsInTransaction(7));
    assert.deepEqual(Object.values(rowCounts(db)), [1, 1, 1, 1, 1, 1, 1]);
    const executions = db
      .prepare("SELECT execution_id FROM llm_for_zotero_plan_executions")
      .all() as Row[];
    assert.deepEqual(
      executions.map((row) => row.execution_id),
      ["execution-8"],
    );
    const tasks = db
      .prepare("SELECT execution_id FROM llm_for_zotero_plan_execution_tasks")
      .all() as Row[];
    assert.deepEqual(
      tasks.map((row) => row.execution_id),
      ["execution-8"],
    );
  });
});
