/**
 * The tables plan mode and its research engine wrote stay in every profile,
 * dormant: a fresh profile still creates them exactly as they were created,
 * nothing ever drops them, and deleting a conversation still removes its rows
 * from each of them.
 */
import { assert } from "chai";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  clearDormantPlanRowsInTransaction,
  initDormantPlanTables,
} from "../src/agent/store/dormantPlanTables";
import {
  clearDormantResearchRowsInTransaction,
  initDormantResearchTables,
} from "../src/agent/store/dormantResearchTables";
import { clearPersistedAgentConversationRowsInTransaction } from "../src/modules/contextPanel/agentConversationCleanup";

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

/**
 * The research store's schema as it stood when the research engine was
 * removed, read from `sqlite_master` after its last `initResearchStore` with
 * whitespace collapsed. It cannot be regenerated: the store that produced it
 * is gone, and this record is what the dormant copy is held to.
 */
const RESEARCH_SCHEMA = JSON.parse(
  readFileSync(
    path.join(__dirname, "fixtures", "dormantResearchSchema.json"),
    "utf8",
  ),
) as Array<{ type: string; name: string; table: string; sql: string | null }>;

const RESEARCH_TABLE_PATTERN =
  "(tbl_name LIKE 'llm_for_zotero_research_%' OR tbl_name LIKE 'llm_for_zotero_plan_scope_snapshot%')";

function researchSchema(db: DatabaseSync) {
  return (
    db
      .prepare(
        `SELECT type, name, tbl_name, sql FROM sqlite_master WHERE ${RESEARCH_TABLE_PATTERN} ORDER BY type, name`,
      )
      .all() as Row[]
  ).map((row) => ({
    type: String(row.type),
    name: String(row.name),
    table: String(row.tbl_name),
    sql:
      typeof row.sql === "string" ? row.sql.replace(/\s+/g, " ").trim() : null,
  }));
}

function researchTables(): string[] {
  return RESEARCH_SCHEMA.filter((row) => row.type === "table").map(
    (row) => row.name,
  );
}

/**
 * One row in every research table for conversation `key`, joined the way
 * the research store joined them: jobs and approvals by conversation, the
 * job's records by its id, and the snapshot's items by the snapshot id.
 */
function insertResearchRows(db: DatabaseSync, key: number): void {
  for (const table of researchTables()) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
    const values = columns.map((column) => {
      const name = String(column.name);
      if (name === "conversation_key") return key;
      if (name === "research_job_id") return `job-${key}`;
      if (name === "snapshot_id") return `snapshot-${key}`;
      return column.type === "INTEGER" ? 1 : `${name}-${key}`;
    });
    db.prepare(
      `INSERT INTO ${table} (${columns.map((column) => column.name).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    ).run(...(values as never[]));
  }
}

function researchRowCounts(db: DatabaseSync): Record<string, number> {
  return Object.fromEntries(
    researchTables().map((table) => [
      table,
      Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as Row).n),
    ]),
  );
}

describe("dormant research tables", function () {
  let db: DatabaseSync;
  let restore: () => void;

  beforeEach(function () {
    ({ db, restore } = installSqliteZotero());
  });

  afterEach(function () {
    restore();
  });

  it("creates the twelve research tables and their indexes with the research store's own statements", async function () {
    await initDormantResearchTables();
    assert.lengthOf(researchTables(), 12);
    assert.deepEqual(researchSchema(db), RESEARCH_SCHEMA);
  });

  it("keeps existing rows when a later start creates the tables again", async function () {
    await initDormantResearchTables();
    insertResearchRows(db, 7);
    await initDormantResearchTables();
    assert.deepEqual(
      Object.values(researchRowCounts(db)),
      researchTables().map(() => 1),
    );
  });

  it("removes one conversation's rows from every research table and keeps the others", async function () {
    await initDormantResearchTables();
    insertResearchRows(db, 7);
    insertResearchRows(db, 8);
    await (
      globalThis as unknown as typeof globalThis & { Zotero: typeof Zotero }
    ).Zotero.DB.executeTransaction(() =>
      clearDormantResearchRowsInTransaction(7),
    );
    assert.deepEqual(
      Object.values(researchRowCounts(db)),
      researchTables().map(() => 1),
    );
    for (const table of researchTables()) {
      const left = JSON.stringify(
        db.prepare(`SELECT * FROM ${table}`).all() as Row[],
      );
      assert.notInclude(left, "-7", `${table} keeps no row of conversation 7`);
    }
  });
});

describe("deleting a conversation with dormant plan and research rows", function () {
  let db: DatabaseSync;
  let restore: () => void;

  beforeEach(function () {
    ({ db, restore } = installSqliteZotero());
  });

  afterEach(function () {
    restore();
  });

  it("removes that conversation's rows from every dormant table and keeps the others", async function () {
    await initDormantPlanTables();
    await initDormantResearchTables();
    insertConversationRows(db, 7);
    insertConversationRows(db, 8);
    insertResearchRows(db, 7);
    insertResearchRows(db, 8);
    await (
      globalThis as unknown as typeof globalThis & { Zotero: typeof Zotero }
    ).Zotero.DB.executeTransaction(() =>
      clearPersistedAgentConversationRowsInTransaction(7),
    );
    assert.deepEqual(Object.values(rowCounts(db)), [1, 1, 1, 1, 1, 1, 1]);
    assert.deepEqual(
      Object.values(researchRowCounts(db)),
      researchTables().map(() => 1),
    );
    for (const table of [...Object.keys(COLUMNS), ...researchTables()]) {
      const left = JSON.stringify(
        db.prepare(`SELECT * FROM ${table}`).all() as Row[],
      );
      assert.notInclude(left, "-7", `${table} keeps no row of conversation 7`);
    }
  });
});
