import { assert } from "chai";
import {
  ACTION_COMPLETION_DISMISS_MS,
  formatActionLabel,
  formatActionCompletionCountdown,
  resolveActionCompletionFeedback,
  resolveActionFailureFeedback,
  resolveActionCompletionStatusText,
} from "../src/modules/contextPanel/actionStatusText";

describe("actionStatusText", function () {
  it("formats snake_case action names for fallback status text", function () {
    assert.equal(formatActionLabel("complete_metadata"), "Complete Metadata");
  });

  it("prefers the last progress summary over the generic completion text", function () {
    assert.equal(
      resolveActionCompletionStatusText({
        actionName: "complete_metadata",
        lastProgressSummary: "0 papers have updatable fields",
      }),
      "0 papers have updatable fields",
    );
  });

  it("falls back to a generic completion message when no summary is available", function () {
    assert.equal(
      resolveActionCompletionStatusText({
        actionName: "auto_tag",
        lastProgressSummary: "   ",
      }),
      "Auto Tag complete",
    );
  });

  it("builds success feedback with a 5-second auto-dismiss", function () {
    assert.deepEqual(
      resolveActionCompletionFeedback({
        actionName: "auto_tag",
        output: { tagged: 2 },
        lastProgressSummary: "Tagged 2 items",
      }),
      {
        status: "success",
        title: "Tagged 2 items",
        description: "Tagged 2 items",
        autoDismissMs: ACTION_COMPLETION_DISMISS_MS,
      },
    );
    assert.equal(ACTION_COMPLETION_DISMISS_MS, 5000);
  });

  it("builds failure feedback with the same countdown behavior", function () {
    assert.deepEqual(
      resolveActionFailureFeedback({
        actionName: "audit_library",
        error: new Error("OpenAlex unavailable"),
      }),
      {
        status: "failure",
        title: "Audit Library failed",
        description: "OpenAlex unavailable",
        autoDismissMs: ACTION_COMPLETION_DISMISS_MS,
      },
    );
    assert.equal(formatActionCompletionCountdown(5), "Closing in 5 seconds");
  });
});
