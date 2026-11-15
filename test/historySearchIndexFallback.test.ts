import { assert } from "chai";
import { shouldFallbackToLoadedConversationHistorySearch } from "../src/modules/contextPanel/setupHandlers/controllers/historyLifecycleController";
import type { ConversationSearchIndexResult } from "../src/shared/conversationSearchIndex";

function indexStatus(
  params: Partial<ConversationSearchIndexResult>,
): ConversationSearchIndexResult {
  return {
    matches: [],
    status: "ready",
    indexedRowCount: 0,
    catalogRowCount: 0,
    staleIndexedRowCount: 0,
    truncatedRowCount: 0,
    ...params,
  };
}

describe("history search index fallback", function () {
  it("falls back when stale coverage still returns partial matches", function () {
    assert.isTrue(
      shouldFallbackToLoadedConversationHistorySearch(
        indexStatus({
          status: "stale",
          catalogRowCount: 2,
          indexedRowCount: 1,
          matches: [
            {
              conversationID: "lfz:test",
              conversationKey: 1,
              system: "codex",
              kind: "paper",
              libraryID: 1,
              paperItemID: 10,
              title: "Indexed match",
              bodyText: "query",
              lastActivityAt: 100,
              userTurnCount: 1,
            },
          ],
        }),
      ),
    );
  });

  it("keeps ready index matches on the indexed path", function () {
    assert.isFalse(
      shouldFallbackToLoadedConversationHistorySearch(
        indexStatus({
          status: "ready",
          catalogRowCount: 1,
          indexedRowCount: 1,
          matches: [
            {
              conversationID: "lfz:test",
              conversationKey: 2,
              system: "codex",
              kind: "global",
              libraryID: 1,
              paperItemID: undefined,
              title: "Ready match",
              bodyText: "query",
              lastActivityAt: 100,
              userTurnCount: 1,
            },
          ],
        }),
      ),
    );
  });

  it("keeps truncated index matches on the truncated expansion path", function () {
    assert.isFalse(
      shouldFallbackToLoadedConversationHistorySearch(
        indexStatus({
          status: "truncated",
          catalogRowCount: 1,
          indexedRowCount: 1,
          truncatedRowCount: 1,
          matches: [
            {
              conversationID: "lfz:test",
              conversationKey: 3,
              system: "claude_code",
              kind: "global",
              libraryID: 1,
              paperItemID: undefined,
              title: "Truncated match",
              bodyText: "query",
              lastActivityAt: 100,
              userTurnCount: 1,
            },
          ],
        }),
      ),
    );
  });

  it("preserves fallback when non-ready coverage has catalog rows and no matches", function () {
    assert.isTrue(
      shouldFallbackToLoadedConversationHistorySearch(
        indexStatus({
          status: "empty",
          catalogRowCount: 1,
          indexedRowCount: 0,
          matches: [],
        }),
      ),
    );
  });
});
