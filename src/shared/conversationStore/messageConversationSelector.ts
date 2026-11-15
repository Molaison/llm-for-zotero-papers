import type {
  ConversationRegistryRow,
  PaperContextJsonColumns,
} from "../conversationRegistry";
import { getRegisteredConversationScope } from "../conversationRegistry";
import { repairRecoverableMessageConversationIDs } from "../conversationMessageIdentityRepair";

declare const Zotero: any;

/**
 * How a conversation's message rows are selected.
 *
 * A message belongs to a conversation by its `conversation_id`, but rows
 * written before that column existed only carry `conversation_key`, and a key
 * can be reissued to a different conversation.  So the selector is either
 * "this conversation id, plus the legacy rows under this key that have no id
 * yet", or — when nothing is registered for the key — a clause that matches
 * nothing at all, because a key with no registered scope must never be read as
 * ownership of whatever rows happen to sit under it.
 */
export type MessageConversationSelector = {
  whereSql: string;
  params: unknown[];
  registered?: ConversationRegistryRow | null;
};

export async function resolveMessageConversationSelector(
  conversationKey: number,
): Promise<MessageConversationSelector> {
  const registered = await getRegisteredConversationScope(conversationKey);
  const conversationID = registered?.conversationID || null;
  return conversationID
    ? {
        whereSql:
          "(conversation_id = ? OR ((conversation_id IS NULL OR TRIM(conversation_id) = '') AND conversation_key = ?))",
        params: [conversationID, conversationKey],
        registered,
      }
    : {
        whereSql: "1 = 0",
        params: [],
        registered,
      };
}

/** The same ownership rule, expressed as a join between two aliased tables. */
export function messageJoinCondition(
  messageAlias: string,
  conversationAlias: string,
): string {
  return (
    `(${messageAlias}.conversation_id = ${conversationAlias}.conversation_id OR ((` +
    `${messageAlias}.conversation_id IS NULL OR TRIM(${messageAlias}.conversation_id) = '') AND ` +
    `${messageAlias}.conversation_key = ${conversationAlias}.conversation_key))`
  );
}

/**
 * The strict selector: conversation id only, no legacy-key fallback.  Used
 * once the legacy rows have been proven unsafe to claim.
 */
export function canonicalMessageConversationSelector(
  registered: ConversationRegistryRow,
): MessageConversationSelector {
  return {
    whereSql: "conversation_id = ?",
    params: [registered.conversationID],
    registered,
  };
}

/**
 * Resolve the selector, first stamping the conversation id onto the legacy
 * rows that provably belong to it.
 *
 * When the repair refuses — the key's stale rows are ambiguous — a read falls
 * back to the strict selector and simply does not see them, while a
 * destructive caller must fail instead: deleting or rewriting rows whose
 * ownership is unproven is the one outcome that cannot be undone.
 */
export async function resolveRepairingMessageConversationSelector(
  config: {
    messagesTable: string;
    storeLabel: string;
    getPaperContextRows: (
      conversationKey: number,
    ) => Promise<PaperContextJsonColumns[]>;
    log: (message: string) => void;
  },
  conversationKey: number,
  options: { destructive?: boolean } = {},
): Promise<MessageConversationSelector> {
  let selector = await resolveMessageConversationSelector(conversationKey);
  if (!selector.registered?.conversationID) return selector;
  const repair = await repairRecoverableMessageConversationIDs({
    queryAsync: Zotero.DB.queryAsync.bind(Zotero.DB),
    tableName: config.messagesTable,
    registered: selector.registered,
    getPaperContextRows: config.getPaperContextRows,
    storeLabel: config.storeLabel,
    log: config.log,
  });
  if (repair.status === "refused") {
    if (options.destructive) {
      throw new Error(
        `Refused destructive ${config.storeLabel} conversation operation for ${conversationKey}: ${repair.reason || "ambiguous stale message ids found"}.`,
      );
    }
    selector = canonicalMessageConversationSelector(selector.registered);
  }
  return selector;
}
