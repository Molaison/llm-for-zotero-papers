import { assert } from "chai";
import {
  TASK_PAPER_SCOPE_MAX_TAGS,
  listTaskPaperScope,
  resolveTaskPaperScopeItemIds,
  type TaskPaperScopeContexts,
} from "../src/agent/context/taskPaperScopeListing";
import type {
  LibraryIndexItem,
  LibraryIndexSnapshot,
  LibraryIndexTag,
} from "../src/services/libraryIndex/contracts";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import { libraryIndexService } from "../src/services/libraryIndexService";

type ItemSeed = Partial<LibraryIndexItem> & { itemId: number };

function item(seed: ItemSeed): LibraryIndexItem {
  return {
    libraryID: 1,
    itemType: "journalArticle",
    kind: "regular",
    title: `Paper ${seed.itemId}`,
    shortTitle: "",
    citationKey: "",
    doi: "",
    creators: [],
    firstCreator: "",
    publicationTitle: "",
    venue: "",
    date: "",
    year: "",
    abstractNote: "",
    extra: "",
    tags: [],
    automaticTags: [],
    collectionIds: [],
    attachmentIds: [],
    childNoteIds: [],
    dateAdded: "",
    dateModified: "",
    addedAt: 0,
    modifiedAt: 0,
    deleted: false,
    ...seed,
  };
}

/**
 * Two collections (Drift, and its child Drift/Rodents), a manual and an
 * automatic tag, a trashed paper, a standalone note, and a paper without PDF.
 */
function fakeSnapshot(): LibraryIndexSnapshot {
  const items = [
    item({
      itemId: 1,
      title: "Drift in CA1",
      year: "2021",
      firstCreator: "Smith",
      collectionIds: [10],
      tags: ["drift", "place cells", "a", "b", "c", "d", "e"],
    }),
    item({ itemId: 2, collectionIds: [10, 11], tags: ["learning"] }),
    item({ itemId: 3, collectionIds: [11], automaticTags: ["learning"] }),
    item({ itemId: 4, collectionIds: [10], deleted: true, tags: ["drift"] }),
    item({ itemId: 5, kind: "standalone-note", collectionIds: [10] }),
    item({ itemId: 6, tags: ["Learning"] }),
    item({ itemId: 7 }),
  ];
  const tag = (
    normalizedName: string,
    manual: number[],
    automatic: number[] = [],
  ): [string, LibraryIndexTag] => [
    normalizedName,
    {
      normalizedName,
      displayVariants: [normalizedName],
      manualItemIds: new Set(manual),
      automaticItemIds: new Set(automatic),
    },
  ];
  return {
    libraryID: 1,
    libraryName: "My Library",
    epoch: 1,
    builtAt: 0,
    itemById: new Map(items.map((entry) => [entry.itemId, entry])),
    topLevelItemOrder: items.map((entry) => entry.itemId),
    attachmentById: new Map([
      [
        101,
        {
          attachmentId: 101,
          libraryID: 1,
          parentItemId: 1,
          title: "PDF",
          filename: "a.pdf",
          contentType: "application/pdf",
          isStandalone: false,
          hasPdfMime: true,
          hasPdfFilename: true,
          isPdf: true,
          isContextEligiblePdf: true,
          isMineruPackage: false,
        },
      ],
    ]),
    childAttachmentIdsByItemId: new Map([[1, [101]]]),
    pdfAttachmentIdsByItemId: new Map([[1, [101]]]),
    childNoteIdsByItemId: new Map(),
    childNoteById: new Map(),
    parentItemIdByChildId: new Map([[101, 1]]),
    collectionById: new Map([
      [
        10,
        {
          collectionId: 10,
          libraryID: 1,
          name: "Drift",
          parentCollectionId: 0,
          deleted: false,
        },
      ],
      [
        11,
        {
          collectionId: 11,
          libraryID: 1,
          name: "Rodents",
          parentCollectionId: 10,
          deleted: false,
        },
      ],
    ]),
    directItemIdsByCollectionId: new Map([
      [10, new Set([1, 2, 4, 5])],
      [11, new Set([2, 3])],
    ]),
    childCollectionIdsByCollectionId: new Map([[10, [11]]]),
    collectionPathById: new Map([
      [10, "Drift"],
      [11, "Drift/Rodents"],
    ]),
    tagByNormalizedName: new Map([
      tag("drift", [1, 4]),
      tag("learning", [2, 6], [3]),
      tag("place cells", [1]),
    ]),
    normalizedTagNameByTagId: new Map(),
    tagIdsByNormalizedName: new Map(),
    unfiledItemIds: new Set([6, 7]),
    untaggedItemIds: new Set([7]),
    pdfCapableItemIds: new Set([1]),
    searchableFieldsByItemId: new Map(),
  } as LibraryIndexSnapshot;
}

describe("taskPaperScopeListing", function () {
  it("lists attached papers, folders and tags in retrieval's union order", function () {
    const snapshot = fakeSnapshot();
    const listing = listTaskPaperScope(snapshot, {
      papers: [{ itemId: 7 }],
      collections: [{ collectionId: 10 }],
      tags: [{ name: "Learning" }],
    });
    assert.deepEqual(
      listing.entries.map((entry) => entry.itemId),
      [7, 1, 2, 6],
      "trashed items, notes and automatic-only tag hits are excluded",
    );
    assert.equal(listing.totalItems, 4);
    assert.equal(listing.listedItems, 4);
    assert.isFalse(listing.truncated);
    assert.isFalse(listing.wholeLibrary);
    assert.deepEqual(listing.entries[1], {
      key: "1:1",
      libraryID: 1,
      itemId: 1,
      title: "Drift in CA1",
      year: "2021",
      firstCreator: "Smith",
      collectionPaths: ["Drift"],
      tags: ["drift", "place cells", "a", "b", "c", "d"],
      text: "pdf",
    });
    assert.lengthOf(listing.entries[1].tags, TASK_PAPER_SCOPE_MAX_TAGS);
    assert.deepEqual(listing.entries[2].collectionPaths, [
      "Drift",
      "Drift/Rodents",
    ]);
    assert.equal(listing.entries[2].text, "none");
  });

  it("leaves out papers the user removed from the task", function () {
    const listing = listTaskPaperScope(fakeSnapshot(), {
      collections: [{ collectionId: 10 }],
      excludedItemIds: [2],
    });
    assert.deepEqual(
      listing.entries.map((entry) => entry.itemId),
      [1],
      "the folder's other paper stays; the removed one is gone",
    );
    assert.equal(listing.totalItems, 1);
  });

  it("does not expand subcollections, as retrieval does not", function () {
    const listing = listTaskPaperScope(fakeSnapshot(), {
      collections: [{ collectionId: 10 }],
    });
    assert.deepEqual(
      listing.entries.map((entry) => entry.itemId),
      [1, 2],
    );
  });

  it("honours automatic tags and aggregate tag scopes", function () {
    const snapshot = fakeSnapshot();
    assert.deepEqual(
      resolveTaskPaperScopeItemIds(snapshot, {
        tags: [{ name: "learning", includeAutomatic: true }],
      }),
      [2, 6, 3],
    );
    assert.deepEqual(
      resolveTaskPaperScopeItemIds(snapshot, {
        tags: [{ name: "Untagged", scope: "untagged" }],
      }),
      [3, 7],
    );
  });

  it("lists the whole library, capped, when nothing is attached", function () {
    const listing = listTaskPaperScope(
      fakeSnapshot(),
      {},
      {
        wholeLibraryCap: 3,
      },
    );
    assert.isTrue(listing.wholeLibrary);
    assert.deepEqual(
      listing.entries.map((entry) => entry.itemId),
      [1, 2, 3],
    );
    assert.equal(listing.totalItems, 5);
    assert.equal(listing.listedItems, 3);
    assert.isTrue(listing.truncated);
  });

  describe("agrees with ZoteroGateway.resolveLibraryScopeItemIds", function () {
    const originalGetSnapshot = libraryIndexService.getSnapshot;

    before(function () {
      const snapshot = fakeSnapshot();
      (
        libraryIndexService as unknown as {
          getSnapshot: (libraryID: number) => Promise<LibraryIndexSnapshot>;
        }
      ).getSnapshot = async () => snapshot;
    });

    after(function () {
      (libraryIndexService as unknown as { getSnapshot: unknown }).getSnapshot =
        originalGetSnapshot;
    });

    const cases: Array<[string, TaskPaperScopeContexts]> = [
      ["papers", { papers: [{ itemId: 7 }, { itemId: 4 }, { itemId: 5 }] }],
      ["one folder", { collections: [{ collectionId: 10 }] }],
      [
        "overlapping folders",
        { collections: [{ collectionId: 11 }, { collectionId: 10 }] },
      ],
      ["unknown folder", { collections: [{ collectionId: 99 }] }],
      ["manual tag", { tags: [{ name: "Learning" }] }],
      [
        "automatic tag",
        { tags: [{ name: "learning", includeAutomatic: true }] },
      ],
      [
        "aggregate scopes",
        {
          tags: [
            { name: "All Tagged", scope: "allTagged", includeAutomatic: true },
            { name: "Untagged", scope: "untagged" },
          ],
        },
      ],
      [
        "everything",
        {
          papers: [{ itemId: 6 }],
          collections: [{ collectionId: 11 }],
          tags: [{ name: "drift" }, { name: "place cells" }],
        },
      ],
      [
        "papers removed in Task progress",
        {
          collections: [{ collectionId: 10 }],
          tags: [{ name: "Learning" }],
          excludedItemIds: [2, 4],
        },
      ],
    ];

    for (const [label, contexts] of cases) {
      it(`matches for ${label}`, async function () {
        const resolved = await new ZoteroGateway().resolveLibraryScopeItemIds({
          libraryID: 1,
          itemIds: (contexts.papers || []).map((paper) => paper.itemId),
          collectionIds: (contexts.collections || []).map(
            (collection) => collection.collectionId,
          ),
          tagContexts: (contexts.tags || []).map((tag) => ({
            name: tag.name,
            normalizedName: tag.normalizedName,
            scope: tag.scope,
            includeAutomatic: tag.includeAutomatic,
          })),
          excludedItemIds: contexts.excludedItemIds,
        });
        assert.deepEqual(
          resolveTaskPaperScopeItemIds(fakeSnapshot(), contexts),
          resolved.itemIds,
        );
        assert.deepEqual(
          listTaskPaperScope(fakeSnapshot(), contexts).entries.map(
            (entry) => entry.itemId,
          ),
          resolved.itemIds,
        );
      });
    }
  });
});
