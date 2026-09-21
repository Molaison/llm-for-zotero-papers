import { assert } from "chai";
import { isScreenshotUnsupportedModel } from "../src/modules/contextPanel/setupHandlers/controllers/modelReasoningController";
import { isReasoningLevelActive } from "../src/utils/llmClient";
import { getModelCapabilities } from "../src/modelCapabilities";

describe("modelReasoningController", function () {
  describe("isScreenshotUnsupportedModel", function () {
    it("updates figure availability when switching DeepSeek endpoints and input modes", function () {
      for (const model of [
        "deepseek-v4-pro",
        "deepseek-reasoner",
        "deepseek-new-model",
      ]) {
        const protocol = "anthropic_messages";
        const official = "https://api.deepseek.com/anthropic";
        const relay = "https://relay.example/anthropic";
        assert.isFalse(
          isScreenshotUnsupportedModel(model, protocol, "api_key", official),
        );
        assert.isFalse(
          isScreenshotUnsupportedModel(model, protocol, "api_key", relay),
        );
        assert.isFalse(
          isScreenshotUnsupportedModel(
            model,
            protocol,
            "api_key",
            relay,
            "vision_allowed",
          ),
        );
        assert.isTrue(
          isScreenshotUnsupportedModel(
            model,
            protocol,
            "api_key",
            official,
            "text_only",
          ),
        );
        assert.isFalse(
          isScreenshotUnsupportedModel(model, protocol, "api_key", official),
        );
      }
    });

    it("allows DeepSeek vision variants unless text-only mode is selected", function () {
      const model = "deepseek-v4-flash-vision-exp";
      const protocol = "openai_chat_compat";
      const apiBase = "https://api.deepseek.com/v1";

      assert.isFalse(
        isScreenshotUnsupportedModel(model, protocol, "api_key", apiBase),
      );
      assert.isTrue(
        isScreenshotUnsupportedModel(
          model,
          protocol,
          "api_key",
          apiBase,
          "text_only",
        ),
      );
    });
  });

  describe("isReasoningLevelActive", function () {
    // The chip used to read the level's display label and treat the words
    // "off" and "disabled" as thinking-off, which is why profiles carried a
    // synonym per level. It now reads the request the level actually sends.
    const deepseek = () =>
      getModelCapabilities({
        model: "deepseek-v4-pro",
        apiBase: "https://api.deepseek.com/v1",
        protocol: "openai_chat_compat",
      });

    it("is inactive when the request switches thinking off", function () {
      assert.isFalse(isReasoningLevelActive(deepseek(), "none"));
      assert.isFalse(
        isReasoningLevelActive(
          getModelCapabilities({
            model: "gemini-2.5-flash",
            apiBase: "https://generativelanguage.googleapis.com/v1beta",
            protocol: "gemini_native",
          }),
          "minimal",
        ),
      );
    });

    it("is active for levels that leave thinking on", function () {
      assert.isTrue(isReasoningLevelActive(deepseek(), "high"));
      assert.isTrue(isReasoningLevelActive(deepseek(), "max"));
      assert.isTrue(isReasoningLevelActive(deepseek(), "low"));
    });

    it("treats the provider default — an empty fragment — as active", function () {
      assert.isTrue(isReasoningLevelActive(deepseek(), "auto"));
    });
  });
});
