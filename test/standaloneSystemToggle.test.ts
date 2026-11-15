import { assert } from "chai";
import { describe, it } from "mocha";
import {
  collapseDuplicateReusableConversationDrafts,
  findReusableConversationDraft,
  findReusableStandaloneDraft,
  isReusableConversationDraft,
  isReusableStandaloneDraft,
} from "../src/modules/contextPanel/standaloneConversationResolution";
import type { ConversationSystem } from "../src/shared/types";

describe("standalone system toggle", function () {
  it("does not force a fresh conversation by default", function () {
    const calls: ConversationSystem[] = [];
    const switchConversationSystem = async (
      nextSystem: ConversationSystem,
      options?: { forceFresh?: boolean },
    ) => {
      assert.isUndefined(options?.forceFresh);
      calls.push(nextSystem);
    };

    void switchConversationSystem("codex");
    assert.deepEqual(calls, ["codex"]);
  });

  it("reuses an active true blank Codex global draft when forced fresh", function () {
    const draft = {
      conversationKey: 5_000_000_001,
      kind: "global",
      libraryID: 1,
      userTurnCount: 0,
    };

    assert.isTrue(
      isReusableStandaloneDraft({
        forceFresh: true,
        summary: draft,
        kind: "global",
        libraryID: 1,
      }),
    );
    assert.isTrue(
      isReusableStandaloneDraft({
        forceFresh: false,
        summary: draft,
        kind: "global",
        libraryID: 1,
      }),
    );
  });

  it("reuses an active true blank Codex paper draft when forced fresh", function () {
    const draft = {
      conversationKey: 6_000_000_001,
      kind: "paper",
      paperItemID: 42,
      libraryID: 1,
      userTurnCount: 0,
    };

    assert.isTrue(
      isReusableStandaloneDraft({
        forceFresh: true,
        summary: draft,
        kind: "paper",
        paperItemID: 42,
      }),
    );
    assert.isTrue(
      isReusableStandaloneDraft({
        forceFresh: false,
        summary: draft,
        kind: "paper",
        paperItemID: 42,
      }),
    );
  });

  it("reuses listed true blank drafts when forced fresh", function () {
    const drafts = [
      {
        conversationKey: 5_000_000_010,
        kind: "global",
        libraryID: 1,
        userTurnCount: 1,
      },
      {
        conversationKey: 5_000_000_011,
        kind: "global",
        libraryID: 1,
        userTurnCount: 0,
      },
    ];

    assert.equal(
      findReusableStandaloneDraft({
        forceFresh: true,
        summaries: drafts,
      })?.conversationKey,
      5_000_000_011,
    );
    assert.equal(
      findReusableStandaloneDraft({
        forceFresh: false,
        summaries: drafts,
      })?.conversationKey,
      5_000_000_011,
    );
  });

  it("keeps side-panel Codex global draft reuse scoped to the current library", function () {
    const drafts = [
      {
        conversationKey: 5_000_000_010,
        kind: "global",
        libraryID: 2,
        userTurnCount: 0,
      },
      {
        conversationKey: 5_000_000_011,
        kind: "global",
        libraryID: 1,
        userTurnCount: 0,
      },
    ];

    assert.equal(
      findReusableConversationDraft({
        forceFresh: true,
        summaries: drafts,
        kind: "global",
        libraryID: 1,
      })?.conversationKey,
      5_000_000_011,
    );
    assert.equal(
      findReusableConversationDraft({
        forceFresh: false,
        summaries: drafts,
        kind: "global",
        libraryID: 1,
      })?.conversationKey,
      5_000_000_011,
    );
  });

  it("prevents side-panel forced fresh from reusing non-blank Codex paper rows", function () {
    const draft = {
      conversationKey: 6_000_000_011,
      kind: "paper",
      paperItemID: 42,
      libraryID: 1,
      userTurnCount: 0,
    };

    assert.isTrue(
      isReusableConversationDraft({
        forceFresh: true,
        summary: draft,
        kind: "paper",
        paperItemID: 42,
      }),
    );
    assert.isFalse(
      isReusableConversationDraft({
        forceFresh: true,
        summary: {
          ...draft,
          title: "can you add 1 to all the coefficients",
        },
        kind: "paper",
        paperItemID: 42,
      }),
    );
    assert.isFalse(
      isReusableConversationDraft({
        forceFresh: true,
        summary: {
          ...draft,
          isDraft: false,
        },
        kind: "paper",
        paperItemID: 42,
      }),
    );
    assert.isFalse(
      isReusableConversationDraft({
        forceFresh: true,
        summary: {
          ...draft,
          providerSessionId: "thread-123",
        },
        kind: "paper",
        paperItemID: 42,
      }),
    );
    assert.isFalse(
      isReusableConversationDraft({
        forceFresh: true,
        summary: {
          ...draft,
          scopedConversationKey: "scope-123",
        },
        kind: "paper",
        paperItemID: 42,
      }),
    );
    assert.isFalse(
      isReusableConversationDraft({
        forceFresh: true,
        summary: {
          ...draft,
          userTurnCount: 1,
        },
        kind: "paper",
        paperItemID: 42,
      }),
    );
    assert.isFalse(
      isReusableConversationDraft({
        forceFresh: true,
        summary: draft,
        kind: "paper",
        paperItemID: 43,
      }),
    );
    assert.isFalse(
      isReusableConversationDraft({
        forceFresh: true,
        summary: null,
        kind: "paper",
        paperItemID: 42,
      }),
    );
  });

  it("uses the same true blank rule for upstream and Claude-style rows", function () {
    assert.isTrue(
      isReusableConversationDraft({
        forceFresh: true,
        summary: {
          conversationKey: 2_000_000_001,
          kind: "global",
          libraryID: 1,
          userTurnCount: 0,
        },
        kind: "global",
        libraryID: 1,
      }),
    );
    assert.isTrue(
      isReusableConversationDraft({
        forceFresh: true,
        summary: {
          conversationKey: 1_000_000_001,
          kind: "paper",
          libraryID: 1,
          paperItemID: 42,
          userTurnCount: 0,
        },
        kind: "paper",
        paperItemID: 42,
      }),
    );
    assert.isFalse(
      isReusableConversationDraft({
        forceFresh: true,
        summary: {
          conversationKey: 3_000_000_001,
          kind: "global",
          libraryID: 1,
          userTurnCount: 0,
          providerSessionId: "claude-session-1",
        },
        kind: "global",
        libraryID: 1,
      }),
    );
    assert.isFalse(
      isReusableConversationDraft({
        forceFresh: true,
        summary: {
          conversationKey: 2_000_000_002,
          kind: "global",
          libraryID: 1,
        },
        kind: "global",
        libraryID: 1,
      }),
    );
  });

  it("does not collapse titled zero-count conversations out of standalone history", function () {
    const entries = [
      {
        conversationKey: 5_000_000_101,
        kind: "global" as const,
        libraryID: 1,
        userTurnCount: 0,
        lastActivityAt: 100,
        title: "can you add 1 to all the coefficients",
      },
      {
        conversationKey: 5_000_000_102,
        kind: "global" as const,
        libraryID: 1,
        userTurnCount: 0,
        lastActivityAt: 200,
        title: "why did this disappear",
      },
      {
        conversationKey: 5_000_000_103,
        kind: "global" as const,
        libraryID: 1,
        userTurnCount: 0,
        lastActivityAt: 300,
        title: "New Codex chat",
      },
      {
        conversationKey: 5_000_000_104,
        kind: "global" as const,
        libraryID: 1,
        userTurnCount: 0,
        lastActivityAt: 400,
        title: "New Codex chat",
      },
    ];

    assert.deepEqual(
      collapseDuplicateReusableConversationDrafts({
        entries,
        activeConversationKey: 5_000_000_101,
      }).map((entry) => entry.conversationKey),
      [5_000_000_101, 5_000_000_102, 5_000_000_104],
    );
  });

  it("keeps only one visible true blank Codex paper draft per scope", function () {
    const entries = [
      {
        conversationKey: 6_000_000_010,
        kind: "paper",
        libraryID: 1,
        paperItemID: 42,
        userTurnCount: 0,
        lastActivityAt: 100,
        title: "New Codex paper chat",
      },
      {
        conversationKey: 6_000_000_011,
        kind: "paper",
        libraryID: 1,
        paperItemID: 42,
        userTurnCount: 0,
        lastActivityAt: 200,
        title: "New Codex paper chat",
      },
      {
        conversationKey: 6_000_000_012,
        kind: "paper",
        libraryID: 1,
        paperItemID: 42,
        userTurnCount: 0,
        lastActivityAt: 300,
        providerSessionId: "thread-123",
        title: "New Codex paper chat",
      },
    ];

    assert.deepEqual(
      collapseDuplicateReusableConversationDrafts({
        entries,
        activeConversationKey: 6_000_000_010,
      }).map((entry) => entry.conversationKey),
      [6_000_000_010, 6_000_000_012],
    );
    assert.deepEqual(
      collapseDuplicateReusableConversationDrafts({
        entries,
      }).map((entry) => entry.conversationKey),
      [6_000_000_011, 6_000_000_012],
    );
  });

  it("does not collapse true blank paper drafts across library scopes", function () {
    const entries = [
      {
        conversationKey: 6_000_000_020,
        kind: "paper" as const,
        libraryID: 1,
        paperItemID: 42,
        userTurnCount: 0,
        lastActivityAt: 100,
      },
      {
        conversationKey: 6_000_000_021,
        kind: "paper" as const,
        libraryID: 2,
        paperItemID: 42,
        userTurnCount: 0,
        lastActivityAt: 200,
      },
    ];

    assert.deepEqual(
      collapseDuplicateReusableConversationDrafts({
        entries,
      }).map((entry) => entry.conversationKey),
      [6_000_000_020, 6_000_000_021],
    );
  });
});
