import { appLogger } from "../../core/logging";

/**
 * The warning channel every conversation store writes to.
 *
 * The facade resolves Zotero lazily, so this remains usable in tests and
 * migrations where the host global does not exist.
 */
export function logConversationStoreWarning(message: string): void {
  appLogger.warn(`LLM: ${message}`);
}

/** Render a thrown value for a store warning without losing a non-Error. */
export function formatConversationStoreError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
