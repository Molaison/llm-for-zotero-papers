import { assert } from "chai";
import type { ChatParams, ModelTurnOutcome } from "../src/utils/llmClient";
import { parseResponsesStream } from "../src/utils/llmClient";
import {
  appendContinuationText,
  callDirectChatTurnWithRecovery,
  EMPTY_OUTPUT_LIMIT_MESSAGE,
  resolveDirectChatResponseText,
  resolveEmptyModelOutcomeMessage,
} from "../src/modules/contextPanel/directChatCompletion";

describe("direct chat completion recovery", function () {
  const baseRequest: ChatParams = {
    prompt: "Explain the paper.",
    history: [{ role: "assistant", content: "Earlier answer." }],
    model: "gpt-5.4",
    apiBase: "https://api.openai.com/v1/responses",
    apiKey: "test",
    providerProtocol: "responses_api",
    outputTokenLimit: { mode: "auto" },
  };

  it("preserves a visible partial response without silently retrying", async function () {
    let calls = 0;
    const result = await callDirectChatTurnWithRecovery({
      request: baseRequest,
      onDelta: () => undefined,
      call: async () => {
        calls += 1;
        return {
          text: "Visible partial answer",
          completion: {
            status: "incomplete",
            reason: "output_limit",
            providerReason: "max_output_tokens",
          },
        };
      },
    });

    assert.equal(calls, 1);
    assert.equal(result.text, "Visible partial answer");
    assert.equal(result.completion.status, "incomplete");
  });

  it("automatically continues a zero-text output cutoff exactly once", async function () {
    const requests: ChatParams[] = [];
    const outcomes: ModelTurnOutcome[] = [
      {
        text: "",
        completion: {
          status: "incomplete",
          reason: "output_limit",
          providerReason: "max_output_tokens",
        },
        continuationState: { responseId: "resp_123" },
      },
      { text: "Recovered answer", completion: { status: "complete" } },
    ];

    const result = await callDirectChatTurnWithRecovery({
      request: baseRequest,
      onDelta: () => undefined,
      call: async (request) => {
        requests.push(request);
        return outcomes[requests.length - 1]!;
      },
    });

    assert.lengthOf(requests, 2);
    assert.equal(result.text, "Recovered answer");
    assert.deepEqual(requests[1]?.continuationState, {
      responseId: "resp_123",
    });
    assert.isUndefined(requests[1]?.context);
    assert.isUndefined(requests[1]?.attachments);
  });

  it("surfaces the specific reasoning-only diagnostic after the one retry", async function () {
    let calls = 0;
    const result = await callDirectChatTurnWithRecovery({
      request: baseRequest,
      onDelta: () => undefined,
      call: async () => {
        calls += 1;
        return {
          text: "",
          completion: {
            status: "incomplete",
            reason: "output_limit",
            providerReason: "length",
          },
        };
      },
    });

    assert.equal(calls, 2);
    assert.equal(
      resolveEmptyModelOutcomeMessage(result.completion),
      EMPTY_OUTPUT_LIMIT_MESSAGE,
    );
    assert.notInclude(EMPTY_OUTPUT_LIMIT_MESSAGE, "No response");
  });

  it("appends continuation text without duplicating an overlapping prefix", function () {
    assert.equal(
      appendContinuationText("First paragraph. Shared", "Shared ending."),
      "First paragraph. Shared ending.",
    );
    assert.equal(
      appendContinuationText("First paragraph.", "First paragraph. Second."),
      "First paragraph. Second.",
    );
  });

  it("keeps non-output terminal causes distinct", function () {
    assert.include(
      resolveEmptyModelOutcomeMessage({
        status: "incomplete",
        reason: "context_limit",
      }),
      "context window",
    );
    assert.include(
      resolveEmptyModelOutcomeMessage({
        status: "blocked",
        reason: "safety",
      }),
      "safety",
    );
    assert.include(
      resolveEmptyModelOutcomeMessage({
        status: "blocked",
        reason: "refusal",
      }),
      "refused",
    );
  });

  it("uses the final Responses text to replace a streamed draft, including an empty answer", async function () {
    for (const finalText of ["corrected answer", ""]) {
      let streamedText = "";
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              [
                { type: "response.output_text.delta", delta: "draft" },
                {
                  type: "response.completed",
                  response: { status: "completed", output_text: finalText },
                },
              ]
                .map((event) => `data: ${JSON.stringify(event)}\n\n`)
                .join(""),
            ),
          );
          controller.close();
        },
      });
      const outcome = await parseResponsesStream(body, (delta) => {
        streamedText += delta;
      });
      assert.equal(streamedText, "draft");
      const visibleText = resolveDirectChatResponseText(outcome, streamedText);
      assert.equal(visibleText, finalText);
      if (!finalText) {
        assert.equal(
          visibleText || resolveEmptyModelOutcomeMessage(outcome.completion),
          "The model completed without producing visible text.",
        );
      }
    }
  });

  it("preserves document output and incomplete stream evidence when no final text is returned", function () {
    const complete: ModelTurnOutcome = {
      text: "",
      completion: { status: "complete" },
    };
    const incomplete: ModelTurnOutcome = {
      text: "",
      completion: { status: "incomplete", reason: "stream_interrupted" },
    };
    assert.equal(
      resolveDirectChatResponseText(complete, "document content", true),
      "document content",
    );
    assert.equal(
      resolveDirectChatResponseText(incomplete, "partial answer"),
      "partial answer",
    );
  });
});
