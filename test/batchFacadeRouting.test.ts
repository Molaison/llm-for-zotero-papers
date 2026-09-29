import { assert } from "chai";
import { auditLibraryAction } from "../src/agent/actions/auditLibrary";
import { completeMetadataAction } from "../src/agent/actions/completeMetadata";
import { discoverRelatedAction } from "../src/agent/actions/discoverRelated";
import { organizeUnfiledAction } from "../src/agent/actions/organizeUnfiled";
import {
  createBatchLibrary,
  installBatchJournal,
  runBatchActionFixture,
} from "./helpers/batchFixtures";
import { installNativeNoteStore } from "./helpers/nativeNoteStore";
import { actionContractFixture } from "./helpers/semanticIntent";

/**
 * Batch actions reach library reads and writes only through the
 * model-visible facades. Each case runs one action through the production
 * registry and checks two things: the calls it made name facades, never a
 * retired primitive, and every durable write it made is filed under the
 * facade name, which is what the history and undo show the user.
 */

const RETIRED_PRIMITIVES = [
  "query_library",
  "read_library",
  "apply_tags",
  "update_metadata",
  "move_to_collection",
  "import_identifiers",
  "search_literature_online",
  "edit_current_note",
];

function assertOnlyFacades(calls: string[]): void {
  for (const name of RETIRED_PRIMITIVES) {
    assert.notInclude(calls, name, `the action still calls ${name}`);
  }
}

const CANONICAL_PATCH = { publicationTitle: "Journal of Memory" };

function literatureSearchStub(results: unknown[]) {
  const seen: Array<Record<string, unknown>> = [];
  return {
    seen,
    stub: (input: unknown) => {
      seen.push(input as Record<string, unknown>);
      return { results };
    },
  };
}

describe("batch actions call facade tools", function () {
  let restore: () => void;

  beforeEach(async function () {
    restore = await installBatchJournal();
  });

  afterEach(function () {
    restore();
  });

  it("organize_unfiled files items through library_update kind:'collections'", async function () {
    const library = createBatchLibrary(
      [
        { itemId: 1, title: "Memory consolidation during sleep" },
        { itemId: 2, title: "Memory consolidation in hippocampus" },
      ],
      [{ collectionId: 11, name: "Memory consolidation" }],
    );

    const run = await runBatchActionFixture({
      action: organizeUnfiledAction,
      input: { _batchItemIds: [1, 2] },
      library,
    });

    assert.isTrue(run.result.ok, JSON.stringify(run.result));
    assertOnlyFacades(run.calls);
    assert.include(run.calls, "library_update");
    assert.lengthOf(run.journal, 1);
    assert.equal(run.journal[0].toolName, "library_update");
    assert.equal(run.journal[0].steps[0].operation, "move_to_collection");
    assert.deepEqual(library.collectionsOf(1), [11]);
    assert.deepEqual(library.collectionsOf(2), [11]);
  });

  it("complete_metadata searches through literature_search and writes through library_update kind:'metadata'", async function () {
    const library = createBatchLibrary([
      { itemId: 1, title: "Seed Paper", fields: { DOI: "10.1000/seed" } },
    ]);
    const search = literatureSearchStub([{ patch: CANONICAL_PATCH }]);

    const run = await runBatchActionFixture({
      action: completeMetadataAction,
      input: { itemIds: [1] },
      library,
      replaceTools: { literature_search: search.stub },
    });

    assert.isTrue(run.result.ok, JSON.stringify(run.result));
    assertOnlyFacades(run.calls);
    assert.includeMembers(run.calls, [
      "library_read",
      "literature_search",
      "library_update",
    ]);
    assert.equal(search.seen[0]?.mode, "metadata");
    assert.lengthOf(run.journal, 1);
    assert.equal(run.journal[0].toolName, "library_update");
    assert.equal(run.journal[0].steps[0].operation, "update_metadata");
    assert.equal(
      library.fieldsOf(1).publicationTitle,
      CANONICAL_PATCH.publicationTitle,
    );
  });

  it("audit_library repairs through library_update and saves its report through note_write", async function () {
    const notes = installNativeNoteStore();
    try {
      const library = createBatchLibrary([
        { itemId: 1, title: "Seed Paper", fields: { DOI: "10.1000/seed" } },
      ]);
      const search = literatureSearchStub([{ patch: CANONICAL_PATCH }]);

      const run = await runBatchActionFixture({
        action: auditLibraryAction,
        input: { _batchItemIds: [1], saveNote: true },
        library,
        replaceTools: { literature_search: search.stub },
      });

      assert.isTrue(run.result.ok, JSON.stringify(run.result));
      assertOnlyFacades(run.calls);
      assert.includeMembers(run.calls, [
        "literature_search",
        "library_update",
        "note_write",
      ]);
      assert.equal(search.seen[0]?.doi, "10.1000/seed");
      assert.deepEqual(
        run.journal.map((action) => action.toolName),
        ["library_update", "note_write"],
      );
      assert.equal(run.journal[0].steps[0].operation, "update_metadata");
      assert.equal(
        library.fieldsOf(1).publicationTitle,
        CANONICAL_PATCH.publicationTitle,
      );
      assert.equal(notes.notes.size, 1, "the audit report was saved");
    } finally {
      notes.restore();
    }
  });

  it("discover_related imports the reviewed selection through library_import kind:'identifiers'", async function () {
    const library = createBatchLibrary([
      { itemId: 1, title: "Seed Paper", fields: { DOI: "10.1000/seed" } },
    ]);
    const search = literatureSearchStub([
      { title: "Related One", doi: "10.1000/r1", year: 2024 },
    ]);

    const run = await runBatchActionFixture({
      action: discoverRelatedAction,
      input: { itemId: 1 },
      library,
      replaceTools: { literature_search: search.stub },
      requestConfirmation: async () => ({
        approved: true,
        actionId: "import",
        data: { selectedPaperIds: ["recommendations-1"] },
      }),
    });

    assert.isTrue(run.result.ok, JSON.stringify(run.result));
    assertOnlyFacades(run.calls);
    assert.includeMembers(run.calls, [
      "library_read",
      "literature_search",
      "library_import",
    ]);
    assert.equal(search.seen[0]?.itemId, 1);
    assert.deepEqual(library.importedIdentifiers, ["10.1000/r1"]);
    assert.lengthOf(run.journal, 1);
    assert.equal(run.journal[0].toolName, "library_import");
    assert.equal(run.journal[0].steps[0].operation, "import_identifiers");
  });

  it("discover_related imports an explicitly requested count through library_import kind:'identifiers'", async function () {
    const library = createBatchLibrary([
      { itemId: 1, title: "Seed Paper", fields: { DOI: "10.1000/seed" } },
    ]);
    const search = literatureSearchStub([
      { title: "Related One", doi: "10.1000/r1", year: 2024 },
      { title: "Related Two", doi: "10.1000/r2", year: 2023 },
    ]);

    const run = await runBatchActionFixture({
      action: discoverRelatedAction,
      input: { itemId: 1 },
      library,
      replaceTools: { literature_search: search.stub },
      configure: (ctx) => {
        const actionContract = actionContractFixture("import_identifiers");
        const intent = actionContract.intent!;
        return {
          ...ctx,
          confirmationMode: "automatic",
          requestContext: {
            actionEntryPoint: "conversation",
            actionContract,
            classifiedIntent: {
              ...intent,
              semantic: { ...intent.semantic!, requestedCount: 1 },
            },
          },
        };
      },
    });

    assert.isTrue(run.result.ok, JSON.stringify(run.result));
    assertOnlyFacades(run.calls);
    assert.include(run.calls, "library_import");
    assert.deepEqual(library.importedIdentifiers, ["10.1000/r1"]);
    assert.lengthOf(run.journal, 1);
    assert.equal(run.journal[0].toolName, "library_import");
    assert.equal(run.journal[0].steps[0].operation, "import_identifiers");
  });
});
