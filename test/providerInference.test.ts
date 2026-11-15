import { assert } from "chai";
import {
  getModelCapabilities,
  resetModelCapabilityStateForTests,
} from "../src/modelCapabilities";
import { detectReasoningProvider } from "../src/modules/contextPanel/chat";

describe("provider inference from model names", function () {
  afterEach(function () {
    resetModelCapabilityStateForTests();
  });

  it("resolves Kimi-for-Coding bare ids on an unrecognized host", function () {
    for (const model of ["k3", "k3-256k", "kimi-for-coding"]) {
      const capabilities = getModelCapabilities({
        model,
        apiBase: "https://api.kimi.com/coding/v1",
        protocol: "openai_chat_compat",
      });
      assert.equal(capabilities.provider, "kimi", model);
      assert.equal(capabilities.reasoning.kind, "select", model);
    }
  });

  it("sees through a vendor prefix on a gateway's model ids", function () {
    // Gateways namespace their catalog — OpenCode Zen serves `opencode/<id>`,
    // and OpenRouter-style ids do the same. The family rules anchored to the
    // start of the string (OpenAI, DeepSeek) missed those, so most of a
    // gateway's models resolved to no provider at all: no reasoning menu and
    // fallback token limits. See #439.
    const zen = "https://opencode.ai/zen/v1";
    for (const [model, provider] of [
      ["opencode/gpt-5.6-sol", "openai"],
      ["opencode/deepseek-v4-pro", "deepseek"],
      ["opencode/claude-sonnet-4-6", "anthropic"],
      ["opencode/grok-4.6", "grok"],
      ["openrouter/deepseek/deepseek-v4-pro", "deepseek"],
    ] as Array<[string, string]>) {
      const capabilities = getModelCapabilities({
        model,
        apiBase: zen,
        protocol: "openai_chat_compat",
      });
      assert.equal(capabilities.provider, provider, model);
      assert.equal(capabilities.reasoning.kind, "select", model);
    }
  });

  it("does not mistake a hyphenated name for a vendor prefix", function () {
    // Only a `/` separates a vendor from its model id; `gpt-4o` must not be
    // read as vendor `gpt`.
    assert.equal(
      getModelCapabilities({
        model: "not-a-vendor-gpt-5.6",
        apiBase: "https://relay.example.com/v1",
      }).provider,
      "unknown",
    );
  });

  it("falls back to model-name inference on relay hosts", function () {
    const relay = "https://relay.example.com/v1";
    assert.equal(
      getModelCapabilities({ model: "kimi-k3", apiBase: relay }).provider,
      "kimi",
    );
    assert.equal(
      getModelCapabilities({ model: "gemini-3.6-flash", apiBase: relay })
        .provider,
      "gemini",
    );
    assert.equal(
      getModelCapabilities({ model: "claude-opus-5", apiBase: relay }).provider,
      "anthropic",
    );
    assert.equal(
      getModelCapabilities({ model: "deepseek-v4-flash", apiBase: relay })
        .provider,
      "deepseek",
    );
  });

  it("keeps explicit provider identities authoritative", function () {
    assert.equal(
      getModelCapabilities({
        provider: "qwen",
        model: "kimi-k3",
        apiBase: "https://relay.example.com/v1",
      }).provider,
      "qwen",
    );
  });

  it("detects the kimi reasoning provider for coding-endpoint model names", function () {
    assert.equal(detectReasoningProvider("k3"), "kimi");
    assert.equal(detectReasoningProvider("k3-256k"), "kimi");
    assert.equal(detectReasoningProvider("kimi-for-coding"), "kimi");
    assert.equal(detectReasoningProvider("kimi-for-coding-highspeed"), "kimi");
  });

  it("does not mistake unrelated ids for the k3 alias", function () {
    assert.equal(detectReasoningProvider("k30"), "unsupported");
    assert.equal(detectReasoningProvider("k3x"), "unsupported");
    assert.equal(detectReasoningProvider("mock3"), "unsupported");
  });
});
