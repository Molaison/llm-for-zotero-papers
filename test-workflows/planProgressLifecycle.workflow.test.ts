import { assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

/**
 * Plan steps live only in the Task progress drawer: visible while the plan
 * runs, gone when it pauses or ends, never recreated from history, and never
 * a floating capsule. The row itself outlives the plan and shows the run
 * completed.
 */
describe("workflow: plan progress lifecycle", function () {
  this.timeout(120000);
  it("shows steps in the drawer only while the plan runs, and keeps the row completed", async function () {
    const api = (Zotero as any).LLMForZotero.api
      .workflowTest as WorkflowTestApi;
    const fixture = await api.createPaperWithPdfFixture({
      title: "Plan progress lifecycle",
      pages: ["Synthetic lifecycle evidence."],
    });
    try {
      const panel = await api.renderPanelForItem(fixture.parentItemId);
      const result = await api.exerciseStreamingReplay({
        panelId: panel.panelId,
        historyTurns: 2,
        chunks: 2,
      });
      Zotero.debug(`PLAN_LIFECYCLE ${JSON.stringify(result)}`, 1);
      assert.isTrue(
        result.stepsVisibleWhileRunning,
        "a running plan shows its steps in the drawer",
      );
      assert.deepEqual(
        result.pausedProgressNodes,
        [0, 0, 0],
        "a paused plan shows no live steps",
      );
      assert.isTrue(result.resumeStartsProgress);
      assert.equal(result.inactiveProgressReads, 0);
      assert.equal(
        result.completedProgressNodes,
        0,
        "completion clears the steps",
      );
      assert.equal(
        result.reopenedProgressNodes,
        0,
        "history cannot recreate the steps",
      );
      assert.isTrue(
        result.rowVisibleAfterCompletion,
        "the Task progress row persists after the plan",
      );
      assert.equal(result.rowStateAfterCompletion, "completed");
      assert.equal(
        result.floatingCapsuleNodes,
        0,
        "no floating plan capsule, ever",
      );
    } finally {
      await api.reset();
      await api.cleanupFixture(fixture);
    }
  });
});
