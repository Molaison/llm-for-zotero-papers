import { assert } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import {
  lockPreparedLibraryChat,
  releasePreparedLibraryChat,
  type LibraryChatLockState,
} from "../src/modules/contextPanel/libraryChatAutoLock";
import {
  activeGlobalConversationByLibrary,
  addAutoLockedGlobalConversationKey,
  chatHistory,
  initializedConversationComposeContextKeys,
  isAutoLockedGlobalConversation,
  loadedConversationKeys,
  removeAutoLockedGlobalConversationKey,
  selectedPaperContextCache,
} from "../src/modules/contextPanel/state";
import {
  getLockedGlobalConversationKey,
  setLockedGlobalConversationKey,
} from "../src/modules/contextPanel/prefHelpers";
import {
  createGlobalPortalItem,
  resolveRememberedGlobalPanelItem,
} from "../src/modules/contextPanel/portalScope";
import {
  bindProvisionedConversationKey,
  getConversationKey,
} from "../src/modules/contextPanel/conversationIdentity";
import { restoreConversationComposeContext } from "../src/modules/contextPanel/chat";

const LIBRARY_ID = 1;
const PREPARED_KEY = 2_500_000_001;
const REMEMBERED_KEY = 2_500_000_002;
const MANUAL_KEY = 2_500_000_003;

const globalScope = globalThis as typeof globalThis & {
  Zotero?: Record<string, unknown>;
};
const originalZotero = globalScope.Zotero;
const prefs = new Map<string, unknown>();

// The same composition setupHandlers uses. It stays in the test so the lock
// policy itself remains free of Zotero and DOM access.
const lockState: LibraryChatLockState = {
  getLockedKey: (libraryID) => getLockedGlobalConversationKey(libraryID),
  setLockedKey: (libraryID, conversationKey) =>
    setLockedGlobalConversationKey(libraryID, conversationKey),
  isAutoLockedKey: (conversationKey) =>
    isAutoLockedGlobalConversation(conversationKey),
  addAutoLockedKey: (conversationKey) =>
    addAutoLockedGlobalConversationKey(conversationKey),
  removeAutoLockedKey: (conversationKey) =>
    removeAutoLockedGlobalConversationKey(conversationKey),
};

/** The conversation key the native item pane resolves for a library. */
function resolvedPaneConversationKey(): number {
  return Math.floor(
    Number(resolveRememberedGlobalPanelItem(LIBRARY_ID, "upstream")?.id || 0),
  );
}

describe("library chat auto lock for a prepared sidebar drop", function () {
  beforeEach(function () {
    prefs.clear();
    globalScope.Zotero = {
      Prefs: {
        get: (key: string) => (prefs.has(key) ? prefs.get(key) : undefined),
        set: (key: string, value: unknown) => {
          prefs.set(key, value);
        },
      },
    };
    // The pane already remembers an older library chat for this library.
    activeGlobalConversationByLibrary.set(LIBRARY_ID, REMEMBERED_KEY);
  });

  afterEach(function () {
    activeGlobalConversationByLibrary.delete(LIBRARY_ID);
    selectedPaperContextCache.delete(PREPARED_KEY);
    loadedConversationKeys.delete(REMEMBERED_KEY);
    chatHistory.delete(REMEMBERED_KEY);
    initializedConversationComposeContextKeys.delete(PREPARED_KEY);
    for (const key of [PREPARED_KEY, REMEMBERED_KEY, MANUAL_KEY]) {
      removeAutoLockedGlobalConversationKey(key);
    }
    if (originalZotero === undefined) delete globalScope.Zotero;
    else globalScope.Zotero = originalZotero;
  });

  it("holds the prepared conversation so a later native render resolves to it", function () {
    assert.equal(
      resolvedPaneConversationKey(),
      REMEMBERED_KEY,
      "without a lock the pane resolves to the remembered library chat",
    );

    selectedPaperContextCache.set(PREPARED_KEY, [
      { itemId: 101, contextItemId: 102, title: "First paper" },
      { itemId: 201, contextItemId: 202, title: "Second paper" },
    ]);
    assert.isNull(
      getLockedGlobalConversationKey(LIBRARY_ID),
      "the library chat remains unlocked until both context upserts succeed",
    );
    assert.isTrue(
      lockPreparedLibraryChat(lockState, {
        libraryID: LIBRARY_ID,
        conversationKey: PREPARED_KEY,
      }),
    );

    assert.equal(
      getLockedGlobalConversationKey(LIBRARY_ID),
      PREPARED_KEY,
      "the prepared conversation owns the lock",
    );
    assert.isTrue(
      isAutoLockedGlobalConversation(PREPARED_KEY),
      "the drop takes an auto lock, so the send flow still releases it",
    );
    assert.equal(
      resolvedPaneConversationKey(),
      PREPARED_KEY,
      "a deferred native render keeps the prepared library chat",
    );
    const rerendered = resolveRememberedGlobalPanelItem(
      LIBRARY_ID,
      "upstream",
    )!;
    assert.equal(getConversationKey(rerendered), PREPARED_KEY);
    assert.lengthOf(
      selectedPaperContextCache.get(rerendered.id) || [],
      2,
      "both explicit context chips still belong to the rerendered owner",
    );
  });

  it("does not restore history over explicitly initialized context when item and conversation keys differ", function () {
    const portal = createGlobalPortalItem(LIBRARY_ID, PREPARED_KEY);
    bindProvisionedConversationKey(portal, REMEMBERED_KEY);
    assert.notEqual(portal.id, getConversationKey(portal));

    // Explicitly clearing the composer leaves an initialized but empty owner.
    // History restore must honor that item-scoped marker, not repopulate it.
    initializedConversationComposeContextKeys.add(portal.id);
    loadedConversationKeys.add(REMEMBERED_KEY);
    chatHistory.set(REMEMBERED_KEY, [
      {
        role: "user",
        text: "Old paper",
        timestamp: 1,
        paperContexts: [
          { itemId: 301, contextItemId: 302, title: "Old paper" },
        ],
      },
    ] as any);

    assert.isFalse(restoreConversationComposeContext(portal));
    assert.isUndefined(selectedPaperContextCache.get(portal.id));
  });

  it("never overrides or releases a manual lock", function () {
    setLockedGlobalConversationKey(LIBRARY_ID, MANUAL_KEY);

    assert.isFalse(
      lockPreparedLibraryChat(lockState, {
        libraryID: LIBRARY_ID,
        conversationKey: PREPARED_KEY,
      }),
      "a manual lock wins over a prepared drop",
    );
    assert.equal(getLockedGlobalConversationKey(LIBRARY_ID), MANUAL_KEY);
    assert.isFalse(isAutoLockedGlobalConversation(MANUAL_KEY));
    assert.equal(
      resolvedPaneConversationKey(),
      MANUAL_KEY,
      "the pane stays on the user's locked chat",
    );

    assert.isFalse(
      releasePreparedLibraryChat(lockState, {
        libraryID: LIBRARY_ID,
        conversationKey: MANUAL_KEY,
      }),
      "releasing never touches a manual lock, even on the same key",
    );
    assert.equal(getLockedGlobalConversationKey(LIBRARY_ID), MANUAL_KEY);
  });

  it("does not release an auto lock taken by another prepared attempt", function () {
    const owner = {
      libraryID: LIBRARY_ID,
      conversationKey: PREPARED_KEY,
    };
    const failed = {
      libraryID: LIBRARY_ID,
      conversationKey: PREPARED_KEY,
    };

    assert.isTrue(lockPreparedLibraryChat(lockState, owner));
    assert.isFalse(
      lockPreparedLibraryChat(lockState, failed),
      "first lock wins for the same key",
    );
    assert.isFalse(
      releasePreparedLibraryChat(lockState, failed),
      "a failed attempt cannot release the owner's lock",
    );
    assert.equal(getLockedGlobalConversationKey(LIBRARY_ID), PREPARED_KEY);
    assert.isTrue(
      isAutoLockedGlobalConversation(PREPARED_KEY),
      "the owner's auto flag remains",
    );

    assert.isTrue(releasePreparedLibraryChat(lockState, owner));
    assert.isNull(getLockedGlobalConversationKey(LIBRARY_ID));
    assert.isFalse(isAutoLockedGlobalConversation(PREPARED_KEY));
  });

  it("leaves no auto lock when the drop does not land", function () {
    // The sidebar prepared a conversation, then the add reported no change.
    const prepared = {
      libraryID: LIBRARY_ID,
      conversationKey: PREPARED_KEY,
    };
    assert.isFalse(
      releasePreparedLibraryChat(lockState, prepared),
      "releasing a lock the drop never took is a no-op",
    );
    assert.isNull(getLockedGlobalConversationKey(LIBRARY_ID));
    assert.isFalse(isAutoLockedGlobalConversation(PREPARED_KEY));
    assert.equal(
      resolvedPaneConversationKey(),
      REMEMBERED_KEY,
      "a failed drop leaves the remembered chat in charge",
    );

    // A lock that was taken and then rolled back is released completely.
    assert.isTrue(lockPreparedLibraryChat(lockState, prepared));
    assert.isTrue(releasePreparedLibraryChat(lockState, prepared));
    assert.isFalse(
      releasePreparedLibraryChat(lockState, prepared),
      "a consumed attempt cannot release twice",
    );
    assert.isNull(getLockedGlobalConversationKey(LIBRARY_ID));
    assert.isFalse(isAutoLockedGlobalConversation(PREPARED_KEY));
    assert.equal(resolvedPaneConversationKey(), REMEMBERED_KEY);
  });

  it("ignores unusable identities instead of locking them", function () {
    assert.isFalse(
      lockPreparedLibraryChat(lockState, {
        libraryID: 0,
        conversationKey: PREPARED_KEY,
      }),
    );
    assert.isFalse(
      lockPreparedLibraryChat(lockState, {
        libraryID: LIBRARY_ID,
        conversationKey: 0,
      }),
    );
    assert.isNull(getLockedGlobalConversationKey(LIBRARY_ID));
  });
});
