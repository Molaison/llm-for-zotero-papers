/**
 * The tables plan mode's research engine wrote. The engine is gone, but no
 * stored data is ever dropped: every start still creates these tables with
 * the research store's own statements, and deleting a conversation still
 * removes its rows from each of them.
 */
export const PLAN_SCOPE_SNAPSHOTS_TABLE = "llm_for_zotero_plan_scope_snapshots";
export const PLAN_SCOPE_SNAPSHOT_ITEMS_TABLE =
  "llm_for_zotero_plan_scope_snapshot_items";
export const RESEARCH_JOBS_TABLE = "llm_for_zotero_research_jobs";
export const RESEARCH_CORPUS_ITEMS_TABLE =
  "llm_for_zotero_research_corpus_items";
export const RESEARCH_WORK_ITEMS_TABLE = "llm_for_zotero_research_work_items";
export const RESEARCH_EVIDENCE_TABLE = "llm_for_zotero_research_evidence";
export const RESEARCH_RECALL_PROBES_TABLE =
  "llm_for_zotero_research_recall_probes";
export const RESEARCH_PAPER_FINDINGS_TABLE =
  "llm_for_zotero_research_paper_findings";
export const RESEARCH_THEME_FINDINGS_TABLE =
  "llm_for_zotero_research_theme_findings";
export const RESEARCH_MUTATION_APPROVALS_TABLE =
  "llm_for_zotero_research_mutation_approvals";
export const RESEARCH_EDGES_TABLE = "llm_for_zotero_research_edges";
export const RESEARCH_OPEN_QUESTIONS_TABLE =
  "llm_for_zotero_research_open_questions";

/** Create the research tables, as the research store created them, when they are missing. */
export async function initDormantResearchTables(): Promise<void> {
  await Zotero.DB.executeTransaction(async () => {
    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${PLAN_SCOPE_SNAPSHOTS_TABLE} (
        snapshot_id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        conversation_key INTEGER NOT NULL,
        digest TEXT NOT NULL,
        item_count INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      )`,
    );
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS llm_plan_scope_snapshot_conversation_idx
       ON ${PLAN_SCOPE_SNAPSHOTS_TABLE} (conversation_key, created_at DESC)`,
    );
    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${PLAN_SCOPE_SNAPSHOT_ITEMS_TABLE} (
        snapshot_id TEXT NOT NULL,
        library_id INTEGER NOT NULL,
        item_key TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (snapshot_id, library_id, item_key)
      )`,
    );
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS llm_plan_scope_snapshot_items_order_idx
       ON ${PLAN_SCOPE_SNAPSHOT_ITEMS_TABLE} (snapshot_id, ordinal)`,
    );
    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${RESEARCH_JOBS_TABLE} (
        research_job_id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL,
        parent_task_id TEXT NOT NULL,
        conversation_key INTEGER NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS llm_research_jobs_execution_idx
       ON ${RESEARCH_JOBS_TABLE} (execution_id, updated_at DESC)`,
    );
    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${RESEARCH_CORPUS_ITEMS_TABLE} (
        research_job_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        parent_task_id TEXT NOT NULL,
        library_id INTEGER NOT NULL,
        item_key TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        screening_status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (research_job_id, library_id, item_key)
      )`,
    );
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS llm_research_corpus_status_idx
       ON ${RESEARCH_CORPUS_ITEMS_TABLE}
       (research_job_id, screening_status, ordinal)`,
    );
    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${RESEARCH_WORK_ITEMS_TABLE} (
        work_item_id TEXT PRIMARY KEY,
        research_job_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        parent_task_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS llm_research_work_claim_idx
       ON ${RESEARCH_WORK_ITEMS_TABLE}
       (research_job_id, stage, status, updated_at)`,
    );
    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${RESEARCH_PAPER_FINDINGS_TABLE} (
        finding_id TEXT PRIMARY KEY,
        research_job_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        parent_task_id TEXT NOT NULL,
        library_id INTEGER NOT NULL,
        item_key TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    );
    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${RESEARCH_EVIDENCE_TABLE} (
        evidence_ref TEXT PRIMARY KEY,
        research_job_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        parent_task_id TEXT NOT NULL,
        library_id INTEGER NOT NULL,
        item_key TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    );
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS llm_research_evidence_job_idx
       ON ${RESEARCH_EVIDENCE_TABLE}
       (research_job_id, library_id, item_key, created_at)`,
    );
    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${RESEARCH_RECALL_PROBES_TABLE} (
        probe_id TEXT PRIMARY KEY,
        research_job_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        parent_task_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    );
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS llm_research_recall_probe_job_idx
       ON ${RESEARCH_RECALL_PROBES_TABLE} (research_job_id, created_at)`,
    );
    await Zotero.DB.queryAsync(
      `CREATE UNIQUE INDEX IF NOT EXISTS llm_research_paper_finding_item_idx
       ON ${RESEARCH_PAPER_FINDINGS_TABLE}
       (research_job_id, library_id, item_key)`,
    );
    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${RESEARCH_THEME_FINDINGS_TABLE} (
        theme_finding_id TEXT PRIMARY KEY,
        research_job_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        parent_task_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    );
    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${RESEARCH_MUTATION_APPROVALS_TABLE} (
        grant_id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL,
        conversation_key INTEGER NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        approved_at INTEGER NOT NULL
      )`,
    );
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS llm_research_mutation_approval_execution_idx
       ON ${RESEARCH_MUTATION_APPROVALS_TABLE} (execution_id, approved_at DESC)`,
    );
    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${RESEARCH_EDGES_TABLE} (
        edge_id TEXT PRIMARY KEY,
        research_job_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        parent_task_id TEXT NOT NULL,
        source TEXT NOT NULL,
        target TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        lifecycle TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS llm_research_edges_job_idx
       ON ${RESEARCH_EDGES_TABLE} (research_job_id, lifecycle, created_at)`,
    );
    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${RESEARCH_OPEN_QUESTIONS_TABLE} (
        question_id TEXT PRIMARY KEY,
        research_job_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        parent_task_id TEXT NOT NULL,
        status TEXT NOT NULL,
        lifecycle TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS llm_research_open_questions_job_idx
       ON ${RESEARCH_OPEN_QUESTIONS_TABLE} (research_job_id, lifecycle, created_at)`,
    );
  });
}

/** Remove one conversation's rows from every research table, inside the caller's transaction. */
export async function clearDormantResearchRowsInTransaction(
  conversationKey: number,
): Promise<void> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT research_job_id AS researchJobId FROM ${RESEARCH_JOBS_TABLE}
     WHERE conversation_key = ?`,
    [conversationKey],
  ).catch((error) => {
    if (/no such table|no table/i.test(String(error))) return [];
    throw error;
  })) as Array<{ researchJobId?: unknown }>;
  const jobIds = rows
    .map((row) =>
      typeof row.researchJobId === "string" ? row.researchJobId : "",
    )
    .filter(Boolean);
  if (jobIds.length) {
    const placeholders = jobIds.map(() => "?").join(", ");
    for (const table of [
      RESEARCH_EDGES_TABLE,
      RESEARCH_OPEN_QUESTIONS_TABLE,
      RESEARCH_THEME_FINDINGS_TABLE,
      RESEARCH_PAPER_FINDINGS_TABLE,
      RESEARCH_RECALL_PROBES_TABLE,
      RESEARCH_EVIDENCE_TABLE,
      RESEARCH_WORK_ITEMS_TABLE,
      RESEARCH_CORPUS_ITEMS_TABLE,
    ]) {
      await Zotero.DB.queryAsync(
        `DELETE FROM ${table} WHERE research_job_id IN (${placeholders})`,
        jobIds,
      );
    }
  }
  await Zotero.DB.queryAsync(
    `DELETE FROM ${RESEARCH_MUTATION_APPROVALS_TABLE}
     WHERE conversation_key = ?`,
    [conversationKey],
  );
  await Zotero.DB.queryAsync(
    `DELETE FROM ${RESEARCH_JOBS_TABLE} WHERE conversation_key = ?`,
    [conversationKey],
  );
  const snapshots = (await Zotero.DB.queryAsync(
    `SELECT snapshot_id AS snapshotId FROM ${PLAN_SCOPE_SNAPSHOTS_TABLE}
     WHERE conversation_key = ?`,
    [conversationKey],
  ).catch((error) => {
    if (/no such table|no table/i.test(String(error))) return [];
    throw error;
  })) as Array<{ snapshotId?: unknown }>;
  const snapshotIds = snapshots
    .map((row) => (typeof row.snapshotId === "string" ? row.snapshotId : ""))
    .filter(Boolean);
  if (snapshotIds.length) {
    const placeholders = snapshotIds.map(() => "?").join(", ");
    await Zotero.DB.queryAsync(
      `DELETE FROM ${PLAN_SCOPE_SNAPSHOT_ITEMS_TABLE}
       WHERE snapshot_id IN (${placeholders})`,
      snapshotIds,
    );
  }
  await Zotero.DB.queryAsync(
    `DELETE FROM ${PLAN_SCOPE_SNAPSHOTS_TABLE} WHERE conversation_key = ?`,
    [conversationKey],
  );
}
