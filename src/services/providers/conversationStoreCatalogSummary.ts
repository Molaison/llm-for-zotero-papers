declare const Zotero: any;

import {
  AMBIGUOUS_PAPER_CONTEXT_INVALID_REASON,
  canMigrateLegacyAmbiguousPaperRegistryScope,
  getConversationScopeValidationDetails,
  getPaperContextOwnershipEvidenceFromRows,
  getRegisteredConversationScope,
  registerConversationScope,
  repairRegisteredConversationScope,
} from "../../shared/conversationRegistry";
import { logConversationStoreWarning } from "../../shared/conversationStore/diagnostics";
import { messageJoinCondition } from "../../shared/conversationStore/messageConversationSelector";
import {
  normalizeConversationKey,
  normalizePaperItemID,
} from "../../shared/conversationStore/keyNormalization";
import {
  repairRecoverableStoreCatalogMessageConversationIDs,
  type ConversationCatalogKind,
  type ConversationStoreIdentityConfig,
} from "./conversationStoreIdentityRepair";

/**
 * The part of a provider's conversation summary these mechanics read.  Each
 * backend store has its own summary type with extra provider columns on top of
 * this shape, and the repair returns the caller's own type back.
 */
export type ConversationCatalogSummary = {
  conversationID: string;
  conversationKey: number;
  libraryID: number;
  kind: ConversationCatalogKind;
  paperItemID?: number;
  createdAt: number;
  updatedAt: number;
  title?: string;
};

/**
 * Everything the identity mechanics need, plus the preference write that
 * remembers which conversation a paper was last read in — the one side effect
 * of a scope repair that lives outside the database.
 */
export type ConversationStoreCatalogConfig = ConversationStoreIdentityConfig & {
  rememberPaperConversationKey: (
    libraryID: number,
    paperItemID: number,
    conversationKey: number,
  ) => void;
};

/**
 * Recompute the catalog columns that cache what the message rows say: the
 * first user turn's text, the latest activity timestamp, and the user turn
 * count.  Listing a history must not have to scan messages, so the catalog row
 * carries the answer and this is what keeps it true.
 *
 * Passing no key refreshes the whole catalog, which is what startup does after
 * a migration; passing one key is the per-write refresh.
 */
export async function refreshStoreConversationCatalogSummary(
  config: ConversationStoreCatalogConfig,
  conversationKey?: number,
): Promise<void> {
  const normalizedKey =
    conversationKey === undefined
      ? null
      : normalizeConversationKey(conversationKey);
  if (conversationKey !== undefined && !normalizedKey) return;
  await repairRecoverableStoreCatalogMessageConversationIDs(
    config,
    normalizedKey || undefined,
  );
  const whereSql = normalizedKey ? "WHERE conversation_key = ?" : "";
  const params = normalizedKey ? [normalizedKey] : [];
  await Zotero.DB.queryAsync(
    `UPDATE ${config.catalogTable}
     SET first_user_title = (
           SELECT m0.text
           FROM ${config.messagesTable} m0
           WHERE ${messageJoinCondition("m0", config.catalogTable)}
             AND m0.role = 'user'
           ORDER BY m0.timestamp ASC, m0.id ASC
           LIMIT 1
         ),
         last_activity_at = COALESCE(
           (
             SELECT MAX(m.timestamp)
             FROM ${config.messagesTable} m
             WHERE ${messageJoinCondition("m", config.catalogTable)}
           ),
           updated_at,
           created_at
         ),
         user_turn_count = COALESCE(
           (
             SELECT SUM(CASE WHEN m.role = 'user' THEN 1 ELSE 0 END)
             FROM ${config.messagesTable} m
             WHERE ${messageJoinCondition("m", config.catalogTable)}
           ),
           0
         )
     ${whereSql}`,
    params,
  );
}

/** Does an existing catalog row already describe the scope being asked for? */
export function sameStoreCatalogScope(
  existing: ConversationCatalogSummary,
  params: {
    libraryID: number;
    kind: ConversationCatalogKind;
    paperItemID?: number | null;
  },
): boolean {
  const requestedPaperItemID =
    params.kind === "paper"
      ? normalizePaperItemID(Number(params.paperItemID))
      : null;
  return (
    existing.libraryID === params.libraryID &&
    existing.kind === params.kind &&
    (existing.paperItemID || null) === (requestedPaperItemID || null)
  );
}

/**
 * Drop the summaries whose registered scope cannot be validated or repaired,
 * and — when the caller is listing one paper's conversations — the repaired
 * ones that turned out to belong to a different paper.
 */
export async function filterValidStoreConversationSummaries<
  T extends ConversationCatalogSummary,
>(
  config: ConversationStoreCatalogConfig,
  summaries: T[],
  expectedPaperItemID?: number | null,
): Promise<T[]> {
  const filtered: T[] = [];
  for (const summary of summaries) {
    const validSummary = await validateOrRepairStoreConversationSummary(
      config,
      summary,
    );
    if (!validSummary) continue;
    const normalizedExpectedPaperItemID = normalizePaperItemID(
      Number(expectedPaperItemID),
    );
    if (
      normalizedExpectedPaperItemID &&
      validSummary.kind === "paper" &&
      validSummary.paperItemID !== normalizedExpectedPaperItemID
    ) {
      continue;
    }
    filtered.push(validSummary);
  }
  return filtered;
}

/**
 * Reconcile one catalog row against the conversation registry.
 *
 * The registry is the authority on what a conversation is scoped to, and a
 * catalog row that contradicts it — or that has no registry entry at all,
 * because the row predates the registry — is not automatically wrong.  So the
 * disagreements are worked through in order: a legacy ambiguous-paper
 * invalidation is migrated, a missing entry for a self-describing scope is
 * registered, and a paper conversation whose paper is unknown is inferred from
 * the papers its own messages name.  Only a row that survives none of that is
 * dropped from the caller's list.
 */
export async function validateOrRepairStoreConversationSummary<
  T extends ConversationCatalogSummary,
>(config: ConversationStoreCatalogConfig, summary: T): Promise<T | null> {
  const validation = await getConversationScopeValidationDetails({
    conversationID: summary.conversationID,
    conversationKey: summary.conversationKey,
    system: config.system,
    kind: summary.kind,
    libraryID: summary.libraryID,
    paperItemID: summary.paperItemID,
  });
  if (validation.valid) return summary;

  const registered =
    validation.registered ||
    (await getRegisteredConversationScope(summary.conversationKey));
  if (
    canMigrateLegacyAmbiguousPaperRegistryScope(registered, {
      system: config.system,
      kind: summary.kind,
      libraryID: summary.libraryID,
      paperItemID: summary.paperItemID,
    })
  ) {
    await repairRegisteredConversationScope({
      conversationID: summary.conversationID,
      conversationKey: summary.conversationKey,
      system: config.system,
      kind: "paper",
      libraryID: summary.libraryID,
      paperItemID: summary.paperItemID,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
      title: summary.title,
    });
    logConversationStoreWarning(
      `Migrated ${config.storeLabel} conversation ${summary.conversationKey} from legacy ${AMBIGUOUS_PAPER_CONTEXT_INVALID_REASON} invalidation to primary paper ${summary.paperItemID}.`,
    );
    return summary;
  }
  if (registered) return null;

  if (summary.kind === "global") {
    const registeredMissingGlobal = await registerConversationScope({
      conversationID: summary.conversationID,
      conversationKey: summary.conversationKey,
      system: config.system,
      kind: summary.kind,
      libraryID: summary.libraryID,
      paperItemID: summary.paperItemID,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
      title: summary.title,
    });
    return registeredMissingGlobal ? summary : null;
  }

  if (summary.paperItemID) {
    const registeredMissingPaper = await registerConversationScope({
      conversationID: summary.conversationID,
      conversationKey: summary.conversationKey,
      system: config.system,
      kind: "paper",
      libraryID: summary.libraryID,
      paperItemID: summary.paperItemID,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
      title: summary.title,
    });
    return registeredMissingPaper ? summary : null;
  }

  const evidence = getPaperContextOwnershipEvidenceFromRows(
    await config.getPaperContextRows(summary.conversationKey),
  );
  const inferredPaperItemID = evidence.singlePaperItemID;
  if (inferredPaperItemID) {
    const repairedConversationID = config.buildConversationID({
      conversationKey: summary.conversationKey,
      kind: "paper",
      libraryID: summary.libraryID,
      paperItemID: inferredPaperItemID,
    });
    await Zotero.DB.queryAsync(
      `UPDATE ${config.catalogTable}
       SET conversation_id = ?,
           paper_item_id = ?
       WHERE conversation_key = ?`,
      [repairedConversationID, inferredPaperItemID, summary.conversationKey],
    );
    await Zotero.DB.queryAsync(
      `UPDATE ${config.messagesTable}
       SET conversation_id = ?
       WHERE conversation_key = ?`,
      [repairedConversationID, summary.conversationKey],
    );
    config.rememberPaperConversationKey(
      summary.libraryID,
      inferredPaperItemID,
      summary.conversationKey,
    );
    await repairRegisteredConversationScope({
      conversationKey: summary.conversationKey,
      system: config.system,
      kind: "paper",
      libraryID: summary.libraryID,
      paperItemID: inferredPaperItemID,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
      title: summary.title,
    });
    logConversationStoreWarning(
      `Repaired ${config.storeLabel} conversation ${summary.conversationKey} to paper ${inferredPaperItemID} while loading history.`,
    );
    return {
      ...summary,
      conversationID: repairedConversationID,
      paperItemID: inferredPaperItemID,
    };
  }

  return null;
}
