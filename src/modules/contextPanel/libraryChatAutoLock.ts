/**
 * A sidebar drop that prepares a library chat must survive the native
 * renderer. The item pane re-renders on selection changes, and without a lock
 * the panel resolves the selection back to its paper conversation (see
 * `resolvePreferredConversationMode`), so the prepared library chat and the
 * paper contexts the drop just added disappear mid-flight.
 *
 * The drop therefore takes the same auto lock as the send flow, and releases
 * it the same way: the first lock wins, and only an auto lock is ever
 * released, so a manual lock is never overridden or dropped.
 */
export type LibraryChatLockState = {
  getLockedKey: (libraryID: number) => number | null;
  setLockedKey: (libraryID: number, conversationKey: number | null) => void;
  isAutoLockedKey: (conversationKey: number) => boolean;
  addAutoLockedKey: (conversationKey: number) => void;
  removeAutoLockedKey: (conversationKey: number) => void;
};

export type PreparedLibraryChat = {
  libraryID: number;
  conversationKey: number;
};

const acquiredLocks = new WeakMap<
  PreparedLibraryChat,
  { libraryID: number; conversationKey: number }
>();

function normalizeId(value: unknown): number {
  const numeric = Math.floor(Number(value));
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

/**
 * Locks the conversation a drop prepared for its library. Returns false when
 * the identity is unusable or a lock already exists — an existing lock is the
 * user's choice, and a drop that cannot take the lock must not leave one.
 */
export function lockPreparedLibraryChat(
  state: LibraryChatLockState,
  prepared: PreparedLibraryChat,
): boolean {
  const libraryID = normalizeId(prepared.libraryID);
  const conversationKey = normalizeId(prepared.conversationKey);
  if (!libraryID || !conversationKey) return false;
  if (state.getLockedKey(libraryID) !== null) return false;
  state.setLockedKey(libraryID, conversationKey);
  state.addAutoLockedKey(conversationKey);
  acquiredLocks.set(prepared, { libraryID, conversationKey });
  return true;
}

/**
 * Releases only the lock this drop took, so a failed or superseded drop never
 * strands one. A manual lock — including one on the same conversation — stays.
 */
export function releasePreparedLibraryChat(
  state: LibraryChatLockState,
  prepared: PreparedLibraryChat,
): boolean {
  const libraryID = normalizeId(prepared.libraryID);
  const conversationKey = normalizeId(prepared.conversationKey);
  if (!libraryID || !conversationKey) return false;
  const acquired = acquiredLocks.get(prepared);
  if (
    !acquired ||
    acquired.libraryID !== libraryID ||
    acquired.conversationKey !== conversationKey ||
    !state.isAutoLockedKey(conversationKey)
  ) {
    return false;
  }
  acquiredLocks.delete(prepared);
  state.removeAutoLockedKey(acquired.conversationKey);
  if (state.getLockedKey(acquired.libraryID) === acquired.conversationKey) {
    state.setLockedKey(acquired.libraryID, null);
  }
  return true;
}
