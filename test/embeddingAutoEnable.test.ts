import { assert } from "chai";
import {
  checkEmbeddingAvailability,
  getEmbeddingUnavailableReason,
  getResolvedEmbeddingConfig,
  resolveSemanticSearchState,
} from "../src/utils/llmClient";

const PREFIX = "extensions.zotero.llmforzotero";
const GEMINI_EMBEDDING_BASE =
  "https://generativelanguage.googleapis.com/v1beta/openai";
const OPENAI_EMBEDDING_BASE = "https://api.openai.com/v1";

describe("semantic search auto-enable", function () {
  const originalZotero = globalThis.Zotero;
  let prefStore: Map<string, unknown>;

  function setPref(key: string, value: unknown) {
    prefStore.set(`${PREFIX}.${key}`, value);
  }

  function setProviderGroups(
    groups: Array<{
      apiBase: string;
      apiKey: string;
      authMode?: string;
    }>,
  ) {
    setPref(
      "modelProviderGroups",
      JSON.stringify(
        groups.map((group, index) => ({
          id: `group-${index}`,
          apiBase: group.apiBase,
          apiKey: group.apiKey,
          authMode: group.authMode ?? "api_key",
          providerProtocol: "openai_chat_compat",
          models: [{ id: `model-${index}`, model: `model-${index}` }],
        })),
      ),
    );
    // Pin the stored groups as already migrated so the legacy migration path
    // does not synthesize extra groups from unrelated prefs.
    setPref("modelProviderGroupsMigrationVersion", 9);
  }

  beforeEach(function () {
    prefStore = new Map<string, unknown>();
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      Prefs: {
        get: (key: string) => prefStore.get(key) ?? "",
        set: (key: string, value: unknown) => {
          prefStore.set(key, value);
        },
      },
    } as typeof Zotero;
  });

  after(function () {
    (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
      originalZotero;
  });

  it("enables embeddings automatically from a configured Gemini provider when the pref is unset", function () {
    setProviderGroups([
      {
        apiBase: "https://generativelanguage.googleapis.com/v1beta",
        apiKey: "gemini-group-key",
      },
    ]);

    const state = resolveSemanticSearchState();
    assert.deepEqual(state, { enabled: true, source: "auto" });
    assert.isTrue(checkEmbeddingAvailability());
    assert.isNull(getEmbeddingUnavailableReason());

    const resolved = getResolvedEmbeddingConfig();
    assert.equal(resolved.apiBase, GEMINI_EMBEDDING_BASE);
    assert.equal(resolved.model, "gemini-embedding-001");
    assert.equal(resolved.apiKey, "gemini-group-key");
    assert.include(resolved.providerKey, "gemini");
    assert.include(resolved.cacheKey, "gemini-embedding-001");
  });

  it("auto-resolves the first configured provider group that supports embeddings", function () {
    setProviderGroups([
      { apiBase: "https://api.anthropic.com/v1", apiKey: "anthropic-key" },
      { apiBase: "https://api.openai.com/v1/responses", apiKey: "openai-key" },
      {
        apiBase: "https://generativelanguage.googleapis.com/v1beta",
        apiKey: "gemini-group-key",
      },
    ]);

    const resolved = getResolvedEmbeddingConfig();
    assert.equal(resolved.apiBase, OPENAI_EMBEDDING_BASE);
    assert.equal(resolved.model, "text-embedding-3-small");
    assert.equal(resolved.apiKey, "openai-key");
    assert.equal(resolveSemanticSearchState().source, "auto");
  });

  it("stays off when the pref is explicitly false even with a usable provider group", function () {
    setProviderGroups([
      {
        apiBase: "https://generativelanguage.googleapis.com/v1beta",
        apiKey: "gemini-group-key",
      },
    ]);
    setPref("enableSemanticSearch", false);

    assert.deepEqual(resolveSemanticSearchState(), {
      enabled: false,
      source: "off",
    });

    setPref("enableSemanticSearch", "false");
    assert.deepEqual(resolveSemanticSearchState(), {
      enabled: false,
      source: "off",
    });
  });

  it("keeps the explicit pref as the source when semantic search is turned on", function () {
    setProviderGroups([
      {
        apiBase: "https://generativelanguage.googleapis.com/v1beta",
        apiKey: "gemini-group-key",
      },
    ]);
    setPref("enableSemanticSearch", true);

    assert.deepEqual(resolveSemanticSearchState(), {
      enabled: true,
      source: "pref",
    });
  });

  it("stays off when no configured provider group supports embeddings", function () {
    setProviderGroups([
      { apiBase: "https://api.anthropic.com/v1", apiKey: "anthropic-key" },
    ]);

    assert.deepEqual(resolveSemanticSearchState(), {
      enabled: false,
      source: "auto",
    });
    assert.isFalse(checkEmbeddingAvailability());
    assert.throws(() => getResolvedEmbeddingConfig(), /No embedding provider/);

    const reason = getEmbeddingUnavailableReason();
    assert.equal(
      reason,
      "No embedding provider configured and no configured OpenAI or Gemini provider to reuse. Select a provider in Settings → Customization → Semantic Search.",
    );
    assert.notInclude(reason ?? "", "anthropic-key");
  });

  it("stays off when a provider that supports embeddings has no API key", function () {
    setProviderGroups([
      {
        apiBase: "https://generativelanguage.googleapis.com/v1beta",
        apiKey: "   ",
      },
    ]);

    assert.deepEqual(resolveSemanticSearchState(), {
      enabled: false,
      source: "auto",
    });
    assert.isFalse(checkEmbeddingAvailability());
  });

  it("keeps an explicit embedding endpoint ahead of auto-resolution", function () {
    setProviderGroups([
      {
        apiBase: "https://generativelanguage.googleapis.com/v1beta",
        apiKey: "gemini-group-key",
      },
    ]);
    setPref("embeddingProvider", "openai");
    setPref("embeddingApiBase", "https://proxy.example/v1");
    setPref("embeddingApiKey", "sk-explicit");
    setPref("embeddingModel", "text-embedding-3-large");

    const resolved = getResolvedEmbeddingConfig();
    assert.equal(resolved.apiBase, "https://proxy.example/v1");
    assert.equal(resolved.model, "text-embedding-3-large");
    assert.equal(resolved.apiKey, "sk-explicit");
    assert.deepEqual(resolveSemanticSearchState(), {
      enabled: true,
      source: "auto",
    });
  });

  it("honours an explicit embedding model over the preset default when auto-resolving", function () {
    setProviderGroups([
      {
        apiBase: "https://generativelanguage.googleapis.com/v1beta",
        apiKey: "gemini-group-key",
      },
    ]);
    setPref("embeddingModel", "text-embedding-004");

    const resolved = getResolvedEmbeddingConfig();
    assert.equal(resolved.apiBase, GEMINI_EMBEDDING_BASE);
    assert.equal(resolved.model, "text-embedding-004");
  });

  it("keys the embedding cache by the effective provider, base and model", function () {
    setProviderGroups([
      {
        apiBase: "https://generativelanguage.googleapis.com/v1beta",
        apiKey: "gemini-group-key",
      },
    ]);
    const auto = getResolvedEmbeddingConfig();

    // A different explicit endpoint must never reuse the auto-resolved entry.
    setPref("embeddingProvider", "openai");
    setPref("embeddingApiBase", "https://proxy.example/v1");
    setPref("embeddingApiKey", "sk-explicit");
    setPref("embeddingModel", "text-embedding-3-large");
    const otherEndpoint = getResolvedEmbeddingConfig();
    assert.notEqual(auto.providerKey, otherEndpoint.providerKey);
    assert.notEqual(auto.cacheKey, otherEndpoint.cacheKey);

    // The same provider, base and model share a cache entry (same vector
    // space), but a different credential gets its own attempt key.
    setPref("embeddingProvider", "gemini");
    setPref("embeddingApiBase", GEMINI_EMBEDDING_BASE);
    setPref("embeddingApiKey", "sk-explicit-different");
    setPref("embeddingModel", "gemini-embedding-001");
    const sameSpace = getResolvedEmbeddingConfig();
    assert.equal(auto.cacheKey, sameSpace.cacheKey);
    assert.notEqual(auto.attemptKey, sameSpace.attemptKey);
  });

  it("ignores provider groups that are not API-key providers", function () {
    setPref(
      "modelProviderGroups",
      JSON.stringify([
        {
          id: "webchat-group",
          authMode: "webchat",
          providerProtocol: "web_sync",
          models: [{ id: "row-1", model: "chatgpt" }],
        },
      ]),
    );
    setPref("modelProviderGroupsMigrationVersion", 9);

    assert.deepEqual(resolveSemanticSearchState(), {
      enabled: false,
      source: "auto",
    });
  });
});
