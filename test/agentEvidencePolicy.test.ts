import { assert } from "chai";
import { resolveReadStopGuidance } from "../src/agent/context/evidencePolicy";

describe("read stop guidance", function () {
  const targeted = { coverage: "targeted" as const, readBudget: 2 };
  const exhaustive = {
    coverage: "exhaustive" as const,
    readBudget: Number.POSITIVE_INFINITY,
  };

  it("leaves further reading to the agent after new evidence", function () {
    const guidance = resolveReadStopGuidance(targeted, {
      frontier: "advanced",
      readsThisTurn: 1,
    });
    assert.equal(guidance.recommendation, "answer_or_self_check");
    assert.include(
      guidance.reason,
      "Decide whether it supports the requested explanation",
    );
    assert.include(guidance.reason, "choose further reads");
    assert.notInclude(guidance.reason, "missing dimension");
  });

  it("discourages repeating unchanged reads while allowing another section", function () {
    const guidance = resolveReadStopGuidance(targeted, {
      frontier: "unchanged",
      readsThisTurn: 2,
    });
    assert.equal(guidance.recommendation, "name_a_specific_missing_dimension");
    assert.equal(
      guidance.reason,
      "This read added no new source text. Avoid repeating it; choose another passage or section if needed to support the answer.",
    );
  });

  it("allows missing evidence retrieval after an unchanged overview", function () {
    const guidance = resolveReadStopGuidance(
      { coverage: "overview", readBudget: 1 },
      { frontier: "unchanged", readsThisTurn: 1 },
    );
    assert.equal(guidance.recommendation, "name_a_specific_missing_dimension");
    assert.include(guidance.reason, "choose another passage or section");
    assert.notInclude(guidance.reason, "sectionId");
  });

  it("keeps reading optional after the legacy read budget is used", function () {
    const guidance = resolveReadStopGuidance(targeted, {
      frontier: "advanced",
      readsThisTurn: 2,
    });
    assert.equal(guidance.recommendation, "answer_or_self_check");
    assert.include(
      guidance.reason,
      "Read counts do not establish sufficient coverage",
    );
  });

  it("keeps gap hunting for exhaustive coverage", function () {
    const unchanged = resolveReadStopGuidance(exhaustive, {
      frontier: "unchanged",
      readsThisTurn: 5,
    });
    assert.equal(unchanged.recommendation, "name_a_specific_missing_dimension");
    const advanced = resolveReadStopGuidance(exhaustive, {
      frontier: "advanced",
      readsThisTurn: 5,
    });
    assert.equal(advanced.recommendation, "answer_or_self_check");
    assert.include(advanced.reason, "missing dimension");
  });

  it("reports source unavailability regardless of coverage", function () {
    const guidance = resolveReadStopGuidance(targeted, {
      frontier: "unavailable",
      readsThisTurn: 1,
    });
    assert.equal(guidance.recommendation, "answer_with_source_limitation");
  });
});
