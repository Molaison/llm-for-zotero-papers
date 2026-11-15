import { assert } from "chai";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "mocha";
import {
  getDeepseekReasoningProfileForModel,
  getRuntimeReasoningOptionsForModel,
} from "../src/utils/reasoningProfiles";
import { isTextOnlyModel } from "../src/providers/modelChecks";

const testDir = dirname(fileURLToPath(import.meta.url));

/**
 * DeepSeek renamed its flagship to plain `deepseek-flash` (DeepSeek-V4.1-Flash)
 * and retired the `deepseek-v4-flash` name, which is still accepted and routed
 * to the same model. Nothing about the API changed — only the id — but every
 * rule that recognised the model was keyed to the old name, so `deepseek-flash`
 * fell through to the non-reasoning chat profile and the 128k generic limits.
 *
 * Verified against https://api-docs.deepseek.com/quick_start/pricing and
 * https://api-docs.deepseek.com/guides/thinking_mode/ (September 2026).
 */

describe("deepseek-flash rename", function () {
  for (const model of [
    "deepseek-flash",
    "deepseek-v4-flash",
    "deepseek-v4-pro",
  ]) {
    it(`offers the V4 reasoning levels for ${model}`, function () {
      // reasoning_effort takes low | high | max, thinking.type takes
      // enabled | disabled, and thinking is on at high effort by default.
      const options = getRuntimeReasoningOptionsForModel("deepseek", model);
      assert.deepEqual(
        options.map((option) => option.level),
        ["none", "low", "high", "max"],
        model,
      );

      const profile = getDeepseekReasoningProfileForModel(model);
      assert.equal(profile.defaultThinkingType, "enabled", model);
      assert.equal(profile.defaultReasoningEffort, "high", model);
      assert.equal(profile.levelToThinkingType.none, "disabled", model);
      assert.equal(profile.levelToReasoningEffort.max, "max", model);
      // Thinking mode ignores temperature, so it is not sent.
      assert.isTrue(profile.omitTemperatureWhenThinking, model);
    });
  }

  it("gives an unreleased DeepSeek model the family's reasoning levels", function () {
    // The rename only hurt because an unrecognised name fell back to the
    // non-reasoning chat profile, so every future id would land there too and
    // silently lose its reasoning menu. The family's thinking API is the
    // contract, so an unknown DeepSeek model is assumed to follow it: showing
    // levels the model rejects is recoverable (Test says so, and the levels
    // are editable), showing none is not.
    for (const unreleased of [
      "deepseek-ultra",
      "deepseek-v5",
      "deepseek-flash-2027",
    ]) {
      assert.deepEqual(
        getRuntimeReasoningOptionsForModel("deepseek", unreleased).map(
          (option) => option.level,
        ),
        ["none", "low", "high", "max"],
        unreleased,
      );
    }
  });

  it("still treats deepseek-chat as having no reasoning levels", function () {
    assert.isEmpty(
      getRuntimeReasoningOptionsForModel("deepseek", "deepseek-chat"),
    );
  });

  it("gives deepseek-flash the 1M context and 384K output the docs state", function () {
    const registry = JSON.parse(
      readFileSync(
        resolve(testDir, "..", "registry/model-capabilities.v1.json"),
        "utf8",
      ),
    ) as {
      models: Array<{
        match: { prefix?: string };
        limits?: Record<string, number>;
      }>;
    };

    const entry = registry.models.find(
      (model) => model.match.prefix === "deepseek-flash",
    );
    assert.isDefined(entry, "deepseek-flash is in the registry");
    assert.equal(entry?.limits?.contextWindowTokens, 1_000_000);
    assert.equal(entry?.limits?.inputTokens, 1_000_000);
    assert.equal(entry?.limits?.outputTokens, 384_000);

    // Prefix matching is longest-first, so the generic `deepseek` entry with
    // its 128k window must not be what `deepseek-flash` lands on.
    const generic = registry.models.find(
      (model) => model.match.prefix === "deepseek",
    );
    assert.equal(generic?.limits?.contextWindowTokens, 128_000);
  });

  it("lets deepseek-flash take images, which the docs list as supported", function () {
    assert.isFalse(isTextOnlyModel("deepseek-flash"));
    // Input defaults apply to the family without a per-version allowlist.
    assert.isFalse(isTextOnlyModel("deepseek-reasoner"));
  });
});
