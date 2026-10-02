import { assert } from "chai";
import {
  resolveTaskProgressTurnScope,
  shouldAnimateTaskProgressRow,
  shouldShowTaskProgress,
  type TaskProgressRowFrame,
  type TaskProgressVisibilityInput,
} from "../src/modules/contextPanel/taskProgress/visibility";

const base: TaskProgressVisibilityInput = {
  conversationKind: "paper",
  isWebChat: false,
  isNoteSession: false,
  collectionCount: 0,
  tagCount: 0,
  paperCount: 1,
  planSeen: false,
};

function paper(itemId: number) {
  return { itemId, contextItemId: itemId + 1000, title: `Paper ${itemId}` };
}

describe("task progress visibility", function () {
  const library: Partial<TaskProgressVisibilityInput> = {
    conversationKind: "global",
    paperCount: 0,
  };
  const matrix: Array<[string, Partial<TaskProgressVisibilityInput>, boolean]> =
    [
      ["a library chat with nothing added", library, false],
      ["a library chat with one paper", { ...library, paperCount: 1 }, true],
      [
        "a library chat with a folder",
        { ...library, collectionCount: 1 },
        true,
      ],
      ["a library chat with a tag", { ...library, tagCount: 1 }, true],
      [
        "a library chat whose run had steps, with nothing added",
        { ...library, planSeen: true },
        true,
      ],
      [
        "a library chat in WebChat, with a paper",
        { ...library, paperCount: 1, isWebChat: true },
        false,
      ],
      [
        "a note chat in library mode, with a folder",
        { ...library, collectionCount: 1, isNoteSession: true },
        false,
      ],
      ["one-paper chat", {}, false],
      ["three papers", { paperCount: 3 }, false],
      ["four papers", { paperCount: 4 }, false],
      ["five papers", { paperCount: 5 }, true],
      ["an attached folder", { collectionCount: 1 }, true],
      ["an attached tag", { tagCount: 1 }, true],
      ["a plan in a one-paper chat", { planSeen: true }, true],
      ["WebChat", { conversationKind: "global", isWebChat: true }, false],
      [
        "WebChat, even with a plan and a folder",
        { isWebChat: true, planSeen: true, collectionCount: 2 },
        false,
      ],
      ["a note chat", { isNoteSession: true, paperCount: 9 }, false],
      [
        "a note chat in library mode",
        { conversationKind: "global", isNoteSession: true },
        false,
      ],
      ["no conversation", { conversationKind: "", planSeen: true }, false],
    ];
  for (const [name, patch, shown] of matrix) {
    it(`${shown ? "shows" : "hides"} the row for ${name}`, function () {
      assert.equal(shouldShowTaskProgress({ ...base, ...patch }), shown);
    });
  }

  it("lowers a library chat's row at the first paper, folder or tag, whatever else is added", function () {
    for (const added of [
      { paperCount: 1 },
      { collectionCount: 1 },
      { tagCount: 1 },
      { paperCount: 3, collectionCount: 2, tagCount: 1 },
    ]) {
      assert.isTrue(
        shouldShowTaskProgress({ ...base, ...library, ...added }),
        JSON.stringify(added),
      );
    }
  });

  it("counts the paper chat's own paper with the attached ones", function () {
    const scope = resolveTaskProgressTurnScope({
      conversationKind: "paper",
      libraryID: 1,
      basePaperItemId: 10,
      message: {
        paperContexts: [paper(11), paper(12), paper(10)],
        fullTextPaperContexts: [paper(13)],
      },
    });
    assert.equal(scope.paperCount, 4);
    assert.deepEqual(
      scope.contexts.papers?.map((entry) => entry.itemId),
      [10, 11, 12, 13],
    );
    assert.equal(scope.label, "");
  });

  it("names folders and tags, and leaves a bare library chat whole", function () {
    const scope = resolveTaskProgressTurnScope({
      conversationKind: "global",
      libraryID: 1,
      basePaperItemId: 10,
      message: {
        selectedCollectionContexts: [
          { collectionId: 5, name: "Drift", libraryID: 1 },
          { collectionId: 6, name: "Learning", libraryID: 1 },
          { collectionId: 5, name: "Drift", libraryID: 1 },
        ],
        selectedTagContexts: [{ name: "memory", libraryID: 1 }],
      },
    });
    assert.equal(scope.label, "Drift + Learning + #memory");
    assert.equal(scope.collectionCount, 2);
    assert.equal(scope.tagCount, 1);
    assert.equal(scope.paperCount, 0, "library chat has no own paper");
    const whole = resolveTaskProgressTurnScope({
      conversationKind: "global",
      libraryID: 1,
      message: null,
    });
    assert.deepEqual(whole.contexts, {});
    assert.notEqual(whole.signature, scope.signature);
    assert.equal(
      resolveTaskProgressTurnScope({
        conversationKind: "global",
        libraryID: 1,
        message: null,
      }).signature,
      whole.signature,
      "the same turn keeps its signature",
    );
  });
});

describe("task progress row motion", function () {
  /** An empty library chat, settled: its context bar is its own, no run. */
  const empty: TaskProgressRowFrame = {
    identity: "7\u0000global\u0000false\u0000false",
    shown: false,
    contextApplies: false,
    runSteps: false,
    composerReady: true,
    runLive: false,
  };
  const withPaper: TaskProgressRowFrame = {
    ...empty,
    shown: true,
    contextApplies: true,
  };

  it("lowers the row when the user adds the first context, and raises it when the last goes", function () {
    assert.isTrue(shouldAnimateTaskProgressRow(empty, withPaper));
    assert.isTrue(shouldAnimateTaskProgressRow(withPaper, empty));
  });

  it("does not move a row that stays as it was", function () {
    assert.isFalse(shouldAnimateTaskProgressRow(empty, empty));
    assert.isFalse(shouldAnimateTaskProgressRow(withPaper, withPaper));
  });

  it("puts the row in its state at once on mount, a conversation switch or a mode change", function () {
    assert.isFalse(shouldAnimateTaskProgressRow(null, withPaper), "mount");
    assert.isFalse(
      shouldAnimateTaskProgressRow(empty, {
        ...withPaper,
        identity: "8\u0000global\u0000false\u0000false",
      }),
      "another conversation",
    );
    assert.isFalse(
      shouldAnimateTaskProgressRow(withPaper, {
        ...empty,
        identity: "7\u0000global\u0000true\u0000false",
      }),
      "the same conversation in WebChat",
    );
  });

  it("puts the row in its state at once while the context bar is still set up from history", function () {
    assert.isFalse(
      shouldAnimateTaskProgressRow(
        { ...empty, composerReady: false },
        withPaper,
      ),
    );
  });

  it("lowers the row when a live run declares its steps, with nothing added", function () {
    assert.isTrue(
      shouldAnimateTaskProgressRow(
        { ...empty, runLive: true },
        { ...empty, shown: true, runSteps: true, runLive: true },
      ),
    );
  });

  it("puts the row in its state at once when steps come back from history or a record is cleared", function () {
    const rebuilt = { ...empty, shown: true, runSteps: true };
    assert.isFalse(
      shouldAnimateTaskProgressRow(empty, rebuilt),
      "the history's steps",
    );
    assert.isFalse(shouldAnimateTaskProgressRow(rebuilt, empty), "cleared");
  });

  it("keeps a row whose run had steps when the last context goes", function () {
    const steps = { ...withPaper, runSteps: true };
    const contextGone = { ...steps, contextApplies: false };
    assert.isTrue(contextGone.shown, "the steps keep it shown");
    assert.isFalse(shouldAnimateTaskProgressRow(steps, contextGone));
  });
});
