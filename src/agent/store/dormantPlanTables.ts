/**
 * The tables plan mode wrote. Plan mode is gone, but no stored data is ever
 * dropped: every start still creates these tables exactly as plan mode did,
 * and deleting a conversation still removes its rows from each of them.
 */
export const PLAN_ARTIFACTS_TABLE = "llm_for_zotero_plan_artifacts";
export const PLAN_EXECUTIONS_TABLE = "llm_for_zotero_plan_executions";
export const PLAN_EXECUTION_TASKS_TABLE = "llm_for_zotero_plan_execution_tasks";
export const PLAN_TASK_TRANSITIONS_TABLE =
  "llm_for_zotero_plan_task_transitions";
export const PLAN_TASK_EVIDENCE_TABLE = "llm_for_zotero_plan_task_evidence";
export const PLAN_AMENDMENTS_TABLE = "llm_for_zotero_plan_amendments";
export const PLAN_AMENDMENT_PROPOSALS_TABLE =
  "llm_for_zotero_plan_amendment_proposals";

/** Create the plan tables, as plan mode created them, when they are missing. */
export async function initDormantPlanTables(): Promise<void> {
  await Zotero.DB.executeTransaction(async () => {
    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${PLAN_ARTIFACTS_TABLE} (
        plan_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        conversation_key INTEGER NOT NULL,
        provider TEXT NOT NULL,
        status TEXT NOT NULL,
        digest TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (plan_id, revision)
      )`,
    );
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS llm_for_zotero_plan_artifacts_conversation_idx
       ON ${PLAN_ARTIFACTS_TABLE} (conversation_key, updated_at DESC)`,
    );
    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${PLAN_EXECUTIONS_TABLE} (
        execution_id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        conversation_key INTEGER NOT NULL,
        status TEXT NOT NULL,
        active_task_id TEXT,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
      )`,
    );
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS llm_for_zotero_plan_executions_plan_idx
       ON ${PLAN_EXECUTIONS_TABLE} (plan_id, revision, updated_at DESC)`,
    );
    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${PLAN_EXECUTION_TASKS_TABLE} (
        task_id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL,
        plan_step_id TEXT NOT NULL,
        parent_task_id TEXT,
        task_order INTEGER NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS llm_for_zotero_plan_tasks_execution_idx
       ON ${PLAN_EXECUTION_TASKS_TABLE} (execution_id, task_order)`,
    );
    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${PLAN_TASK_TRANSITIONS_TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        execution_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        from_status TEXT NOT NULL,
        to_status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    );
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS llm_for_zotero_plan_transitions_execution_idx
       ON ${PLAN_TASK_TRANSITIONS_TABLE} (execution_id, id)`,
    );
    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${PLAN_TASK_EVIDENCE_TABLE} (
        evidence_id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        verified INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    );
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS llm_for_zotero_plan_evidence_task_idx
       ON ${PLAN_TASK_EVIDENCE_TABLE} (execution_id, task_id, created_at)`,
    );
    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${PLAN_AMENDMENTS_TABLE} (
        grant_id TEXT PRIMARY KEY,
        proposal_digest TEXT NOT NULL UNIQUE,
        plan_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        execution_id TEXT NOT NULL,
        conversation_key INTEGER NOT NULL,
        kind TEXT NOT NULL,
        authority TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        authorized_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS llm_for_zotero_plan_amendments_execution_idx
       ON ${PLAN_AMENDMENTS_TABLE} (execution_id, authorized_at ASC)`,
    );
    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${PLAN_AMENDMENT_PROPOSALS_TABLE} (
        proposal_digest TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        execution_id TEXT NOT NULL,
        conversation_key INTEGER NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
  });
}

/** Remove one conversation's rows from every plan table. */
export async function clearDormantPlanRowsInTransaction(
  conversationKey: number,
): Promise<void> {
  const executionRows = (await Zotero.DB.queryAsync(
    `SELECT execution_id AS executionId FROM ${PLAN_EXECUTIONS_TABLE}
     WHERE conversation_key = ?`,
    [conversationKey],
  ).catch((error) => {
    if (/no such table|no table/i.test(String(error))) return [];
    throw error;
  })) as Array<{ executionId?: unknown }>;
  const executionIds = executionRows
    .map((row) =>
      typeof row.executionId === "string" ? row.executionId.trim() : "",
    )
    .filter(Boolean);
  if (executionIds.length) {
    const placeholders = executionIds.map(() => "?").join(", ");
    for (const table of [
      PLAN_TASK_EVIDENCE_TABLE,
      PLAN_TASK_TRANSITIONS_TABLE,
      PLAN_EXECUTION_TASKS_TABLE,
    ]) {
      await Zotero.DB.queryAsync(
        `DELETE FROM ${table} WHERE execution_id IN (${placeholders})`,
        executionIds,
      );
    }
  }
  await Zotero.DB.queryAsync(
    `DELETE FROM ${PLAN_AMENDMENT_PROPOSALS_TABLE} WHERE conversation_key = ?`,
    [conversationKey],
  );
  await Zotero.DB.queryAsync(
    `DELETE FROM ${PLAN_AMENDMENTS_TABLE} WHERE conversation_key = ?`,
    [conversationKey],
  );
  await Zotero.DB.queryAsync(
    `DELETE FROM ${PLAN_EXECUTIONS_TABLE} WHERE conversation_key = ?`,
    [conversationKey],
  );
  await Zotero.DB.queryAsync(
    `DELETE FROM ${PLAN_ARTIFACTS_TABLE} WHERE conversation_key = ?`,
    [conversationKey],
  );
}
