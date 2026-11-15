import { assert } from "chai";
import {
  buildLibraryListModelView,
  LIBRARY_LIST_FULL_ROWS,
} from "../src/agent/services/libraryListModelView";
import type {
  QueryLibraryInclude,
  QueryLibraryItemResult,
} from "../src/agent/services/libraryQueryService";

const ROOMY = 1_000_000;

/** A list row as LibraryQueryService builds it, with every metadata field. */
function row(
  index: number,
  include: QueryLibraryInclude[] = ["metadata"],
): QueryLibraryItemResult {
  const fields: Record<string, string> = {
    title: `Paper ${index} on drift`,
    shortTitle: "",
    abstractNote: `Abstract ${index}. ${"Place fields drift. ".repeat(30)}`,
    publicationTitle: "Journal of Drift",
    journalAbbreviation: "",
    proceedingsTitle: "",
    date: "2020",
    volume: "",
    issue: "",
    pages: "",
    DOI: "",
    url: "",
    language: "",
    extra: "",
    ISSN: "",
    ISBN: "",
    publisher: "",
    place: "",
  };
  return {
    itemId: index,
    itemKey: `KEY${index}`,
    itemType: "journalArticle",
    title: `Paper ${index} on drift`,
    firstCreator: `Author${index}`,
    year: "2020",
    dateAdded: "2026-09-01 10:00:00",
    attachments: include.includes("attachments")
      ? [
          {
            contextItemId: 1000 + index,
            title: "PDF",
            contentType: "application/pdf",
          },
        ]
      : [],
    tags: include.includes("tags") ? ["drift"] : [],
    collectionIds: [6],
    ...(include.includes("metadata")
      ? {
          metadata: {
            itemId: index,
            itemType: "journalArticle",
            title: `Paper ${index} on drift`,
            fields: fields as never,
            creators: [
              {
                creatorType: "author",
                firstName: "Ada",
                lastName: `Author${index}`,
              },
            ],
          },
        }
      : {}),
  };
}

function listResult(count: number, include?: QueryLibraryInclude[]) {
  const results = Array.from({ length: count }, (_, i) => row(i + 1, include));
  return {
    entity: "items",
    mode: "list",
    totalCount: 250,
    results,
    warnings: [],
    returnedCount: results.length,
    limited: true,
  };
}

function view(
  result: ReturnType<typeof listResult>,
  include: QueryLibraryInclude[] = ["metadata"],
  roomTokens = ROOMY,
) {
  const built = buildLibraryListModelView({
    input: { include },
    result,
    roomTokens,
  });
  assert.isNotNull(built);
  return built! as {
    content: Record<string, any>;
    stored: Record<string, any>;
  };
}

const size = (value: unknown) => JSON.stringify(value).length;

describe("library_search list model view", function () {
  it("lists every row by id, title, first creator and year, and the requested fields for the top rows only", function () {
    const result = listResult(100);
    const { content } = view(result);
    assert.lengthOf(content.results, LIBRARY_LIST_FULL_ROWS);
    assert.lengthOf(content.moreResults, 100 - LIBRARY_LIST_FULL_ROWS);
    assert.deepEqual(
      [...content.results, ...content.moreResults].map((r: any) => r.itemId),
      result.results.map((r) => r.itemId),
      "every listed item, in order",
    );
    assert.deepEqual(content.moreResults[0], {
      itemId: LIBRARY_LIST_FULL_ROWS + 1,
      title: `Paper ${LIBRARY_LIST_FULL_ROWS + 1} on drift`,
      firstCreator: `Author${LIBRARY_LIST_FULL_ROWS + 1}`,
      year: "2020",
    });
    const full = content.results[0];
    assert.include(full.metadata.fields.abstractNote, "Abstract 1.");
    assert.notProperty(
      full.metadata.fields,
      "volume",
      "an unset field says nothing",
    );
    assert.notProperty(full, "tags", "a list include did not ask for");
    assert.notProperty(full, "attachments");
    assert.deepEqual(content.omitted, {
      results: 100 - LIBRARY_LIST_FULL_ROWS,
    });
    assert.equal(content.totalCount, 250);
    assert.isTrue(content.limited);
    assert.isBelow(size(content), size(result) / 3);
  });

  it("keeps the fields a list include asked for, even when empty", function () {
    const include: QueryLibraryInclude[] = ["attachments", "tags"];
    const result = listResult(3, include);
    result.results[1].tags = [];
    const { content } = view(result, include);
    assert.deepEqual(content.results[0].tags, ["drift"]);
    assert.deepEqual(
      content.results[1].tags,
      [],
      "asked for, so an empty list is news",
    );
    assert.lengthOf(content.results[0].attachments, 1);
  });

  it("shows a short list whole, and leaves an empty one alone", function () {
    const result = listResult(10);
    const { content } = view(result);
    assert.lengthOf(content.results, 10);
    assert.notProperty(content, "moreResults");
    assert.notProperty(content, "omitted");
    assert.isNull(
      buildLibraryListModelView({
        input: { include: ["metadata"] },
        result: listResult(0),
        roomTokens: ROOMY,
      }),
    );
  });

  it("fits a small model's room: rows lose their fields from the bottom up, then brief rows leave from the end", function () {
    const result = listResult(100);
    const roomy = view(result).content;
    const tight = view(result, ["metadata"], 1_500).content;
    assert.isAtLeast(tight.results.length, 1);
    assert.isBelow(tight.results.length, roomy.results.length);
    assert.deepEqual(
      tight.results.map((r: any) => r.itemId),
      roomy.results.slice(0, tight.results.length).map((r: any) => r.itemId),
    );
    assert.isAtMost(Math.ceil(size(tight) / 4), 1_500 + 200);
    const listed = tight.results.length + (tight.moreResults?.length || 0);
    assert.equal(
      tight.omitted.results,
      100 - tight.results.length,
      "every row not shown whole is counted",
    );
    assert.isAtMost(listed, 100);
  });

  it("stores every row whole and in order, so the rows shown brief start at the number shown whole", function () {
    const result = listResult(40);
    const { content, stored } = view(result);
    assert.deepEqual(stored.results, result.results);
    assert.equal(
      stored.results[content.results.length].itemId,
      content.moreResults[0].itemId,
    );
  });
});
