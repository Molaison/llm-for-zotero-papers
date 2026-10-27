import type { AnnotationReplyBatch } from "../shared/types";

// Annotation delivery lives in the chat SQLite store, not reader preferences.
// Claims span conversations so changing tabs cannot resend a frozen version.
// This module stays free of the chat store so the presentation layer can read
// a batch without dragging the agent tool stack into its import graph.
const ANNOTATION_BATCHES = "llm_for_zotero_annotation_batches";
const ANNOTATION_CLAIMS = "llm_for_zotero_annotation_claims";

export async function initAnnotationReplyStore(): Promise<void> {
  await Zotero.DB.queryAsync(`CREATE TABLE IF NOT EXISTS ${ANNOTATION_BATCHES} (
    id TEXT PRIMARY KEY, conversation_key INTEGER NOT NULL, created_at INTEGER NOT NULL, payload TEXT NOT NULL)`);
  await Zotero.DB.queryAsync(`CREATE TABLE IF NOT EXISTS ${ANNOTATION_CLAIMS} (
    identity TEXT NOT NULL, version TEXT NOT NULL, batch_id TEXT NOT NULL,
    generated_block TEXT, PRIMARY KEY(identity, version))`);
}
export async function loadAnnotationReplyBatches(conversationKey?: number): Promise<AnnotationReplyBatch[]> {
  await initAnnotationReplyStore();
  const rows = await Zotero.DB.queryAsync(`SELECT payload FROM ${ANNOTATION_BATCHES}${conversationKey === undefined ? "" : " WHERE conversation_key = ?"} ORDER BY created_at DESC`, conversationKey === undefined ? [] : [conversationKey]);
  return (rows || []).map(row => JSON.parse(String(row.payload)));
}
export async function loadAnnotationReplyBatch(id: string): Promise<AnnotationReplyBatch> {
  await initAnnotationReplyStore();
  const rows = await Zotero.DB.queryAsync(`SELECT payload FROM ${ANNOTATION_BATCHES} WHERE id = ?`, [id]);
  if (!rows?.length) throw new Error("找不到批注批次；未发送或回写。");
  return JSON.parse(rows[0].payload);
}
export async function saveAnnotationReplyBatch(batch: AnnotationReplyBatch): Promise<void> {
  await Zotero.DB.queryAsync(`INSERT OR REPLACE INTO ${ANNOTATION_BATCHES} (id, conversation_key, created_at, payload) VALUES (?, ?, ?, ?)`, [batch.id, batch.conversationKey, batch.createdAt, JSON.stringify(batch)]);
}
export async function getAnnotationReplyClaims(identity: string): Promise<Array<{version: string; batch_id: string; generated_block: string | null}>> {
  await initAnnotationReplyStore();
  return (await Zotero.DB.queryAsync(`SELECT version, batch_id, generated_block FROM ${ANNOTATION_CLAIMS} WHERE identity = ?`, [identity]) || []).map(row => ({version: String(row.version), batch_id: String(row.batch_id), generated_block: row.generated_block == null ? null : String(row.generated_block)}));
}
export async function reserveAnnotationReplyBatch(batch: AnnotationReplyBatch): Promise<void> {
  await initAnnotationReplyStore();
  await Zotero.DB.executeTransaction(async () => {
    for (const target of batch.targets) {
      const claims = await getAnnotationReplyClaims(target.identity);
      if (claims.some(claim => claim.version === target.version)) throw new Error(`${target.identity} 此版本已发送、进行中或结果未确认；不会重复发送。`);
      await Zotero.DB.queryAsync(`INSERT INTO ${ANNOTATION_CLAIMS} (identity, version, batch_id) VALUES (?, ?, ?)`, [target.identity, target.version, batch.id]);
    }
    await saveAnnotationReplyBatch(batch);
  });
}
export async function releaseUnsentAnnotationReplyBatch(batch: AnnotationReplyBatch): Promise<void> {
  await Zotero.DB.executeTransaction(async () => {
    await Zotero.DB.queryAsync(`DELETE FROM ${ANNOTATION_CLAIMS} WHERE batch_id = ? AND generated_block IS NULL`, [batch.id]);
    batch.status = "not-sent";
    await saveAnnotationReplyBatch(batch);
  });
}
export async function recordAnnotationReplyBlock(identity: string, version: string, block: string): Promise<void> {
  await Zotero.DB.queryAsync(`UPDATE ${ANNOTATION_CLAIMS} SET generated_block = ? WHERE identity = ? AND version = ?`, [block, identity, version]);
}
