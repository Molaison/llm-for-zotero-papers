import { assert } from "chai";
import {
  getOutputCapRecovery,
  normalizeProviderCompletion,
  parseResponsesStream,
  parseStreamResponse,
} from "../src/utils/llmClient";

function makeSseStream(events: unknown[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const event of events) {
        controller.enqueue(
          encoder.encode(
            `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`,
          ),
        );
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

describe("LLM terminal outcome normalization", function () {
  it("maps provider terminal reasons without conflating their causes", function () {
    assert.deepEqual(normalizeProviderCompletion("length"), {
      status: "incomplete",
      reason: "output_limit",
      providerReason: "length",
    });
    assert.deepEqual(normalizeProviderCompletion("MAX_TOKENS"), {
      status: "incomplete",
      reason: "output_limit",
      providerReason: "MAX_TOKENS",
    });
    assert.deepEqual(
      normalizeProviderCompletion("model_context_window_exceeded"),
      {
        status: "incomplete",
        reason: "context_limit",
        providerReason: "model_context_window_exceeded",
      },
    );
    assert.deepEqual(normalizeProviderCompletion("pause_turn"), {
      status: "incomplete",
      reason: "provider_pause",
      providerReason: "pause_turn",
    });
    assert.deepEqual(normalizeProviderCompletion("content_filter"), {
      status: "blocked",
      reason: "safety",
      providerReason: "content_filter",
    });
    assert.deepEqual(normalizeProviderCompletion("refusal"), {
      status: "blocked",
      reason: "refusal",
      providerReason: "refusal",
    });
    assert.deepEqual(normalizeProviderCompletion("MALFORMED_FUNCTION_CALL"), {
      status: "blocked",
      reason: "malformed_tool_call",
      providerReason: "MALFORMED_FUNCTION_CALL",
    });
    assert.deepEqual(
      normalizeProviderCompletion(undefined, { responseStatus: "failed" }),
      {
        status: "blocked",
        reason: "other",
        providerReason: "failed",
      },
    );
  });

  it("preserves partial Chat Completions text and marks finish_reason length incomplete", async function () {
    const deltas: string[] = [];
    const outcome = await parseStreamResponse(
      makeSseStream([
        { choices: [{ delta: { content: "Partial answer" } }] },
        { choices: [{ delta: {}, finish_reason: "length" }] },
      ]),
      (delta) => deltas.push(delta),
    );

    assert.equal(outcome.text, "Partial answer");
    assert.equal(deltas.join(""), "Partial answer");
    assert.deepEqual(outcome.completion, {
      status: "incomplete",
      reason: "output_limit",
      providerReason: "length",
    });
  });

  for (const withPartialText of [false, true]) {
    it(`rejects a Chat SSE error ${withPartialText ? "after partial text and a stop reason" : "without visible text"} with UI-visible provider details`, async function () {
      const error = {
        message:
          "The gateway could not project the upstream response to Chat Completions.",
        code: "invalid_upstream_response",
        type: "server_error",
        private: "private-upstream-debug-token",
      };
      const deltas: string[] = [];
      const body = makeSseStream([
        ...(withPartialText
          ? [
              {
                choices: [
                  {
                    delta: { content: "Partial answer" },
                    finish_reason: "stop",
                  },
                ],
              },
            ]
          : []),
        { choices: [{ delta: {}, finish_reason: null }], error },
      ]);
      let failure: unknown;
      try {
        await parseStreamResponse(body, (delta) => deltas.push(delta));
      } catch (err) {
        failure = err;
      }

      assert.instanceOf(
        failure,
        Error,
        "must reject rather than return an outcome",
      );
      for (const detail of [error.message, error.code, error.type]) {
        assert.include((failure as Error).message, detail);
      }
      assert.notInclude((failure as Error).message, "private");
      assert.notInclude((failure as Error).message, error.private);
      assert.notProperty(failure, "private");
      assert.propertyVal(failure, "code", error.code);
      assert.propertyVal(failure, "type", error.type);
      assert.equal(deltas.join(""), withPartialText ? "Partial answer" : "");
      assert.isFalse(body.locked, "release the reader on failure");
    });
  }

  it("still skips malformed Chat SSE JSON before valid answer frames", async function () {
    const deltas: string[] = [];
    const outcome = await parseStreamResponse(
      makeSseStream([
        '{"choices":',
        { choices: [{ delta: { content: "Answer" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]),
      (delta) => deltas.push(delta),
    );

    assert.equal(outcome.text, "Answer");
    assert.equal(deltas.join(""), "Answer");
    assert.equal(outcome.completion.status, "complete");
  });

  it("does not let malformed JSON hide a later structured Chat SSE error", async function () {
    for (const error of [
      { message: "Upstream failed", code: 502, type: "server_error" },
      { code: 502, type: "server_error" },
      {
        message: { private: "private-message" },
        code: { private: "private-code" },
        type: { private: "private-type" },
      },
    ]) {
      let failure: unknown;
      try {
        await parseStreamResponse(
          makeSseStream(['{"choices":', { error }]),
          () => undefined,
        );
      } catch (err) {
        failure = err;
      }

      assert.instanceOf(failure, Error);
      const hasValidCode = typeof error.code === "number";
      assert.equal(
        (failure as Error).message,
        `Chat Completions stream error: ${
          typeof error.message === "string"
            ? error.message
            : "Chat Completions stream failed."
        }${hasValidCode ? "; code=502; type=server_error" : ""}`,
      );
      assert.propertyVal(failure, "code", hasValidCode ? 502 : undefined);
      assert.propertyVal(
        failure,
        "type",
        hasValidCode ? "server_error" : undefined,
      );
      assert.notInclude((failure as Error).message, "private");
    }
  });

  it("preserves Responses continuation state for a reasoning-only cutoff", async function () {
    const outcome = await parseResponsesStream(
      makeSseStream([
        {
          type: "response.reasoning_summary.delta",
          delta: "Private progress summary",
          response: { id: "resp_456" },
        },
        {
          type: "response.incomplete",
          response: {
            id: "resp_456",
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
          },
        },
      ]),
      () => undefined,
    );

    assert.equal(outcome.text, "");
    assert.deepEqual(outcome.completion, {
      status: "incomplete",
      reason: "output_limit",
      providerReason: "max_output_tokens",
    });
    assert.deepEqual(outcome.continuationState, { responseId: "resp_456" });
  });
});

describe("output cap rejection recovery", function () {
  const openaiUrl = "https://api.deepseek.com/v1/chat/completions";
  const anthropicUrl = "https://api.anthropic.com/v1/messages";

  it("takes the provider's stated maximum from several phrasings", function () {
    for (const message of [
      "Invalid max_tokens value, the valid range of max_tokens is [1, 8192]",
      "`max_tokens` must be less than or equal to `8192`",
      "max_tokens is too large: 384000. This model supports at most 8192 completion tokens, whereas you provided 384000.",
      "max_tokens: 384000 > 8192, which is the maximum allowed number of output tokens for this model",
    ]) {
      assert.deepEqual(
        getOutputCapRecovery({
          status: 400,
          message: `400 Bad Request (${openaiUrl}) - {"error":{"message":"${message}","code":400}}`,
          url: openaiUrl,
          requested: 384_000,
        }),
        { mode: "fixed", value: 8_192, scope: "endpoint" },
        message,
      );
    }
  });

  it("omits the cap for OpenAI-compatible providers that reject it without a number", function () {
    assert.deepEqual(
      getOutputCapRecovery({
        status: 400,
        message:
          '{"error":{"message":"Unsupported parameter: max_tokens","code":400}}',
        url: openaiUrl,
        requested: 384_000,
      }),
      { mode: "omit", scope: "endpoint" },
    );
  });

  it("falls back to the compatibility seed for Anthropic, which requires max_tokens", function () {
    assert.deepEqual(
      getOutputCapRecovery({
        status: 400,
        message:
          '{"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: unsupported value"}}',
        url: anthropicUrl,
        requested: 128_000,
      }),
      { mode: "fixed", value: 8_192, scope: "endpoint" },
    );
  });

  it("derives the room left from an Anthropic context-limit rejection", function () {
    assert.deepEqual(
      getOutputCapRecovery({
        status: 400,
        message:
          '{"error":{"message":"input length and max_tokens exceed context limit: 150000 + 64000 > 200000, decrease input length or max_tokens and try again"}}',
        url: anthropicUrl,
        requested: 64_000,
      }),
      // Derived from this prompt's size, so it must not be cached.
      { mode: "fixed", value: 200_000 - 150_000 - 1_024, scope: "request" },
    );
  });

  it("ignores unrelated errors and unrelated numbers", function () {
    assert.isNull(
      getOutputCapRecovery({
        status: 500,
        message: "max_tokens exploded 8192",
        url: openaiUrl,
        requested: 384_000,
      }),
    );
    assert.isNull(
      getOutputCapRecovery({
        status: 400,
        message: '{"error":{"message":"temperature must be 1","code":400}}',
        url: openaiUrl,
        requested: 384_000,
      }),
    );
  });
});
