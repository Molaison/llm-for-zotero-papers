/**
 * The resume gate of long jobs (stage 6.4): a note job over fifty papers,
 * one note a paper, survives the user's Stop and a restart of the agent's
 * state, and "continue" finishes it with no paper written twice. Only the
 * model is scripted; the notes are real Zotero notes, proved by receipts.
 */
import { assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

describe("workflow: long job resume", function () {
  this.timeout(180000);

  it("finishes a fifty-paper note job after Stop and a restart, with one note a paper and none written twice", async function () {
    assert.match(
      Zotero.DataDirectory.dir,
      /(?:[/\\]zotero-dev|[/\\]\.scaffold[/\\]test[/\\]data)[/\\]?$/,
    );
    const api = (Zotero as any).LLMForZotero.api
      .workflowTest as WorkflowTestApi;
    const libraryID = Zotero.Libraries.userLibraryID;
    const folder = new Zotero.Collection();
    (folder as { libraryID: number }).libraryID = libraryID;
    folder.name = `Note job ${Date.now()}`;
    await folder.saveTx();
    const papers: Zotero.Item[] = [];
    try {
      for (let index = 1; index <= 50; index += 1) {
        const paper = new Zotero.Item("journalArticle");
        paper.libraryID = libraryID;
        paper.setField("title", `Drift resume paper ${index}`);
        paper.setCollections([folder.id]);
        await paper.saveTx();
        papers.push(paper);
      }
      const ids = papers.map((paper) => paper.id);
      const panel = await api.renderPanelForItem(ids[0]);
      try {
        const result = await api.exerciseLongJobNoteResume({
          panelId: panel.panelId,
          collection: {
            collectionId: folder.id,
            name: folder.name,
            libraryID,
          },
          papers: papers.map((paper) => ({
            itemId: paper.id,
            title: String(paper.getField("title")),
          })),
          inputTokenCap: 40_000,
          stopAfterNotes: 20,
        });
        const report = JSON.stringify(result);

        // The user's Stop ended the first turn midway, resumable.
        assert.equal(result.first.runStatus, "cancelled", report);
        assert.equal(result.first.end, "cancelled", report);
        assert.isAtLeast(result.first.noted.length, 20, report);
        assert.isBelow(result.first.noted.length, 50, report);
        assert.isAbove(
          result.first.read,
          result.first.noted.length,
          "stopped with papers read whose notes were not written yet",
        );

        // After the restart, "continue" picked the job back up at its first
        // paper without a note, and finished it.
        const left = ids.filter((id) => !result.first.noted.includes(id));
        assert.include(
          result.second.resumeNote,
          `“Save a note on each paper” ${result.first.noted.length} of 50 done`,
          report,
        );
        assert.include(
          result.second.resumeNote,
          `The ${left.length} papers left, in order: ${left.join(", ")}.`,
        );
        assert.equal(result.second.runStatus, "completed", report);
        assert.equal(result.second.end, "completed", report);

        // The note the resumed model wrote again was skipped by the host.
        assert.deepEqual(result.second.skipped, [result.second.again], report);

        // Every paper ends with exactly one note, proved by one receipt.
        for (const id of ids) {
          assert.equal(result.notesPerPaper[id], 1, `paper ${id}: ${report}`);
          assert.equal(
            result.receiptsPerPaper[id],
            1,
            `paper ${id}: ${report}`,
          );
        }
      } finally {
        await api.clickPanelDelete(panel.panelId).catch(() => undefined);
      }
    } finally {
      for (const paper of papers) {
        for (const noteId of paper.getNotes())
          await Zotero.Items.get(noteId)
            ?.eraseTx()
            .catch(() => undefined);
        await paper.eraseTx().catch(() => undefined);
      }
      await folder.eraseTx().catch(() => undefined);
    }
  });

  it("stops a fifty-note batch while it writes, counts exactly the notes written, and continue writes only the rest", async function () {
    assert.match(
      Zotero.DataDirectory.dir,
      /(?:[/\\]zotero-dev|[/\\]\.scaffold[/\\]test[/\\]data)[/\\]?$/,
    );
    const api = (Zotero as any).LLMForZotero.api
      .workflowTest as WorkflowTestApi;
    const libraryID = Zotero.Libraries.userLibraryID;
    const folder = new Zotero.Collection();
    (folder as { libraryID: number }).libraryID = libraryID;
    folder.name = `Note batch ${Date.now()}`;
    await folder.saveTx();
    const papers: Zotero.Item[] = [];
    try {
      for (let index = 1; index <= 50; index += 1) {
        const paper = new Zotero.Item("journalArticle");
        paper.libraryID = libraryID;
        paper.setField("title", `Drift batch paper ${index}`);
        paper.setCollections([folder.id]);
        await paper.saveTx();
        papers.push(paper);
      }
      const ids = papers.map((paper) => paper.id);
      const panel = await api.renderPanelForItem(ids[0]);
      try {
        const result = await api.exerciseLongJobBatchStop({
          panelId: panel.panelId,
          collection: {
            collectionId: folder.id,
            name: folder.name,
            libraryID,
          },
          papers: papers.map((paper) => ({
            itemId: paper.id,
            title: String(paper.getField("title")),
          })),
          // Room for the whole folder in one pass: the model reads every
          // paper, then writes every note in one batch.
          inputTokenCap: 2_000_000,
          stopAfterNotes: 20,
        });
        const report = JSON.stringify(result);

        // Stop, pressed while the batch was writing, ended the run, and the
        // batch within one note of it.
        assert.equal(result.first.runStatus, "cancelled", report);
        assert.equal(result.first.end, "cancelled", report);
        assert.equal(result.first.notesAtStop, 20, report);
        assert.isAtLeast(result.first.noted.length, 20, report);
        assert.isAtMost(result.first.noted.length, 21, report);

        // What the batch wrote reached the ledger, exactly: its receipt and
        // the part name the papers that have a note, and no other.
        assert.equal(result.first.receiptStatus, "partial", report);
        assert.deepEqual(result.first.receiptApplied, result.first.noted);
        assert.deepEqual(result.first.ledgerDone, result.first.noted);
        assert.equal(result.first.ledgerStatus, "pending", report);

        // "continue" resumed the job at the papers left; the batch sent again
        // whole was refused for the papers already written, naming the rest.
        const left = ids.filter((id) => !result.first.noted.includes(id));
        assert.include(
          result.second.resumeNote,
          `“Write a short reading note on each paper” ${result.first.noted.length} of 50 done`,
          report,
        );
        assert.include(
          result.second.resumeNote,
          `The ${left.length} papers left, in order: ${left.join(", ")}.`,
        );
        assert.isFalse(result.second.refused?.ok, report);
        assert.include(
          result.second.refused?.error || "",
          `Send the call again with only the papers left: ${left.join(", ")}.`,
          report,
        );
        // The stopped batch, continued by its id, wrote only the rest.
        assert.deepEqual(result.second.resumedApplied, left, report);
        assert.equal(result.second.runStatus, "completed", report);
        assert.equal(result.second.end, "completed", report);

        // Every paper ends with exactly one note, proved by one receipt.
        for (const id of ids) {
          assert.equal(result.notesPerPaper[id], 1, `paper ${id}: ${report}`);
          assert.equal(
            result.receiptsPerPaper[id],
            1,
            `paper ${id}: ${report}`,
          );
        }
      } finally {
        await api.clickPanelDelete(panel.panelId).catch(() => undefined);
      }
    } finally {
      for (const paper of papers) {
        for (const noteId of paper.getNotes())
          await Zotero.Items.get(noteId)
            ?.eraseTx()
            .catch(() => undefined);
        await paper.eraseTx().catch(() => undefined);
      }
      await folder.eraseTx().catch(() => undefined);
    }
  });
});
