import { assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

describe("workflow: ordinary Chat rendering reuse", function () {
  this.timeout(60000);

  it("streams readable answers without replacing their message wrapper", async function () {
    const api = (Zotero as any).LLMForZotero.api
      .workflowTest as WorkflowTestApi;
    const fixture = await api.createPaperWithPdfFixture({
      title: "Chat reuse",
      pdfTitle: "Chat reuse PDF",
      pages: ["Fixture evidence."],
    });
    try {
      const panel = await api.renderPanelForItem(fixture.parentItemId);
      const result = await api.exerciseChatModeStreamingTurn({
        panelId: panel.panelId,
        turnIndex: 1,
        chunks: 24,
      });
      assert.isTrue(result.streamedTextVisible);
      assert.equal(
        result.wrapperReplacements,
        0,
        "ordinary Chat preserves its mounted wrapper throughout answer streaming",
      );
    } finally {
      await api.reset();
      await api.cleanupFixture(fixture);
    }
  });

  it("preserves thinking, selection, scrolling, citations, completion and cancellation", async function () {
    const api = (Zotero as any).LLMForZotero.api
      .workflowTest as WorkflowTestApi;
    const fixture = await api.createPaperWithPdfFixture({
      title: "Chat behavior",
      pdfTitle: "Chat behavior PDF",
      pages: ["Fixture evidence."],
    });
    try {
      const panel = await api.renderPanelForItem(fixture.parentItemId);
      const result = await api.exerciseChatRenderingLifecycle(panel.panelId);
      await Zotero.File.putContentsAsync(
        `${Zotero.DataDirectory.dir}/chat-rendering-lifecycle.json`,
        JSON.stringify(result, null, 2),
      );
      for (const [key, value] of Object.entries(result)) {
        if (key === "manualScrollDelta")
          assert.closeTo(value as number, 0, 2, key);
        else if (key === "followBottomGap")
          assert.isAtMost(value as number, 2, key);
        else assert.isTrue(value, key);
      }
    } finally {
      await api.reset();
      await api.cleanupFixture(fixture);
    }
  });

  it("finishes a chat turn without rebuilding earlier turns", async function () {
    const api = (Zotero as any).LLMForZotero.api
      .workflowTest as WorkflowTestApi;
    const fixture = await api.createPaperWithPdfFixture({
      title: "Chat turn end",
      pdfTitle: "Chat turn end PDF",
      pages: ["Fixture evidence."],
    });
    try {
      const panel = await api.renderPanelForItem(fixture.parentItemId);
      const result = await api.exerciseCompletedChatTurnRefresh(panel.panelId);
      await Zotero.File.putContentsAsync(
        `${Zotero.DataDirectory.dir}/completed-chat-turn-refresh.json`,
        JSON.stringify(result, null, 2),
      );
      for (const [key, value] of Object.entries(result)) {
        assert.isTrue(value as boolean, `${key}: ${JSON.stringify(result)}`);
      }
    } finally {
      await api.reset();
      await api.cleanupFixture(fixture);
    }
  });

  it("releases a detached panel without losing the saved conversation", async function () {
    const api = (Zotero as any).LLMForZotero.api
      .workflowTest as WorkflowTestApi;
    const fixture = await api.createPaperWithPdfFixture({
      title: "Closed chat",
      pdfTitle: "Closed chat PDF",
      pages: ["Fixture evidence."],
    });
    try {
      const before = await api.memoryProbeInspect({
        label: "before",
        gc: false,
      });
      const panel = await api.renderPanelForItem(fixture.parentItemId);
      await api.seedPanelStoredTurn(
        panel.panelId,
        "Saved question",
        "Saved answer",
      );
      const doc = Zotero.getMainWindow().document;
      const body = doc.querySelector(
        `[data-workflow-panel-id="${panel.panelId}"]`,
      )!;
      assert.exists(body);
      body.remove();
      await Zotero.Promise.delay(160);
      const after = await api.memoryProbeInspect({ label: "after", gc: false });
      assert.equal(after.rawItemsDisconnected, before.rawItemsDisconnected);
      assert.equal(after.panelsDisconnected, before.panelsDisconnected);
      const reopened = await api.renderPanelForItem(fixture.parentItemId);
      const reopenedBody = doc.querySelector(
        `[data-workflow-panel-id="${reopened.panelId}"]`,
      )!;
      assert.include(reopenedBody.textContent || "", "Saved answer");
      assert.include(reopenedBody.textContent || "", "Saved question");
    } finally {
      await api.reset();
      await api.cleanupFixture(fixture);
    }
  });
});
