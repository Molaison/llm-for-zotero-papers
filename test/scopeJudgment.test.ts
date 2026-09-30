/**
 * A write outside the turn's authorized scope: in YOLO the host may run it on
 * the agent's judgment, except where a rail (a prohibited impact or an
 * integrity signal) or a non-amendable failure blocks it. Safe and Auto
 * always block it.
 */
import { assert } from "chai";
import { decideScopeJudgment } from "../src/agent/authorization/scopeJudgment";

describe("scope judgment", function () {
  const failure = {
    code: "different_operation" as const,
    message: "Action apply_tags does not match any authorized obligation.",
    expectedCount: 1,
    proposedCount: 1,
    rejectedTargets: [],
    missingTargets: [],
  };
  const base = {
    failure,
    actionImpact: "state_change" as const,
    riskSignals: [] as string[],
  };

  it("grants yolo judgment for unmatched conversation writes and keeps the rails", function () {
    for (const code of [
      "different_operation",
      "different_parameters",
      "scope_mismatch",
      "fixed_selection",
      "added_target",
      "incomplete_batch",
    ] as const) {
      assert.deepEqual(
        decideScopeJudgment({
          ...base,
          originalMode: "yolo",
          failure: { ...failure, code },
        }),
        { kind: "execute", authority: "yolo_judgment" },
        code,
      );
    }
    for (const code of [
      "hard_constraint",
      "protected_target",
      "closed_obligation",
      "stale_scope",
      "workflow_dependency",
      "missing_typed_proposal",
    ] as const) {
      assert.equal(
        decideScopeJudgment({
          ...base,
          originalMode: "yolo",
          failure: { ...failure, code },
        }).kind,
        "block",
        code,
      );
    }
    for (const signal of [
      "protected_target",
      "authorization_tampering",
      "privilege_escalation",
    ]) {
      assert.equal(
        decideScopeJudgment({
          ...base,
          originalMode: "yolo",
          riskSignals: [signal],
        }).kind,
        "block",
        signal,
      );
    }
    assert.equal(
      decideScopeJudgment({
        ...base,
        originalMode: "yolo",
        actionImpact: "prohibited",
      }).kind,
      "block",
    );
    for (const mode of ["safe", "auto"] as const) {
      assert.equal(
        decideScopeJudgment({ ...base, originalMode: mode }).kind,
        "block",
        mode,
      );
    }
  });
});
