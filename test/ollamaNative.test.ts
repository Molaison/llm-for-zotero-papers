import { assert } from "chai";
import {
  callLLM,
  callLLMStream,
  resolveOllamaNumCtx,
} from "../src/utils/llmClient";
import type { OutputRequestPolicy } from "../src/utils/outputTokenPolicy";
import {
  resolveOllamaNativeApiRoot,
  resolveOllamaNativeEndpoint,
  resolveProviderTransportEndpoint,
  buildProviderAuthHeaders,
} from "../src/utils/providerTransport";
import { detectProviderPreset } from "../src/utils/providerPresets";
import { PAPER_CITATION_CONTRACT } from "../src/shared/instructionContracts";

describe("ollama native protocol", function () {
  const originalZotero = globalThis.Zotero;
  const originalToolkit = (
    globalThis as typeof globalThis & { ztoolkit?: unknown }
  ).ztoolkit;

  /** NDJSON framing: one complete JSON object per line, no `data:` prefix. */
  function makeNdjsonStream(chunks: string[]): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
  }

  function mockFetch(
    handler: (url: string, init?: RequestInit) => Promise<unknown>,
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

  beforeEach(function () {
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

  after(function () {
    (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
      originalZotero;
    (
      globalThis as typeof globalThis & { ztoolkit?: typeof originalToolkit }
    ).ztoolkit = originalToolkit;
  });

  describe("endpoint resolution", function () {
    it("appends /api/chat to a bare origin", function () {
      assert.equal(
        resolveOllamaNativeEndpoint("http://localhost:11434"),
        "http://localhost:11434/api/chat",
      );
    });

    it("strips a pasted /v1 rather than producing /v1/api/chat", function () {
      assert.equal(
        resolveOllamaNativeEndpoint("http://localhost:11434/v1"),
        "http://localhost:11434/api/chat",
      );
    });

    it("does not double up when the base already names /api/chat", function () {
      assert.equal(
        resolveOllamaNativeEndpoint("http://localhost:11434/api/chat"),
        "http://localhost:11434/api/chat",
      );
    });

    it("preserves a reverse-proxy path prefix", function () {
      assert.equal(
        resolveOllamaNativeEndpoint("https://gpu.lan/ollama"),
        "https://gpu.lan/ollama/api/chat",
      );
      assert.equal(
        resolveOllamaNativeApiRoot("https://gpu.lan/ollama"),
        "https://gpu.lan/ollama/api",
      );
    });

    it("routes through the shared transport resolver", function () {
      assert.equal(
        resolveProviderTransportEndpoint({
          protocol: "ollama_native",
          apiBase: "http://localhost:11434",
        }),
        "http://localhost:11434/api/chat",
      );
    });
  });

  describe("headers", function () {
    it("omits Authorization when no key is configured", function () {
      const headers = buildProviderAuthHeaders({
        protocol: "ollama_native",
        apiKey: "",
      });
      assert.deepEqual(headers, { "Content-Type": "application/json" });
    });

    it("sends a bearer token when the server is behind a proxy that needs one", function () {
      const headers = buildProviderAuthHeaders({
        protocol: "ollama_native",
        apiKey: "proxy-secret",
      });
      assert.equal(headers.Authorization, "Bearer proxy-secret");
    });
  });

  describe("preset detection", function () {
    it("claims the default Ollama port", function () {
      assert.equal(detectProviderPreset("http://localhost:11434"), "ollama");
      assert.equal(detectProviderPreset("http://127.0.0.1:11434/v1"), "ollama");
    });

    it("claims a local base that names an /api path on a custom port", function () {
      assert.equal(detectProviderPreset("http://localhost:8081/api"), "ollama");
    });

    it("leaves other local ports to the generic local preset", function () {
      assert.equal(
        detectProviderPreset("http://localhost:1234/v1"),
        "local_openai",
      );
      assert.equal(
        detectProviderPreset("http://192.168.1.50:8000/v1"),
        "local_openai",
      );
    });

    it("does not claim hosted providers", function () {
      assert.equal(
        detectProviderPreset("https://api.openai.com/v1/responses"),
        "openai",
      );
      assert.equal(
        detectProviderPreset("https://api.anthropic.com/v1"),
        "anthropic",
      );
    });
  });

  describe("streaming", function () {
    it("separates message.thinking from message.content", async function () {
      const reasoning: string[] = [];
      const deltas: string[] = [];
      mockFetch(async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        body: makeNdjsonStream([
          '{"message":{"role":"assistant","thinking":"Let me think. "},"done":false}\n',
          '{"message":{"role":"assistant","thinking":"Canberra it is."},"done":false}\n',
          '{"message":{"role":"assistant","content":"The capital "},"done":false}\n',
          '{"message":{"role":"assistant","content":"is Canberra."},"done":true,"done_reason":"stop","prompt_eval_count":11,"eval_count":18}\n',
        ]),
        json: async () => ({}),
        text: async () => "",
      }));

      const text = await callLLMStream(
        {
          prompt: "What is the capital of Australia?",
          model: "gemma3",
          apiBase: "http://localhost:11434",
          providerProtocol: "ollama_native",
        },
        (delta) => deltas.push(delta),
        (event) => reasoning.push(event.details || ""),
      );

      assert.equal(text.text, "The capital is Canberra.");
      assert.deepEqual(deltas, ["The capital ", "is Canberra."]);
      assert.equal(reasoning.join(""), "Let me think. Canberra it is.");
    });

    it("reports usage from the final chunk", async function () {
      let usage: { promptTokens: number; completionTokens: number } | null =
        null;
      mockFetch(async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        body: makeNdjsonStream([
          '{"message":{"content":"hi"},"done":true,"prompt_eval_count":7,"eval_count":3}\n',
        ]),
        json: async () => ({}),
        text: async () => "",
      }));

      await callLLMStream(
        {
          prompt: "hi",
          model: "qwen3:8b",
          apiBase: "http://localhost:11434",
          providerProtocol: "ollama_native",
        },
        () => undefined,
        undefined,
        (stats) => {
          usage = stats;
        },
      );

      assert.isNotNull(usage);
      assert.equal(usage!.promptTokens, 7);
      assert.equal(usage!.completionTokens, 3);
    });

    it("preserves partial text when done_reason reports a length cutoff", async function () {
      mockFetch(async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        body: makeNdjsonStream([
          '{"message":{"content":"Partial answer"},"done":true,"done_reason":"length"}\n',
        ]),
        json: async () => ({}),
        text: async () => "",
      }));

      const outcome = await callLLMStream(
        {
          prompt: "hi",
          model: "qwen3:8b",
          apiBase: "http://localhost:11434",
          providerProtocol: "ollama_native",
        },
        () => undefined,
      );

      assert.equal(outcome.text, "Partial answer");
      assert.deepEqual(outcome.completion, {
        status: "incomplete",
        reason: "output_limit",
        providerReason: "length",
      });
    });

    it("handles a JSON object split across chunk boundaries", async function () {
      const deltas: string[] = [];
      mockFetch(async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        body: makeNdjsonStream([
          '{"message":{"content":"split ',
          'across"},"done":false}\n{"message":{"content":" chunks"},"done":true}\n',
        ]),
        json: async () => ({}),
        text: async () => "",
      }));

      const text = await callLLMStream(
        {
          prompt: "x",
          model: "qwen3:8b",
          apiBase: "http://localhost:11434",
          providerProtocol: "ollama_native",
        },
        (delta) => deltas.push(delta),
      );

      assert.equal(text.text, "split across chunks");
    });

    it("flushes a final object that arrives without a trailing newline", async function () {
      mockFetch(async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        body: makeNdjsonStream([
          '{"message":{"content":"no trailing newline"},"done":true}',
        ]),
        json: async () => ({}),
        text: async () => "",
      }));

      const text = await callLLMStream(
        {
          prompt: "x",
          model: "qwen3:8b",
          apiBase: "http://localhost:11434",
          providerProtocol: "ollama_native",
        },
        () => undefined,
      );

      assert.equal(text.text, "no trailing newline");
    });

    it("keeps multibyte characters intact across chunk boundaries", async function () {
      const encoder = new TextEncoder();
      const full = encoder.encode(
        '{"message":{"content":"思考中"},"done":true}\n',
      );
      // The JSON prefix is 23 bytes, so 思 occupies bytes 23-25. Cutting at 24
      // lands inside that codepoint, which is what the decoder must buffer.
      const cut = 24;
      mockFetch(async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(full.slice(0, cut));
            controller.enqueue(full.slice(cut));
            controller.close();
          },
        }),
        json: async () => ({}),
        text: async () => "",
      }));

      const text = await callLLMStream(
        {
          prompt: "x",
          model: "qwen3:8b",
          apiBase: "http://localhost:11434",
          providerProtocol: "ollama_native",
        },
        () => undefined,
      );

      assert.equal(text.text, "思考中");
    });
  });

  describe("request payload", function () {
    it("posts to /api/chat with unlimited num_predict by default", async function () {
      let capturedUrl = "";
      let body: Record<string, unknown> = {};
      mockFetch(async (url, init) => {
        capturedUrl = url;
        body = JSON.parse(String(init?.body || "{}")) as Record<
          string,
          unknown
        >;
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          body: makeNdjsonStream([
            '{"message":{"content":"ok"},"done":true}\n',
          ]),
          json: async () => ({}),
          text: async () => "",
        };
      });

      await callLLMStream(
        {
          prompt: "hi",
          model: "gemma3",
          apiBase: "http://localhost:11434",
          providerProtocol: "ollama_native",
        },
        () => undefined,
      );

      assert.equal(capturedUrl, "http://localhost:11434/api/chat");
      assert.equal(body.model, "gemma3");
      assert.equal(body.stream, true);
      const serializedMessages = (body.messages as Array<{ content?: string }>)
        .map((message) => message.content || "")
        .join("\n");
      assert.equal(
        serializedMessages.split(PAPER_CITATION_CONTRACT).length - 1,
        1,
      );
      // The plugin's 8192 default would let a thinking model spend the whole
      // budget reasoning and return empty content.
      assert.equal(
        (body.options as Record<string, unknown>)?.num_predict,
        -1,
        "untouched default must defer to Ollama's own unlimited default",
      );
    });

    it("merges user options.* instead of replacing the whole options object", async function () {
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
          body: makeNdjsonStream([
            '{"message":{"content":"ok"},"done":true}\n',
          ]),
          json: async () => ({}),
          text: async () => "",
        };
      });

      await callLLMStream(
        {
          prompt: "hi",
          model: "qwen3:8b",
          apiBase: "http://localhost:11434",
          providerProtocol: "ollama_native",
          profileOverride: {
            forModel: "qwen3:8b",
            extraBody: { options: { repeat_penalty: 1.1 } },
          },
        },
        () => undefined,
      );

      const options = body.options as Record<string, unknown>;
      assert.equal(options.repeat_penalty, 1.1, "the user parameter arrives");
      assert.equal(
        options.num_predict,
        -1,
        "a user options.* entry must not drop num_predict",
      );
      assert.isNumber(
        options.num_ctx,
        "losing num_ctx silently reinstates context truncation",
      );
      assert.isNumber(options.temperature);
    });

    /** Run one streaming chat request and return the options it sent. */
    async function captureChatOptions(
      params: Parameters<typeof callLLMStream>[0],
    ): Promise<Record<string, unknown>> {
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
          body: makeNdjsonStream([
            '{"message":{"content":"ok"},"done":true}\n',
          ]),
          json: async () => ({}),
          text: async () => "",
        };
      });
      await callLLMStream(params, () => undefined);
      return (body.options as Record<string, unknown>) || {};
    }

    it("treats an explicit input cap as a ceiling, not the num_ctx to allocate", async function () {
      const options = await captureChatOptions({
        prompt: "hi",
        model: "qwen3.8-max",
        apiBase: "http://localhost:11434",
        providerProtocol: "ollama_native",
        inputTokenCap: 1_000_000,
      });

      assert.isNumber(options.num_ctx);
      assert.isAtMost(
        options.num_ctx as number,
        16_384,
        "a short prompt must not pre-allocate the whole 1M-token cap",
      );
    });

    it("caps num_ctx at the model window for a long prompt", async function () {
      const options = await captureChatOptions({
        prompt: "word ".repeat(20_000),
        model: "qwen3:8b",
        apiBase: "http://localhost:11434",
        providerProtocol: "ollama_native",
        profileOverride: {
          forModel: "qwen3:8b",
          limits: { contextWindowTokens: 40_960 },
        },
      });

      assert.equal(options.num_ctx, 40_960);
    });

    it("sizes num_ctx to a mid-sized prompt within a large window", async function () {
      const options = await captureChatOptions({
        prompt: "word ".repeat(12_000),
        model: "qwen3:8b",
        apiBase: "http://localhost:11434",
        providerProtocol: "ollama_native",
        profileOverride: {
          forModel: "qwen3:8b",
          limits: { contextWindowTokens: 131_072 },
        },
      });

      assert.equal(options.num_ctx, 32_768);
    });

    it("clamps a custom output limit to the detected model maximum", async function () {
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
          body: makeNdjsonStream([
            '{"message":{"content":"ok"},"done":true}\n',
          ]),
          json: async () => ({}),
          text: async () => "",
        };
      });

      await callLLMStream(
        {
          prompt: "hi",
          model: "qwen3.8-max",
          apiBase: "http://localhost:11434",
          providerProtocol: "ollama_native",
          outputTokenLimit: { mode: "custom", tokens: 200_000 },
          profileOverride: {
            forModel: "qwen3.8-max",
            limits: { outputTokens: 64_000 },
          },
        },
        () => undefined,
      );

      assert.equal(
        (body.options as Record<string, unknown>)?.num_predict,
        64_000,
      );
    });

    it("preserves an explicit 4096-token choice", async function () {
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
          body: makeNdjsonStream([
            '{"message":{"content":"ok"},"done":true}\n',
          ]),
          json: async () => ({}),
          text: async () => "",
        };
      });

      await callLLMStream(
        {
          prompt: "hi",
          model: "gemma3",
          apiBase: "http://localhost:11434",
          providerProtocol: "ollama_native",
          outputTokenLimit: { mode: "custom", tokens: 4096 },
        },
        () => undefined,
      );

      assert.equal(
        (body.options as Record<string, unknown>)?.num_predict,
        4096,
      );
    });
  });

  describe("num_ctx sizing", function () {
    const unlimited: OutputRequestPolicy = {
      mode: "unlimited",
      source: "auto_provider",
    };

    function numCtx(
      estimatedPromptTokens: number,
      contextWindowTokens: number,
      outputPolicy: OutputRequestPolicy = unlimited,
    ) {
      return resolveOllamaNumCtx({
        protocol: "ollama_native",
        estimatedPromptTokens,
        outputPolicy,
        contextWindowTokens,
      });
    }

    it("allocates a small tier for a short prompt", function () {
      assert.equal(numCtx(1_500, 40_960), 8_192);
    });

    it("rounds a larger prompt up to the next power-of-two tier", function () {
      assert.equal(numCtx(20_000, 40_960 * 4), 32_768);
    });

    it("never exceeds the resolved context window", function () {
      assert.equal(numCtx(60_000, 40_960), 40_960);
    });

    it("does not allocate the 256K default window for a short prompt", function () {
      assert.equal(numCtx(1_500, 256_000), 8_192);
    });

    it("reserves a custom output limit inside num_ctx", function () {
      const custom: OutputRequestPolicy = {
        mode: "numeric",
        tokens: 32_768,
        source: "custom",
      };
      assert.equal(numCtx(1_500, 256_000, custom), 65_536);
      assert.equal(numCtx(1_500, 40_960, custom), 40_960);
    });

    it("uses the auto reserve for a capability-ceiling output policy", function () {
      const ceiling: OutputRequestPolicy = {
        mode: "numeric",
        tokens: 64_000,
        source: "auto_capability",
      };
      assert.equal(numCtx(1_500, 256_000, ceiling), 8_192);
    });

    it("returns an explicit window below the minimum tier as-is", function () {
      assert.equal(numCtx(1_500, 2_048), 2_048);
    });

    it("sends nothing for other protocols", function () {
      assert.isUndefined(
        resolveOllamaNumCtx({
          protocol: "openai_chat_compat",
          estimatedPromptTokens: 1_500,
          outputPolicy: unlimited,
          contextWindowTokens: 40_960,
        }),
      );
    });

    it("rounds at the tier boundary", function () {
      // need = ceil(prompt * 1.2) + 4096
      assert.equal(numCtx(0, 256_000), 4_096);
      assert.equal(numCtx(3_413, 256_000), 8_192, "need exactly 8192");
      assert.equal(numCtx(3_414, 256_000), 16_384, "need 8193");
    });

    it("tolerates non-finite inputs", function () {
      assert.equal(numCtx(Number.NaN, 40_960), 4_096);
      assert.equal(numCtx(1_500, Number.NaN), 8_192);
      assert.equal(numCtx(1_500, 0), 8_192);
    });
  });

  describe("non-streaming", function () {
    it("returns message.content", async function () {
      mockFetch(async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          message: { role: "assistant", content: "Canberra" },
          done: true,
        }),
        text: async () => "",
      }));

      const text = await callLLM({
        prompt: "capital?",
        model: "gemma3",
        apiBase: "http://localhost:11434",
        providerProtocol: "ollama_native",
      });

      assert.equal(text.text, "Canberra");
    });

    it("does not promote reasoning into the answer when content is empty", async function () {
      // The #363 shape. The answer stays empty: a server putting the answer in
      // the reasoning field is the server's bug, and silently promoting it
      // would hide the misconfiguration.
      mockFetch(async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          message: {
            role: "assistant",
            content: "",
            thinking: "The user is asking... The capital is Canberra.",
          },
          done: true,
        }),
        text: async () => "",
      }));

      const text = await callLLM({
        prompt: "capital?",
        model: "gemma4",
        apiBase: "http://localhost:11434",
        providerProtocol: "ollama_native",
      });

      assert.equal(text.text, "");
    });
  });
});
