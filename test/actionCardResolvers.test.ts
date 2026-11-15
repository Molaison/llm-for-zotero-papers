import { assert } from "chai";
import { createZoteroActionCardResolvers } from "../src/modules/contextPanel/agentTrace/actionCardResolvers";

/** The library the resolvers read, as much of it as they touch. */
type ZoteroStub = {
  Items?: { get: (id: number) => unknown };
  Collections?: { get: (id: number) => unknown };
};

const globalScope = globalThis as typeof globalThis & { Zotero?: unknown };

function installZotero(stub: ZoteroStub): void {
  globalScope.Zotero = stub as unknown;
}

/** One regular item, as the resolvers ask it about itself. */
function item(overrides: {
  firstCreator?: string;
  date?: string;
  title?: string;
  libraryID?: number;
  key?: string;
}) {
  return {
    firstCreator: overrides.firstCreator ?? "",
    libraryID: overrides.libraryID ?? 1,
    key: overrides.key ?? "K1",
    getField: (field: string) => (field === "date" ? overrides.date || "" : ""),
    getDisplayTitle: () => overrides.title ?? "",
    isNote: () => false,
    // A regular item answers this too, which is exactly why asking it is not
    // enough to decide that an id names a note.
    getNoteTitle: () => "Not a note at all",
  };
}

const resolvers = () => createZoteroActionCardResolvers(() => undefined);

describe("action card library resolvers", function () {
  const originalZotero = globalScope.Zotero;

  afterEach(function () {
    globalScope.Zotero = originalZotero;
  });

  describe("naming an item", function () {
    it("names a paper the way the reader already cites it", function () {
      installZotero({
        Items: {
          get: () =>
            item({
              firstCreator: "Smith",
              date: "2021-03-01",
              libraryID: 4,
              key: "ABCD1234",
            }),
        },
      });

      assert.deepEqual(resolvers().itemLabel(11), {
        label: "Smith, 2021",
        libraryID: 4,
        itemKey: "ABCD1234",
      });
    });

    it("names a paper with no date by its creator alone", function () {
      installZotero({
        Items: { get: () => item({ firstCreator: "Smith", date: "n.d." }) },
      });

      assert.equal(resolvers().itemLabel(11)?.label, "Smith");
    });

    it("falls back to the title when nobody is credited", function () {
      installZotero({
        Items: {
          get: () => item({ date: "2021", title: "Attention in transformers" }),
        },
      });

      assert.equal(
        resolvers().itemLabel(11)?.label,
        "Attention in transformers",
      );
    });

    it("says nothing about an item with nothing to say", function () {
      installZotero({ Items: { get: () => item({}) } });

      assert.isUndefined(
        resolvers().itemLabel(11),
        "the card falls back to the identity rather than an empty name",
      );
    });

    it("names a child note's paper, and says which item that is", function () {
      // A note-writing receipt targets the note it wrote. The note is already
      // the row's own chip, so what the row covers is the paper it hangs under.
      installZotero({
        Items: {
          get: (id: number) =>
            id === 99
              ? {
                  isNote: () => true,
                  getNoteTitle: () => "Reading notes",
                  parentItemID: 11,
                  libraryID: 4,
                  key: "N99",
                }
              : item({
                  firstCreator: "Smith",
                  date: "2021-03-01",
                  libraryID: 4,
                  key: "ABCD1234",
                }),
        },
      });

      assert.deepEqual(resolvers().itemLabel(99), {
        label: "Smith, 2021",
        libraryID: 4,
        itemKey: "ABCD1234",
        itemId: 11,
      });
    });

    it("says nothing about a standalone note, which is its own object", function () {
      installZotero({
        Items: {
          get: () => ({
            isNote: () => true,
            getNoteTitle: () => "Reading notes",
            parentItemID: false,
            libraryID: 1,
            key: "N99",
          }),
        },
      });

      assert.isUndefined(
        resolvers().itemLabel(99),
        "a note with no paper must not be drawn as a paper beside itself",
      );
    });

    it("says nothing about a child note whose paper is gone", function () {
      installZotero({
        Items: {
          get: (id: number) =>
            id === 99
              ? {
                  isNote: () => true,
                  getNoteTitle: () => "Reading notes",
                  parentItemID: 11,
                  libraryID: 1,
                  key: "N99",
                }
              : false,
        },
      });

      assert.isUndefined(resolvers().itemLabel(99));
    });

    it("says nothing about an item the library no longer holds", function () {
      installZotero({ Items: { get: () => false } });

      assert.isUndefined(resolvers().itemLabel(11));
    });

    it("says nothing when the library read throws", function () {
      installZotero({
        Items: {
          get: () => {
            throw new Error("Zotero is shutting down");
          },
        },
      });

      assert.isUndefined(resolvers().itemLabel(11));
    });

    it("says nothing when there is no Zotero to ask", function () {
      globalScope.Zotero = undefined;

      assert.isUndefined(resolvers().itemLabel(11));
      assert.isUndefined(resolvers().collectionLabel(3));
      assert.isUndefined(resolvers().noteLabel(99));
    });
  });

  describe("naming a collection", function () {
    it("names a collection by its own name", function () {
      installZotero({
        Collections: { get: () => ({ name: "Reviews", libraryID: 4 }) },
      });

      assert.deepEqual(resolvers().collectionLabel(3), {
        label: "Reviews",
        libraryID: 4,
      });
    });

    it("says nothing about a collection that is gone", function () {
      installZotero({ Collections: { get: () => false } });

      assert.isUndefined(resolvers().collectionLabel(3));
    });
  });

  describe("naming a note", function () {
    it("names a note by its own title", function () {
      installZotero({
        Items: {
          get: () => ({
            isNote: () => true,
            getNoteTitle: () => "Reading notes",
            libraryID: 4,
            key: "N99",
          }),
        },
      });

      assert.deepEqual(resolvers().noteLabel(99), {
        label: "Reading notes",
        libraryID: 4,
        itemKey: "N99",
      });
    });

    it("calls an untitled note a note", function () {
      installZotero({
        Items: {
          get: () => ({
            isNote: () => true,
            getNoteTitle: () => "",
            libraryID: 1,
            key: "N99",
          }),
        },
      });

      assert.equal(resolvers().noteLabel(99)?.label, "Note");
    });

    it("says nothing when the id no longer names a note", function () {
      installZotero({
        Items: { get: () => item({ firstCreator: "Smith", date: "2021" }) },
      });

      assert.isUndefined(
        resolvers().noteLabel(99),
        "a reused id must not put a paper's name where a note belongs",
      );
    });
  });

  it("passes the material lookup through untouched", function () {
    const materialTitle = createZoteroActionCardResolvers((documentId) =>
      documentId === "doc-1" ? "Attention in transformers" : undefined,
    ).materialTitle;

    assert.equal(materialTitle("doc-1"), "Attention in transformers");
    assert.isUndefined(materialTitle("doc-2"));
  });
});
