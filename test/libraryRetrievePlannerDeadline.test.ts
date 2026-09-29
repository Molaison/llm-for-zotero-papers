import { assert } from "chai";
import { createRetrieveServiceRig } from "./helpers/libraryRetrieveRig";

describe("library retrieve planner deadline", function () {
  it("proceeds with the literal query when the planner is slower than the soft deadline and the index is on", async function () {
    const rig = createRetrieveServiceRig({
      papers: 2,
      textIndex: {
        isEnabled: () => true,
        search: async () => ({
          chunks: [],
          papers: [],
          coverage: {
            scopeAttachments: 2,
            indexed: 2,
            unindexed: [],
            failed: [],
            stale: [],
          },
          queryTerms: [],
          timings: {},
        }),
        leadingChunks: async () => null,
      },
      plannerDelayMs: 50,
      plannerDeadlineMs: 10,
      modelConfigured: true,
    });
    const result = await rig.service.retrieve({
      query: "method",
      depth: "evidence",
    });
    assert.deepEqual(
      result.queryPlan.variants,
      [],
      "literal plan has no model variants",
    );
    assert.match(result.warnings.join("\n"), /Query planner exceeded/);
  });

  it("waits for the planner when the index is off", async function () {
    const rig = createRetrieveServiceRig({
      papers: 2,
      plannerDelayMs: 50,
      plannerDeadlineMs: 10,
      modelConfigured: true,
    });
    const result = await rig.service.retrieve({
      query: "method",
      depth: "evidence",
    });
    assert.notMatch(result.warnings.join("\n"), /Query planner exceeded/);
    assert.lengthOf(result.queryPlan.variants, 1, "the model plan was used");
  });
});
