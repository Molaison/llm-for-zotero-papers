import { assert } from "chai";
import {
  getAnthropicReasoningProfileForModel,
  getDeepseekReasoningProfileForModel,
  getMimoReasoningProfileForModel,
  getOpenAIReasoningProfileForModel,
  getReasoningDefaultLevelForModel,
  getRuntimeReasoningOptionsForModel,
  supportsReasoningForModel,
} from "../src/utils/reasoningProfiles";
import { buildReasoningPayload } from "../src/utils/llmClient";

describe("reasoningProfiles", function () {
  const levels = (provider: any, model: string) =>
    getRuntimeReasoningOptionsForModel(provider, model).map((o) => o.level);
  describe("provider vocabularies match the published APIs", function () {
    // Each level id is the value the provider documents, so the menu, the
    // editor and the request all say the same word. Sources: DeepSeek thinking
    // mode guide, OpenAI reasoning guide + model pages, xAI reasoning guide,
    // Claude effort docs. Checked 2026-09-09.

    it("DeepSeek V4 offers none/low/high/max, the efforts the API accepts", function () {
      for (const model of ["deepseek-v4-pro", "deepseek-v4-flash"]) {
        assert.deepEqual(
          levels("deepseek", model),
          ["none", "low", "high", "max"],
          model,
        );
      }
      const profile = getDeepseekReasoningProfileForModel("deepseek-v4-pro");
      assert.equal(profile.levelToThinkingType.none, "disabled");
      assert.equal(profile.levelToReasoningEffort.low, "low");
      assert.equal(profile.levelToReasoningEffort.max, "max");
      assert.equal(
        getReasoningDefaultLevelForModel("deepseek", "deepseek-v4-pro"),
        "high",
      );
    });

    it("GPT-5.6 offers the full documented effort ladder", function () {
      for (const model of ["gpt-5.6-sol", "gpt-5.6-luna"]) {
        assert.deepEqual(
          levels("openai", model),
          ["none", "low", "medium", "high", "xhigh", "max"],
          model,
        );
      }
      assert.equal(
        getReasoningDefaultLevelForModel("openai", "gpt-5.6-sol"),
        "medium",
      );
    });

    it("Grok 4.5 and 4.6 accept reasoning effort; plain grok-4 does not", function () {
      assert.deepEqual(levels("grok", "grok-4.6"), [
        "low",
        "medium",
        "high",
        "xhigh",
      ]);
      assert.deepEqual(levels("grok", "grok-4.20-multi-agent"), [
        "low",
        "medium",
        "high",
        "xhigh",
      ]);
      assert.deepEqual(levels("grok", "grok-4.5"), ["low", "medium", "high"]);
      // Reasoning cannot be disabled on the models that take the parameter.
      assert.notInclude(levels("grok", "grok-4.6"), "none");
    });

    it("Qwen, Kimi and MiMo name their boolean switch off/on", function () {
      // Qwen's control is enable_thinking: true | false — there is no effort
      // ladder, so calling thinking-off `low` and thinking-on `high` invented
      // a scale the API does not have.
      assert.deepEqual(levels("qwen", "qwen3-235b-a22b"), ["off", "on"]);
      assert.deepEqual(levels("qwen", "qwen3-235b-a22b-thinking-2507"), ["on"]);
      assert.deepEqual(levels("qwen", "qwen3-32b-instruct-2507"), []);

      // Kimi k2/k2.5 and MiMo drive thinking.type and nothing else.
      assert.deepEqual(levels("kimi", "kimi-k2-thinking"), ["off", "on"]);
      assert.deepEqual(levels("mimo", "mimo-v2.5-pro"), ["on"]);
    });

    it("builds Qwen, Kimi and MiMo switch payloads", function () {
      assert.deepEqual(
        buildReasoningPayload(
          { provider: "qwen", level: "off" },
          false,
          "qwen3-235b-a22b",
        ),
        {
          extra: { chat_template_kwargs: { enable_thinking: false } },
          omitTemperature: false,
        },
      );
      assert.deepEqual(
        buildReasoningPayload(
          { provider: "kimi", level: "off" },
          false,
          "kimi-k2-thinking",
        ),
        { extra: { thinking: { type: "disabled" } }, omitTemperature: false },
      );
      assert.deepEqual(
        buildReasoningPayload(
          { provider: "mimo", level: "on" },
          false,
          "mimo-v2.5-pro",
        ),
        { extra: { thinking: { type: "enabled" } }, omitTemperature: false },
      );
    });

    it("MiniMax and GLM expose the thinking switch their APIs document", function () {
      // MiniMax: thinking.type adaptive | disabled — off by default on M3, and
      // permanently on for the M2.x line, where `disabled` is accepted but
      // ignored, so offering an off switch there would be a lie.
      assert.deepEqual(levels("minimax", "MiniMax-M3"), ["off", "on"]);
      assert.equal(
        getReasoningDefaultLevelForModel("minimax", "MiniMax-M3"),
        "off",
      );
      assert.deepEqual(levels("minimax", "MiniMax-M2.5"), ["on"]);

      // GLM: thinking.type enabled | disabled, default enabled.
      assert.deepEqual(levels("glm", "glm-4.6"), ["off", "on"]);
      assert.equal(getReasoningDefaultLevelForModel("glm", "glm-4.6"), "on");
    });

    it("builds MiniMax and GLM thinking payloads", function () {
      assert.deepEqual(
        buildReasoningPayload(
          { provider: "minimax", level: "on" },
          false,
          "MiniMax-M3",
        ),
        { extra: { thinking: { type: "adaptive" } }, omitTemperature: false },
      );
      assert.deepEqual(
        buildReasoningPayload(
          { provider: "glm", level: "off" },
          false,
          "glm-4.6",
        ),
        { extra: { thinking: { type: "disabled" } }, omitTemperature: false },
      );
    });

    it("Claude adaptive models expose all five effort levels", function () {
      for (const model of [
        "claude-opus-5",
        "claude-sonnet-5",
        "claude-opus-4-8",
        "claude-opus-4-7",
      ]) {
        assert.deepEqual(
          levels("anthropic", model),
          ["low", "medium", "high", "xhigh", "max"],
          model,
        );
      }
      // `max` is the provider's own word, not our rename of `xhigh`.
      const profile = getAnthropicReasoningProfileForModel("claude-opus-5");
      assert.equal(profile.levelToEffort.xhigh, "xhigh");
      assert.equal(profile.levelToEffort.max, "max");
    });
  });

  it("gives every level exactly one name", function () {
    // A level used to carry a display alias — deepseek's `minimal` showed as
    // "disabled", gemini's `low` as its budget — so the reasoning menu and the
    // model editor named the same level differently with nothing to reconcile
    // them. The level id is the name now, in both places.
    const models: Array<
      [Parameters<typeof getRuntimeReasoningOptionsForModel>[0], string]
    > = [
      ["deepseek", "deepseek-v4-pro"],
      ["gemini", "gemini-2.5-flash"],
      ["gemini", "gemini-2.5-pro"],
      ["kimi", "kimi-k2-thinking"],
      ["mimo", "mimo-v2.5-pro"],
      ["qwen", "qwen3-235b-a22b"],
      ["openai", "gpt-5.4"],
      ["anthropic", "claude-opus-4-5"],
    ];
    for (const [provider, model] of models) {
      for (const option of getRuntimeReasoningOptionsForModel(
        provider,
        model,
      )) {
        assert.equal(option.label, option.level, `${model} ${option.level}`);
      }
    }
  });

  describe("OpenAI GPT-5 family profiles", function () {
    it("supports xhigh reasoning for gpt-5.4", function () {
      const options = getRuntimeReasoningOptionsForModel("openai", "gpt-5.4");
      assert.deepEqual(
        options.map((option) => option.level),
        ["default", "low", "medium", "high", "xhigh"],
      );

      const profile = getOpenAIReasoningProfileForModel("gpt-5.4");
      assert.equal(profile.defaultLevel, "default");
      assert.deepEqual(profile.levelToEffort, {
        default: null,
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
      });
    });

    it("supports xhigh reasoning for gpt-5.5", function () {
      const options = getRuntimeReasoningOptionsForModel("openai", "gpt-5.5");
      assert.deepEqual(
        options.map((option) => option.level),
        ["default", "low", "medium", "high", "xhigh"],
      );

      const profile = getOpenAIReasoningProfileForModel("gpt-5.5");
      assert.equal(profile.defaultLevel, "default");
      assert.equal(profile.levelToEffort.xhigh, "xhigh");
    });

    it("limits gpt-5.4-pro to medium/high/xhigh reasoning", function () {
      const options = getRuntimeReasoningOptionsForModel(
        "openai",
        "gpt-5.4-pro",
      );
      assert.deepEqual(
        options.map((option) => option.level),
        ["medium", "high", "xhigh"],
      );
      assert.equal(
        getReasoningDefaultLevelForModel("openai", "gpt-5.4-pro"),
        "medium",
      );
    });

    it("limits gpt-5-pro to high reasoning only", function () {
      const options = getRuntimeReasoningOptionsForModel("openai", "gpt-5-pro");
      assert.deepEqual(
        options.map((option) => option.level),
        ["high"],
      );
      assert.equal(
        getReasoningDefaultLevelForModel("openai", "gpt-5-pro"),
        "high",
      );
    });

    it("supports codex-specific xhigh reasoning on gpt-5.2 and gpt-5.3 codex", function () {
      const gpt52Codex = getRuntimeReasoningOptionsForModel(
        "openai",
        "gpt-5.2-codex",
      );
      const gpt53Codex = getRuntimeReasoningOptionsForModel(
        "openai",
        "gpt-5.3-codex",
      );

      assert.deepEqual(
        gpt52Codex.map((option) => option.level),
        ["low", "medium", "high", "xhigh"],
      );
      assert.deepEqual(
        gpt53Codex.map((option) => option.level),
        ["low", "medium", "high", "xhigh"],
      );
    });
  });

  describe("CPR papers aliases", function () {
    // The four aliases the papers route offers, each with its own ladder.
    it("gives each canonical papers alias its own effort ladder and default", function () {
      assert.deepEqual(levels("openai", "papers/gpt-5.6-sol"), [
        "high",
        "medium",
        "xhigh",
      ]);
      assert.equal(
        getReasoningDefaultLevelForModel("openai", "papers/gpt-5.6-sol"),
        "high",
      );
      assert.deepEqual(levels("openai", "papers/gpt-5.6-sol-instant"), ["low"]);
      assert.equal(
        getReasoningDefaultLevelForModel(
          "openai",
          "papers/gpt-5.6-sol-instant",
        ),
        "low",
      );
      for (const model of ["papers/gpt-5.6-pro", "papers/gpt-6-pro"]) {
        assert.deepEqual(levels("openai", model), ["max"], model);
        assert.equal(
          getReasoningDefaultLevelForModel("openai", model),
          "max",
          model,
        );
      }
    });

    it("does not transfer the papers ladders onto the plain model names", function () {
      // The plain ids are different deployments with their own documented
      // ladder; only the canonical `papers/...` alias carries the papers table.
      assert.deepEqual(levels("openai", "gpt-5.6-sol"), [
        "none",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ]);
      assert.equal(
        getReasoningDefaultLevelForModel("openai", "papers/gpt-5.6-sol"),
        "high",
      );
    });
  });

  describe("OpenAI pre-reasoning families", function () {
    const NON_REASONING_MODELS = [
      "gpt-4o",
      "gpt-4o-mini",
      "gpt-4o-2024-08-06",
      "gpt-4.1",
      "gpt-4-turbo",
      "gpt-4.5-preview",
      "chatgpt-4o-latest",
      "gpt-3.5-turbo",
      "gpt-35-turbo",
    ];

    it("offers no reasoning levels for the gpt-3 and gpt-4 families", function () {
      for (const model of NON_REASONING_MODELS) {
        assert.deepEqual(
          getRuntimeReasoningOptionsForModel("openai", model),
          [],
          `${model} should offer no reasoning levels`,
        );
        assert.isFalse(
          supportsReasoningForModel("openai", model),
          `${model} should not claim reasoning support`,
        );
        assert.isNull(
          getReasoningDefaultLevelForModel("openai", model),
          `${model} should have no default reasoning level`,
        );
      }
    });

    it("sends no reasoning payload for gpt-4o even when a level is selected", function () {
      // A level can still arrive from a cached selection made before the
      // model was switched. The payload builder must drop it rather than let
      // the request 400 on an unrecognized `reasoning_effort`.
      assert.deepEqual(
        buildReasoningPayload(
          { provider: "openai", level: "low" },
          false,
          "gpt-4o",
          "https://api.openai.com/v1",
          "openai_chat_compat",
        ),
        { extra: {}, omitTemperature: false },
      );
    });

    it("keeps the optimistic level set for an unrecognized OpenAI model", function () {
      // Guard against anyone narrowing this into a fallback swap: a model
      // OpenAI has not shipped yet must still get a usable level set without
      // a code change, which is the whole point of the optimistic fallback.
      assert.deepEqual(
        getRuntimeReasoningOptionsForModel("openai", "gpt-6").map(
          (option) => option.level,
        ),
        ["default", "low", "medium", "high"],
      );
      assert.isTrue(supportsReasoningForModel("openai", "gpt-6"));
    });
  });

  describe("DeepSeek V4 profiles", function () {
    it("supports disabled, low, high, and max thinking modes", function () {
      const options = getRuntimeReasoningOptionsForModel(
        "deepseek",
        "deepseek-v4-pro",
      );
      assert.deepEqual(
        options.map((option) => option.level),
        ["none", "low", "high", "max"],
      );

      const profile = getDeepseekReasoningProfileForModel(
        "deepseek/deepseek-v4-flash",
      );
      assert.equal(profile.defaultLevel, "high");
      assert.equal(profile.defaultThinkingType, "enabled");
      assert.equal(profile.defaultReasoningEffort, "high");
      assert.isTrue(profile.omitTemperatureWhenThinking);
      assert.equal(profile.levelToThinkingType.none, "disabled");
      assert.equal(profile.levelToReasoningEffort.low, "low");
      assert.equal(profile.levelToReasoningEffort.max, "max");
    });

    it("builds documented DeepSeek V4 thinking payloads", function () {
      assert.deepEqual(
        buildReasoningPayload(
          { provider: "deepseek", level: "none" },
          false,
          "deepseek-v4-pro",
        ),
        {
          extra: { thinking: { type: "disabled" } },
          omitTemperature: false,
        },
      );
      assert.deepEqual(
        buildReasoningPayload(
          { provider: "deepseek", level: "high" },
          false,
          "deepseek-v4-pro",
        ),
        {
          extra: {
            thinking: { type: "enabled" },
            reasoning_effort: "high",
          },
          omitTemperature: true,
        },
      );
      assert.deepEqual(
        buildReasoningPayload(
          { provider: "deepseek", level: "max" },
          false,
          "deepseek-v4-pro",
        ),
        {
          extra: {
            thinking: { type: "enabled" },
            reasoning_effort: "max",
          },
          omitTemperature: true,
        },
      );
      assert.deepEqual(
        buildReasoningPayload(
          { provider: "deepseek", level: "max" },
          false,
          "deepseek-v4-pro",
          "https://api.deepseek.com/anthropic",
          "anthropic_messages",
        ),
        {
          extra: {
            thinking: { type: "enabled" },
            output_config: { effort: "max" },
          },
          omitTemperature: true,
        },
      );
      assert.deepEqual(
        buildReasoningPayload(
          { provider: "deepseek", level: "default" },
          false,
          "deepseek-reasoner",
        ),
        {
          extra: { thinking: { type: "enabled" } },
          omitTemperature: false,
        },
      );
    });
  });

  describe("Xiaomi MiMo profiles", function () {
    it("exposes opt-in thinking for documented MiMo models", function () {
      for (const modelName of [
        "mimo-v2.5-pro",
        "mimo-v2.5",
        "mimo-v2-pro",
        "mimo-v2-omni",
        "mimo-v2-flash",
      ]) {
        const options = getRuntimeReasoningOptionsForModel("mimo", modelName);
        assert.deepEqual(
          options.map((option) => option.level),
          ["on"],
          modelName,
        );
        assert.deepEqual(
          options.map((option) => option.label),
          ["on"],
          modelName,
        );
      }

      const profile = getMimoReasoningProfileForModel("mimo-v2.5-pro");
      assert.equal(profile.defaultLevel, "on");
      assert.equal(profile.levelToThinkingType.on, "enabled");
      // An unseen MiMo id takes the flagship's opt-in thinking rather than
      // reporting none; mimo-v2.5-pro has thinking on by default.
      assert.deepEqual(
        getRuntimeReasoningOptionsForModel("mimo", "mimo-unknown").map(
          (option) => option.level,
        ),
        ["on"],
      );
    });

    it("builds conservative MiMo thinking payloads", function () {
      // Sending nothing is "Auto — provider default", not a level of its own.
      assert.deepEqual(
        buildReasoningPayload(
          { provider: "mimo", level: "auto" },
          false,
          "mimo-v2.5-pro",
          "https://api.xiaomimimo.com/v1",
          "openai_chat_compat",
        ),
        { extra: {}, omitTemperature: false },
      );
      assert.deepEqual(
        buildReasoningPayload(
          { provider: "mimo", level: "on" },
          false,
          "mimo-v2.5-pro",
          "https://api.xiaomimimo.com/v1",
          "openai_chat_compat",
        ),
        {
          extra: { thinking: { type: "enabled" } },
          omitTemperature: false,
        },
      );
    });
  });

  describe("Anthropic profiles", function () {
    it("classifies current Opus, Sonnet, and Haiku thinking modes", function () {
      const opus47 = getAnthropicReasoningProfileForModel("claude-opus-4-7");
      assert.isTrue(opus47.supportsAdaptiveThinking);
      assert.isFalse(opus47.supportsManualThinking);
      assert.equal(opus47.preferredMode, "adaptive");
      assert.equal(opus47.levelToEffort.xhigh, "xhigh");

      const sonnet46 =
        getAnthropicReasoningProfileForModel("claude-sonnet-4-6");
      assert.isTrue(sonnet46.supportsAdaptiveThinking);
      assert.isTrue(sonnet46.supportsManualThinking);
      assert.equal(sonnet46.preferredMode, "adaptive");
      assert.equal(sonnet46.levelToEffort.max, "max");
      assert.notInclude(
        getRuntimeReasoningOptionsForModel(
          "anthropic",
          "claude-sonnet-4-6",
        ).map((option) => option.level),
        "xhigh",
      );

      const haiku45 = getAnthropicReasoningProfileForModel(
        "claude-haiku-4-5-20251001",
      );
      assert.isFalse(haiku45.supportsAdaptiveThinking);
      assert.isTrue(haiku45.supportsManualThinking);
      assert.equal(haiku45.preferredMode, "manual");
    });

    it("gives an unknown Claude model the current flagship's levels", function () {
      // Opus 5 / Sonnet 5 / Fable 5.1 all use adaptive thinking, so a Claude
      // id we have not seen is assumed to as well rather than being reported
      // as having no reasoning at all. See test/unseenModelReasoning.test.ts.
      assert.deepEqual(
        getRuntimeReasoningOptionsForModel("anthropic", "claude-unknown-3").map(
          (option) => option.level,
        ),
        ["low", "medium", "high", "max"],
      );
    });

    it("builds Anthropic payloads only for Anthropic Messages protocol", function () {
      assert.deepEqual(
        buildReasoningPayload(
          { provider: "anthropic", level: "high" },
          false,
          "claude-sonnet-4-6",
          "https://api.anthropic.com/v1",
          "openai_chat_compat",
          { maxTokens: 4096 },
        ),
        { extra: {}, omitTemperature: false },
      );

      assert.deepEqual(
        buildReasoningPayload(
          { provider: "anthropic", level: "max" },
          false,
          "claude-sonnet-4-6",
          "https://api.anthropic.com/v1",
          "anthropic_messages",
          { maxTokens: 4096 },
        ),
        {
          extra: {
            thinking: { type: "adaptive" },
            output_config: { effort: "max" },
          },
          omitTemperature: true,
        },
      );

      assert.deepEqual(
        buildReasoningPayload(
          { provider: "anthropic", level: "xhigh" },
          false,
          "claude-opus-4-7",
          "https://api.anthropic.com/v1",
          "anthropic_messages",
          { maxTokens: 4096 },
        ),
        {
          extra: {
            thinking: { type: "adaptive" },
            output_config: { effort: "xhigh" },
          },
          omitTemperature: true,
        },
      );

      assert.deepEqual(
        buildReasoningPayload(
          { provider: "anthropic", level: "high" },
          false,
          "claude-haiku-4-5",
          "https://api.anthropic.com/v1",
          "anthropic_messages",
          { maxTokens: 4096 },
        ),
        {
          extra: {
            thinking: { type: "enabled", budget_tokens: 3072 },
          },
          omitTemperature: true,
        },
      );
    });
  });
});
