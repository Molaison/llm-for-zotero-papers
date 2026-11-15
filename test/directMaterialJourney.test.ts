import { assert } from "chai";
import { loadPlanDocument } from "../src/agent/documents/store";
import {
  BLOCK_HEADER,
  DOCUMENT_TITLE,
  PARENT_ITEM_ID,
  beginDirectMaterialJourney,
  firstEvent,
  installDirectJourneyEnvironment,
  materialBlock,
  toolResultFor,
} from "./helpers/materialJourneys";
import type { DirectJourneyEnvironment } from "./helpers/materialJourneys";
import type { MaterialRef } from "../src/agent/documents/materialRef";

/**
 * The complete direct-Agent material journey: generate in one turn, save in
 * the next, and recover the same material after a failed save.
 *
 * Every other test in this area covers one seam of that path. This one drives
 * `AgentRuntime.runTurn` across the run boundary the product decision creates
 * (`submit_document` ends its turn), so the parts have to agree: the ref the
 * finalizer minted, the ref frozen into the confirmation the user approves,
 * the ref on the receipt, and the ref the next turn is told about.
 */

describe("direct material journey", function () {
  let environment: DirectJourneyEnvironment;
  let library: DirectJourneyEnvironment["library"];

  beforeEach(async function () {
    environment = await installDirectJourneyEnvironment();
    library = environment.library;
  });

  afterEach(function () {
    environment.restore();
  });

  it("generates material in one turn and saves it as a verified note in the next", async function () {
    const conversationKey = 880_101;
    const journey = beginDirectMaterialJourney(library, conversationKey);
    const { turn: first, materialRef } = await journey.authorMaterial();

    // Turn 1: the document is finalized and the turn ends on it.
    assert.equal(
      first.steps,
      1,
      "submit_document ends the turn, so it costs exactly one generation step",
    );
    const submitResult = toolResultFor(first.events, "submit_document");
    assert.isTrue(submitResult?.ok);
    assert.deepEqual(
      (submitResult?.content as { materialRef?: MaterialRef }).materialRef,
      materialRef,
      "the announcement names the ref the finalizer returned",
    );
    const firstFinal = firstEvent(first.events, "final");
    assert.deepEqual(
      firstFinal?.materialRef,
      materialRef,
      "the terminal event names the material the turn produced",
    );
    assert.equal(firstFinal?.documentId, materialRef.documentId);

    // Turn 2: the save turn. It never regenerates; it names the document.
    const second = await journey.saveAsNote();
    assert.equal(second.outcome.kind, "completed");
    assert.equal(
      second.steps,
      2,
      "one step proposes the note and one step answers after it is written",
    );

    // The save turn is told the material exists, so it can name the document
    // instead of writing the guide a second time.
    assert.include(
      materialBlock(second.prompts) || "",
      `documentId=${materialRef.documentId} version=${materialRef.documentVersion} hash=${materialRef.contentHash} title="${DOCUMENT_TITLE}" status=finalized`,
    );

    // The user authorizes an exact material version, not just a tool call.
    const confirmation = firstEvent(second.events, "confirmation_required");
    assert.exists(
      confirmation,
      "a note write must be reviewed before it happens",
    );
    assert.equal(confirmation?.action.toolName, "note_write");
    assert.deepEqual(
      confirmation?.action.material,
      { operation: "note_create", ref: materialRef },
      "the confirmation card carries the frozen material reference",
    );
    assert.isTrue(
      second.events.some(
        (event) =>
          event.type === "confirmation_resolved" && event.approved === true,
      ),
    );

    const noteResult = toolResultFor(second.events, "note_write");
    assert.isTrue(noteResult?.ok, "the approved note write must succeed");
    const content = noteResult?.content as {
      noteId?: number;
      documentId?: string;
    };
    assert.equal(content.documentId, materialRef.documentId);
    assert.isNumber(content.noteId);

    // The receipt is the durable proof, and it names both the material and
    // the native state it verified.
    const receipt = (noteResult?.actionReceipts || []).find(
      (entry) => entry.operation === "note_create",
    );
    assert.exists(receipt, "a note write must mint a receipt");
    assert.deepEqual(receipt?.materialRef, materialRef);
    assert.equal(receipt?.verification, "verified");
    assert.include(
      receipt?.verifiedFacts || [],
      `created_note:item:${content.noteId}`,
    );
    const hashFact = (receipt?.verifiedFacts || []).find((fact) =>
      fact.startsWith(`native_note:${content.noteId}:html_sha256:`),
    );
    assert.exists(
      hashFact,
      "the strong evidence path records the native note digest",
    );
    assert.match(hashFact!, /html_sha256:[0-9a-f]{64}$/);

    // Zotero itself must hold the exact finalized document.
    const document = await loadPlanDocument(materialRef.documentId);
    assert.exists(document);
    const note = library.notes.get(content.noteId!);
    assert.exists(note, "the note must exist in the library");
    assert.equal(note.getNote(), document!.visibleHtml);
    assert.equal(note.parentID, PARENT_ITEM_ID);

    // The receipt this journey actually minted must close the material
    // outcome, or a later turn would keep offering to save the same guide
    // and the user would end up with two notes.
    const third = await journey.acknowledge();
    assert.deepEqual(
      third.request?.materialOutcomes?.map((entry) => entry.status),
      ["saved"],
    );
    assert.isUndefined(
      materialBlock(third.prompts),
      "saved material is never offered for saving again",
    );
    assert.deepEqual(
      [first.steps, second.steps, third.steps],
      [1, 2, 1],
      "four generation steps for the whole journey: author, propose, answer, acknowledge",
    );
  });

  it("recovers the same material for a retry after a failed native write", async function () {
    const conversationKey = 880_202;
    const journey = beginDirectMaterialJourney(library, conversationKey);
    const { turn: first, materialRef } = await journey.authorMaterial();
    const document = await loadPlanDocument(materialRef.documentId);
    assert.exists(document);

    // Turn 2: the native write never reaches the database.
    const second = await journey.saveAsNote({
      finalText: "I could not save it.",
      failNativeWrite: true,
    });
    const failed = toolResultFor(second.events, "note_write");
    assert.exists(failed, "the failed write still reports a result");
    assert.isFalse(failed?.ok, "a native write that did not land is not ok");
    assert.equal(
      library.notes.size,
      0,
      "nothing may be left behind in the library by a failed write",
    );

    // Turn 3: the host tells the model the material is still available, and
    // the model retries the save with the same documentId.
    const third = await journey.retrySave();
    const block = materialBlock(third.prompts);
    assert.exists(
      block,
      "the turn after a failed write must be told the material still exists",
    );
    assert.include(
      block!,
      `documentId=${materialRef.documentId} version=${materialRef.documentVersion} hash=${materialRef.contentHash} title="${DOCUMENT_TITLE}" status=write_failed`,
    );
    assert.include(block!, "a previous save of this material failed");
    assert.include(
      block!,
      "If the user asks to save it, call note_write with that documentId; do not regenerate it.",
    );
    const blockIndex = third.prompts[0].findIndex((message) =>
      String(message.content).includes(BLOCK_HEADER),
    );
    assert.isTrue(
      (third.prompts[0][blockIndex] as { transient?: boolean }).transient,
      "the block is recomputed every turn, so it must never be persisted",
    );
    assert.include(
      String(third.prompts[0][blockIndex + 1]?.content),
      "Try again",
      "the block sits immediately before this turn's user message",
    );

    assert.equal(third.outcome.kind, "completed");
    const retried = toolResultFor(third.events, "note_write");
    assert.isTrue(retried?.ok, "the retry writes the same material");
    const content = retried?.content as {
      noteId?: number;
      documentId?: string;
    };
    assert.equal(content.documentId, materialRef.documentId);
    const note = library.notes.get(content.noteId!);
    assert.equal(note.getNote(), document!.visibleHtml);

    // No turn after the first ever asked the model to author the material
    // again: the scripts contain no submit_document call, and an unscripted
    // generation step fails the turn outright.
    assert.deepEqual(
      [first.steps, second.steps, third.steps],
      [1, 2, 2],
      "five generation steps for the whole journey: author, propose, answer, propose again, answer",
    );
    assert.isFalse(
      [...second.events, ...third.events].some(
        (event) => event.type === "material_finalized",
      ),
      "material is finalized once for the whole journey",
    );
  });
});
