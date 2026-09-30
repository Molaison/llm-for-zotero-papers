/**
 * Every deletion entry point clears the conversation's Task progress record:
 * the conversation-owned runtime state (conversation deletion, pending
 * deletion finalize, WebChat leave), the in-transaction agent row purge
 * (every store's local delete, turn deletion, edit truncation, the WebChat
 * startup sweep), the post-commit agent cleanup, and a queued deletion.
 */
import { assert } from "chai";
import type { PendingDeletionEntry } from "../src/core/conversations/pendingDeletionStore";
import {
  clearAgentConversationState,
  clearPersistedAgentConversationRowsInTransaction,
} from "../src/modules/contextPanel/agentConversationCleanup";
import { clearTaskProgressOnPendingDeletion } from "../src/modules/contextPanel/pendingDeletionWiring";
import {
  clearAllState,
  clearConversationOwnedRuntimeState,
} from "../src/modules/contextPanel/state";
import {
  beginTaskRun,
  clearAllTaskProgress,
  getTaskProgress,
} from "../src/modules/contextPanel/taskProgress/store";

const KEY = 882211;

function seed(): void {
  beginTaskRun(KEY, { runId: "run-del", turnIndex: 1 });
  assert.isNotNull(getTaskProgress(KEY));
}

describe("task progress is cleared on deletion", function () {
  afterEach(function () {
    clearAllTaskProgress();
  });

  it("with the conversation-owned runtime state", function () {
    seed();
    clearConversationOwnedRuntimeState(KEY);
    assert.isNull(getTaskProgress(KEY));
  });

  it("with the agent rows a store deletes in its transaction", async function () {
    seed();
    await clearPersistedAgentConversationRowsInTransaction(KEY);
    assert.isNull(getTaskProgress(KEY));
  });

  it("with the agent state cleaned up after the commit", async function () {
    seed();
    await clearAgentConversationState(KEY).catch(() => undefined);
    assert.isNull(getTaskProgress(KEY));
  });

  it("the moment a deletion is queued, but not for a dropped intent", function () {
    const entry = { conversationKey: KEY } as PendingDeletionEntry;
    seed();
    clearTaskProgressOnPendingDeletion({
      type: "queued",
      entry,
      dropped: true,
    });
    assert.isNotNull(getTaskProgress(KEY), "a dropped intent leaves it");
    clearTaskProgressOnPendingDeletion({ type: "undone", entry });
    assert.isNotNull(getTaskProgress(KEY), "undo leaves it");
    for (const type of [
      "queued",
      "committing",
      "local-deleted",
      "quarantined",
    ] as const) {
      seed();
      clearTaskProgressOnPendingDeletion({ type, entry });
      assert.isNull(getTaskProgress(KEY), type);
    }
  });

  it("with all state at shutdown", function () {
    seed();
    clearAllState();
    assert.isNull(getTaskProgress(KEY));
  });
});
