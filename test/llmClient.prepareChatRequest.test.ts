import { assert } from "chai";
import { createHash } from "node:crypto";
import { buildLLMHistoryMessages } from "../src/modules/contextPanel/chat";
import type {
  Message,
  ChatAttachment,
} from "../src/modules/contextPanel/types";
import {
  takeRetryUserSnapshot,
  restoreRetryUserSnapshot,
} from "../src/modules/contextPanel/retryUserSnapshot";
import {
  appendMessage,
  initChatStore,
  createGlobalConversation,
  loadConversation,
} from "../src/utils/chatStore";
import {
  installSqliteZotero,
  resetConversationStoreProcessStateForTests,
} from "./helpers/conversationStoreDb";
import { createPdfFixture } from "./helpers/pdfFixture";
import {
  callEmbeddings,
  callLLM,
  buildReasoningPayload,
  callLLMStream,
  getResolvedEmbeddingConfig,
  prepareChatRequest,
  ReasoningBudgetError,
} from "../src/utils/llmClient";
import {
  loadCodexDirectCatalog,
  resetCodexDirectCatalogForTests,
} from "../src/codexAuth/modelCatalog";
import { CODEX_DIRECT_RESPONSES_URL } from "../src/codexAuth/auth";
import { CORE_RESEARCH_CONTRACT } from "../src/shared/instructionContracts";
import {
  publishModelCapabilityCatalog,
  resetModelCapabilityStateForTests,
} from "../src/modelCapabilities";

describe("llmClient prepareChatRequest", function () {
  const originalZotero = globalThis.Zotero;
  const originalToolkit = (
    globalThis as typeof globalThis & { ztoolkit?: unknown }
  ).ztoolkit;

  function makeSseStream(chunks: string[]): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });
  }

  function mockFetch(
    handler: (_url: string, init?: RequestInit) => Promise<unknown>,
  ) {
    (
      globalThis as typeof globalThis & {
        ztoolkit: { getGlobal: (name: string) => unknown; log: () => void };
      }
    ).ztoolkit = {
      getGlobal: (name: string) => (name === "fetch" ? handler : undefined),
      log: () => undefined,
    };
  }

  function anthropicOkStream() {
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      body: makeSseStream([
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ]),
      json: async () => ({}),
      text: async () => "",
    };
  }

  beforeEach(function () {
    resetCodexDirectCatalogForTests();
    const prefStore = new Map<string, unknown>();
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      Prefs: {
        get: (key: string) => prefStore.get(key) ?? "",
        set: (key: string, value: unknown) => {
          prefStore.set(key, value);
        },
      },
    } as typeof Zotero;
  });

  afterEach(function () {
    resetCodexDirectCatalogForTests();
  });

  after(function () {
    (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
      originalZotero;
    (
      globalThis as typeof globalThis & { ztoolkit?: typeof originalToolkit }
    ).ztoolkit = originalToolkit;
  });

  it("reports document-context trimming effects before the request is sent", function () {
    const prepared = prepareChatRequest({
      prompt: "Summarize the paper.",
      context: "A".repeat(700000),
      model: "deepseek-custom",
      apiBase: "https://api.example.com/v1",
    });

    assert.isTrue(prepared.inputCap.capped);
    assert.isTrue(
      prepared.inputCap.effects.documentContextTrimmed ||
        prepared.inputCap.effects.documentContextDropped,
    );
  });

  it("emits the exact Auto payload policy for optional and required protocols", async function () {
    const capture = async (
      params: Parameters<typeof callLLM>[0],
      reply: unknown,
    ): Promise<Record<string, unknown>> => {
      let body: Record<string, unknown> = {};
      mockFetch(async (_url, init) => {
        body = JSON.parse(String(init?.body || "{}")) as Record<
          string,
          unknown
        >;
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => reply,
          text: async () => "",
        };
      });
      await callLLM({ ...params, outputTokenLimit: { mode: "auto" } });
      return body;
    };

    const responses = await capture(
      {
        prompt: "hi",
        model: "gpt-4o-mini",
        apiBase: "https://api.openai.com/v1/responses",
        apiKey: "test",
        providerProtocol: "responses_api",
      },
      { status: "completed", output_text: "ok" },
    );
    assert.notProperty(responses, "max_output_tokens");

    const chat = await capture(
      {
        prompt: "hi",
        model: "chat-compatible-model",
        apiBase: "https://provider.example/v1",
        apiKey: "test",
        providerProtocol: "openai_chat_compat",
      },
      { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] },
    );
    assert.notProperty(chat, "max_tokens");
    assert.notProperty(chat, "max_completion_tokens");

    const gemini = await capture(
      {
        prompt: "hi",
        model: "gemini-2.5-pro",
        apiBase: "https://generativelanguage.googleapis.com/v1beta",
        apiKey: "test",
        providerProtocol: "gemini_native",
      },
      {
        candidates: [
          { content: { parts: [{ text: "ok" }] }, finishReason: "STOP" },
        ],
      },
    );
    assert.notNestedProperty(gemini, "generationConfig.maxOutputTokens");

    const anthropic = await capture(
      {
        prompt: "hi",
        model: "claude-sonnet-4-6",
        apiBase: "https://api.anthropic.com/v1",
        apiKey: "test",
        providerProtocol: "anthropic_messages",
      },
      { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" },
    );
    assert.equal(anthropic.max_tokens, 64_000);
  });

  it("transmits a validated Custom output limit only on protocols that honor it", async function () {
    const capture = async (
      params: Parameters<typeof callLLM>[0],
      reply: unknown,
    ): Promise<Record<string, unknown>> => {
      let body: Record<string, unknown> = {};
      mockFetch(async (_url, init) => {
        body = JSON.parse(String(init?.body || "{}")) as Record<
          string,
          unknown
        >;
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => reply,
          text: async () => "",
        };
      });
      await callLLM({
        ...params,
        outputTokenLimit: { mode: "custom", tokens: 123 },
      });
      return body;
    };

    const responses = await capture(
      {
        prompt: "hi",
        model: "gpt-4o-mini",
        apiBase: "https://api.openai.com/v1/responses",
        apiKey: "test",
        providerProtocol: "responses_api",
      },
      { status: "completed", output_text: "ok" },
    );
    assert.equal(responses.max_output_tokens, 123);

    const chat = await capture(
      {
        prompt: "hi",
        model: "chat-compatible-model",
        apiBase: "https://provider.example/v1",
        apiKey: "test",
        providerProtocol: "openai_chat_compat",
      },
      { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] },
    );
    assert.equal(chat.max_tokens, 123);

    const gemini = await capture(
      {
        prompt: "hi",
        model: "gemini-2.5-pro",
        apiBase: "https://generativelanguage.googleapis.com/v1beta",
        apiKey: "test",
        providerProtocol: "gemini_native",
      },
      {
        candidates: [
          { content: { parts: [{ text: "ok" }] }, finishReason: "STOP" },
        ],
      },
    );
    assert.equal(
      (gemini.generationConfig as Record<string, unknown>).maxOutputTokens,
      123,
    );
  });

  it("includes extra system messages in the prepared request payload", function () {
    const prepared = prepareChatRequest({
      prompt: "Answer the question.",
      context: "Small context.",
      model: "gpt-4o-mini",
      apiBase: "https://api.example.com/v1",
      systemMessages: ["Briefly mention that retrieval was used."],
    });

    assert.include(
      prepared.messages.map((message) => String(message.content)).join("\n"),
      "Briefly mention that retrieval was used.",
    );
  });

  it("keeps system prompts inside input messages for Grok responses requests", async function () {
    let capturedBody: Record<string, unknown> | null = null;
    (
      globalThis as typeof globalThis & {
        ztoolkit: { getGlobal: (name: string) => unknown; log: () => void };
      }
    ).ztoolkit = {
      getGlobal: (name: string) => {
        if (name === "fetch") {
          return async (_url: string, init?: RequestInit) => {
            capturedBody = JSON.parse(String(init?.body || "{}")) as Record<
              string,
              unknown
            >;
            return {
              ok: true,
              status: 200,
              statusText: "OK",
              json: async () => ({ output_text: "OK" }),
              text: async () => "",
            };
          };
        }
        return undefined;
      },
      log: () => undefined,
    };

    const output = await callLLM({
      prompt: "Say hi.",
      model: "grok-4",
      apiBase: "https://api.x.ai/v1/responses",
      apiKey: "xai-test",
    });

    assert.equal(output.text, "OK");
    assert.isNotNull(capturedBody);
    assert.notProperty(capturedBody as object, "instructions");
    assert.isArray(capturedBody?.input);
    const input = capturedBody?.input as Array<Record<string, unknown>>;
    assert.equal(input[0]?.role, "system");
    assert.include(String(input[0]?.content || ""), CORE_RESEARCH_CONTRACT);
    assert.equal(input[input.length - 1]?.role, "user");
  });

  it("merges non-agent chat system messages into a single leading system entry", async function () {
    let capturedBody: Record<string, unknown> | null = null;
    (
      globalThis.Zotero.Prefs as { set: (key: string, value: unknown) => void }
    ).set(
      "extensions.zotero.llmforzotero.systemPrompt",
      "You are a custom paper analyst.",
    );
    (
      globalThis as typeof globalThis & {
        ztoolkit: { getGlobal: (name: string) => unknown; log: () => void };
      }
    ).ztoolkit = {
      getGlobal: (name: string) => {
        if (name === "fetch") {
          return async (_url: string, init?: RequestInit) => {
            capturedBody = JSON.parse(String(init?.body || "{}")) as Record<
              string,
              unknown
            >;
            const encoder = new TextEncoder();
            return {
              ok: true,
              status: 200,
              statusText: "OK",
              body: new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(
                    encoder.encode(
                      'data: {"choices":[{"delta":{"content":"OK"}}]}\n\n',
                    ),
                  );
                  controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                  controller.close();
                },
              }),
              json: async () => ({}),
              text: async () => "",
            };
          };
        }
        return undefined;
      },
      log: () => undefined,
    };

    const output = await callLLMStream(
      {
        prompt: "Summarize the attached paper.",
        context: "Paper context body.",
        history: [
          { role: "user", content: "Earlier question." },
          { role: "assistant", content: "Earlier answer." },
        ],
        model: "Qwen/Qwen3.5-27B",
        apiBase: "https://api.siliconflow.cn/v1",
        apiKey: "sf-test",
        systemMessages: ["Mention if the document context was trimmed."],
      },
      () => undefined,
    );

    assert.equal(output.text, "OK");
    assert.isNotNull(capturedBody);
    assert.isArray(capturedBody?.messages);
    const messages = capturedBody?.messages as Array<Record<string, unknown>>;
    assert.deepEqual(
      messages.map((message) => message.role),
      ["system", "user", "assistant", "user"],
    );
    assert.equal(
      messages.filter((message) => message.role === "system").length,
      1,
    );
    assert.include(
      String(messages[0]?.content || ""),
      "You are a custom paper analyst.",
    );
    assert.include(String(messages[0]?.content || ""), "Document Context:");
    assert.include(
      String(messages[0]?.content || ""),
      "Mention if the document context was trimmed.",
    );
  });

  it("keeps explicit codex auth mode in prepared request", function () {
    const prepared = prepareChatRequest({
      prompt: "hello",
      model: "gpt-5.4",
      apiBase: "https://chatgpt.com/backend-api/codex/responses",
      authMode: "codex_auth",
    });

    assert.equal(prepared.authMode, "codex_auth");
  });

  it("sends exact Codex Direct effort while ignoring dormant advanced settings", async function () {
    await loadCodexDirectCatalog({
      authPath: "/test/codex/auth.json",
      readText: async () =>
        JSON.stringify({
          tokens: { access_token: "catalog", refresh_token: "refresh" },
        }),
      fetchFn: (async () =>
        new Response(
          JSON.stringify({
            models: [
              {
                slug: "gpt-codex",
                display_name: "GPT Codex",
                visibility: "list",
                priority: 1,
                supported_reasoning_levels: [
                  { effort: "low" },
                  { effort: "medium" },
                  { effort: "high" },
                  { effort: "xhigh" },
                  { effort: "max" },
                  { effort: "ultra" },
                ],
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )) as typeof fetch,
    });
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> = {};
    let capturedHeaders = new Headers();
    (
      globalThis as typeof globalThis & {
        ztoolkit: {
          getGlobal: (name: string) => unknown;
          log: () => void;
        };
      }
    ).ztoolkit = {
      getGlobal: (name: string) => {
        if (name === "process") return { env: { HOME: "/home/tester" } };
        if (name === "IOUtils") {
          return {
            read: async () =>
              new TextEncoder().encode(
                JSON.stringify({
                  tokens: {
                    access_token: "direct-token",
                    refresh_token: "direct-refresh",
                    account_id: "account-789",
                  },
                }),
              ),
          };
        }
        if (name !== "fetch") return undefined;
        return async (url: string, init?: RequestInit) => {
          capturedUrl = url;
          capturedBody = JSON.parse(String(init?.body || "{}")) as Record<
            string,
            unknown
          >;
          capturedHeaders = new Headers(init?.headers);
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            body: makeSseStream([
              'data: {"type":"response.output_text.delta","delta":"OK"}\n\n',
              'data: {"type":"response.completed","response":{"output_text":"OK"}}\n\n',
            ]),
            json: async () => ({}),
            text: async () => "",
          };
        };
      },
      log: () => undefined,
    };

    const output = await callLLMStream(
      {
        prompt: "Hello",
        model: "gpt-codex",
        apiBase: "https://malicious.example/v1/responses",
        authMode: "codex_auth",
        providerProtocol: "gemini_native",
        temperature: 1.8,
        outputTokenLimit: { mode: "custom", tokens: 7 },
        profileOverride: {
          forModel: "gpt-codex",
          extraBody: { dormant_advanced_value: true },
        },
        reasoning: {
          provider: "openai",
          level: "default",
          effort: "max",
        },
      },
      () => undefined,
    );

    assert.equal(output.text, "OK");
    assert.equal(capturedUrl, CODEX_DIRECT_RESPONSES_URL);
    assert.deepEqual(capturedBody.reasoning, {
      effort: "max",
      summary: "detailed",
    });
    for (const key of [
      "temperature",
      "max_output_tokens",
      "dormant_advanced_value",
    ]) {
      assert.notProperty(capturedBody, key);
    }
    assert.equal(capturedHeaders.get("Authorization"), "Bearer direct-token");
    assert.equal(capturedHeaders.get("ChatGPT-Account-ID"), "account-789");

    for (const effort of ["low", "medium", "high", "xhigh", "max", "ultra"]) {
      await callLLMStream(
        {
          prompt: `Use ${effort}`,
          model: "gpt-codex",
          authMode: "codex_auth",
          reasoning: {
            provider: "openai",
            level: "default",
            effort,
          },
        },
        () => undefined,
      );
      assert.equal(
        (capturedBody.reasoning as { effort?: string } | undefined)?.effort,
        effort,
      );
    }
  });

  it("keeps image content for DeepSeek vision models in automatic mode", function () {
    const prepared = prepareChatRequest({
      prompt: "Describe this image.",
      images: ["data:image/png;base64,AAAA"],
      model: "deepseek-v4-flash-vision-exp",
      apiBase: "https://api.deepseek.com/v1",
    });

    const lastMessage = prepared.messages[prepared.messages.length - 1];
    assert.equal(lastMessage.role, "user");
    assert.isArray(lastMessage.content);
    assert.include(JSON.stringify(prepared.messages), "image_url");
  });

  it("keeps image content for existing and new DeepSeek models in automatic mode", function () {
    for (const model of [
      "deepseek-chat",
      "deepseek-reasoner",
      "deepseek-future-model",
    ]) {
      const prepared = prepareChatRequest({
        prompt: "Describe this image.",
        images: ["data:image/png;base64,AAAA"],
        model,
        apiBase: "https://api.deepseek.com/v1",
      });

      const lastMessage = prepared.messages[prepared.messages.length - 1];
      assert.equal(lastMessage.role, "user");
      assert.isArray(lastMessage.content, model);
      assert.include(
        JSON.stringify(prepared.messages),
        "data:image/png;base64,AAAA",
        model,
      );
    }
  });

  it("omits images when the provider explicitly reports no image support", function () {
    const identity = {
      model: "deepseek-future-model",
      apiBase: "https://api.deepseek.com/v1",
      protocol: "openai_chat_compat",
      authMode: "api_key",
    };
    try {
      publishModelCapabilityCatalog(identity, [
        {
          id: identity.model,
          source: "live",
          inputs: { image: false },
        },
      ]);
      const prepared = prepareChatRequest({
        prompt: "Describe this image.",
        images: ["data:image/png;base64,AAAA"],
        model: identity.model,
        apiBase: identity.apiBase,
        providerProtocol: "openai_chat_compat",
        authMode: "api_key",
      });
      assert.isString(prepared.messages[prepared.messages.length - 1].content);
      assert.notInclude(JSON.stringify(prepared.messages), "image_url");
    } finally {
      resetModelCapabilityStateForTests();
    }
  });

  it("strips image content from explicit text-only chat requests", function () {
    const prepared = prepareChatRequest({
      prompt: "Describe this image.",
      images: ["data:image/png;base64,AAAA"],
      model: "local-text-only",
      apiBase: "https://api.example.test/v1",
    });

    const lastMessage = prepared.messages[prepared.messages.length - 1];
    assert.equal(lastMessage.role, "user");
    assert.isString(lastMessage.content);
    assert.include(String(lastMessage.content), "Describe this image.");
    assert.include(String(lastMessage.content), "image input");
    assert.notInclude(JSON.stringify(prepared.messages), "image_url");
  });

  it("strips image content when input mode is forced to text-only", function () {
    const prepared = prepareChatRequest({
      prompt: "Describe this image.",
      images: ["data:image/png;base64,AAAA"],
      model: "deepseek-vl2",
      apiBase: "https://api.deepseek.com/v1",
      inputMode: "text_only",
    });

    const lastMessage = prepared.messages[prepared.messages.length - 1];
    assert.equal(lastMessage.role, "user");
    assert.isString(lastMessage.content);
    assert.include(String(lastMessage.content), "Describe this image.");
    assert.include(String(lastMessage.content), "image input");
    assert.notInclude(JSON.stringify(prepared.messages), "image_url");
  });

  it("keeps image content when input mode explicitly allows vision", function () {
    const prepared = prepareChatRequest({
      prompt: "Describe this image.",
      images: ["data:image/png;base64,AAAA"],
      model: "deepseek-chat",
      apiBase: "https://api.deepseek.com/v1",
      inputMode: "vision_allowed",
    });

    const lastMessage = prepared.messages[prepared.messages.length - 1];
    assert.equal(lastMessage.role, "user");
    assert.isArray(lastMessage.content);
    assert.include(JSON.stringify(prepared.messages), "image_url");
  });

  it("keeps Anthropic Messages thinking off by default and preserves temperature", async function () {
    let capturedBody: Record<string, unknown> | null = null;
    mockFetch(async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body || "{}")) as Record<
        string,
        unknown
      >;
      return anthropicOkStream();
    });

    const output = await callLLMStream(
      {
        prompt: "Say ok.",
        model: "claude-sonnet-4-6",
        apiBase: "https://api.anthropic.com/v1",
        apiKey: "anthropic-test",
        providerProtocol: "anthropic_messages",
        temperature: 0.3,
      },
      () => undefined,
    );

    assert.equal(output.text, "OK");
    assert.notProperty(capturedBody || {}, "thinking");
    assert.notProperty(capturedBody || {}, "output_config");
    assert.equal(capturedBody?.temperature, 0.3);
  });

  it("never sends temperature to Claude Haiku 5.5, with or without thinking off", async function () {
    const bodies: Array<Record<string, unknown>> = [];
    mockFetch(async (_url, init) => {
      bodies.push(
        JSON.parse(String(init?.body || "{}")) as Record<string, unknown>,
      );
      return anthropicOkStream();
    });

    for (const reasoning of [
      undefined,
      { provider: "anthropic" as const, level: "none" as const },
    ]) {
      await callLLMStream(
        {
          prompt: "Say ok.",
          model: "claude-haiku-5-5",
          apiBase: "https://api.anthropic.com/v1",
          apiKey: "anthropic-test",
          providerProtocol: "anthropic_messages",
          temperature: 0,
          reasoning,
        },
        () => undefined,
      );
    }

    assert.lengthOf(bodies, 2);
    assert.notProperty(bodies[0], "temperature");
    assert.notProperty(bodies[0], "thinking");
    assert.notProperty(bodies[1], "temperature");
    assert.deepEqual(bodies[1].thinking, { type: "disabled" });
  });

  it("omits temperature for Haiku 5.5 snapshot IDs and non-Messages routes", function () {
    for (const model of [
      "claude-haiku-5-5@20261001",
      "claude-haiku-5-5-20261001",
    ]) {
      const payload = buildReasoningPayload(
        { provider: "anthropic", level: "none" },
        false,
        model,
        "https://api.anthropic.com/v1",
        "anthropic_messages",
      );
      assert.isTrue(payload.omitTemperature, model);
    }
    const viaOpenRouter = buildReasoningPayload(
      { provider: "anthropic", level: "low" },
      false,
      "anthropic/claude-haiku-5-5",
      "https://openrouter.ai/api/v1",
      "openai_chat_compat",
    );
    assert.isTrue(viaOpenRouter.omitTemperature);
  });

  it("sends OpenAI prompt cache hints for cache-aware full context", async function () {
    let capturedBody: Record<string, unknown> | null = null;
    mockFetch(async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body || "{}")) as Record<
        string,
        unknown
      >;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        body: makeSseStream([
          'data: {"choices":[{"delta":{"content":"OK"}}]}\n\n',
          "data: [DONE]\n\n",
        ]),
        json: async () => ({}),
        text: async () => "",
      };
    });

    await callLLMStream(
      {
        prompt: "Say ok.",
        context: "Stable paper text ".repeat(1200),
        model: "gpt-5.4",
        apiBase: "https://api.openai.com/v1",
        apiKey: "openai-test",
        providerProtocol: "openai_chat_compat",
        contextCache: {
          enabled: true,
          mode: "stable_prefix",
          provider: "openai",
          providerLabel: "OpenAI prompt cache",
          telemetry: "openai_cached_tokens",
          cacheKey: "openai:gpt-5.4:paper:abc",
          requestHints: {
            promptCacheKey: "openai:gpt-5.4:paper:abc",
            promptCacheRetention: "24h",
          },
        },
      },
      () => undefined,
    );

    assert.equal(capturedBody?.prompt_cache_key, "openai:gpt-5.4:paper:abc");
    assert.equal(capturedBody?.prompt_cache_retention, "24h");
  });

  it("sends Anthropic cache_control on stable system context", async function () {
    let capturedBody: Record<string, unknown> | null = null;
    mockFetch(async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body || "{}")) as Record<
        string,
        unknown
      >;
      return anthropicOkStream();
    });

    await callLLMStream(
      {
        prompt: "Say ok.",
        context: "Stable paper text ".repeat(1200),
        model: "claude-sonnet-4-6",
        apiBase: "https://api.anthropic.com/v1",
        apiKey: "anthropic-test",
        providerProtocol: "anthropic_messages",
        contextCache: {
          enabled: true,
          mode: "anthropic_block",
          provider: "anthropic",
          providerLabel: "Anthropic prompt cache",
          telemetry: "anthropic_read_write",
          cacheKey: "anthropic:paper:abc",
          requestHints: {
            anthropicBlockCacheControl: { type: "ephemeral" },
          },
        },
      },
      () => undefined,
    );

    assert.isArray(capturedBody?.system);
    const system = capturedBody?.system as Array<Record<string, unknown>>;
    assert.deepEqual(system[0]?.cache_control, { type: "ephemeral" });
    assert.include(String(system[0]?.text || ""), "Document Context:");
  });

  it("sends PDF attachments as Anthropic Messages document blocks", async function () {
    let capturedBody: Record<string, unknown> | null = null;
    mockFetch(async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body || "{}")) as Record<
        string,
        unknown
      >;
      return anthropicOkStream();
    });
    const originalIOUtils = (
      globalThis as typeof globalThis & { IOUtils?: unknown }
    ).IOUtils;
    (
      globalThis as typeof globalThis & {
        IOUtils?: { read: (path: string) => Promise<Uint8Array> };
      }
    ).IOUtils = {
      read: async () => new TextEncoder().encode("%PDF test"),
    };

    try {
      await callLLMStream(
        {
          prompt: "Summarize this PDF.",
          model: "claude-sonnet-4-6",
          apiBase: "https://api.anthropic.com/v1",
          apiKey: "anthropic-test",
          providerProtocol: "anthropic_messages",
          attachments: [
            {
              name: "paper.pdf",
              mimeType: "application/pdf",
              storedPath: "/tmp/paper.pdf",
            },
          ],
        },
        () => undefined,
      );
    } finally {
      (
        globalThis as typeof globalThis & { IOUtils?: typeof originalIOUtils }
      ).IOUtils = originalIOUtils;
    }

    const messages = capturedBody?.messages as
      | Array<{ content?: Array<Record<string, unknown>> }>
      | undefined;
    const content = messages?.[messages.length - 1]?.content || [];
    const documentBlock = content.find((part) => part.type === "document") as
      | { source?: { type?: string; media_type?: string; data?: string } }
      | undefined;
    assert.equal(documentBlock?.source?.type, "base64");
    assert.equal(documentBlock?.source?.media_type, "application/pdf");
    assert.equal(documentBlock?.source?.data, "JVBERiB0ZXN0");
    assert.isUndefined(
      content.find(
        (part) =>
          part.type === "image" &&
          (part.source as { media_type?: string } | undefined)?.media_type ===
            "application/pdf",
      ),
    );
  });

  it("maps PDF data URLs to Anthropic Messages document blocks", async function () {
    let capturedBody: Record<string, unknown> | null = null;
    mockFetch(async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body || "{}")) as Record<
        string,
        unknown
      >;
      return anthropicOkStream();
    });

    await callLLMStream(
      {
        prompt: "Summarize this PDF.",
        images: ["data:application/pdf;base64,JVBERi0x"],
        model: "claude-sonnet-4-6",
        apiBase: "https://api.anthropic.com/v1",
        apiKey: "anthropic-test",
        providerProtocol: "anthropic_messages",
      },
      () => undefined,
    );

    const messages = capturedBody?.messages as
      | Array<{ content?: Array<Record<string, unknown>> }>
      | undefined;
    const content = messages?.[messages.length - 1]?.content || [];
    const documentBlock = content.find((part) => part.type === "document") as
      | { source?: { type?: string; media_type?: string; data?: string } }
      | undefined;
    assert.equal(documentBlock?.source?.type, "base64");
    assert.equal(documentBlock?.source?.media_type, "application/pdf");
    assert.equal(documentBlock?.source?.data, "JVBERi0x");
    assert.isUndefined(
      content.find(
        (part) =>
          part.type === "image" &&
          (part.source as { media_type?: string } | undefined)?.media_type ===
            "application/pdf",
      ),
    );
  });

  it("uses adaptive thinking for Sonnet 4.6 and never sends temperature", async function () {
    let capturedBody: Record<string, unknown> | null = null;
    mockFetch(async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body || "{}")) as Record<
        string,
        unknown
      >;
      return anthropicOkStream();
    });

    await callLLMStream(
      {
        prompt: "Think.",
        model: "claude-sonnet-4-6",
        apiBase: "https://api.anthropic.com/v1",
        apiKey: "anthropic-test",
        providerProtocol: "anthropic_messages",
        reasoning: { provider: "anthropic", level: "max" },
        temperature: 0.3,
        outputTokenLimit: { mode: "custom", tokens: 4096 },
      },
      () => undefined,
    );

    assert.deepEqual(capturedBody?.thinking, { type: "adaptive" });
    assert.deepEqual(capturedBody?.output_config, { effort: "max" });
    assert.notProperty(capturedBody || {}, "temperature");
    assert.notNestedProperty(capturedBody || {}, "thinking.budget_tokens");
  });

  it("uses manual budget thinking for Haiku 4.5 with a valid budget", async function () {
    let capturedBody: Record<string, unknown> | null = null;
    mockFetch(async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body || "{}")) as Record<
        string,
        unknown
      >;
      return anthropicOkStream();
    });

    await callLLMStream(
      {
        prompt: "Think.",
        model: "claude-haiku-4-5",
        apiBase: "https://api.anthropic.com/v1",
        apiKey: "anthropic-test",
        providerProtocol: "anthropic_messages",
        reasoning: { provider: "anthropic", level: "high" },
        temperature: 0.3,
        outputTokenLimit: { mode: "custom", tokens: 4096 },
      },
      () => undefined,
    );

    assert.deepEqual(capturedBody?.thinking, {
      type: "enabled",
      budget_tokens: 3072,
    });
    assert.notProperty(capturedBody || {}, "temperature");
  });

  it("never sends manual budget thinking for Opus 4.7", async function () {
    let capturedBody: Record<string, unknown> | null = null;
    mockFetch(async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body || "{}")) as Record<
        string,
        unknown
      >;
      return anthropicOkStream();
    });

    await callLLMStream(
      {
        prompt: "Think.",
        model: "claude-opus-4-7",
        apiBase: "https://api.anthropic.com/v1",
        apiKey: "anthropic-test",
        providerProtocol: "anthropic_messages",
        reasoning: { provider: "anthropic", level: "xhigh" },
        outputTokenLimit: { mode: "custom", tokens: 4096 },
      },
      () => undefined,
    );

    assert.deepEqual(capturedBody?.thinking, { type: "adaptive" });
    assert.deepEqual(capturedBody?.output_config, { effort: "xhigh" });
    assert.notNestedProperty(capturedBody || {}, "thinking.budget_tokens");
  });

  it("emits Anthropic-compatible thinking deltas for regular streaming chat", async function () {
    mockFetch(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      body: makeSseStream([
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Plan first."}}\n\n',
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Done"}}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ]),
      json: async () => ({}),
      text: async () => "",
    }));

    const reasoningChunks: string[] = [];
    const output = await callLLMStream(
      {
        prompt: "Think.",
        model: "deepseek-v4-flash",
        apiBase: "https://api.deepseek.com/anthropic",
        apiKey: "deepseek-test",
        providerProtocol: "anthropic_messages",
        reasoning: { provider: "deepseek", level: "xhigh" },
      },
      () => undefined,
      (event) => {
        if (event.details) reasoningChunks.push(event.details);
      },
    );

    assert.equal(output.text, "Done");
    assert.deepEqual(reasoningChunks, ["Plan first."]);
  });

  it("maps Anthropic streaming stop_reason max_tokens to an incomplete outcome", async function () {
    mockFetch(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      body: makeSseStream([
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Partial answer"}}\n\n',
        'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ]),
      json: async () => ({}),
      text: async () => "",
    }));

    const outcome = await callLLMStream(
      {
        prompt: "Think.",
        model: "claude-sonnet-4-6",
        apiBase: "https://api.anthropic.com/v1",
        apiKey: "anthropic-test",
        providerProtocol: "anthropic_messages",
      },
      () => undefined,
    );

    assert.equal(outcome.text, "Partial answer");
    assert.deepEqual(outcome.completion, {
      status: "incomplete",
      reason: "output_limit",
      providerReason: "max_tokens",
    });
  });

  it("does not leak Anthropic thinking fields into OpenAI-compatible Claude calls", async function () {
    let capturedBody: Record<string, unknown> | null = null;
    mockFetch(async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body || "{}")) as Record<
        string,
        unknown
      >;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        body: makeSseStream([
          'data: {"choices":[{"delta":{"content":"OK"}}]}\n\n',
          "data: [DONE]\n\n",
        ]),
        json: async () => ({}),
        text: async () => "",
      };
    });

    const output = await callLLMStream(
      {
        prompt: "Say ok.",
        model: "claude-sonnet-4-6",
        apiBase: "https://api.example.com/v1",
        apiKey: "compat-test",
        providerProtocol: "openai_chat_compat",
        reasoning: { provider: "anthropic", level: "high" },
      },
      () => undefined,
    );

    assert.equal(output.text, "OK");
    assert.notProperty(capturedBody || {}, "thinking");
    assert.notProperty(capturedBody || {}, "output_config");
    assert.notProperty(capturedBody || {}, "reasoning_effort");
  });

  it("downgrades Anthropic Messages reasoning after provider rejections", async function () {
    const requestBodies: Record<string, unknown>[] = [];
    mockFetch(async (_url, init) => {
      requestBodies.push(
        JSON.parse(String(init?.body || "{}")) as Record<string, unknown>,
      );
      if (requestBodies.length === 1) {
        return {
          ok: false,
          status: 400,
          statusText: "Bad Request",
          text: async () => "thinking.type adaptive is not supported",
        };
      }
      if (requestBodies.length === 2) {
        return {
          ok: false,
          status: 400,
          statusText: "Bad Request",
          text: async () => "budget_tokens is not supported",
        };
      }
      return anthropicOkStream();
    });

    await callLLMStream(
      {
        prompt: "Think.",
        model: "claude-sonnet-4-6",
        apiBase: "https://third-party.example/v1",
        apiKey: "proxy-test",
        providerProtocol: "anthropic_messages",
        reasoning: { provider: "anthropic", level: "high" },
        temperature: 0.3,
        outputTokenLimit: { mode: "custom", tokens: 4096 },
      },
      () => undefined,
    );

    assert.deepEqual(requestBodies[0]?.thinking, { type: "adaptive" });
    assert.deepEqual(requestBodies[1]?.thinking, {
      type: "enabled",
      budget_tokens: 3072,
    });
    assert.notProperty(requestBodies[2] || {}, "thinking");
    assert.equal(requestBodies[2]?.temperature, 0.3);
  });

  it("fails locally when Anthropic manual thinking cannot fit under max_tokens", async function () {
    try {
      await callLLMStream(
        {
          prompt: "Think.",
          model: "claude-haiku-4-5",
          apiBase: "https://api.anthropic.com/v1",
          apiKey: "anthropic-test",
          providerProtocol: "anthropic_messages",
          reasoning: { provider: "anthropic", level: "high" },
          outputTokenLimit: { mode: "custom", tokens: 1024 },
        },
        () => undefined,
      );
      assert.fail("expected max_tokens validation to fail locally");
    } catch (error) {
      assert.instanceOf(error, ReasoningBudgetError);
      assert.equal(
        (error as ReasoningBudgetError).code,
        "reasoning_budget_too_small",
      );
      assert.include(
        (error as Error).message,
        "extended thinking requires max_tokens of at least 2048",
      );
    }
  });

  it("rejects Codex app-server in the generic LLM client", async function () {
    try {
      await callLLMStream(
        {
          prompt: "What changed?",
          model: "gpt-5.4",
          authMode: "codex_app_server" as const,
          apiBase: "",
        },
        () => undefined,
      );
      assert.fail("expected generic app-server transport to reject");
    } catch (error) {
      assert.include(
        (error as Error).message,
        "native Codex conversation system",
      );
    }
  });

  it("throws when no dedicated embedding provider is configured", async function () {
    const setPref = globalThis.Zotero.Prefs.set as (
      key: string,
      value: unknown,
    ) => void;
    setPref("extensions.zotero.llmforzotero.embeddingProvider", "");
    setPref("extensions.zotero.llmforzotero.embeddingApiBase", "");
    try {
      await callEmbeddings(["hello"]);
      assert.fail("expected callEmbeddings to throw");
    } catch (error) {
      assert.include(
        (error as Error).message,
        "No embedding provider configured",
      );
    }
  });

  it("changes embedding keys when the dedicated provider config changes", function () {
    const setPref = globalThis.Zotero.Prefs.set as (
      key: string,
      value: unknown,
    ) => void;
    setPref("extensions.zotero.llmforzotero.embeddingProvider", "openai");
    setPref(
      "extensions.zotero.llmforzotero.embeddingApiBase",
      "https://api.openai.com/v1",
    );
    setPref("extensions.zotero.llmforzotero.embeddingApiKey", "sk-first");
    setPref(
      "extensions.zotero.llmforzotero.embeddingModel",
      "text-embedding-3-small",
    );
    const initial = getResolvedEmbeddingConfig();

    setPref(
      "extensions.zotero.llmforzotero.embeddingApiBase",
      "https://proxy.example/v1",
    );
    const endpointChanged = getResolvedEmbeddingConfig();

    setPref(
      "extensions.zotero.llmforzotero.embeddingApiBase",
      "https://api.openai.com/v1",
    );
    setPref("extensions.zotero.llmforzotero.embeddingApiKey", "sk-second");
    const keyChanged = getResolvedEmbeddingConfig();

    assert.notEqual(initial.providerKey, endpointChanged.providerKey);
    assert.notEqual(initial.attemptKey, keyChanged.attemptKey);
  });

  it("refreshes codex auth token on 401 and retries once", async function () {
    const prefsKey = "extensions.zotero.llmforzotero.modelProviderGroups";
    const versionKey =
      "extensions.zotero.llmforzotero.modelProviderGroupsMigrationVersion";
    (
      globalThis.Zotero.Prefs as { set: (key: string, value: unknown) => void }
    ).set(
      prefsKey,
      JSON.stringify([
        {
          id: "provider-codex",
          apiBase: "https://chatgpt.com/backend-api/codex/responses",
          apiKey: "",
          authMode: "codex_auth",
          models: [
            {
              id: "m1",
              model: "gpt-5.4",
              temperature: 0.3,
              outputTokenLimit: { mode: "auto" },
            },
          ],
        },
      ]),
    );
    (
      globalThis.Zotero.Prefs as { set: (key: string, value: unknown) => void }
    ).set(versionKey, 2);

    const authJson = JSON.stringify({
      tokens: { access_token: "old-access", refresh_token: "refresh-1" },
      last_refresh: "2026-01-01T00:00:00.000Z",
    });
    const writes: string[] = [];
    let apiCallCount = 0;
    const fetchMock = async (url: string) => {
      if (url === "https://auth.openai.com/oauth/token") {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            access_token: "new-access",
            refresh_token: "refresh-2",
          }),
          text: async () => "",
        };
      }
      apiCallCount += 1;
      if (apiCallCount === 1) {
        return {
          ok: false,
          status: 401,
          statusText: "Unauthorized",
          text: async () => "unauthorized",
          json: async () => ({}),
        };
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ output_text: "OK after refresh" }),
        text: async () => "",
      };
    };

    (
      globalThis as typeof globalThis & {
        ztoolkit: { getGlobal: (name: string) => unknown; log: () => void };
      }
    ).ztoolkit = {
      getGlobal: (name: string) => {
        if (name === "fetch") return fetchMock;
        if (name === "process") return { env: { HOME: "/home/tester" } };
        if (name === "IOUtils") {
          return {
            exists: async () => true,
            read: async () => new TextEncoder().encode(authJson),
            makeDirectory: async () => undefined,
            write: async (_path: string, data: Uint8Array) => {
              writes.push(new TextDecoder("utf-8").decode(data));
            },
          };
        }
        return undefined;
      },
      log: () => undefined,
    };

    const output = await callLLM({
      prompt: "ping",
      model: "gpt-5.4",
    });
    assert.equal(output.text, "OK after refresh");
    assert.equal(apiCallCount, 2);
    assert.isAtLeast(writes.length, 1);
    assert.include(writes[writes.length - 1], "new-access");
  });

  it("executes SiliconFlow chat, PDF context Q&A, multi-turn streaming, and cancellation via openai_chat_compat", async function () {
    let lastUrl = "";
    let lastHeaders: Record<string, string> = {};
    let lastBody: Record<string, unknown> = {};

    mockFetch(async (url, init) => {
      lastUrl = url;
      lastHeaders = (init?.headers as Record<string, string>) || {};
      lastBody = JSON.parse(String(init?.body || "{}")) as Record<
        string,
        unknown
      >;
      if (init?.signal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      if (lastBody.stream) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          body: makeSseStream([
            'data: {"choices":[{"delta":{"content":"Silicon"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"Flow"},"finish_reason":"stop"}]}\n\n',
            "data: [DONE]\n\n",
          ]),
          json: async () => ({}),
          text: async () => "",
        };
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          choices: [
            {
              message: { content: "Answer from SiliconFlow" },
              finish_reason: "stop",
            },
          ],
        }),
        text: async () => "",
      };
    });

    // 1. Plain chat & PDF selected context Q&A
    const nonStream = await callLLM({
      prompt: "Explain this paragraph.",
      context: "Selected PDF text about transformer attention.",
      model: "Qwen/Qwen2.5-72B-Instruct",
      apiBase: "https://api.siliconflow.cn/v1",
      apiKey: "sf-key-123",
      providerProtocol: "openai_chat_compat",
    });
    assert.equal(lastUrl, "https://api.siliconflow.cn/v1/chat/completions");
    assert.equal(lastHeaders.Authorization, "Bearer sf-key-123");
    assert.equal(lastBody.model, "Qwen/Qwen2.5-72B-Instruct");
    assert.equal(nonStream.text, "Answer from SiliconFlow");

    // 2. Streaming + multi-turn history
    const deltas: string[] = [];
    const streamed = await callLLMStream(
      {
        prompt: "Follow-up question",
        history: [
          { role: "user", content: "First question" },
          { role: "assistant", content: "First answer" },
        ],
        model: "deepseek-ai/DeepSeek-V3",
        apiBase: "https://api.siliconflow.cn/v1",
        apiKey: "sf-key-123",
        providerProtocol: "openai_chat_compat",
      },
      (delta) => deltas.push(delta),
    );
    assert.equal(lastUrl, "https://api.siliconflow.cn/v1/chat/completions");
    assert.equal(lastBody.model, "deepseek-ai/DeepSeek-V3");
    assert.deepEqual(deltas, ["Silicon", "Flow"]);
    assert.equal(streamed.text, "SiliconFlow");

    // 3. Cancellation via AbortController
    const abortController = new AbortController();
    abortController.abort();
    let aborted = false;
    try {
      await callLLM({
        prompt: "Should abort",
        model: "Qwen/Qwen2.5-72B-Instruct",
        apiBase: "https://api.siliconflow.cn/v1",
        apiKey: "sf-key-123",
        providerProtocol: "openai_chat_compat",
        signal: abortController.signal,
      });
    } catch {
      aborted = true;
    }
    assert.isTrue(aborted, "aborted signal cancels the request");
  });

  for (const stream of [false, true]) {
    for (const mixed of [false, true]) {
      it(`PDF review F1: preserves official ${mixed ? "mixed" : "non-PDF"} attachments in ${stream ? "stream" : "nonstream"} order`, async function () {
        const originalIO = (globalThis as any).IOUtils;
        const pdfBytes = createPdfFixture(2);
        const suffix = `${stream}-${mixed}`;
        const names = mixed
          ? [
              `first-${suffix}.txt`,
              `论文-${suffix}.pdf`,
              `last-${suffix}.txt`,
              `appendix-${suffix}.pdf`,
            ]
          : [`notes-${suffix}.txt`];
        const uploaded = new Map<string, string>();
        const wires: any[] = [];
        (globalThis as any).IOUtils = {
          read: async (path: string) =>
            path.endsWith(".pdf")
              ? pdfBytes
              : new TextEncoder().encode("original notes"),
        };
        mockFetch(async (url, init) => {
          if (url.endsWith("/files")) {
            const multipart = await new Response(init?.body).text();
            const filename = /filename="([^"]+)"/.exec(multipart)?.[1];
            assert.isString(filename);
            const id = `file-${uploaded.size}`;
            uploaded.set(id, filename!);
            return { ok: true, json: async () => ({ id }) };
          }
          assert.isTrue(url.endsWith("/responses"));
          wires.push(JSON.parse(String(init?.body)));
          return {
            ok: true,
            body: undefined,
            json: async () => ({ status: "completed", output_text: "OK" }),
          };
        });
        try {
          const params = {
            prompt: "Read the files",
            model: "gpt-4.1",
            apiBase: "https://api.openai.com/v1",
            apiKey: "F1-offline",
            authMode: "api_key" as const,
            providerProtocol: "responses_api" as const,
            attachments: names.map((name) => ({
              name,
              storedPath: `/synthetic/${name}`,
              mimeType: name.endsWith(".pdf")
                ? "application/pdf"
                : "text/plain",
            })),
          };
          const result = stream
            ? await callLLMStream(params, () => {})
            : await callLLM(params);
          assert.equal(result.text, "OK");
          assert.lengthOf(wires, 1);
          const parts = wires[0].input
            .at(-1)
            .content.filter((part: any) => part.type === "input_file");
          assert.deepEqual(
            parts.map((part: any) =>
              part.file_id ? uploaded.get(part.file_id) : part.filename,
            ),
            names,
          );
          assert.equal(uploaded.size, mixed ? 2 : 1);
          for (const part of parts.filter((part: any) => part.file_data)) {
            assert.deepEqual(
              Buffer.from(part.file_data.split(",")[1], "base64"),
              Buffer.from(pdfBytes),
            );
          }
        } finally {
          (globalThis as any).IOUtils = originalIO;
        }
      });
    }
  }

  it("PDF review F1: does not promise arbitrary file uploads on compatible Responses", async function () {
    let posts = 0;
    mockFetch(async () => {
      posts++;
      throw new Error("must not upload or send");
    });
    let error: unknown;
    try {
      await callLLM({
        prompt: "Read notes",
        model: "unconfirmed-alias",
        apiBase: "https://compat.invalid/v1",
        apiKey: "offline",
        authMode: "api_key",
        providerProtocol: "responses_api",
        inputMode: "pdf_allowed",
        attachments: [
          {
            name: "notes.txt",
            mimeType: "text/plain",
            storedPath: "/synthetic/notes.txt",
          },
        ],
      });
    } catch (caught) {
      error = caught;
    }
    assert.instanceOf(error, Error);
    assert.equal(posts, 0);
  });

  describe("R13 production history PDF prefix", function () {
    const bytes = createPdfFixture(2);
    const otherBytes = createPdfFixture(3);
    const pdf: ChatAttachment = {
      id: "pdf-paper-20-history",
      name: "原始论文.pdf",
      category: "pdf",
      mimeType: "application/pdf",
      storedPath: "/synthetic/blob-a.pdf",
      contentHash: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.length,
    };
    const base = {
      model: "gpt-4.1",
      apiBase: "https://api.openai.com/v1",
      apiKey: "R13-offline",
      authMode: "api_key" as const,
      providerProtocol: "responses_api" as const,
    };
    let originalIO: unknown;
    let originalFetch: typeof fetch;
    let reads: string[];
    let wires: any[];
    let uploads: string[];

    const row = (timestamp = 100, files = [pdf]): Message => ({
      role: "user",
      text: `question ${timestamp}`,
      timestamp,
      attachments: [{ ...pdf, name: "visible-only.pdf" }],
      modelAttachments: files,
      pdfPaperContexts: [
        {
          itemId: 10,
          contextItemId: 20,
          title: "Paper",
          contentSourceMode: "pdf",
        },
      ],
    });
    const users = (wire: any) =>
      wire.input.filter((m: any) => m.role === "user");
    const files = (message: any): any[] =>
      Array.isArray(message.content)
        ? message.content.filter((p: any) => p.type === "input_file")
        : [];
    const send = async (
      params: Parameters<typeof callLLM>[0],
      stream: boolean,
    ) => (stream ? callLLMStream(params, () => {}) : callLLM(params));
    const exactPdf = (part: any, name = pdf.name, data = bytes) => {
      assert.deepEqual(Object.keys(part).sort(), [
        "file_data",
        "filename",
        "type",
      ]);
      assert.equal(part.filename, name);
      assert.deepEqual(
        Buffer.from(part.file_data.split(",")[1], "base64"),
        Buffer.from(data),
      );
    };
    const noInternalMetadata = (wire: unknown) => {
      for (const forbidden of [
        "fileAttachments",
        "storedPath",
        "contentHash",
        "/synthetic/",
      ]) {
        assert.notInclude(JSON.stringify(wire), forbidden);
      }
    };

    beforeEach(function () {
      originalIO = (globalThis as any).IOUtils;
      originalFetch = globalThis.fetch;
      globalThis.fetch = async () => {
        throw new Error("External network forbidden");
      };
      reads = [];
      wires = [];
      uploads = [];
      (globalThis as any).IOUtils = {
        read: async (path: string) => {
          reads.push(path);
          return path === "/synthetic/blob-b.pdf" ? otherBytes : bytes;
        },
      };
      mockFetch(async (url, init) => {
        if (url.endsWith("/files")) {
          const multipart = await new Response(init?.body).text();
          uploads.push(/filename="([^"]+)"/.exec(multipart)![1]);
          return {
            ok: true,
            json: async () => ({ id: `file-R13-${uploads.length}` }),
          };
        }
        const wire = JSON.parse(String(init?.body));
        wires.push(wire);
        noInternalMetadata(wire);
        return {
          ok: true,
          status: 200,
          body: wire.stream
            ? makeSseStream([
                'data: {"type":"response.output_text.delta","delta":"OK"}\n\n',
                'data: {"type":"response.completed","response":{"status":"completed","output_text":"OK"}}\n\n',
              ])
            : undefined,
          json: async () => ({ status: "completed", output_text: "OK" }),
        };
      });
    });

    afterEach(function () {
      (globalThis as any).IOUtils = originalIO;
      globalThis.fetch = originalFetch;
    });

    for (const stream of [false, true]) {
      it(`retains exact first-user PDF across Send/reload/original-user Retry (${stream ? "stream" : "nonstream"})`, async function () {
        resetConversationStoreProcessStateForTests();
        const db = installSqliteZotero();
        try {
          await initChatStore();
          const conversationKey = await createGlobalConversation(1, {
            title: "R13 offline",
          });
          // F1: real legacy SQL row lacks the later selection's SHA256.
          const first = row(100, [{ ...pdf, contentHash: undefined }]);
          await send(
            {
              ...base,
              prompt: first.text,
              attachments: first.modelAttachments,
            },
            stream,
          );
          const firstWire = users(wires[0])[0];
          exactPdf(files(firstWire)[0]);
          await appendMessage(conversationKey, first);
          await appendMessage(conversationKey, {
            role: "assistant",
            text: "answer 1",
            timestamp: 101,
          });
          const second = row(102);
          await appendMessage(conversationKey, second);
          // The actual SQL row serializer/loader is the source, not JSON cloning.
          const reloaded = await loadConversation(conversationKey, 20);
          const history = reloaded as Message[];
          assert.equal(history[0].modelAttachments?.[0].contentHash, undefined);
          assert.equal(
            history[0].modelAttachments?.[0].storedPath,
            pdf.storedPath,
          );
          assert.equal(history[0].attachments?.[0].name, "visible-only.pdf");
          assert.equal(history[0].pdfPaperContexts?.[0].contextItemId, 20);
          const originalUser = history[2];
          const id = originalUser.id;
          const timestamp = originalUser.timestamp;
          assert.isNumber(id);
          const snapshot = takeRetryUserSnapshot(originalUser);
          const sendOriginalUser = () =>
            send(
              {
                ...base,
                prompt: originalUser.text,
                history: buildLLMHistoryMessages(history.slice(0, 2)),
                attachments: originalUser.modelAttachments,
              },
              stream,
            );
          await sendOriginalUser();
          assert.deepEqual(users(wires[1])[0], firstWire);
          assert.lengthOf(files(users(wires[1])[1]), 0);
          // A failed preparation restores the same row; Retry uses its saved files.
          originalUser.modelAttachments = [];
          originalUser.modelName = "temporary-retry-target";
          restoreRetryUserSnapshot(originalUser, snapshot);
          await sendOriginalUser();
          assert.strictEqual(history[2], originalUser);
          assert.equal(originalUser.id, id);
          assert.equal(originalUser.timestamp, timestamp);
          assert.deepEqual(takeRetryUserSnapshot(originalUser), snapshot);
          assert.deepEqual(wires[2].input, wires[1].input);
          exactPdf(files(users(wires[2])[0])[0]);
          assert.deepEqual(reads, [
            pdf.storedPath,
            pdf.storedPath,
            pdf.storedPath,
          ]);
          assert.lengthOf(uploads, 0);
          const stored = db.all(
            "SELECT model_attachments_json FROM llm_for_zotero_chat_messages WHERE role = 'user'",
          );
          assert.notInclude(JSON.stringify(stored), "base64");
        } finally {
          db.db.close();
          resetConversationStoreProcessStateForTests();
        }
      });

      it(`aborts while reading a history PDF without HTTP (${stream ? "stream" : "nonstream"})`, async function () {
        const controller = new AbortController();
        (globalThis as any).IOUtils.read = async () => {
          controller.abort();
          return bytes;
        };
        let error: any;
        try {
          await send(
            {
              ...base,
              prompt: "next",
              history: buildLLMHistoryMessages([
                row(100, [{ ...pdf, contentHash: undefined }]),
              ]),
              signal: controller.signal,
            },
            stream,
          );
        } catch (caught) {
          error = caught;
        }
        assert.equal(error?.name, "AbortError");
        assert.lengthOf(wires, 0);
        assert.lengthOf(uploads, 0);
      });

      it(`deduplicates only retained users, preserving names/content/order (${stream ? "stream" : "nonstream"})`, async function () {
        const renamed = { ...pdf, name: "别名.pdf" };
        const different = {
          ...pdf,
          storedPath: "/synthetic/blob-b.pdf",
          contentHash: createHash("sha256").update(otherBytes).digest("hex"),
        };
        const history = buildLLMHistoryMessages([
          row(100, [pdf]),
          { role: "assistant", text: "done", timestamp: 101 },
          row(102, [
            { ...pdf, storedPath: "/synthetic/unused-copy.pdf" },
            renamed,
            different,
          ]),
        ]);
        const before = JSON.stringify(history);
        await send(
          {
            ...base,
            prompt: "next",
            history,
            attachments: [pdf, renamed, different],
          },
          stream,
        );
        const input = users(wires[0]);
        exactPdf(files(input[0])[0]);
        assert.lengthOf(files(input[1]), 2);
        exactPdf(files(input[1])[0], renamed.name);
        exactPdf(files(input[1])[1], different.name, otherBytes);
        assert.lengthOf(files(input[2]), 0);
        assert.equal(JSON.stringify(history), before);
        // Force real token-cap removal of all old users; current PDF must return.
        const cappedHistory = buildLLMHistoryMessages([
          {
            ...row(100, [{ ...pdf, contentHash: undefined }]),
            text: "old ".repeat(30_000),
          },
        ]);
        const params = {
          ...base,
          prompt: "new",
          history: cappedHistory,
          attachments: [pdf],
          inputTokenCap: 4096,
        };
        assert.isTrue(
          prepareChatRequest(params).inputCap.effects.historyDropped,
        );
        await send(params, stream);
        const retained = users(wires[1]);
        assert.lengthOf(retained, 1);
        exactPdf(files(retained[0])[0]);
        // A separate request/session cannot borrow the first request's seen set.
        await send(
          { ...base, prompt: "independent", attachments: [pdf] },
          stream,
        );
        exactPdf(files(users(wires[2])[0])[0]);
      });

      it(`F1 sends one 25 MB legacy PDF before accounting duplicates (${stream ? "stream" : "nonstream"})`, async function () {
        const large = new Uint8Array(25_000_000);
        large.set(new TextEncoder().encode("%PDF-"));
        const hash = createHash("sha256").update(large).digest("hex");
        (globalThis as any).IOUtils.read = async (path: string) => {
          reads.push(path);
          return large;
        };
        const known = { ...pdf, contentHash: hash };
        const missing = { ...pdf, contentHash: undefined };
        for (const [historical, current] of [
          [missing, known],
          [known, missing],
        ]) {
          await send(
            {
              ...base,
              prompt: "same PDF follow up",
              history: buildLLMHistoryMessages([row(100, [historical])]),
              attachments: [current],
            },
            stream,
          );
        }
        for (const wire of wires) {
          const input = users(wire);
          assert.lengthOf(files(input[0]), 1);
          assert.lengthOf(files(input[1]), 0);
          const part = files(input[0])[0];
          assert.equal(part.filename, pdf.name);
          assert.equal(
            createHash("sha256")
              .update(Buffer.from(part.file_data.split(",")[1], "base64"))
              .digest("hex"),
            hash,
          );
        }
        assert.deepEqual(
          reads,
          [pdf.storedPath, pdf.storedPath, pdf.storedPath],
          "missing-hash reads are reused; known duplicates never reread",
        );
      });

      it(`F1 never bridges different bytes or known hashes through a path (${stream ? "stream" : "nonstream"})`, async function () {
        const unknown = { ...pdf, contentHash: undefined };
        const different = {
          ...pdf,
          contentHash: createHash("sha256").update(otherBytes).digest("hex"),
        };
        // Same path/name cannot prove equal bytes, even for two old rows.
        (globalThis as any).IOUtils.read = async (path: string) => {
          reads.push(path);
          return reads.length === 1 ? bytes : otherBytes;
        };
        await send(
          {
            ...base,
            prompt: "next",
            history: buildLLMHistoryMessages([row(100, [unknown])]),
            attachments: [unknown],
          },
          stream,
        );
        exactPdf(files(users(wires[0])[0])[0]);
        exactPdf(files(users(wires[0])[1])[0], pdf.name, otherBytes);
        assert.lengthOf(reads, 2);
        reads = [];
        (globalThis as any).IOUtils.read = async (path: string) => {
          reads.push(path);
          return reads.length <= 2 ? bytes : otherBytes;
        };
        // An unknown middle alias matches A, but must not collapse known B.
        await send(
          {
            ...base,
            prompt: "next",
            history: buildLLMHistoryMessages([
              row(100, [pdf, unknown, different]),
            ]),
            attachments: [pdf],
          },
          stream,
        );
        const retained = files(users(wires[1])[0]);
        assert.lengthOf(retained, 2);
        exactPdf(retained[0]);
        exactPdf(retained[1], pdf.name, otherBytes);
        assert.lengthOf(files(users(wires[1])[1]), 0);
        assert.lengthOf(reads, 3, "each selection read at most once");
        (globalThis as any).IOUtils.read = async () => bytes;
        const renamed = { ...unknown, name: "renamed.pdf" };
        await send(
          {
            ...base,
            prompt: "next",
            history: buildLLMHistoryMessages([row()]),
            attachments: [renamed],
          },
          stream,
        );
        exactPdf(files(users(wires[2])[0])[0]);
        exactPdf(files(users(wires[2])[1])[0], renamed.name);
      });

      it(`F1 reuses proven managed blob identity in either hash direction (${stream ? "stream" : "nonstream"})`, async function () {
        (globalThis.Zotero as any).Profile = { dir: "/synthetic/profile" };
        const managed = {
          ...pdf,
          storedPath: `/synthetic/profile/chat-attachments/blobs/${pdf.contentHash}/original.pdf`,
        };
        const missing = { ...managed, contentHash: undefined };
        for (const [historical, current] of [
          [missing, managed],
          [managed, missing],
        ]) {
          await send(
            {
              ...base,
              prompt: "next",
              history: buildLLMHistoryMessages([row(100, [historical])]),
              attachments: buildLLMHistoryMessages([row(102, [current])])[0]
                .fileAttachments,
            },
            stream,
          );
        }
        for (const wire of wires) {
          exactPdf(files(users(wire)[0])[0]);
          assert.lengthOf(files(users(wire)[1]), 0);
        }
        assert.deepEqual(reads, [managed.storedPath, managed.storedPath]);
        const nonPdf = {
          ...missing,
          name: "notes.txt",
          category: "text" as const,
          mimeType: "text/plain",
        };
        assert.isUndefined(
          buildLLMHistoryMessages([row(104, [nonPdf])])[0].fileAttachments?.[0]
            .contentHash,
          "do not change non-PDF upload/cache identity policy",
        );
      });

      it(`F1 aborts during missing-hash digest without HTTP (${stream ? "stream" : "nonstream"})`, async function () {
        const controller = new AbortController();
        const cryptoDescriptor = Object.getOwnPropertyDescriptor(
          globalThis,
          "crypto",
        );
        const originalCrypto = globalThis.crypto;
        let digests = 0;
        Object.defineProperty(globalThis, "crypto", {
          configurable: true,
          value: {
            subtle: {
              digest: async (algorithm: string, data: BufferSource) => {
                digests++;
                const digest = await originalCrypto.subtle.digest(
                  algorithm,
                  data,
                );
                controller.abort();
                return digest;
              },
            },
          },
        });
        let error: any;
        try {
          await send(
            {
              ...base,
              prompt: "next",
              history: buildLLMHistoryMessages([
                row(100, [{ ...pdf, contentHash: undefined }]),
              ]),
              signal: controller.signal,
            },
            stream,
          );
        } catch (caught) {
          error = caught;
        } finally {
          if (cryptoDescriptor)
            Object.defineProperty(globalThis, "crypto", cryptoDescriptor);
          else delete (globalThis as any).crypto;
        }
        assert.equal(digests, 1);
        assert.equal(error?.name, "AbortError");
        assert.lengthOf(reads, 1);
        assert.lengthOf(wires, 0);
        assert.lengthOf(uploads, 0);
      });

      it(`retains historical mixed official uploads/cache in place (${stream ? "stream" : "nonstream"})`, async function () {
        const notes = {
          ...pdf,
          id: "txt",
          contentHash: undefined,
          name: `history-${stream}.txt`,
          mimeType: "text/plain",
          category: "text" as const,
          storedPath: `/synthetic/history-${stream}.txt`,
        };
        const history = buildLLMHistoryMessages([
          row(100, [
            notes,
            pdf,
            {
              ...notes,
              name: `after-${stream}.txt`,
              storedPath: `/synthetic/after-${stream}.txt`,
            },
          ]),
        ]);
        const params = {
          ...base,
          prompt: "follow up",
          history,
          attachments: [pdf],
        };
        await send(params, stream);
        await send(params, stream);
        assert.lengthOf(
          uploads,
          2,
          "second request must reuse official /files cache",
        );
        for (const wire of wires) {
          assert.deepEqual(
            files(users(wire)[0]).map((part) => part.file_id || part.filename),
            ["file-R13-1", pdf.name, "file-R13-2"],
          );
          exactPdf(files(users(wire)[0])[1]);
          assert.lengthOf(files(users(wire)[1]), 0);
        }
      });
    }

    it("uses saved model attachments including explicit empty arrays, with visible fallback and no images", function () {
      assert.deepEqual(
        buildLLMHistoryMessages([{ ...row(), modelAttachments: [] }])[0],
        { role: "user", content: row().text },
      );
      const fallback = buildLLMHistoryMessages([
        { ...row(), modelAttachments: undefined },
      ])[0];
      assert.equal(fallback.fileAttachments?.[0].name, "visible-only.pdf");
      const image = {
        ...pdf,
        category: "image" as const,
        name: "image.png",
        mimeType: "image/png",
      };
      assert.isUndefined(
        buildLLMHistoryMessages([row(100, [image])])[0].fileAttachments,
      );
      assert.isUndefined(
        buildLLMHistoryMessages([{ ...row(), role: "assistant" }])[0]
          .fileAttachments,
      );
    });

    it("marks historical PDF preparation failures as recovery none, and permits explicit Retry", async function () {
      const history = buildLLMHistoryMessages([row()]);
      (globalThis as any).IOUtils.read = async () =>
        new TextEncoder().encode("not a PDF");
      let error: any;
      try {
        await callLLM({ ...base, prompt: "next", history });
      } catch (caught) {
        error = caught;
      }
      assert.deepEqual(error?.modelRecovery, {
        automaticRecovery: "none",
        source: "pdf_input",
      });
      assert.lengthOf(wires, 0);
      (globalThis as any).IOUtils.read = async () => bytes;
      await callLLM({ ...base, prompt: "next", history });
      exactPdf(files(users(wires[0])[0])[0]);
    });

    it("enforces the strict combined history/current 50 MB limit before HTTP", async function () {
      const large = new Uint8Array(25_000_000);
      large.set(new TextEncoder().encode("%PDF-"));
      (globalThis as any).IOUtils.read = async () => large;
      let error: any;
      try {
        await callLLM({
          ...base,
          prompt: "next",
          history: buildLLMHistoryMessages([row()]),
          attachments: [
            {
              ...pdf,
              name: "different.pdf",
              storedPath: "/synthetic/large-b.pdf",
              contentHash: "b".repeat(64),
            },
          ],
        });
      } catch (caught) {
        error = caught;
      }
      assert.include(String(error), "50 MB");
      assert.deepEqual(error.modelRecovery, {
        automaticRecovery: "none",
        source: "pdf_input",
      });
      assert.lengthOf(wires, 0);
      assert.lengthOf(uploads, 0);
    });

    it("strips internal metadata from non-Responses HTTP and ignores historical files", async function () {
      const history = buildLLMHistoryMessages([row()]);
      let wire: any;
      mockFetch(async (_url, init) => {
        wire = JSON.parse(String(init?.body));
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: "OK" }, finish_reason: "stop" }],
          }),
        };
      });
      await callLLM({
        ...base,
        model: "chat-compatible",
        apiBase: "https://compat.invalid/v1",
        providerProtocol: "openai_chat_compat",
        prompt: "next",
        history,
      });
      noInternalMetadata(wire);
      assert.deepEqual(
        wire.messages.filter((m: any) => m.role === "user"),
        [
          { role: "user", content: row().text },
          { role: "user", content: "next" },
        ],
      );
      for (const [providerProtocol, model, apiBase] of [
        [
          "anthropic_messages",
          "claude-sonnet-4-6",
          "https://api.anthropic.com/v1",
        ],
        [
          "gemini_native",
          "gemini-2.5-pro",
          "https://generativelanguage.googleapis.com/v1beta",
        ],
        ["ollama_native", "llama3.2", "http://localhost:11434"],
      ] as const) {
        mockFetch(async (_url, init) => {
          wire = JSON.parse(String(init?.body));
          return {
            ok: true,
            json: async () => ({
              content: [{ type: "text", text: "OK" }],
              stop_reason: "end_turn",
              candidates: [
                { content: { parts: [{ text: "OK" }] }, finishReason: "STOP" },
              ],
              message: { content: "OK" },
              done: true,
            }),
          };
        });
        await callLLM({
          ...base,
          providerProtocol,
          model,
          apiBase,
          prompt: "next",
          history,
        });
        noInternalMetadata(wire);
      }
      for (const providerProtocol of [
        "anthropic_messages",
        "gemini_native",
        "ollama_native",
        "codex_responses",
      ] as const) {
        const prepared = prepareChatRequest({
          ...base,
          prompt: "next",
          history,
          providerProtocol,
        });
        noInternalMetadata(prepared.messages);
      }
      assert.lengthOf(reads, 0);
      assert.lengthOf(uploads, 0);
    });
  });
});
