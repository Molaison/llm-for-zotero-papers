import { assert } from "chai";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { OpenAICompatibleAgentAdapter } from "../src/agent/model/openaiCompatible";
import { AnthropicMessagesAgentAdapter } from "../src/agent/model/anthropicMessages";
import type { AgentStepParams } from "../src/agent/model/adapter";
import { isMalformedToolArgumentsDiagnostic } from "../src/agent/toolArgumentDiagnostics";

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

const protocols = [
  {
    name: "OpenAI-compatible",
    createAdapter: () => new OpenAICompatibleAgentAdapter(),
    request: {
      model: "deepseek-v4-pro",
      apiBase: "https://api.deepseek.com/v1",
      providerProtocol: "openai_chat_compat" as const,
    },
    text: sse({ choices: [{ delta: { content: "Read the methods." } }] }),
    reasoning: sse({
      choices: [{ delta: { reasoning_content: "Check the paper." } }],
    }),
    tool: (args: string) =>
      sse({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_read",
                  function: { name: "read_paper", arguments: args },
                },
              ],
            },
          },
        ],
      }),
    finish: (reason = "tool_calls") =>
      sse({ choices: [{ delta: {}, finish_reason: reason }] }),
    outputLimit: "length",
    usage: sse({
      choices: [],
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
    }),
    terminal: "data: [DONE]\n\n",
  },
  {
    name: "Anthropic-compatible",
    createAdapter: () => new AnthropicMessagesAgentAdapter(),
    request: {
      model: "claude-sonnet-4-5",
      apiBase: "https://api.anthropic.com/v1",
      providerProtocol: "anthropic_messages" as const,
    },
    text:
      sse({
        type: "content_block_start",
        index: 1,
        content_block: { type: "text", text: "" },
      }) +
      sse({
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "Read the methods." },
      }) +
      sse({ type: "content_block_stop", index: 1 }),
    reasoning:
      sse({
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      }) +
      sse({
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Check the paper." },
      }) +
      sse({
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "sig-test" },
      }) +
      sse({ type: "content_block_stop", index: 0 }),
    tool: (args: string) =>
      sse({
        type: "content_block_start",
        index: 2,
        content_block: {
          type: "tool_use",
          id: "call_read",
          name: "read_paper",
          input: {},
        },
      }) +
      sse({
        type: "content_block_delta",
        index: 2,
        delta: { type: "input_json_delta", partial_json: args },
      }) +
      sse({ type: "content_block_stop", index: 2 }),
    finish: (reason = "tool_use") =>
      sse({ type: "message_delta", delta: { stop_reason: reason } }),
    outputLimit: "max_tokens",
    usage: "",
    terminal: 'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  },
];

function startStep(
  protocol: (typeof protocols)[number],
  callbacks: Partial<AgentStepParams> = {},
) {
  return protocol.createAdapter().runStep({
    request: {
      conversationKey: 1,
      mode: "agent",
      userText: "Read the methods",
      apiKey: "synthetic-test-key",
      ...protocol.request,
    },
    messages: [{ role: "user", content: "Read the methods" }],
    tools: [
      {
        name: "read_paper",
        description: "Read paper",
        inputSchema: { type: "object" },
        executionClass: "read",
        requiresConfirmation: false,
      },
    ],
    ...callbacks,
  });
}

async function withinDeadline<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Adapter waited after the terminal event")),
          1000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function openStream(
  chunks: string[],
  cancel: () => void | Promise<void> = () => {},
) {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      for (const chunk of chunks)
        value.enqueue(new TextEncoder().encode(chunk));
    },
    cancel() {
      cancelled = true;
      return cancel();
    },
  });
  return {
    body,
    get cancelled() {
      return cancelled;
    },
    close() {
      if (!cancelled) controller.close();
    },
  };
}

describe("Agent stream completion", function () {
  const originalToolkit = (globalThis as any).ztoolkit;

  afterEach(function () {
    (globalThis as any).ztoolkit = originalToolkit;
  });

  function useFetch(fetch: typeof globalThis.fetch) {
    (globalThis as any).ztoolkit = {
      log: () => {},
      getGlobal: (name: string) => (name === "fetch" ? fetch : undefined),
    };
  }

  function useStream(body: ReadableStream<Uint8Array>) {
    useFetch(
      async () =>
        new Response(body, {
          headers: { "content-type": "text/event-stream" },
        }),
    );
  }

  for (const protocol of protocols) {
    describe(protocol.name, function () {
      for (const newline of ["\n", "\r\n"]) {
        it(`returns a complete tool call with a split terminal marker (${JSON.stringify(newline)})`, async function () {
          const terminal = protocol.terminal.replaceAll("\n", newline);
          const prefix = (
            protocol.reasoning +
            protocol.text +
            protocol.tool('{"query":"methods"}') +
            protocol.finish() +
            protocol.usage
          ).replaceAll("\n", newline);
          const stream = openStream(
            [
              prefix + terminal.slice(0, -4),
              terminal.slice(-4) + protocol.text.replaceAll("\n", newline),
            ],
            () => new Promise<void>(() => {}),
          );
          useStream(stream.body);
          const text: string[] = [];
          const reasoning: string[] = [];
          const usage: unknown[] = [];
          try {
            const step = await withinDeadline(
              startStep(protocol, {
                onTextDelta: async (delta) => {
                  text.push(delta);
                },
                onReasoning: async (event) => {
                  if (event.details) reasoning.push(event.details);
                },
                onUsage: async (value) => {
                  usage.push(value);
                },
              }),
            );
            assert.equal(step.kind, "tool_calls");
            if (step.kind !== "tool_calls") return;
            assert.deepEqual(step.calls, [
              {
                id: "call_read",
                name: "read_paper",
                arguments: { query: "methods" },
              },
            ]);
            assert.equal(step.assistantMessage.content, "Read the methods.");
            assert.deepEqual(text, ["Read the methods."]);
            assert.deepEqual(reasoning, ["Check the paper."]);
            if (protocol.usage)
              assert.containSubset(usage, [
                { promptTokens: 12, completionTokens: 8, totalTokens: 20 },
              ]);
            assert.isTrue(
              stream.cancelled,
              "remaining body consumption must be cancelled",
            );
            assert.isFalse(
              stream.body.locked,
              "cleanup must not wait for cancellation to settle",
            );
          } finally {
            stream.close();
          }
        });
      }

      it("returns the final answer even if body cancellation rejects", async function () {
        const stream = openStream(
          [protocol.text + protocol.terminal + protocol.text],
          () => Promise.reject(new Error("Transport cleanup failed")),
        );
        useStream(stream.body);
        try {
          const step = await withinDeadline(startStep(protocol));
          assert.equal(step.kind, "final");
          if (step.kind === "final")
            assert.equal(step.text, "Read the methods.");
          assert.isTrue(stream.cancelled);
          assert.isFalse(stream.body.locked);
        } finally {
          stream.close();
        }
      });

      it("keeps output-limit tool calls incomplete at the terminal marker", async function () {
        const stream = openStream([
          protocol.tool('{"query":') +
            protocol.finish(protocol.outputLimit) +
            protocol.terminal,
        ]);
        useStream(stream.body);
        try {
          const step = await withinDeadline(startStep(protocol));
          assert.equal(step.kind, "incomplete");
          if (step.kind === "incomplete")
            assert.equal(step.reason, "output_limit");
          assert.notProperty(step, "calls");
          assert.notProperty(step.assistantMessage, "tool_calls");
          assert.isFalse(stream.body.locked);
        } finally {
          stream.close();
        }
      });

      it("retains malformed-argument rejection after terminal completion", async function () {
        const stream = openStream([
          protocol.tool('{"query":') + protocol.finish() + protocol.terminal,
        ]);
        useStream(stream.body);
        try {
          const step = await withinDeadline(startStep(protocol));
          assert.equal(step.kind, "tool_calls");
          if (step.kind === "tool_calls")
            assert.isTrue(
              isMalformedToolArgumentsDiagnostic(step.calls[0].arguments),
            );
          assert.isFalse(stream.body.locked);
        } finally {
          stream.close();
        }
      });

      it("preserves normal EOF completion without a terminal marker", async function () {
        const stream = openStream([protocol.text]);
        stream.close();
        useStream(stream.body);
        const step = await withinDeadline(startStep(protocol));
        assert.equal(step.kind, "final");
        if (step.kind === "final") assert.equal(step.text, "Read the methods.");
        assert.isFalse(stream.cancelled);
        assert.isFalse(stream.body.locked);
      });

      it("releases a tool call and cancels a real HTTP body left open after completion", async function () {
        let responseClosed: Promise<unknown> | undefined;
        let serverEndedBody = false;
        const server = createServer((request, response) => {
          request.resume();
          responseClosed = once(response, "close");
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write(
            protocol.tool('{"query":"methods"}') +
              protocol.finish() +
              protocol.terminal,
          );
          response.on("finish", () => {
            serverEndedBody = true;
          });
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/stream`;
        const controller = new AbortController();
        const fetch = globalThis.fetch;
        useFetch((_url, init) => fetch(url, init));
        try {
          const step = await withinDeadline(
            startStep(protocol, { signal: controller.signal }),
          );
          assert.equal(step.kind, "tool_calls");
          if (step.kind === "tool_calls")
            assert.deepEqual(step.calls[0].arguments, { query: "methods" });
          assert.isFalse(
            serverEndedBody,
            "the adapter must finish before the server ends the body",
          );
          assert.exists(responseClosed);
          await withinDeadline(responseClosed!);
        } finally {
          controller.abort();
          server.closeAllConnections();
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
        }
      });
    });
  }
});
