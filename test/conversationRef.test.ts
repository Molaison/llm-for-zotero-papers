import { assert } from "chai";
import {
  conversationRefCacheKey,
  conversationRefToRegistryScope,
  normalizeConversationRefFromRegistry,
  resolveConversationRefForKey,
} from "../src/shared/conversationRef";

describe("conversation refs", function () {
  const globalScope = globalThis as typeof globalThis & {
    Zotero?: Record<string, unknown>;
  };
  const originalZotero = globalScope.Zotero;

  afterEach(function () {
    globalScope.Zotero = originalZotero;
  });

  it("normalizes a valid paper registry row into an ID-first ref", function () {
    const ref = normalizeConversationRefFromRegistry({
      conversationID: " opaque-chat-id ",
      conversationKey: 7101,
      system: "codex",
      kind: "paper",
      profileSignature: "profile-test",
      libraryID: 1,
      paperItemID: 3196,
      valid: true,
    });

    assert.deepEqual(ref, {
      conversationID: "opaque-chat-id",
      legacyConversationKey: 7101,
      system: "codex",
      kind: "paper",
      libraryID: 1,
      paperItemID: 3196,
      profileSignature: "profile-test",
    });
    assert.equal(ref ? conversationRefCacheKey(ref) : "", "opaque-chat-id");
    assert.deepEqual(ref ? conversationRefToRegistryScope(ref) : null, {
      conversationID: "opaque-chat-id",
      conversationKey: 7101,
      system: "codex",
      kind: "paper",
      libraryID: 1,
      paperItemID: 3196,
      profileSignature: "profile-test",
    });
  });

  it("rejects invalid or incomplete registry rows", function () {
    assert.equal(
      normalizeConversationRefFromRegistry({
        conversationID: "opaque-chat-id",
        conversationKey: 7101,
        system: "codex",
        kind: "paper",
        profileSignature: "profile-test",
        libraryID: 1,
        paperItemID: 3196,
        valid: false,
      }),
      null,
    );
    assert.equal(
      normalizeConversationRefFromRegistry({
        conversationID: "opaque-chat-id",
        conversationKey: 7101,
        system: "codex",
        kind: "paper",
        profileSignature: "profile-test",
        libraryID: 1,
        paperItemID: null,
        valid: true,
      }),
      null,
    );
  });

  it("resolves a ref from the registry by legacy key", async function () {
    globalScope.Zotero = {
      DB: {
        queryAsync: async (sql: string) => {
          if (
            sql.includes("FROM llm_for_zotero_conversation_registry") &&
            sql.includes("WHERE legacy_conversation_key = ?")
          ) {
            return [
              {
                conversationID: "opaque-chat-id",
                conversationKey: 8101,
                system: "claude_code",
                kind: "global",
                profileSignature: "profile-test",
                libraryID: 2,
                paperItemID: null,
                valid: 1,
              },
            ];
          }
          return [];
        },
      },
    };

    const ref = await resolveConversationRefForKey(8101);

    assert.deepEqual(ref, {
      conversationID: "opaque-chat-id",
      legacyConversationKey: 8101,
      system: "claude_code",
      kind: "global",
      libraryID: 2,
      profileSignature: "profile-test",
    });
  });
});
