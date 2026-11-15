declare const Zotero: any;

import type { ConversationSystem } from "../../shared/types";
import type { PaperContextJsonColumns } from "../../shared/conversationRegistry";
import { generateConversationInstanceID } from "../../shared/conversationRegistry";
import { repairRecoverableCatalogMessageConversationIDs } from "../../shared/conversationMessageIdentityRepair";
import {
  normalizeConversationKey,
  normalizeLibraryID,
  normalizePaperItemID,
} from "../../shared/conversationStore/keyNormalization";
import { logConversationStoreWarning } from "../../shared/conversationStore/diagnostics";

/** Both backend catalogs classify a conversation the same two ways. */
export type ConversationCatalogKind = "global" | "paper";

/**
 * What a backend conversation store has to tell the shared identity mechanics
 * about itself: where its rows live, what system its registry entries are
 * keyed by, how it spells its own name in a warning, and how it builds a
 * conversation id (the id embeds the provider's profile signature, which only
 * the store can supply).
 */
export type ConversationStoreIdentityConfig = {
  system: ConversationSystem;
  storeLabel: string;
  catalogTable: string;
  messagesTable: string;
  buildConversationID: (params: {
    conversationKey: number;
    kind: ConversationCatalogKind;
    libraryID: number;
    paperItemID?: number | null;
  }) => string;
  getPaperContextRows: (
    conversationKey: number,
  ) => Promise<PaperContextJsonColumns[]>;
};

/**
 * Stamp the catalog's conversation ids onto the message rows that provably
 * belong to them, for one conversation or for the whole catalog.
 *
 * Returns the counts the callers act on: a delete refuses outright when any
 * conversation was left unrepaired, because deleting rows whose ownership is
 * ambiguous cannot be undone.
 */
export async function repairRecoverableStoreCatalogMessageConversationIDs(
  config: ConversationStoreIdentityConfig,
  conversationKey?: number,
): Promise<{
  checked: number;
  repaired: number;
  refused: number;
}> {
  const normalizedKey =
    conversationKey === undefined
      ? null
      : normalizeConversationKey(conversationKey);
  if (conversationKey !== undefined && !normalizedKey) {
    return { checked: 0, repaired: 0, refused: 0 };
  }
  return await repairRecoverableCatalogMessageConversationIDs({
    queryAsync: Zotero.DB.queryAsync.bind(Zotero.DB),
    catalogTable: config.catalogTable,
    messageTable: config.messagesTable,
    system: config.system,
    kindSql: "c.kind",
    paperItemIDSql: "c.paper_item_id",
    getPaperContextRows: config.getPaperContextRows,
    storeLabel: config.storeLabel,
    log: logConversationStoreWarning,
    ...(normalizedKey
      ? { filterSql: "c.conversation_key = ?", filterParams: [normalizedKey] }
      : {}),
  });
}

/**
 * Give every catalog row — and the message rows under its key — the
 * conversation id its scope implies.  Rows written before the id column
 * existed are the ones this fills in; a row that already has an id is left
 * alone, because a rebuilt id would orphan the registry entry that points at
 * the old one.
 */
export async function backfillStoreCatalogConversationIDs(
  config: ConversationStoreIdentityConfig,
): Promise<void> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT conversation_key AS conversationKey,
            library_id AS libraryID,
            kind AS kind,
            paper_item_id AS paperItemID
     FROM ${config.catalogTable}`,
  )) as
    | Array<{
        conversationKey?: unknown;
        libraryID?: unknown;
        kind?: unknown;
        paperItemID?: unknown;
      }>
    | undefined;
  for (const row of rows || []) {
    const conversationKey = normalizeConversationKey(
      Number(row.conversationKey),
    );
    const libraryID = normalizeLibraryID(Number(row.libraryID));
    const kind =
      row.kind === "paper" ? "paper" : row.kind === "global" ? "global" : null;
    if (!conversationKey || !libraryID || !kind) continue;
    const paperItemID = normalizePaperItemID(Number(row.paperItemID));
    const conversationID = config.buildConversationID({
      conversationKey,
      kind,
      libraryID,
      paperItemID,
    });
    await Zotero.DB.queryAsync(
      `UPDATE ${config.catalogTable}
       SET conversation_id = ?
       WHERE conversation_key = ?
         AND (conversation_id IS NULL OR TRIM(conversation_id) = '')`,
      [conversationID, conversationKey],
    );
    await Zotero.DB.queryAsync(
      `UPDATE ${config.messagesTable}
       SET conversation_id = ?
       WHERE conversation_key = ?
         AND (conversation_id IS NULL OR TRIM(conversation_id) = '')`,
      [conversationID, conversationKey],
    );
  }
}

/**
 * Adopt the registry's instance id where one exists, and mint a fresh one
 * where none does.  The instance id is what separates a reissued key's new
 * conversation from the deleted one that held the key before it.
 */
export async function backfillStoreCatalogConversationInstanceIDs(
  catalogTable: string,
): Promise<void> {
  await Zotero.DB.queryAsync(
    `UPDATE ${catalogTable}
     SET conversation_instance_id = (
       SELECT r.instance_id
       FROM llm_for_zotero_conversation_registry r
       WHERE r.conversation_id = ${catalogTable}.conversation_id
         AND r.instance_id IS NOT NULL
         AND TRIM(r.instance_id) <> ''
       LIMIT 1
     )
     WHERE (conversation_instance_id IS NULL OR TRIM(conversation_instance_id) = '')
       AND conversation_id IS NOT NULL
       AND EXISTS (
         SELECT 1
         FROM llm_for_zotero_conversation_registry r
         WHERE r.conversation_id = ${catalogTable}.conversation_id
           AND r.instance_id IS NOT NULL
           AND TRIM(r.instance_id) <> ''
       )`,
  );
  const rows = (await Zotero.DB.queryAsync(
    `SELECT conversation_key AS conversationKey
     FROM ${catalogTable}
     WHERE conversation_instance_id IS NULL
        OR TRIM(conversation_instance_id) = ''`,
  )) as Array<{ conversationKey?: unknown }> | undefined;
  for (const row of rows || []) {
    const conversationKey = normalizeConversationKey(
      Number(row.conversationKey),
    );
    if (!conversationKey) continue;
    await Zotero.DB.queryAsync(
      `UPDATE ${catalogTable}
       SET conversation_instance_id = ?
       WHERE conversation_key = ?
         AND (conversation_instance_id IS NULL OR TRIM(conversation_instance_id) = '')`,
      [generateConversationInstanceID(), conversationKey],
    );
  }
}

/**
 * Recover missing catalog timestamps from the conversation's own messages,
 * falling back to now, so ordering a history list never depends on a NULL.
 */
export async function backfillStoreCatalogConversationTimestamps(
  config: Pick<
    ConversationStoreIdentityConfig,
    "catalogTable" | "messagesTable"
  >,
): Promise<void> {
  const now = Date.now();
  await Zotero.DB.queryAsync(
    `UPDATE ${config.catalogTable}
     SET created_at = COALESCE(
       created_at,
       (SELECT MIN(m.timestamp)
        FROM ${config.messagesTable} m
        WHERE m.conversation_key = ${config.catalogTable}.conversation_key),
       ?
     )
     WHERE created_at IS NULL`,
    [now],
  );
  await Zotero.DB.queryAsync(
    `UPDATE ${config.catalogTable}
     SET updated_at = COALESCE(
       updated_at,
       (SELECT MAX(m.timestamp)
        FROM ${config.messagesTable} m
        WHERE m.conversation_key = ${config.catalogTable}.conversation_key),
       created_at,
       ?
     )
     WHERE updated_at IS NULL`,
    [now],
  );
}
