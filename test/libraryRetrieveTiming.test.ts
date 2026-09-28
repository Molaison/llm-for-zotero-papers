import { assert } from "chai";
import {
  clearRetrievalTimingsForTests,
  getRecentRetrievalTimings,
} from "../src/services/retrieval/retrievalTiming";
import { createRetrieveServiceRig } from "./helpers/libraryRetrieveRig";

describe("library retrieve timing", function () {
  beforeEach(function () {
    clearRetrievalTimingsForTests();
  });

  it("records one report per retrieve with scope, plan, records and paper_snippets phases", async function () {
    const rig = createRetrieveServiceRig({ papers: 2 });
    await rig.service.retrieve({ query: "method", depth: "evidence" });
    const [report] = getRecentRetrievalTimings();
    assert.isOk(report, "a timing report is recorded");
    for (const phase of [
      "scope",
      "plan",
      "records",
      "paper_snippets",
      "rank",
    ] as const) {
      assert.property(report.phases, phase);
    }
    assert.isAtLeast(report.totalMs, 0);
    assert.equal(report.counters.papersTouched, 2);
  });
});
