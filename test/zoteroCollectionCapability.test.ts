import { assert } from "chai";
import {
  CollectionCapability,
  type CollectionCapabilityDeps,
} from "../src/agent/services/zotero/collectionCapability";

/**
 * The collection and saved-search paths used to live on `ZoteroGateway` and
 * reached the item and collection lookups through `this`. They now take those
 * lookups as dependencies, so this file drives the capability on its own —
 * the same behaviour `collectionMoveSemantics.test.ts`,
 * `collectionMembershipObjectModel.test.ts` and
 * `collectionsTagsSavedSearches.test.ts` pin through the facade, asserted
 * here against the seam the facade fills in.
 */
describe("collection capability", function () {
  /** The id Zotero hands a freshly created saved search in this fixture. */
  const NEW_SEARCH_ID = 99;

  type FakeItem = {
    id: number;
    libraryID: number;
    collections: number[];
    saves: number;
    parentID: number | false;
    isRegularItem: () => boolean;
    isNote: () => boolean;
    isAttachment: () => boolean;
    isAnnotation: () => boolean;
    getDisplayTitle: () => string;
    getField: (name: string) => string;
    getCreators: () => unknown[];
    getTags: () => unknown[];
    getAttachments: () => number[];
    getCollections: () => number[];
    addToCollection: (id: number) => void;
    removeFromCollection: (id: number) => void;
    inCollection: (id: number) => boolean;
    saveTx: () => Promise<boolean>;
  };

  type FakeCollection = {
    id: number;
    name: string;
    libraryID: number;
    parentID: number | false;
    deleted: boolean;
    saves: number;
    erased: Array<{ deleteItems?: boolean } | undefined>;
    childItemIds: number[];
    descendants: Array<{ id: number; type: string }>;
    getChildItems: (asIDs: true, includeDeleted?: boolean) => number[];
    getChildCollections: (asIDs: true) => number[];
    getDescendents: (
      nested: boolean,
      type: "collection" | "item" | null,
      includeDeletedItems?: boolean,
    ) => Array<{ id: number; type: string }>;
    saveTx: (options?: { deleteItems?: boolean }) => Promise<boolean>;
    eraseTx: (options?: { deleteItems?: boolean }) => Promise<void>;
  };

  type FakeSearch = {
    id: number;
    libraryID: number;
    name: string;
    deleted: boolean;
    conditions: Array<{ condition: string; operator: string; value: unknown }>;
    erased: boolean;
    addCondition: (
      condition: string,
      operator: string,
      value?: unknown,
      required?: boolean,
    ) => void;
    removeCondition: (id: number) => void;
    getConditions: () => Record<string, unknown>;
    saveTx: () => Promise<boolean>;
    eraseTx: () => Promise<void>;
  };

  let items: Map<number, FakeItem>;
  let collections: Map<number, FakeCollection>;
  let searches: Map<number, FakeSearch>;

  const globalScope = globalThis as typeof globalThis & { Zotero?: unknown };
  const originalZotero = globalScope.Zotero;

  function makeItem(seed: {
    id: number;
    collections?: number[];
    kind?: "regular" | "note" | "attachment";
    parentID?: number | false;
  }): FakeItem {
    const item: FakeItem = {
      id: seed.id,
      libraryID: 1,
      collections: [...(seed.collections || [])],
      saves: 0,
      parentID: seed.parentID ?? false,
      isRegularItem: () => (seed.kind || "regular") === "regular",
      isNote: () => seed.kind === "note",
      isAttachment: () => seed.kind === "attachment",
      isAnnotation: () => false,
      getDisplayTitle: () => `Paper ${seed.id}`,
      getField: (name: string) => (name === "title" ? `Paper ${seed.id}` : ""),
      getCreators: () => [],
      getTags: () => [],
      getAttachments: () => [],
      getCollections: () => [...item.collections],
      addToCollection: (id: number) => {
        if (!item.collections.includes(id)) item.collections.push(id);
      },
      removeFromCollection: (id: number) => {
        item.collections = item.collections.filter((entry) => entry !== id);
      },
      inCollection: (id: number) => item.collections.includes(id),
      saveTx: async () => {
        item.saves += 1;
        return true;
      },
    };
    items.set(seed.id, item);
    return item;
  }

  function makeCollection(seed: {
    id: number;
    name: string;
    parentID?: number | false;
    deleted?: boolean;
    childItemIds?: number[];
    descendants?: Array<{ id: number; type: string }>;
  }): FakeCollection {
    const collection: FakeCollection = {
      id: seed.id,
      name: seed.name,
      libraryID: 1,
      parentID: seed.parentID ?? false,
      deleted: seed.deleted ?? false,
      saves: 0,
      erased: [],
      childItemIds: seed.childItemIds || [],
      descendants: seed.descendants || [],
      getChildItems: () => [...collection.childItemIds],
      getChildCollections: () =>
        collection.descendants
          .filter((entry) => entry.type === "collection")
          .map((entry) => entry.id),
      getDescendents: () => collection.descendants,
      saveTx: async () => {
        collection.saves += 1;
        return true;
      },
      eraseTx: async (options?: { deleteItems?: boolean }) => {
        collection.erased.push(options);
      },
    };
    collections.set(seed.id, collection);
    return collection;
  }

  function makeSearch(seed: {
    id: number;
    name: string;
    deleted?: boolean;
  }): FakeSearch {
    const search: FakeSearch = {
      id: seed.id,
      libraryID: 1,
      name: seed.name,
      deleted: seed.deleted ?? false,
      conditions: [],
      erased: false,
      addCondition: (condition, operator, value) => {
        search.conditions.push({ condition, operator, value });
      },
      removeCondition: (id: number) => {
        search.conditions.splice(id, 1);
      },
      getConditions: () =>
        Object.fromEntries(
          search.conditions.map((entry, index) => [String(index), entry]),
        ),
      saveTx: async () => {
        searches.set(search.id, search);
        return true;
      },
      eraseTx: async () => {
        search.erased = true;
      },
    };
    searches.set(seed.id, search);
    return search;
  }

  beforeEach(function () {
    items = new Map();
    collections = new Map();
    searches = new Map();
    globalScope.Zotero = {
      Items: {
        get: (id: number) => items.get(id) || null,
        getAll: async () => [...items.values()],
      },
      Collections: {
        get: (id: number) => collections.get(id) || null,
        getByLibrary: (libraryID: number) =>
          [...collections.values()].filter(
            (collection) => collection.libraryID === libraryID,
          ),
      },
      Collection: class {
        id = 500;
        name = "";
        parentID: number | false = false;
        libraryID = 0;
        async saveTx() {
          makeCollection({
            id: this.id,
            name: this.name,
            parentID: this.parentID,
          });
          return true;
        }
      },
      Searches: {
        get: (id: number) => searches.get(id) || null,
        getByLibrary: () => [...searches.values()],
      },
      Search: class {
        id = NEW_SEARCH_ID;
        libraryID = 1;
        name = "";
        conditions: Array<{
          condition: string;
          operator: string;
          value: unknown;
        }> = [];
        addCondition(condition: string, operator: string, value: unknown) {
          this.conditions.push({ condition, operator, value });
        }
        removeCondition() {}
        getConditions() {
          return {};
        }
        async saveTx() {
          const created = makeSearch({ id: this.id, name: this.name });
          created.conditions = this.conditions;
          return true;
        }
      },
      SearchConditions: {
        get: (name: string) =>
          name === "tag" || name === "dateAdded" || name === "joinMode"
            ? { operators: { is: true, isAfter: true, any: true, all: true } }
            : undefined,
      },
      debug: () => undefined,
    };
  });

  afterEach(function () {
    globalScope.Zotero = originalZotero;
  });

  /** The capability under test, with every dependency answered explicitly. */
  function capability(deps: Partial<CollectionCapabilityDeps> = {}) {
    return new CollectionCapability({
      getItem: (itemId) =>
        (items.get(Number(itemId)) as unknown as Zotero.Item) || null,
      getCollection: (collectionId) =>
        (collections.get(
          Number(collectionId),
        ) as unknown as Zotero.Collection) || null,
      getCollectionSummary: (collectionId) => {
        const collection = collections.get(Number(collectionId));
        return collection
          ? {
              collectionId: collection.id,
              name: collection.name,
              libraryID: collection.libraryID,
              path: collection.name,
            }
          : null;
      },
      resolveBibliographicItem: (item) => item ?? null,
      ...deps,
    });
  }

  describe("reading the tree", function () {
    it("lists a library's collections by path, parents before children", function () {
      makeCollection({ id: 10, name: "Neuro" });
      makeCollection({ id: 30, name: "Methods", parentID: 10 });
      makeCollection({ id: 20, name: "Aging" });

      const summaries = capability().listCurrentCollectionSummaries(1);

      assert.deepEqual(
        summaries.map((summary) => summary.path),
        ["Aging", "Neuro", "Neuro / Methods"],
      );
    });

    it("reads an item's real membership, including a book with no PDF", function () {
      makeItem({ id: 101, collections: [10, 20, 30] });

      assert.deepEqual(capability().getItemCollectionIds(101), [10, 20, 30]);
    });

    it("reports a missing item as filed nowhere rather than throwing", function () {
      assert.deepEqual(capability().getItemCollectionIds(404), []);
    });

    it("describes native state so a mutation receipt can be verified", function () {
      makeCollection({ id: 30, name: "Methods", parentID: 10 });

      assert.deepEqual(capability().getCollectionNativeState(30), {
        exists: true,
        name: "Methods",
        parentCollectionId: 10,
        deleted: false,
      });
      assert.deepEqual(capability().getCollectionNativeState(404), {
        exists: false,
        name: "",
        parentCollectionId: null,
        deleted: false,
      });
    });

    it("lists a collection's papers, and every member when items are asked for", function () {
      makeCollection({ id: 10, name: "Neuro", childItemIds: [101, 102] });
      makeItem({ id: 101 });
      makeItem({ id: 102, kind: "note" });

      const papers = capability().listCurrentCollectionTargetIds({
        libraryID: 1,
        collectionId: 10,
        targetKind: "papers",
      });
      const all = capability().listCurrentCollectionTargetIds({
        libraryID: 1,
        collectionId: 10,
        targetKind: "items",
      });

      assert.deepEqual(papers, [101], "a note is not a paper");
      assert.deepEqual(all, [101, 102]);
    });

    it("refuses a collection from another library", function () {
      makeCollection({ id: 10, name: "Neuro", childItemIds: [101] });

      assert.deepEqual(
        capability().listCurrentCollectionTargetIds({
          libraryID: 2,
          collectionId: 10,
          targetKind: "items",
        }),
        [],
      );
    });

    it("describes what a delete would take with it", function () {
      makeCollection({
        id: 10,
        name: "Neuro",
        childItemIds: [101, 102],
        descendants: [{ id: 30, type: "collection" }],
      });

      const snapshot = capability().snapshotCollectionForDelete({
        collectionId: 10,
      });

      assert.equal(snapshot?.name, "Neuro");
      assert.deepEqual(snapshot?.itemIds, [101, 102]);
      assert.equal(snapshot?.childCollectionCount, 1);
      assert.isNull(
        capability().snapshotCollectionForDelete({ collectionId: 404 }),
      );
    });
  });

  describe("creating and renaming", function () {
    it("creates a collection and reports its path", async function () {
      const created = await capability().createCollection({
        name: "  Neuro  ",
        libraryID: 1,
      });

      assert.equal(created.name, "Neuro", "the name is trimmed");
      assert.equal(collections.get(created.collectionId)?.name, "Neuro");
    });

    it("refuses an unnamed collection and a missing parent", async function () {
      try {
        await capability().createCollection({ name: "   ", libraryID: 1 });
        assert.fail("an unnamed collection must not be created");
      } catch (error) {
        assert.include(String(error), "Collection name is required");
      }

      try {
        await capability().createCollection({
          name: "Child",
          libraryID: 1,
          parentCollectionId: 404,
        });
        assert.fail("a collection must not be parented to nothing");
      } catch (error) {
        assert.include(String(error), "Parent collection 404 not found");
      }
    });

    it("renames without losing the id every filed item references", async function () {
      const collection = makeCollection({ id: 10, name: "Nuero" });

      const result = await capability().updateCollection({
        collectionId: 10,
        name: "Neuro",
      });

      assert.equal(result.status, "updated");
      assert.equal(result.previousName, "Nuero", "the inverse needs this");
      assert.equal(result.collectionId, 10);
      assert.equal(collection.name, "Neuro");
    });

    it("refuses a move that would detach the subtree from the library", async function () {
      makeCollection({
        id: 10,
        name: "Neuro",
        descendants: [{ id: 30, type: "collection" }],
      });
      makeCollection({ id: 30, name: "Methods", parentID: 10 });

      const result = await capability().updateCollection({
        collectionId: 10,
        parentCollectionId: 30,
      });

      assert.equal(result.status, "not_found");
      assert.include(result.reason || "", "detach the whole subtree");
      assert.equal(collections.get(10)?.saves, 0, "nothing was written");
    });

    it("writes nothing when neither the name nor the parent changes", async function () {
      const collection = makeCollection({ id: 10, name: "Neuro" });

      const result = await capability().updateCollection({
        collectionId: 10,
        name: "Neuro",
      });

      assert.equal(result.status, "unchanged");
      assert.equal(collection.saves, 0);
    });
  });

  describe("trashing and restoring", function () {
    it("trashes rather than erases, so a restore brings the same ids back", async function () {
      const collection = makeCollection({ id: 10, name: "Neuro" });

      await capability().deleteCollection({ collectionId: 10 });

      assert.isTrue(collection.deleted);
      assert.lengthOf(collection.erased, 0, "erase is the permanent verb");
      assert.equal(collection.saves, 1);
    });

    it("erases only when the caller asks for it permanently", async function () {
      const collection = makeCollection({ id: 10, name: "Neuro" });

      await capability().deleteCollection({
        collectionId: 10,
        permanent: true,
        deleteItems: true,
      });

      assert.deepEqual(collection.erased, [{ deleteItems: true }]);
      assert.isFalse(collection.deleted);
    });

    it("restores a parent together with the subtree the trash took down", async function () {
      const parent = makeCollection({
        id: 10,
        name: "Neuro",
        deleted: true,
        descendants: [{ id: 30, type: "collection" }],
      });
      const child = makeCollection({
        id: 30,
        name: "Methods",
        parentID: 10,
        deleted: true,
      });

      const result = await capability().restoreCollections({
        collectionIds: [10],
      });

      assert.deepEqual(result.collectionIds, [10, 30]);
      assert.isFalse(parent.deleted);
      assert.isFalse(child.deleted, "a stranded subtree is not a restore");
    });

    it("skips a collection that was never in the trash", async function () {
      makeCollection({ id: 10, name: "Neuro" });

      const result = await capability().restoreCollections({
        collectionIds: [10],
      });

      assert.equal(result.restoredCount, 0);
    });
  });

  describe("writing membership as a set", function () {
    it("adds and removes in one transaction and records the prior set", async function () {
      const item = makeItem({ id: 101, collections: [10, 20] });
      makeCollection({ id: 10, name: "Neuro" });
      makeCollection({ id: 30, name: "Aging" });

      const result = await capability().setItemCollections({
        assignments: [{ itemId: 101, collectionIds: [10, 30] }],
      });

      assert.deepEqual(item.collections, [10, 30], "20 is gone, 30 is added");
      assert.equal(item.saves, 1, "never observable half-moved");
      assert.equal(result.changedCount, 1);
      assert.deepEqual(result.priorCollections, [
        { itemId: 101, collectionIds: [10, 20] },
      ]);
      assert.equal(result.items[0].status, "moved");
    });

    it("collapses several destinations for one item into a single set", async function () {
      const item = makeItem({ id: 101, collections: [] });

      await capability().setItemCollections({
        assignments: [
          { itemId: 101, collectionIds: [10] },
          { itemId: 101, collectionIds: [20] },
        ],
      });

      assert.deepEqual(
        item.collections,
        [10, 20],
        "the second assignment must not undo the first",
      );
    });

    it("reports an item already filed exactly here without writing", async function () {
      const item = makeItem({ id: 101, collections: [10] });
      makeCollection({ id: 10, name: "Neuro" });

      const result = await capability().setItemCollections({
        assignments: [{ itemId: 101, collectionIds: [10] }],
      });

      assert.equal(item.saves, 0);
      assert.equal(result.items[0].status, "skipped");
      assert.equal(result.items[0].reason, "Already filed exactly here");
    });

    it("refuses a child attachment before writing either half of the move", async function () {
      const child = makeItem({ id: 105, kind: "attachment", parentID: 101 });
      makeItem({ id: 101 });

      const result = await capability().setItemCollections({
        assignments: [{ itemId: 105, collectionIds: [10] }],
      });

      assert.equal(result.changedCount, 0);
      assert.equal(result.items[0].status, "missing");
      assert.deepEqual(child.collections, [], "no half-applied move");
      assert.deepEqual(
        items.get(101)?.collections,
        [],
        "and the parent is never filed in its place",
      );
    });
  });

  describe("filing items into collections", function () {
    it("adds without unfiling, which is what add means", async function () {
      const item = makeItem({ id: 101, collections: [10] });
      makeCollection({ id: 30, name: "Aging" });

      const result = await capability().addItemsToCollections({
        assignments: [{ itemId: 101, targetCollectionId: 30 }],
      });

      assert.deepEqual(item.collections, [10, 30]);
      assert.equal(result.addedCount, 1);
      assert.equal(result.movedCount, 0);
    });

    it("moves out of the named source only", async function () {
      const item = makeItem({ id: 101, collections: [10, 20] });
      makeCollection({ id: 30, name: "Aging" });

      const result = await capability().addItemsToCollections({
        assignments: [{ itemId: 101, targetCollectionId: 30 }],
        mode: "move",
        from: 10,
      });

      assert.deepEqual(item.collections, [20, 30], "20 was never mentioned");
      assert.equal(result.movedCount, 1);
      assert.deepEqual(result.priorCollections, [
        { itemId: 101, collectionIds: [10, 20] },
      ]);
    });

    it("replaces the whole membership when the source is everything", async function () {
      const item = makeItem({ id: 101, collections: [10, 20] });
      makeCollection({ id: 30, name: "Aging" });

      await capability().addItemsToCollections({
        assignments: [{ itemId: 101, targetCollectionId: 30 }],
        mode: "move",
        from: "all",
      });

      assert.deepEqual(item.collections, [30]);
    });

    it("never guesses the source of a move", async function () {
      makeItem({ id: 101, collections: [10] });
      makeCollection({ id: 30, name: "Aging" });

      try {
        await capability().addItemsToCollections({
          assignments: [{ itemId: 101, targetCollectionId: 30 }],
          mode: "move",
        });
        assert.fail("a move without a source must not silently unfile");
      } catch (error) {
        assert.include(String(error), "A move needs an explicit source");
      }
      assert.deepEqual(items.get(101)?.collections, [10]);
    });

    it("reports a paper already in the collection as skipped", async function () {
      const item = makeItem({ id: 101, collections: [30] });
      makeCollection({ id: 30, name: "Aging" });

      const result = await capability().addItemsToCollections({
        assignments: [{ itemId: 101, targetCollectionId: 30 }],
      });

      assert.equal(item.saves, 0);
      assert.equal(result.items[0].status, "skipped");
      assert.equal(result.addedCount, 0);
    });

    it("takes an item out of one collection and says whether it was there", async function () {
      const item = makeItem({ id: 101, collections: [10] });
      makeCollection({ id: 10, name: "Neuro" });

      const removed = await capability().removeItemFromCollection({
        itemId: 101,
        collectionId: 10,
      });
      const again = await capability().removeItemFromCollection({
        itemId: 101,
        collectionId: 10,
      });

      assert.isTrue(removed.removed);
      assert.deepEqual(item.collections, []);
      assert.isFalse(again.removed);
      assert.equal(again.reason, "The item was not in that collection");
      assert.equal(item.saves, 1, "the second call writes nothing");
    });

    it("reads every item and collection through the injected lookups", async function () {
      const askedItems: Array<number | undefined> = [];
      const askedSummaries: Array<number | undefined> = [];
      const item = makeItem({ id: 101, collections: [] });
      makeCollection({ id: 30, name: "Aging" });

      await capability({
        getItem: (itemId) => {
          askedItems.push(itemId);
          return item as unknown as Zotero.Item;
        },
        getCollectionSummary: (collectionId) => {
          askedSummaries.push(collectionId);
          return {
            collectionId: Number(collectionId),
            name: "Aging",
            libraryID: 1,
            path: "Aging",
          };
        },
      }).addItemsToCollections({
        assignments: [{ itemId: 101, targetCollectionId: 30 }],
      });

      assert.deepEqual(askedItems, [101]);
      assert.deepEqual(askedSummaries, [30]);
    });
  });

  describe("saved searches", function () {
    it("creates a search from a condition set and lists it back", async function () {
      const created = await capability().saveSavedSearch({
        libraryID: 1,
        name: "Recent neuro",
        joinMode: "all",
        conditions: [
          { condition: "tag", operator: "is", value: "Neuroscience" },
          { condition: "dateAdded", operator: "isAfter", value: "2024-01-01" },
        ],
      });

      assert.equal(created.status, "created");
      const listed = capability().listSavedSearches(1);
      assert.deepEqual(
        listed.map((search) => search.name),
        ["Recent neuro"],
      );
      assert.deepEqual(
        listed[0].conditions.map((entry) => entry.condition),
        ["joinMode", "tag", "dateAdded"],
      );
    });

    it("replaces the conditions of an existing search rather than appending", async function () {
      const existing = makeSearch({ id: 42, name: "Old" });
      existing.conditions = [
        { condition: "tag", operator: "is", value: "Stale" },
      ];

      const result = await capability().saveSavedSearch({
        libraryID: 1,
        name: "Fresh",
        savedSearchId: 42,
        conditions: [{ condition: "tag", operator: "is", value: "Fresh" }],
      });

      assert.equal(result.status, "updated");
      assert.deepEqual(
        existing.conditions.map((entry) => entry.value),
        ["Fresh"],
        "updating means the conditions given, not those plus the old ones",
      );
    });

    it("refuses a condition Zotero does not have, naming the valid operators", async function () {
      try {
        await capability().saveSavedSearch({
          libraryID: 1,
          name: "Broken",
          conditions: [{ condition: "tag", operator: "contains", value: "x" }],
        });
        assert.fail("an invalid operator must not reach the store");
      } catch (error) {
        assert.include(String(error), "Invalid search conditions");
        assert.include(String(error), "Valid operators");
      }
      assert.lengthOf([...searches.values()], 0);
    });

    it("trashes a saved search, and restores it by id", async function () {
      const search = makeSearch({ id: 42, name: "Recent neuro" });

      const trashed = await capability().deleteSavedSearch({
        savedSearchId: 42,
      });
      assert.equal(trashed.status, "trashed");
      assert.isTrue(search.deleted);
      assert.isFalse(search.erased, "trash is not erase");

      const restored = await capability().restoreSavedSearches({
        savedSearchIds: [42],
      });
      assert.deepEqual(restored.savedSearchIds, [42]);
      assert.isFalse(search.deleted);
    });

    it("erases only when asked, and reports one that is not there", async function () {
      const search = makeSearch({ id: 42, name: "Recent neuro" });

      const erased = await capability().deleteSavedSearch({
        savedSearchId: 42,
        permanent: true,
      });
      assert.equal(erased.status, "erased");
      assert.isTrue(search.erased);

      const missing = await capability().deleteSavedSearch({
        savedSearchId: 404,
      });
      assert.equal(missing.status, "not_found");
    });
  });
});
