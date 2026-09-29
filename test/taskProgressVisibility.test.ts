import { assert } from "chai";
import {
  resolveTaskProgressTurnScope,
  shouldShowTaskProgress,
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
  const matrix: Array<[string, Partial<TaskProgressVisibilityInput>, boolean]> =
    [
      ["library chat", { conversationKind: "global", paperCount: 0 }, true],
      ["one-paper chat", {}, false],
      ["three papers", { paperCount: 3 }, false],
      ["four papers", { paperCount: 4 }, true],
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
