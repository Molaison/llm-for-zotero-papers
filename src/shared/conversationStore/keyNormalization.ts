/**
 * The value normalization every conversation store applies at its boundary.
 *
 * Conversation keys, library ids and paper item ids all arrive from callers,
 * database rows and preferences, where a missing value is variously `0`,
 * `null`, `undefined` or `NaN`.  Each store collapsed all of those to `null`
 * with the same three lines; the rule is stated once here so a store cannot
 * quietly accept a key the others reject.
 */
export function normalizeConversationKey(
  conversationKey: number,
): number | null {
  if (!Number.isFinite(conversationKey)) return null;
  const normalized = Math.floor(conversationKey);
  return normalized > 0 ? normalized : null;
}

export function normalizeLibraryID(libraryID: number): number | null {
  if (!Number.isFinite(libraryID)) return null;
  const normalized = Math.floor(libraryID);
  return normalized > 0 ? normalized : null;
}

export function normalizePaperItemID(paperItemID: number): number | null {
  if (!Number.isFinite(paperItemID)) return null;
  const normalized = Math.floor(paperItemID);
  return normalized > 0 ? normalized : null;
}

/** A history limit is always at least one row; a junk limit falls back. */
export function normalizeLimit(limit: number, fallback: number): number {
  if (!Number.isFinite(limit)) return fallback;
  return Math.max(1, Math.floor(limit));
}

/** `null` means "no limit", and so does any value that cannot be one. */
export function normalizeOptionalLimit(
  limit: number | null | undefined,
): number | null {
  if (limit === null) return null;
  if (!Number.isFinite(Number(limit))) return null;
  const normalized = Math.floor(Number(limit));
  return normalized > 0 ? normalized : null;
}

/** A catalog row with no usable timestamp is treated as touched just now. */
export function normalizeCatalogTimestamp(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return Date.now();
  return Math.floor(parsed);
}
