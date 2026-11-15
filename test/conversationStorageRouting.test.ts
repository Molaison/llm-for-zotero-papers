import { assert } from "chai";
import {
  CLAUDE_GLOBAL_CONVERSATION_KEY_BASE,
  CODEX_GLOBAL_CONVERSATION_KEY_BASE,
  RUNTIME_CONVERSATION_KEY_END,
  UPSTREAM_GLOBAL_CONVERSATION_KEY_BASE,
} from "../src/shared/conversationKeySpace";
import { resolveConversationStorageSystem } from "../src/shared/conversationStorageRouting";

describe("conversation storage routing", function () {
  it("uses explicit conversation system before numeric classification", function () {
    assert.equal(
      resolveConversationStorageSystem({
        conversationKey: 42,
        conversationSystem: "codex",
      }),
      "codex",
    );
    assert.equal(
      resolveConversationStorageSystem({
        conversationKey: CODEX_GLOBAL_CONVERSATION_KEY_BASE + 1,
        conversationSystem: "claude_code",
      }),
      "claude_code",
    );
  });

  it("falls back to bounded key classification when no system is available", function () {
    assert.equal(
      resolveConversationStorageSystem({
        conversationKey: CODEX_GLOBAL_CONVERSATION_KEY_BASE + 1,
      }),
      "codex",
    );
    assert.equal(
      resolveConversationStorageSystem({
        conversationKey: CLAUDE_GLOBAL_CONVERSATION_KEY_BASE + 1,
      }),
      "claude_code",
    );
    assert.equal(
      resolveConversationStorageSystem({
        conversationKey: UPSTREAM_GLOBAL_CONVERSATION_KEY_BASE + 1,
      }),
      "upstream",
    );
  });

  it("does not silently route future high keys to runtime storage", function () {
    assert.isNull(
      resolveConversationStorageSystem({
        conversationKey: RUNTIME_CONVERSATION_KEY_END,
      }),
    );
  });
});
