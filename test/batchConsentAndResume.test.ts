import { installNativeNoteStore } from "./helpers/nativeNoteStore";
import { assert } from "chai";
import { LibraryMutationService } from "../src/agent/services/libraryMutationService";
import { executeLibraryMutationAction } from "../src/agent/services/mutationCoordinator";
import { initAgentChangeJournal } from "../src/agent/store/changeJournal";
import { createNoteWriteBatchTool } from "../src/agent/tools/write/noteWriteBatch";
import { ChangeJournalTestDb } from "./helpers/changeJournalTestDb";

/**
 * The binding constraint on "write a summary note for each of my 50 most
 * recent papers" was never the round budget — it was consent. `note_write`
 * takes one `targetItemId`, and every `mode:'create'` call returns its own
 * review card, so the request meant 50 tool calls and 50 human approvals.
 */
describe("batched note writing", function () {
  let saved: Array<{ itemId: number; content: string }>;
  let trashed: number[][];
  let nextNoteId: number;
  let native: ReturnType<typeof installNativeNoteStore>;

  function gateway(overrides: Record<string, unknown> = {}) {
    return {
      getItem: (id: number) =>
        id === 999
          ? null
          : {
              id,
              libraryID: 1,
              getDisplayTitle: () => `Paper ${id}`,
              getField: () => "",
            },
      saveAnswerToNote: async (params: {
        item: { id: number };
        content: string;
      }) => {
        saved.push({ itemId: params.item.id, content: params.content });
        return { noteId: nextNoteId++ };
      },
      trashItems: async (params: { itemIds: number[] }) => {
        trashed.push(params.itemIds);
        return { trashedCount: params.itemIds.length, items: [] };
      },
      ...overrides,
    };
  }

  const context = {
    request: { conversationKey: 1, libraryID: 1 },
    journalFallbackApproved: true,
    modelName: "test-model",
  } as never;

  beforeEach(function () {
    saved = [];
    trashed = [];
    nextNoteId = 500;
    native = installNativeNoteStore({
      startId: 500,
      onSave: (note) =>
        saved.push({ itemId: note.parentID, content: note.getNote() }),
    });
  });

  afterEach(function () {
    return native.restore();
  });

  it("writes one note per item in a single operation", async function () {
    const service = new LibraryMutationService(gateway() as never);
    const outcome = await service.executeOperation(
      {
        type: "save_notes_batch",
        notes: [
          { targetItemId: 1, content: "Summary of one" },
          { targetItemId: 2, content: "Summary of two" },
        ],
      },
      context,
    );

    assert.deepEqual(
      saved.map((entry) => entry.itemId),
      [1, 2],
    );
    const result = (outcome.result as { result: Record<string, number> })
      .result;
    assert.equal(result.createdCount, 2);
  });

  it("keeps going when one target is bad", async function () {
    const service = new LibraryMutationService(gateway() as never);
    const outcome = await service.executeOperation(
      {
        type: "save_notes_batch",
        notes: [
          { targetItemId: 1, content: "ok" },
          { targetItemId: 999, content: "missing target" },
          { targetItemId: 2, content: "also ok" },
        ],
      },
      context,
    );
    // One bad id must not cost the other forty-nine notes.
    const result = (
      outcome.result as {
        result: { createdCount: number; failedCount: number };
      }
    ).result;
    assert.equal(result.createdCount, 2);
    assert.equal(result.failedCount, 1);
  });

  it("undoes the set from one durable inverse per note, not a whole-batch inverse", async function () {
    const db = new ChangeJournalTestDb();
    globalThis.Zotero = { ...globalThis.Zotero, DB: db } as never;
    await initAgentChangeJournal();
    const service = new LibraryMutationService(gateway() as never);

    const coordinated = await executeLibraryMutationAction({
      service,
      operations: [
        {
          type: "save_notes_batch",
          notes: [
            { targetItemId: 1, content: "a" },
            { targetItemId: 2, content: "b" },
          ],
        },
      ],
      context,
      facadeToolName: "note_write_batch",
    });

    // The batch is one action; each note is a step that carries the inverse
    // for exactly the note it wrote.
    assert.lengthOf([...db.actions.values()], 1);
    const steps = [...db.steps.values()].sort(
      (left, right) => Number(left.sequence_no) - Number(right.sequence_no),
    );
    assert.lengthOf(steps, 2);
    assert.deepEqual(
      steps.map(
        (step) => JSON.parse(String(step.inverse_json)).operations as unknown[],
      ),
      [
        [{ type: "trash_items", itemIds: [500] }],
        [{ type: "trash_items", itemIds: [501] }],
      ],
    );

    // Replaying every recorded inverse, newest step first, trashes each note
    // exactly once: there is no whole-batch inverse to double-trash them.
    for (const step of [...steps].reverse()) {
      for (const operation of JSON.parse(String(step.inverse_json))
        .operations) {
        await service.executeOperation(operation, context);
      }
    }
    assert.deepEqual(trashed, [[501], [500]]);
    assert.equal(coordinated.effect, "applied");
  });

  describe("the confirmation card", function () {
    it("puts every note on one checklist rather than one card each", function () {
      const tool = createNoteWriteBatchTool(gateway() as never);
      const validated = tool.validate({
        notes: [
          { targetItemId: 1, content: "First summary" },
          { targetItemId: 2, content: "Second summary" },
        ],
      });
      assert.isTrue(validated.ok);
      if (!validated.ok) return;

      const action = tool.createPendingAction?.(validated.value, context);
      const checklist = action?.fields?.[0] as
        | { type: string; items: Array<{ id: string; description?: string }> }
        | undefined;
      assert.equal(checklist?.type, "checklist");
      assert.lengthOf(checklist?.items || [], 2);
      // Approving fifty pieces of generated text sight-unseen is consent in
      // name only, so each row previews its content.
      assert.include(checklist?.items[0].description || "", "First summary");
    });

    it("writes only the notes left checked", async function () {
      const tool = createNoteWriteBatchTool(gateway() as never);
      const validated = tool.validate({
        notes: [
          { targetItemId: 1, content: "a" },
          { targetItemId: 2, content: "b" },
          { targetItemId: 3, content: "c" },
        ],
      });
      assert.isTrue(validated.ok);
      if (!validated.ok) return;

      const applied = tool.applyConfirmation?.(validated.value, {
        writeNotesChecklist: ["1", "3"],
      });
      assert.isTrue(applied?.ok);
      if (!applied?.ok) return;
      assert.deepEqual(
        applied.value.operation.notes.map((n) => n.targetItemId),
        [1, 3],
      );
    });

    it("refuses when everything was unchecked", function () {
      const tool = createNoteWriteBatchTool(gateway() as never);
      const validated = tool.validate({
        notes: [{ targetItemId: 1, content: "a" }],
      });
      assert.isTrue(validated.ok);
      if (!validated.ok) return;
      const applied = tool.applyConfirmation?.(validated.value, {
        writeNotesChecklist: [],
      });
      assert.isFalse(applied?.ok);
    });

    it("rejects entries with no content rather than writing empty notes", function () {
      const tool = createNoteWriteBatchTool(gateway() as never);
      const result = tool.validate({
        notes: [{ targetItemId: 1, content: "   " }],
      });
      assert.isFalse(result.ok);
    });
  });
});
