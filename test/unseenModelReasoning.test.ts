import { assert } from "chai";
import { describe, it } from "mocha";
import { getModelCapabilities } from "../src/modelCapabilities";

/**
 * A model id we have never seen must still offer the reasoning its family
 * supports. Each family's `fallback` profile is set to what that family's
 * CURRENT FLAGSHIP does, checked against live docs in September 2026:
 *
 * - anthropic — Opus 5 / Sonnet 5 / Fable 5.1 use `thinking: {type:
 *   "adaptive"}` with `output_config.effort`; `type: "enabled"` returns 400 on
 *   4.7 and later. platform.claude.com/docs/en/build-with-claude/extended-thinking
 * - glm — glm-4.6 takes `thinking.type` enabled|disabled, default enabled.
 *   docs.z.ai/guides/llm/glm-4.6
 * - minimax — MiniMax-M3 takes `thinking.type` enabled|adaptive|disabled.
 *   platform.minimax.io/docs/guides/text-m3-function-call
 * - mimo — mimo-v2.5-pro has thinking on by default.
 *   mimo.mi.com/docs/en-US/api/chat/openai-api
 *
 * The alternative is what these families did before: report `unknown` (no
 * menu) or, worse for Kimi, `none` — an active claim that a model cannot
 * reason. Offering a level the model rejects is recoverable; the Test button
 * reports it and the levels are editable.
 */

const HOSTS: Record<string, string> = {
  anthropic: "https://api.anthropic.com",
  glm: "https://open.bigmodel.cn/api/paas/v4",
  minimax: "https://api.minimax.chat/v1",
  mimo: "https://api.xiaomimimo.com/v1",
};

describe("reasoning for models we have not seen", function () {
  const unseen: Array<[string, string, string]> = [
    ["anthropic", "claude-opus-9", "anthropic_messages"],
    ["anthropic", "claude-sonnet-7-2", "anthropic_messages"],
    ["glm", "glm-air-next", "openai_chat_compat"],
    ["minimax", "minimax-m4", "openai_chat_compat"],
    ["mimo", "mimo-v3-pro", "openai_chat_compat"],
  ];

  for (const [family, model, protocol] of unseen) {
    it(`offers ${family} levels for an unreleased ${model}`, function () {
      const capabilities = getModelCapabilities({
        model,
        apiBase: HOSTS[family],
        protocol: protocol as "anthropic_messages" | "openai_chat_compat",
      });

      assert.notEqual(
        capabilities.reasoning.kind,
        "unknown",
        `${model} should not report unknown`,
      );
      assert.notEqual(
        capabilities.reasoning.kind,
        "none",
        `${model} must not be claimed to have no reasoning`,
      );
      assert.isNotEmpty(capabilities.reasoning.options, model);
    });
  }

  it("still reports no reasoning where a model genuinely has none", function () {
    // deepseek-chat is a documented non-reasoning model, so the optimistic
    // fallback must not paper over it.
    const capabilities = getModelCapabilities({
      model: "deepseek-chat",
      apiBase: "https://api.deepseek.com/anthropic",
      protocol: "openai_chat_compat",
    });
    assert.equal(capabilities.reasoning.kind, "none");
  });
});
