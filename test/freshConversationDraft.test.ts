import { assert } from "chai";
import { describe, it } from "mocha";
import {
  resolveFreshConversationDraft,
  type FreshConversationDraftRepository,
} from "../src/modules/contextPanel/freshConversationDraft";
import type { ConversationCatalogEntry } from "../src/core/conversations/repository";

function entry(
  patch: Partial<ConversationCatalogEntry>,
): ConversationCatalogEntry {
  return {
    conversationID: `lfz:test:${patch.conversationKey || 0}`,
    conversationKey: patch.conversationKey || 0,
    system: patch.system || "upstream",
    kind: patch.kind || "global",
    libraryID: patch.libraryID || 1,
    createdAt: patch.createdAt || 1,
    lastActivityAt: patch.lastActivityAt || patch.createdAt || 1,
    userTurnCount: patch.userTurnCount || 0,
    ...patch,
  };
}

describe("fresh conversation draft resolver", function () {
  it("creates a new paper draft when the remembered conversation has turns", async function () {
    const calls: string[] = [];
    const repository: FreshConversationDraftRepository = {
      getCatalogEntry: async () => {
        calls.push("get");
        return entry({
          conversationKey: 42,
          kind: "paper",
          libraryID: 7,
          paperItemID: 42,
          userTurnCount: 2,
        });
      },
      listCatalogEntries: async () => {
        calls.push("list");
        return [];
      },
      createCatalogEntry: async () => {
        calls.push("create");
        return entry({
          conversationKey: 1500000042,
          kind: "paper",
          libraryID: 7,
          paperItemID: 42,
          userTurnCount: 0,
        });
      },
    };

    const result = await resolveFreshConversationDraft({
      repository,
      system: "upstream",
      kind: "paper",
      libraryID: 7,
      paperItemID: 42,
      currentConversationKey: 42,
    });

    assert.deepEqual(calls, ["get", "list", "create"]);
    assert.deepInclude(result, {
      conversationKey: 1500000042,
      reused: false,
      source: "created",
    });
  });

  it("reuses a same-scope empty global draft before creating another one", async function () {
    let created = false;
    const repository: FreshConversationDraftRepository = {
      getCatalogEntry: async () => null,
      listCatalogEntries: async () => [
        entry({
          conversationKey: 2000000007,
          kind: "global",
          libraryID: 7,
          userTurnCount: 3,
        }),
        entry({
          conversationKey: 2000000008,
          kind: "global",
          libraryID: 7,
          userTurnCount: 0,
        }),
      ],
      createCatalogEntry: async () => {
        created = true;
        return entry({
          conversationKey: 2000000009,
          kind: "global",
          libraryID: 7,
        });
      },
    };

    const result = await resolveFreshConversationDraft({
      repository,
      system: "upstream",
      kind: "global",
      libraryID: 7,
    });

    assert.isFalse(created);
    assert.deepInclude(result, {
      conversationKey: 2000000008,
      reused: true,
      source: "listed",
    });
  });

  it("does not reuse the excluded active conversation", async function () {
    const repository: FreshConversationDraftRepository = {
      getCatalogEntry: async () =>
        entry({
          conversationKey: 2000000008,
          kind: "global",
          libraryID: 7,
          userTurnCount: 0,
        }),
      listCatalogEntries: async () => [
        entry({
          conversationKey: 2000000008,
          kind: "global",
          libraryID: 7,
          userTurnCount: 0,
        }),
      ],
      createCatalogEntry: async () =>
        entry({
          conversationKey: 2000000009,
          kind: "global",
          libraryID: 7,
          userTurnCount: 0,
        }),
    };

    const result = await resolveFreshConversationDraft({
      repository,
      system: "upstream",
      kind: "global",
      libraryID: 7,
      currentConversationKey: 2000000008,
      excludeConversationKey: 2000000008,
    });

    assert.deepInclude(result, {
      conversationKey: 2000000009,
      reused: false,
      source: "created",
    });
  });

  it("skips an excluded listed draft and reuses the next same-scope draft", async function () {
    let created = false;
    const repository: FreshConversationDraftRepository = {
      getCatalogEntry: async () => null,
      listCatalogEntries: async () => [
        entry({
          conversationKey: 2000000008,
          kind: "global",
          libraryID: 7,
          userTurnCount: 0,
        }),
        entry({
          conversationKey: 2000000009,
          kind: "global",
          libraryID: 7,
          userTurnCount: 0,
        }),
      ],
      createCatalogEntry: async () => {
        created = true;
        return entry({
          conversationKey: 2000000010,
          kind: "global",
          libraryID: 7,
          userTurnCount: 0,
        });
      },
    };

    const result = await resolveFreshConversationDraft({
      repository,
      system: "upstream",
      kind: "global",
      libraryID: 7,
      excludeConversationKey: 2000000008,
    });

    assert.isFalse(created);
    assert.deepInclude(result, {
      conversationKey: 2000000009,
      reused: true,
      source: "listed",
    });
  });

  it("does not reuse a key that still has stored transcript messages", async function () {
    const createdKeys: number[] = [];
    const repository: FreshConversationDraftRepository = {
      getCatalogEntry: async () => null,
      listCatalogEntries: async () => [],
      loadMessages: async (params) =>
        params.conversationKey === 2000000008
          ? [
              {
                role: "user",
                text: "old startup transcript",
                timestamp: 1,
              },
            ]
          : [],
      createCatalogEntry: async () => {
        const conversationKey =
          createdKeys.length === 0 ? 2000000008 : 2000000009;
        createdKeys.push(conversationKey);
        return entry({
          conversationKey,
          kind: "global",
          libraryID: 7,
          userTurnCount: 0,
        });
      },
    };

    const result = await resolveFreshConversationDraft({
      repository,
      system: "upstream",
      kind: "global",
      libraryID: 7,
      currentConversationKey: 2000000008,
    });

    assert.deepEqual(createdKeys, [2000000008, 2000000009]);
    assert.deepInclude(result, {
      conversationKey: 2000000009,
      reused: false,
      source: "created",
    });
  });
});
