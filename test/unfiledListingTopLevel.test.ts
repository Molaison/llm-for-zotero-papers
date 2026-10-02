import { assert } from "chai";
import { libraryIndexService } from "../src/services/libraryIndexService";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import { createLibrarySearchTool } from "../src/agent/tools/read/librarySearch";
import type { AgentToolContext } from "../src/agent/types";

/**
 * What library_search lists as unfiled.
 *
 * The live reorganization found its 254th "unfiled item", an annotation, with
 * its own script: Zotero's `Items.getAll(library, onlyTopLevel)` drops child
 * notes and child attachments but not annotations, so a script that trusts it
 * counts every highlight as a top-level item. The plugin's listing must never
 * do that. The fakes here are stricter than Zotero: `Items.getAll` returns
 * every item, children and the annotation included, and the unfiled search
 * matches every row in no collection, children included.
 */
describe("the unfiled listing holds top-level items only", function () {
  type FakeItem = {
    id: number;
    libraryID: number;
    parentID: number | false;
    kind: "regular" | "note" | "attachment" | "annotation";
    title: string;
    collections: number[];
    attachments?: number[];
    notes?: number[];
    contentType?: string;
  };

  const PAPER = 1;
  const FILED_PAPER = 2;
  const STANDALONE_NOTE = 3;
  const BOOK_WITHOUT_PDF = 4;
  const PDF = 7;
  const ANNOTATION = 8;
  const CHILD_NOTE = 13;
  const FILED_PDF = 21;

  const library: FakeItem[] = [
    {
      id: PAPER,
      libraryID: 1,
      parentID: false,
      kind: "regular",
      title: "Representational drift as a result of implicit regularization",
      collections: [],
      attachments: [PDF],
      notes: [CHILD_NOTE],
    },
    {
      id: FILED_PAPER,
      libraryID: 1,
      parentID: false,
      kind: "regular",
      title: "Filed paper",
      collections: [10],
      attachments: [FILED_PDF],
    },
    {
      id: STANDALONE_NOTE,
      libraryID: 1,
      parentID: false,
      kind: "note",
      title: "Loose note",
      collections: [],
    },
    {
      id: BOOK_WITHOUT_PDF,
      libraryID: 1,
      parentID: false,
      kind: "regular",
      title: "A book with no PDF",
      collections: [],
    },
    {
      id: PDF,
      libraryID: 1,
      parentID: PAPER,
      kind: "attachment",
      title: "Full Text PDF",
      collections: [],
      contentType: "application/pdf",
    },
    {
      id: ANNOTATION,
      libraryID: 1,
      parentID: PDF,
      kind: "annotation",
      title: "",
      collections: [],
    },
    {
      id: CHILD_NOTE,
      libraryID: 1,
      parentID: PAPER,
      kind: "note",
      title: "Reading notes",
      collections: [],
    },
    {
      id: FILED_PDF,
      libraryID: 1,
      parentID: FILED_PAPER,
      kind: "attachment",
      title: "Full Text PDF",
      collections: [],
      contentType: "application/pdf",
    },
  ];

  function native(item: FakeItem) {
    return {
      id: item.id,
      key: `KEY${item.id}`,
      libraryID: item.libraryID,
      parentID: item.parentID,
      deleted: false,
      itemTypeID: 1,
      dateAdded: "2024-01-01 00:00:00",
      dateModified: "2024-02-01 00:00:00",
      attachmentContentType: item.contentType || "",
      attachmentFilename: item.contentType ? "paper.pdf" : "",
      isRegularItem: () => item.kind === "regular",
      isNote: () => item.kind === "note",
      isAttachment: () => item.kind === "attachment",
      isAnnotation: () => item.kind === "annotation",
      getField: (field: string) => (field === "title" ? item.title : ""),
      getDisplayTitle: () => item.title,
      getNoteTitle: () => item.title,
      getCreators: () => [],
      getTags: () => [],
      getCollections: () => [...item.collections],
      getAttachments: () => [...(item.attachments || [])],
      getNotes: () => [...(item.notes || [])],
    };
  }

  const items = new Map(library.map((item) => [item.id, native(item)]));
  const globalScope = globalThis as typeof globalThis & { Zotero?: unknown };
  const originalZotero = globalScope.Zotero;
  let searchFails = false;

  beforeEach(function () {
    searchFails = false;
    libraryIndexService.clearForTests();
    globalScope.Zotero = {
      Items: {
        get: (id: number) => items.get(Number(id)) || null,
        getAll: async () => [...items.values()],
      },
      Collections: {
        get: (id: number) =>
          id === 10
            ? {
                id: 10,
                name: "Filed",
                libraryID: 1,
                parentID: false,
                deleted: false,
                getChildItems: () => [FILED_PAPER],
                getChildCollections: () => [],
              }
            : null,
        getByLibrary: () => [
          {
            id: 10,
            name: "Filed",
            libraryID: 1,
            parentID: false,
            deleted: false,
            getChildItems: () => [FILED_PAPER],
            getChildCollections: () => [],
          },
        ],
      },
      Libraries: {
        userLibraryID: 1,
        getName: () => "My Library",
        get: () => ({ name: "My Library" }),
      },
      ItemTypes: { getName: () => "journalArticle" },
      Search: class {
        private conditions: string[] = [];
        constructor(_params?: unknown) {}
        addCondition(condition: string) {
          this.conditions.push(condition);
        }
        async search() {
          if (searchFails) throw new Error("search unavailable");
          return library
            .filter(
              (item) =>
                !this.conditions.includes("unfiled") ||
                !item.collections.length,
            )
            .map((item) => item.id);
        }
      },
      debug: () => undefined,
    };
  });

  afterEach(function () {
    globalScope.Zotero = originalZotero;
    libraryIndexService.clearForTests();
  });

  async function listUnfiled(filters: Record<string, unknown>) {
    const tool = createLibrarySearchTool(new ZoteroGateway());
    const parsed = tool.validate!({
      entity: "items",
      mode: "list",
      libraryID: 1,
      filters: { unfiled: true, ...filters },
    });
    assert.isTrue(parsed.ok, JSON.stringify(parsed));
    if (!parsed.ok) throw new Error("unreachable");
    const result = (await tool.execute(parsed.value, {
      request: { conversationKey: 1, libraryID: 1, mode: "agent" },
      item: null,
      currentAnswerText: "",
      modelName: "test-model",
    } as unknown as AgentToolContext)) as {
      results: Array<{ itemId: number }>;
      totalCount: number;
    };
    return {
      ids: result.results.map((entry) => entry.itemId).sort((a, b) => a - b),
      totalCount: result.totalCount,
    };
  }

  it("lists unfiled papers with no annotation, child note or attachment among them", async function () {
    const listed = await listUnfiled({});
    assert.deepEqual(
      listed.ids,
      [PAPER, STANDALONE_NOTE, BOOK_WITHOUT_PDF],
      "top-level items only: a standalone note is top-level and can be filed",
    );
    assert.equal(listed.totalCount, 3);
  });

  it("lists only the regular papers with a PDF when hasPdf is asked", async function () {
    const listed = await listUnfiled({ hasPdf: true });
    assert.deepEqual(listed.ids, [PAPER]);
    assert.equal(listed.totalCount, 1);
  });

  it("keeps the same top-level set when Zotero's search fails and the index answers", async function () {
    searchFails = true;
    const listed = await listUnfiled({});
    assert.deepEqual(listed.ids, [PAPER, STANDALONE_NOTE, BOOK_WITHOUT_PDF]);
    assert.equal(
      listed.totalCount,
      3,
      "the count the model pages by counts no annotation or child item either",
    );
  });
});
