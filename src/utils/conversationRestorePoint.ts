/** Durable, bounded undo storage for remote-history replacement. */
export const CONVERSATION_RESTORE_POINTS_TABLE =
  "llm_for_zotero_conversation_restore_points";
export const CONVERSATION_RESTORE_REFS_TABLE =
  "llm_for_zotero_conversation_restore_refs";
export const MAX_CONVERSATION_RESTORE_BYTES = 16 * 1024 * 1024;

// Deliberately idempotent rather than process-cached: a profile/database may change.
export async function initConversationRestorePointStore(): Promise<void> {
  await Zotero.DB.queryAsync(
    `CREATE TABLE IF NOT EXISTS ${CONVERSATION_RESTORE_POINTS_TABLE} (
      conversation_key INTEGER PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      conversation_instance_id TEXT NOT NULL,
      profile_signature TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      columns_json TEXT NOT NULL,
      messages_json TEXT NOT NULL,
      last_synced_hash TEXT
    )`,
  );
  await Zotero.DB.queryAsync(
    `CREATE TABLE IF NOT EXISTS ${CONVERSATION_RESTORE_REFS_TABLE} (
      conversation_key INTEGER NOT NULL,
      blob_hash TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(conversation_key, blob_hash)
    )`,
  );
  await Zotero.DB.queryAsync(
    `CREATE INDEX IF NOT EXISTS llm_for_zotero_conversation_restore_refs_blob_idx
     ON ${CONVERSATION_RESTORE_REFS_TABLE} (blob_hash)`,
  );
}

/** The caller owns the transaction; missing lazy tables contain no restore point. */
export async function deleteConversationRestorePointInTransaction(
  conversationKey: number,
): Promise<void> {
  for (const table of [
    CONVERSATION_RESTORE_REFS_TABLE,
    CONVERSATION_RESTORE_POINTS_TABLE,
  ]) {
    try {
      await Zotero.DB.queryAsync(
        `DELETE FROM ${table} WHERE conversation_key = ?`,
        [conversationKey],
      );
    } catch (error) {
      if (!/no such table|no table/i.test(String(error))) throw error;
    }
  }
}
