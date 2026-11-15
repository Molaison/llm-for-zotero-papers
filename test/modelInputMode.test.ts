import { assert } from "chai";
import {
  getModelInputModeOptionsForRuntime,
  normalizeModelInputModeForRuntime,
} from "../src/utils/modelInputMode";

describe("model input mode support", function () {
  it("keeps manual input mode overrides available for API-key provider models", function () {
    assert.deepEqual(getModelInputModeOptionsForRuntime("api_key"), [
      "auto",
      "text_only",
      "vision_allowed",
    ]);
    assert.equal(
      normalizeModelInputModeForRuntime("text_only", "api_key"),
      "text_only",
    );
  });

  it("does not offer or preserve manual input mode overrides for runtime auth modes", function () {
    for (const runtimeMode of [
      "codex_auth",
      "codex_app_server",
      "claude_code",
      "copilot_auth",
      "webchat",
    ]) {
      assert.deepEqual(getModelInputModeOptionsForRuntime(runtimeMode), []);
      assert.isUndefined(
        normalizeModelInputModeForRuntime("text_only", runtimeMode),
      );
      assert.isUndefined(
        normalizeModelInputModeForRuntime("vision_allowed", runtimeMode),
      );
    }
  });

  it("defaults unknown runtime modes to API-key provider behavior", function () {
    assert.deepEqual(getModelInputModeOptionsForRuntime(undefined), [
      "auto",
      "text_only",
      "vision_allowed",
    ]);
  });
});
