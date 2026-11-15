import type { ConversationSystem } from "../types";
import {
  deleteConversationSearchIndexRow,
  refreshConversationSearchIndexForConversation,
} from "../conversationSearchIndex";
import {
  formatConversationStoreError,
  logConversationStoreWarning,
} from "./diagnostics";

/**
 * Search-index maintenance as the conversation stores need it.
 *
 * The index is a derived view of the catalogs: a store that fails to refresh it
 * has a stale search result, not a lost conversation, so a refresh failure is
 * logged and swallowed.  Deletion is not optional in the same way — it runs
 * through the shared row delete and reports its own failure to the caller.
 *
 * `storeLabel` is the provider's name as it appears in the warning ("upstream",
 * "Codex", "Claude"); `system` is the value the index rows are keyed by.
 */
export async function refreshStoreConversationSearchIndex(params: {
  system: ConversationSystem;
  storeLabel: string;
  conversationKey: number;
}): Promise<void> {
  try {
    await refreshConversationSearchIndexForConversation({
      system: params.system,
      conversationKey: params.conversationKey,
    });
  } catch (error) {
    logConversationStoreWarning(
      `Failed to refresh ${params.storeLabel} conversation search index for ${params.conversationKey}: ${formatConversationStoreError(error)}`,
    );
  }
}

export async function deleteStoreConversationSearchIndex(params: {
  system: ConversationSystem;
  conversationKey: number;
}): Promise<void> {
  await deleteConversationSearchIndexRow({
    system: params.system,
    conversationKey: params.conversationKey,
  });
}
