import { assert } from "chai";
import { savePlanExecutionLedger } from "../src/agent/plans/store";
import {
  clearPlanModeState,
  isExplicitContinueCommand,
  restorePendingPlanExecution,
  stageApprovedPlanExecution,
  takePendingPlanExecution,
} from "../src/modules/contextPanel/planModeState";
import {
  installPlanStoreZotero,
  storedPlanExecution,
} from "./helpers/planStoreDb";

const CONVERSATION_KEY = 5101;

const storedExecution = (status: "interrupted" | "waiting_for_user") =>
  storedPlanExecution(status, CONVERSATION_KEY);

describe("explicit continue commands", function () {
  it("accepts the whole message as a continue command in either language", function () {
    for (const text of [
      "continue",
      "resume",
      "go on",
      "keep going",
      "proceed",
      "continue the plan",
      "resume the plan",
      "继续",
      "继续执行",
      "繼續",
      "繼續執行",
    ]) {
      assert.isTrue(isExplicitContinueCommand(text), text);
    }
  });

  it("ignores case, surrounding space and trailing punctuation", function () {
    for (const text of [
      "Continue",
      "  RESUME  ",
      "Go on.",
      "keep going!",
      "Proceed...",
      "continue?",
      "Continue the plan.",
      "继续。",
      "繼續！",
      "继续执行？",
      "Keep going …",
    ]) {
      assert.isTrue(isExplicitContinueCommand(text), text);
    }
  });

  it("treats any longer or different message as a new request", function () {
    for (const text of [
      "",
      "   ",
      "continue with a different question about X",
      "Please continue",
      "Can you continue?",
      "continued",
      "don't continue",
      "continue writing the summary",
      "resume the plan later",
      "What does the plan continue with?",
      "继续写",
      "请继续",
    ]) {
      assert.isFalse(isExplicitContinueCommand(text), JSON.stringify(text));
    }
  });
});

describe("pending plan execution", function () {
  let restoreZotero: () => void;

  beforeEach(async function () {
    restoreZotero = await installPlanStoreZotero();
    clearPlanModeState(CONVERSATION_KEY);
  });

  afterEach(function () {
    clearPlanModeState(CONVERSATION_KEY);
    restoreZotero();
  });

  it("runs an execution staged by approval or Resume whatever the message says", async function () {
    const approved = storedExecution("interrupted");
    stageApprovedPlanExecution(approved);

    const context = await takePendingPlanExecution(
      CONVERSATION_KEY,
      "What is the sample size of this study?",
    );

    assert.deepInclude(context, {
      phase: "executing",
      executionId: approved.executionId,
    });
    assert.isUndefined(
      await takePendingPlanExecution(CONVERSATION_KEY, "continue"),
      "a staged execution is taken once, and nothing is stored behind it",
    );
  });

  it("leaves a stored interrupted execution alone for an ordinary message", async function () {
    await savePlanExecutionLedger(storedExecution("interrupted"));

    assert.isUndefined(
      await takePendingPlanExecution(
        CONVERSATION_KEY,
        "What is the sample size of this study?",
      ),
    );
    assert.isUndefined(
      await takePendingPlanExecution(
        CONVERSATION_KEY,
        "continue with a different question about the methods",
      ),
    );
  });

  it("resumes a stored interrupted execution on an explicit continue", async function () {
    const stored = storedExecution("interrupted");
    await savePlanExecutionLedger(stored);

    for (const text of ["continue", "继续。"]) {
      assert.deepInclude(
        await takePendingPlanExecution(CONVERSATION_KEY, text),
        {
          phase: "executing",
          planId: stored.planId,
          revision: stored.revision,
          executionId: stored.executionId,
          approvedDigest: stored.planDigest,
        },
        text,
      );
    }
  });

  it("resumes a stored execution waiting for the user with whatever the user answers", async function () {
    const stored = storedExecution("waiting_for_user");
    await savePlanExecutionLedger(stored);

    for (const text of ["Use the 2019 cohort only.", "", "continue"]) {
      assert.deepInclude(
        await takePendingPlanExecution(CONVERSATION_KEY, text),
        {
          phase: "executing",
          executionId: stored.executionId,
          activeTaskId: `${stored.executionId}:task-2`,
        },
        JSON.stringify(text),
      );
    }
  });

  it("puts back only a staged execution when a send stops before dispatch", async function () {
    const stored = storedExecution("interrupted");
    await savePlanExecutionLedger(stored);
    const resumed = await takePendingPlanExecution(
      CONVERSATION_KEY,
      "continue",
    );
    assert.exists(resumed);
    restorePendingPlanExecution(CONVERSATION_KEY, resumed);
    assert.isUndefined(
      await takePendingPlanExecution(CONVERSATION_KEY, "Summarize the paper"),
      "a stored execution must pass the resume rule again, not become staged",
    );

    stageApprovedPlanExecution(stored);
    const staged = await takePendingPlanExecution(
      CONVERSATION_KEY,
      "Summarize the paper",
    );
    restorePendingPlanExecution(CONVERSATION_KEY, staged);
    assert.strictEqual(
      await takePendingPlanExecution(CONVERSATION_KEY, "Summarize the paper"),
      staged,
      "a staged execution returns to the stage exactly as it was taken",
    );
  });
});
