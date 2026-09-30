import { assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

describe("workflow: agent final delivery", function () {
  this.timeout(60000);
  for (const failFinalRefresh of [false, true]) {
    it(`persists and displays the completed note outcome${failFinalRefresh ? " after a final-render exception" : ""}`, async function () {
      assert.match(
        Zotero.DataDirectory.dir,
        /(?:[/\\]zotero-dev|[/\\]\.scaffold[/\\]test[/\\]data)[/\\]?$/,
      );
      const api = (Zotero as any).LLMForZotero.api
        .workflowTest as WorkflowTestApi;
      const fixture = await api.createPaperWithPdfFixture({
        title: "Final delivery",
        pages: ["Disposable delivery fixture."],
      });
      try {
        const panel = await api.renderPanelForItem(fixture.parentItemId);
        const result = await api.exerciseAgentDeliveryReplay({
          panelId: panel.panelId,
          failFinalRefresh,
        });
        assert.equal(result.injected, failFinalRefresh);
        assert.equal(result.runStatus, "completed", JSON.stringify(result));
        assert.include(result.finalText || "", "The requested note is saved");
        assert.equal(result.retained, result.finalText);
        assert.deepEqual(result.storedAnswers, [result.finalText]);
        assert.equal(result.messageText, result.finalText);
        assert.isFalse(result.streaming);
        assert.match(result.summary || "", /^Worked for /);
        assert.equal(result.actionCards, 1);
        assert.equal(result.noteIds.length, 1);
        assert.isTrue(result.verified);
        assert.match(
          result.status || "",
          failFinalRefresh ? /Error:.*presentation failure/ : /Ready/,
        );
        const note = Zotero.Items.get(result.noteIds[0]);
        await note.reload(undefined as never, true);
        assert.equal(note.parentID, fixture.parentItemId);
        assert.include(note.getNote(), "A complete, persisted note body.");
      } finally {
        await api.cleanupFixture(fixture);
        await api.reset();
      }
    });
  }
});
