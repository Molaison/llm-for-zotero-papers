import { assert } from "chai";
import {
  captureBatchInteraction,
  restoreBatchInteraction,
} from "../src/agent/actions/batchInteraction";

describe("durable action interaction", function () {
  it("resumes a job from the entry point it was started from", function () {
    const stored = captureBatchInteraction({ actionEntryPoint: "action_ui" });
    assert.deepEqual(stored, {
      version: 2,
      entryPoint: "action_ui",
      preferences: [],
    });
    const resumed = restoreBatchInteraction(
      { actionEntryPoint: "conversation" } as never,
      JSON.parse(JSON.stringify(stored)),
    );
    assert.equal(resumed.actionEntryPoint, "action_ui");
  });

  it("reads a job stored with classifier-era review preferences", function () {
    const stored = {
      version: 2,
      entryPoint: "action_ui",
      intentRevision: 3,
      preferences: [
        {
          obligationId: "a",
          operation: "apply_tags",
          reviewPreference: "direct",
        },
      ],
    };
    assert.equal(
      restoreBatchInteraction({} as never, stored).actionEntryPoint,
      "action_ui",
    );
  });

  it("resumes an untrusted stored interaction as a conversation", function () {
    for (const stored of [
      undefined,
      { version: 1, entryPoint: "action_ui", preferences: [] },
      { version: 2, entryPoint: "menu", preferences: [] },
      {
        version: 2,
        entryPoint: "action_ui",
        preferences: [{ obligationId: "a", reviewPreference: "always" }],
      },
    ]) {
      assert.equal(
        restoreBatchInteraction(
          { actionEntryPoint: "action_ui" } as never,
          stored,
        ).actionEntryPoint,
        "conversation",
        JSON.stringify(stored),
      );
    }
  });
});
