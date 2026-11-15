import { assert } from "chai";
import {
  normalizeCollectionContextRefs,
  normalizeExcludedItemIds,
  normalizeTagContextRefs,
} from "../src/services/context/normalizers";
import { resolveTaskProgressTurnScope } from "../src/modules/contextPanel/taskProgress/visibility";

describe("task progress exclusions", function () {
  it("keeps a folder's and a tag's removed papers through normalization", function () {
    assert.deepEqual(
      normalizeCollectionContextRefs([
        {
          collectionId: 10,
          name: "Drift",
          libraryID: 1,
          excludedItemIds: [4, "7", 4, -1, "x"],
        },
      ]),
      [
        {
          collectionId: 10,
          name: "Drift",
          libraryID: 1,
          excludedItemIds: [4, 7],
        },
      ],
    );
    assert.deepEqual(
      normalizeTagContextRefs([
        {
          name: "drift",
          normalizedName: "drift",
          libraryID: 1,
          excludedItemIds: [9],
        },
      ])[0].excludedItemIds,
      [9],
    );
    assert.notProperty(
      normalizeCollectionContextRefs([
        { collectionId: 10, name: "Drift", libraryID: 1, excludedItemIds: [] },
      ])[0],
      "excludedItemIds",
      "no empty list is kept",
    );
    assert.isUndefined(normalizeExcludedItemIds("4"));
  });

  it("carries removed papers into the Task progress scope and its identity", function () {
    const base = {
      conversationKind: "global" as const,
      libraryID: 1,
    };
    const without = resolveTaskProgressTurnScope({
      ...base,
      message: {
        selectedCollectionContexts: [
          { collectionId: 10, name: "Drift", libraryID: 1 },
        ],
      },
    });
    const withExcluded = resolveTaskProgressTurnScope({
      ...base,
      message: {
        selectedCollectionContexts: [
          {
            collectionId: 10,
            name: "Drift",
            libraryID: 1,
            excludedItemIds: [5, 2],
          },
        ],
        selectedTagContexts: [
          {
            name: "learning",
            normalizedName: "learning",
            libraryID: 1,
            excludedItemIds: [2, 3],
          },
        ],
      },
    });
    assert.deepEqual(withExcluded.contexts.excludedItemIds, [2, 3, 5]);
    assert.isUndefined(without.contexts.excludedItemIds);
    assert.notEqual(
      withExcluded.signature,
      without.signature,
      "removing a paper recomputes the listing",
    );
  });
});
