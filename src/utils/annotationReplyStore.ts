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
function decodeBatch(row: Record<string, unknown>): AnnotationReplyBatch {
  const payload = String(row.payload);
  const batch = JSON.parse(payload);
  if (
    !batch ||
    typeof batch.id !== "string" ||
    !batch.id ||
    batch.id !== String(row.id) ||
    batch.protocol !== "zotero-annotation-replies/v1" ||
    !Number.isSafeInteger(batch.conversationKey) ||
    batch.conversationKey !== Number(row.conversation_key) ||
    !Number.isSafeInteger(batch.createdAt) ||
    batch.createdAt !== Number(row.created_at) ||
    (batch.owner !== undefined && typeof batch.owner !== "string") ||
    (batch.stage !== undefined &&
      !["reserved", "armed"].includes(batch.stage)) ||
    !Array.isArray(batch.targets) ||
    !batch.targets.length ||
    new Set(
      batch.targets.map((target: { identity?: unknown }) => target?.identity),
    ).size !== batch.targets.length ||
    !batch.targets.every(
      (target: AnnotationReplyBatch["targets"][number]) =>
        target &&
        Number.isSafeInteger(target.libraryID) &&
        Number.isSafeInteger(target.attachmentID) &&
        Number.isSafeInteger(target.annotationID) &&
        typeof target.attachmentKey === "string" &&
        typeof target.annotationKey === "string" &&
        target.identity ===
          `${target.libraryID}:${target.attachmentKey}:${target.annotationKey}` &&
        typeof target.version === "string" &&
        !!target.version &&
        typeof target.title === "string" &&
        typeof target.comment === "string" &&
        typeof target.quotedText === "string" &&
        target.position &&
        Number.isSafeInteger(target.position.pageIndex) &&
        target.position.pageIndex >= 0 &&
        Array.isArray(target.position.rects) &&
        target.position.rects.length > 0,
    ) ||
    !Array.isArray(batch.pages) ||
    ![
      "inflight",
      "uncertain",
      "answered",
      "invalid",
      "applied",
      "not-sent",
      "retry-allowed",
    ].includes(batch.status) ||
    (batch.rawAnswer !== undefined && typeof batch.rawAnswer !== "string") ||
    (batch.revision !== undefined &&
      (!Number.isSafeInteger(batch.revision) || batch.revision < 0))
  )
    throw new Error("便签记录损坏；保留记录与占用，禁止回写或释放。");
  return { ...batch, revision: batch.revision ?? 0 };
}
function readBatch(row: Record<string, unknown>): AnnotationReplyBatch {
  try {
    return decodeBatch(row);
  } catch {
    return {
      id: String(row.id),
      conversationKey: Number(row.conversation_key),
      createdAt: Number(row.created_at),
      protocol: "zotero-annotation-replies/v1",
      status: "corrupt",
      revision: 0,
      targets: [],
      pages: [],
      error: "便签记录损坏；原始记录与占用已保留，禁止回写或释放。",
    };
  }
}
export async function loadAnnotationReplyBatches(
  conversationKey?: number,
): Promise<AnnotationReplyBatch[]> {
  await initAnnotationReplyStore();
  const rows = await Zotero.DB.queryAsync(
    `SELECT id, conversation_key, created_at, payload FROM ${ANNOTATION_BATCHES}${conversationKey === undefined ? "" : " WHERE conversation_key = ?"} ORDER BY created_at DESC`,
    conversationKey === undefined ? [] : [conversationKey],
  );
  return (rows || []).map((row) => readBatch(row));
}
export async function loadAnnotationReplyBatch(
  id: string,
): Promise<AnnotationReplyBatch> {
  await initAnnotationReplyStore();
  const rows = await Zotero.DB.queryAsync(
    `SELECT id, conversation_key, created_at, payload FROM ${ANNOTATION_BATCHES} WHERE id = ?`,
    [id],
  );
  if (!rows?.length) throw new Error("找不到批注批次；未发送或回写。");
  return readBatch(rows[0]);
}
export async function saveAnnotationReplyBatch(
  batch: AnnotationReplyBatch,
): Promise<void> {
  if (batch.status === "corrupt")
    throw new Error("便签记录损坏；保留原始记录与占用，禁止写入。");
  await Zotero.DB.queryAsync(
    `INSERT OR REPLACE INTO ${ANNOTATION_BATCHES} (id, conversation_key, created_at, payload) VALUES (?, ?, ?, ?)`,
    [batch.id, batch.conversationKey, batch.createdAt, JSON.stringify(batch)],
  );
}
export async function getAnnotationReplyClaims(
  identity: string,
): Promise<
  Array<{ version: string; batch_id: string; generated_block: string | null }>
> {
  await initAnnotationReplyStore();
  return (
    (await Zotero.DB.queryAsync(
      `SELECT version, batch_id, generated_block FROM ${ANNOTATION_CLAIMS} WHERE identity = ?`,
      [identity],
    )) || []
  ).map((row) => ({
    version: String(row.version),
    batch_id: String(row.batch_id),
    generated_block:
      row.generated_block == null ? null : String(row.generated_block),
  }));
}
export async function reserveAnnotationReplyBatch(
  batch: AnnotationReplyBatch,
): Promise<void> {
  await initAnnotationReplyStore();
  for (const target of batch.targets) {
    const claims = await getAnnotationReplyClaims(target.identity);
    if (claims.some((claim) => claim.version === target.version))
      throw new Error("此版本已发送、进行中或结果未确认；不会重复发送。");
    await Zotero.DB.queryAsync(
      `INSERT INTO ${ANNOTATION_CLAIMS} (identity, version, batch_id) VALUES (?, ?, ?)`,
      [target.identity, target.version, batch.id],
    );
  }
  await saveAnnotationReplyBatch(batch);
}
export async function releaseAnnotationReplyClaim(
  identity: string,
  version: string,
  batchId: string,
): Promise<void> {
  await Zotero.DB.queryAsync(
    `DELETE FROM ${ANNOTATION_CLAIMS} WHERE identity = ? AND version = ? AND batch_id = ? AND generated_block IS NULL`,
    [identity, version, batchId],
  );
  await requireOneClaimChange();
}
async function requireOneClaimChange(): Promise<void> {
  const rows = await Zotero.DB.queryAsync("SELECT changes() AS count");
  if (Number(rows?.[0]?.count) !== 1)
    throw new Error("便签占用归属已变化；事务已取消。");
}
export async function recordAnnotationReplyBlock(
  identity: string,
  version: string,
  block: string,
  batchId: string,
): Promise<void> {
  await Zotero.DB.queryAsync(
    `UPDATE ${ANNOTATION_CLAIMS} SET generated_block = ? WHERE identity = ? AND version = ? AND batch_id = ?`,
    [block, identity, version, batchId],
  );
  await requireOneClaimChange();
}
