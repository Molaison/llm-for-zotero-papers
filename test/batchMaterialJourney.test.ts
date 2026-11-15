import { assert } from "chai";
import { loadPlanDocument } from "../src/agent/documents/store";
import { listJournalActions } from "../src/agent/store/changeJournal";
import { listBatchItems } from "../src/agent/store/batchItemStore";
import {
  BATCH_HEADER,
  MATERIAL_HEADER,
  beginBatchMaterialJourney,
  eventsOfType,
  firstEvent,
  hostBlock,
  installBatchJourneyEnvironment,
  toolResultFor,
} from "./helpers/materialJourneys";
import type { BatchJourneyEnvironment } from "./helpers/materialJourneys";
import type { AgentEvent } from "../src/agent/types";

/**
 * The complete durable-batch journey: write a note onto three papers, have one
 * of them refused by Zotero, continue the batch in the next turn, and undo the
 * whole set in the one after that.
 *
 * The seams each have their own test. This one drives `AgentRuntime.runTurn`
 * across the two run boundaries the story creates, so the parts have to agree:
 * the material the tool froze before the user approved anything, the durable
 * rows that say which items still owe a note, the host block the next turn is
 * told about, the single journal action that owns every note, and the undo that
 * reverts it.
 */

/** Every fact the batch call's own receipts carry, in one flat list. */
function receiptFacts(events: readonly AgentEvent[]): string[] {
  const result = toolResultFor(events, "note_write_batch");
  assert.exists(result, "the batch write must produce a tool result");
  const receipts = result!.actionReceipts || [];
  assert.isNotEmpty(receipts, "an approved batch write mints a receipt");
  return receipts.flatMap((receipt) => receipt.verifiedFacts || []);
}

/** Matches the one content read-back fact a written note is proved by. */
function readBackOf(noteId: number): (fact: string) => boolean {
  return (fact) => fact.startsWith(`native_note:${noteId}:html_sha256:`);
}

describe("batch material journey", function () {
  let environment: BatchJourneyEnvironment;
  let library: BatchJourneyEnvironment["library"];

  beforeEach(async function () {
    environment = await installBatchJourneyEnvironment();
    library = environment.library;
  });

  afterEach(function () {
    environment.restore();
  });

  it("writes three notes, continues the one that failed, and undoes the set", async function () {
    const conversationKey = 881_101;
    const journey = beginBatchMaterialJourney(library, conversationKey);

    // Turn 1: one call carries all three bodies, and Zotero refuses paper 2.
    const first = await journey.writeThreeNotes();
    assert.equal(first.outcome.kind, "completed");

    // The user approved the exact bodies, named by the material frozen for them.
    const confirmation = firstEvent(first.events, "confirmation_required");
    assert.exists(
      confirmation,
      "a batch write must be reviewed before it runs",
    );
    assert.equal(confirmation?.action.toolName, "note_write_batch");
    assert.deepEqual(
      confirmation?.action.fields[0]?.type === "checklist"
        ? confirmation.action.fields[0].items.map((item) => item.label)
        : [],
      ["Paper 1", "Paper 2", "Paper 3"],
      "every item of the set is on one card",
    );

    // Three bodies, three documents, one durable row each.
    const batchItems = eventsOfType(first.events, "batch_item_outcome");
    assert.lengthOf(batchItems, 3, "each item of the batch is announced");
    const batchId = batchItems[0].batchId;
    assert.deepEqual(
      batchItems.map((event) => event.itemKey),
      ["item:1", "item:2", "item:3"],
    );
    assert.deepEqual(
      batchItems.map((event) => event.status),
      ["saved", "failed", "saved"],
      "a refused item fails on its own; the batch does not stop at it",
    );
    assert.deepEqual(
      batchItems.map((event) => event.written),
      [true, false, true],
      "the call reports which notes it actually wrote",
    );
    assert.match(batchItems[1].error || "", /Zotero refused the note write/);
    assert.isEmpty(
      eventsOfType(first.events, "material_finalized"),
      "fifty note bodies must never flood the turn's material ledger",
    );

    const rowsAfterFirst = await listBatchItems(batchId);
    assert.deepEqual(
      rowsAfterFirst.map((row) => row.status),
      ["saved", "failed", "saved"],
    );
    const frozen = rowsAfterFirst.map((row) => row.materialRef!);
    assert.lengthOf(
      new Set(frozen.map((ref) => ref.documentId)),
      3,
      "each note body is its own finalized document",
    );
    for (const [index, ref] of frozen.entries()) {
      const document = await loadPlanDocument(ref.documentId);
      assert.exists(document, "every item's body is stored before any write");
      assert.equal(document!.contentHash, ref.contentHash);
      assert.include(
        document!.visibleMarkdown,
        `Summary of paper ${index + 1}`,
      );
    }
    const savedNoteIds = [rowsAfterFirst[0].noteId!, rowsAfterFirst[2].noteId!];
    assert.equal(library.notes.size, 2, "only the notes that landed exist");
    for (const [index, noteId] of savedNoteIds.entries()) {
      const document = await loadPlanDocument(
        frozen[index === 0 ? 0 : 2].documentId,
      );
      assert.equal(library.notes.get(noteId).stored, document!.visibleHtml);
    }

    // Every note the batch physically wrote is proved on the receipt the same
    // way a single note_write proves its own: by a native read-back of the
    // stored note, named as one fact per note. A batch is not exempt from the
    // rule that a write yields content evidence, and the item Zotero refused
    // must leave no such fact behind.
    const firstFacts = receiptFacts(first.events);
    assert.deepEqual(
      savedNoteIds.map(
        (noteId) => firstFacts.filter(readBackOf(noteId)).length,
      ),
      [1, 1],
      "each written note carries exactly one content read-back fact",
    );
    assert.lengthOf(
      firstFacts.filter((fact) => fact.startsWith("native_note:")),
      2,
      "the refused item is proved by nothing: two notes landed, two facts",
    );
    assert.deepEqual(
      savedNoteIds.map((noteId) =>
        firstFacts.includes(`created_note:item:${noteId}`),
      ),
      [true, true],
      "a batch that created the note names it the way one note_write does",
    );

    // One action, one step per note, and the refused note is a failed step.
    const [openedAction] = await listJournalActions({ conversationKey });
    assert.exists(openedAction, "the batch opens exactly one journal action");
    assert.equal(openedAction.toolName, "note_write_batch");
    assert.equal(openedAction.status, "partially_applied");
    assert.equal(openedAction.affectedCount, 2);
    assert.deepEqual(
      openedAction.steps.map((step) => step.sequence),
      [1, 2, 3],
    );
    assert.deepEqual(
      openedAction.steps.map((step) => step.status),
      ["applied", "failed", "applied"],
    );

    // Turn 2: the host tells the model the batch can be continued, and the
    // model continues it by name. No body is authored a second time.
    const second = await journey.finishTheRest();
    assert.equal(second.outcome.kind, "completed");
    const block = hostBlock(second.prompts, BATCH_HEADER);
    assert.exists(block, "the turn after an interrupted batch must name it");
    assert.include(
      block!.content,
      `batchId=${batchId} total=3 saved=2 failed=1 pending=0`,
    );
    assert.include(
      block!.content,
      `To continue, call note_write_batch with resumeBatchId=${batchId}; the saved items are skipped and no note is regenerated.`,
    );
    assert.isTrue(
      block!.transient,
      "the rows are read again every turn, so the block must never persist",
    );
    assert.include(
      block!.next,
      "Finish the rest",
      "the host block sits immediately before this turn's user message",
    );
    assert.isUndefined(
      hostBlock(second.prompts, MATERIAL_HEADER),
      "batch bodies are recovered from the batch's own rows, not the ledger",
    );

    const resumeResult = toolResultFor(second.events, "note_write_batch");
    assert.isTrue(resumeResult?.ok, "the resume writes the note that failed");
    const rowsAfterResume = await listBatchItems(batchId);
    assert.deepEqual(
      rowsAfterResume.map((row) => row.status),
      ["saved", "saved", "saved"],
    );
    assert.deepEqual(
      rowsAfterResume.map((row) => row.materialRef),
      frozen,
      "the frozen material identities are unchanged: nothing was regenerated",
    );
    const recoveredNoteId = rowsAfterResume[1].noteId!;
    const recoveredDocument = await loadPlanDocument(frozen[1].documentId);
    assert.equal(
      library.notes.get(recoveredNoteId).stored,
      recoveredDocument!.visibleHtml,
      "the recovered note carries exactly the body frozen before the failure",
    );
    assert.deepEqual(
      [rowsAfterResume[0].noteId, rowsAfterResume[2].noteId],
      savedNoteIds,
      "the notes that already landed are left alone",
    );
    assert.equal(library.notes.size, 3, "exactly the missing note is added");
    assert.deepEqual(
      eventsOfType(second.events, "batch_item_outcome").map(
        (event) => event.written,
      ),
      [false, true, false],
      "a resume announces every row it holds and names the one it wrote",
    );
    assert.isEmpty(
      eventsOfType(second.events, "material_finalized"),
      "a resume finalizes nothing",
    );

    // The resume proves the one note it wrote and nothing else. The two notes
    // an earlier call already wrote are not re-proved here: this call did not
    // write them, so its receipt must not speak for them.
    const resumeFacts = receiptFacts(second.events);
    assert.lengthOf(
      resumeFacts.filter((fact) => fact.startsWith("native_note:")),
      1,
      "a resume proves exactly the rows it wrote",
    );
    assert.lengthOf(
      resumeFacts.filter(readBackOf(recoveredNoteId)),
      1,
      "the recovered note carries its own content read-back",
    );
    for (const noteId of savedNoteIds)
      assert.notInclude(
        resumeFacts.join(" "),
        `native_note:${noteId}:`,
        "a row this call skipped is not re-proved by it",
      );

    // The batch is finished, but its action still holds the first attempt's
    // failed step, so the journal records it as partially applied.
    const actionsAfterResume = await listJournalActions({ conversationKey });
    assert.deepEqual(
      actionsAfterResume.map((action) => action.actionId),
      [openedAction.actionId],
      "a resume opens no second action beside the batch's own",
    );
    assert.equal(actionsAfterResume[0].status, "partially_applied");
    assert.equal(actionsAfterResume[0].affectedCount, 3);
    assert.deepEqual(
      actionsAfterResume[0].steps.map((step) => step.sequence).sort(),
      [1, 2, 3, 4],
      "resumed steps continue the action's sequence instead of colliding",
    );

    // Turn 3: one undo reverts the whole set.
    const third = await journey.undoThem();
    assert.equal(third.outcome.kind, "completed");
    assert.isUndefined(
      hostBlock(third.prompts, BATCH_HEADER),
      "a batch with every item written is no longer offered for continuing",
    );
    const undoResult = toolResultFor(third.events, "undo");
    assert.isTrue(undoResult?.ok);
    assert.equal((undoResult?.content as { status?: string }).status, "undone");
    assert.equal(
      (undoResult?.content as { actionId?: string }).actionId,
      openedAction.actionId,
    );
    assert.deepEqual(
      library.trashed,
      [[recoveredNoteId], [savedNoteIds[1]], [savedNoteIds[0]]],
      "the action's steps are reverted newest-first, one note each",
    );
    assert.deepEqual(
      [...library.notes.values()].map((note) => note.deleted),
      [true, true, true],
      "every note the batch wrote is gone from the library",
    );
    const [revertedAction] = await listJournalActions({
      actionId: openedAction.actionId,
    });
    assert.equal(revertedAction.status, "reverted");

    assert.deepEqual(
      [first.steps, second.steps, third.steps],
      [2, 2, 2],
      "six generation steps: propose, answer, continue, answer, undo, answer",
    );
    const batchCalls = [first, second].map(
      (turn) =>
        eventsOfType(turn.events, "tool_call").filter(
          (event) => event.name === "note_write_batch",
        ).length,
    );
    assert.deepEqual(
      batchCalls,
      [1, 1],
      "one batch call wrote three notes and one continued them; no body was authored twice",
    );
  });

  it("does not vouch for a batch note it could not read back", async function () {
    const conversationKey = 881_102;
    const journey = beginBatchMaterialJourney(library, conversationKey);
    // Paper 3's note is trashed the instant Zotero stores it: the write landed
    // inside the mutation window, so the set-level postcondition still holds,
    // but the receipt's own re-read afterwards finds no live note.
    library.trashNoteFor(3);

    // Every note lands, so the whole-set postcondition holds and the verdict
    // turns on the receipt's per-note re-read alone.
    const first = await journey.writeThreeNotes({ refuseParentId: null });
    assert.equal(first.outcome.kind, "completed");
    assert.deepEqual(
      eventsOfType(first.events, "batch_item_outcome").map(
        (event) => event.status,
      ),
      ["saved", "saved", "saved"],
      "the write itself landed on all three papers",
    );

    const result = toolResultFor(first.events, "note_write_batch");
    const receipts = result?.actionReceipts || [];
    assert.lengthOf(receipts, 1, "one approved batch, one receipt");
    const receipt = receipts[0];
    const vanishedNoteId = [...library.notes.keys()].find(
      (id) => library.notes.get(id).parentID === 3,
    )!;

    assert.deepEqual(
      receipt.reasons,
      [`Zotero item ${vanishedNoteId} is not a live note after mutation.`],
      "the receipt names the note it could not re-read",
    );
    assert.equal(
      receipt.verification,
      "unverified",
      "a receipt that could not re-read a note it wrote must not say verified",
    );
    assert.notInclude(
      (receipt.verifiedFacts || []).join(" "),
      `native_note:${vanishedNoteId}:`,
      "the note it could not read back carries no content fact",
    );

    // The write is not retracted: it landed inside the mutation window, so the
    // targets stay applied. Only what the receipt vouches for changes.
    assert.equal(receipt.status, "applied");
    assert.isNotEmpty(
      receipt.appliedTargets || [],
      "the applied targets are what the mutation window proved",
    );
    const rows = await listBatchItems(
      eventsOfType(first.events, "batch_item_outcome")[0].batchId,
    );
    assert.deepEqual(
      rows.map((row) => row.status),
      ["saved", "saved", "saved"],
      "the durable rows still record three written notes",
    );
  });
});
