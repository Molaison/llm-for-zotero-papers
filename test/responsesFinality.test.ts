import { assert } from "chai";
import { parseResponsesStepStream } from "../src/agent/model/responsesShared";
import { CodexResponsesAgentAdapter } from "../src/agent/model/codexResponses";
import { parseResponsesStream } from "../src/utils/llmClient";

function stream(
  events: unknown[],
  keepOpen = false,
  onCancel?: () => void | Promise<void>,
) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const bytes = new TextEncoder().encode(
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
      );
      controller.enqueue(bytes.subarray(0, 17));
      controller.enqueue(bytes.subarray(17));
      if (!keepOpen) controller.close();
    },
    cancel() {
      return onCancel?.();
    },
  });
}

const tool = {
  id: "item-1",
  type: "function_call",
  call_id: "call-1",
  name: "write_note",
  arguments: '{"paperId":42}',
};
const completed = (output: unknown[] = []) => ({
  type: "response.completed",
  response: { id: "response-1", status: "completed", output },
});

describe("Responses terminal integrity", function () {
  for (const terminal of [
    {
      type: "response.failed",
      response: { status: "failed", error: { message: "disconnected" } },
    },
    { type: "error", error: { message: "disconnected" } },
    undefined,
  ]) {
    it(`withholds tools after ${terminal?.type || "EOF"}`, async function () {
      const events: unknown[] = [
        { type: "response.output_item.added", item: tool },
      ];
      if (terminal) events.push(terminal);
      const result = await parseResponsesStepStream(stream(events));
      assert.notEqual(result.completion.status, "complete");
      assert.deepEqual(result.toolCalls, []);
    });
  }

  it("withholds incomplete tool arguments without trying to execute or repair them", async function () {
    const result = await parseResponsesStepStream(
      stream([
        {
          type: "response.incomplete",
          response: {
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
            output: [{ ...tool, arguments: '{"paperId":' }],
          },
        },
      ]),
    );
    assert.equal(result.completion.status, "incomplete");
    assert.deepEqual(result.toolCalls, []);
  });

  it("uses completed arguments while retaining streamed-only reasoning metadata", async function () {
    const result = await parseResponsesStepStream(
      stream([
        {
          type: "response.output_item.added",
          item: { ...tool, arguments: "" },
        },
        {
          type: "response.output_item.added",
          item: {
            id: "reasoning-1",
            type: "reasoning",
            encrypted_content: "opaque",
          },
        },
        completed([tool, { id: "reasoning-1", type: "reasoning" }]),
      ]),
    );
    assert.deepEqual(result.toolCalls[0].arguments, { paperId: 42 });
    assert.deepInclude(result.outputItems[1], { encrypted_content: "opaque" });
  });

  it("rejects malformed completed tool arguments", async function () {
    let error: unknown;
    try {
      await parseResponsesStepStream(
        stream([completed([{ ...tool, arguments: '{"paperId":' }])]),
      );
    } catch (caught) {
      error = caught;
    }
    assert.instanceOf(error, Error);
  });

  it("never executes an added tool absent from the completed output", async function () {
    const result = await parseResponsesStepStream(
      stream([{ type: "response.output_item.added", item: tool }, completed()]),
    );
    assert.deepEqual(result.toolCalls, []);
    assert.deepEqual(result.outputItems, []);
  });

  it("never executes a done tool removed from the final output", async function () {
    const result = await parseResponsesStepStream(
      stream([{ type: "response.output_item.done", item: tool }, completed()]),
    );
    assert.deepEqual(result.toolCalls, []);
    assert.deepEqual(result.outputItems, []);
  });

  it("does not retain a streamed draft removed from the final output", async function () {
    const result = await parseResponsesStepStream(
      stream([
        {
          type: "response.output_item.done",
          item: {
            id: "draft",
            type: "message",
            content: [{ type: "output_text", text: "draft" }],
          },
        },
        completed(),
      ]),
    );
    assert.equal(result.text, "");
    assert.deepEqual(result.outputItems, []);
  });

  it("preserves a done tool when a compatible terminal omits its output array", async function () {
    const result = await parseResponsesStepStream(
      stream([
        { type: "response.output_item.done", item: tool },
        { type: "response.completed", response: { status: "completed" } },
      ]),
    );
    assert.deepEqual(result.toolCalls, [
      { id: "call-1", name: "write_note", arguments: { paperId: 42 } },
    ]);
  });

  for (const finalId of [undefined, "final-item"]) {
    it(`matches final tool identity by call_id when item id is ${finalId ? "changed" : "omitted"}`, async function () {
      const { id: _id, ...finalTool } = tool;
      const result = await parseResponsesStepStream(
        stream([
          {
            type: "response.output_item.done",
            item: { ...tool, arguments: '{"paperId":1}' },
          },
          completed([{ ...finalTool, ...(finalId ? { id: finalId } : {}) }]),
        ]),
      );
      assert.deepEqual(result.toolCalls, [
        { id: "call-1", name: "write_note", arguments: { paperId: 42 } },
      ]);
      assert.lengthOf(result.outputItems, 1);
    });
  }

  for (const args of [tool.arguments, '{"paperId":1}']) {
    it(`rejects ${args === tool.arguments ? "duplicate" : "conflicting"} final tool call identifiers`, async function () {
      let error: unknown;
      try {
        await parseResponsesStepStream(
          stream([
            completed([tool, { ...tool, id: "another-item", arguments: args }]),
          ]),
        );
      } catch (caught) {
        error = caught;
      }
      assert.instanceOf(error, Error);
      assert.include((error as Error).message, "tool call identifier");
    });
  }

  it("rejects a streamed item whose identities refer to two different final items", async function () {
    let error: unknown;
    try {
      await parseResponsesStepStream(
        stream([
          {
            type: "response.output_item.done",
            item: { ...tool, call_id: "call-2" },
          },
          completed([tool, { ...tool, id: "item-2", call_id: "call-2" }]),
        ]),
      );
    } catch (caught) {
      error = caught;
    }
    assert.instanceOf(error, Error);
    assert.include((error as Error).message, "conflicting final items");
  });

  it("keeps failure authoritative over stale incomplete metadata", async function () {
    const result = await parseResponsesStepStream(
      stream([
        {
          type: "response.failed",
          response: {
            status: "failed",
            incomplete_details: { reason: "stop" },
            output: [tool],
          },
        },
      ]),
    );
    assert.equal(result.completion.status, "blocked");
    assert.deepEqual(result.toolCalls, []);
  });

  for (const parser of ["agent", "chat"] as const) {
    const parse = (body: ReadableStream<Uint8Array>) =>
      parser === "agent"
        ? parseResponsesStepStream(body)
        : parseResponsesStream(body, () => {});

    it(`${parser} settles on completed while the connection remains open`, async function () {
      let cancelled = false;
      const body = stream(
        [
          {
            type: "response.completed",
            response: { status: "completed", output_text: "done" },
          },
        ],
        true,
        () => {
          cancelled = true;
        },
      );
      const result = await (parser === "agent"
        ? parseResponsesStepStream(body)
        : parseResponsesStream(body, () => {}));
      assert.equal(result.text, "done");
      assert.isTrue(cancelled);
    });

    it(`${parser} settles even when cancellation never settles`, async function () {
      const result = await parse(
        stream([completed()], true, () => new Promise(() => {})),
      );
      assert.equal(result.completion.status, "complete");
    });

    it(`${parser} keeps completed output when cancellation rejects`, async function () {
      const result = await parse(
        stream([completed()], true, async () => {
          throw new Error("cleanup failed");
        }),
      );
      assert.equal(result.completion.status, "complete");
    });

    it(`${parser} rejects a contradictory terminal status`, async function () {
      let caught: unknown;
      try {
        await parse(
          stream([
            {
              type: "response.completed",
              response: { status: "in_progress", output: [tool] },
            },
          ]),
        );
      } catch (error) {
        caught = error;
      }
      assert.instanceOf(caught, Error);
    });

    it(`${parser} respects an explicitly empty final answer`, async function () {
      const result = await parse(
        stream([
          { type: "response.output_text.delta", delta: "draft" },
          {
            type: "response.completed",
            response: { status: "completed", output_text: "" },
          },
        ]),
      );
      assert.equal(result.text, "");
    });

    it(`${parser} preserves separate output items and completes partial text snapshots`, async function () {
      const deltas: string[] = [];
      const body = stream([
        {
          type: "response.output_text.delta",
          item_id: "a",
          output_index: 0,
          content_index: 0,
          delta: "fir",
        },
        {
          type: "response.output_text.done",
          item_id: "a",
          output_index: 0,
          content_index: 0,
          text: "first",
        },
        {
          type: "response.output_text.done",
          item_id: "a",
          output_index: 0,
          content_index: 1,
          text: " second",
        },
        {
          type: "response.output_text.done",
          item_id: "b",
          output_index: 1,
          content_index: 0,
          text: " third",
        },
        {
          type: "response.completed",
          response: { status: "completed", output_text: "first second third" },
        },
      ]);
      const result = await (parser === "agent"
        ? parseResponsesStepStream(body, (text) => {
            deltas.push(text);
          })
        : parseResponsesStream(body, (text) => {
            deltas.push(text);
          }));
      assert.equal(result.text, "first second third");
      assert.equal(deltas.join(""), "first second third");
    });

    it(`${parser} propagates consumer exceptions`, async function () {
      const error = new Error("consumer stopped");
      let caught: unknown;
      try {
        const body = stream([
          { type: "response.output_text.delta", delta: "text" },
          completed(),
        ]);
        if (parser === "agent")
          await parseResponsesStepStream(body, () => {
            throw error;
          });
        else
          await parseResponsesStream(body, () => {
            throw error;
          });
      } catch (value) {
        caught = value;
      }
      assert.strictEqual(caught, error);
    });
  }

  for (const terminal of [
    undefined,
    {
      type: "response.failed",
      response: { error: { message: "upstream failure" } },
    },
  ]) {
    it(`generic text chat rejects ${terminal ? "an explicit failure" : "EOF before completion"}`, async function () {
      const events: unknown[] = [
        { type: "response.output_text.delta", delta: "partial" },
      ];
      if (terminal) events.push(terminal);
      let caught: unknown;
      try {
        await parseResponsesStream(stream(events), () => {});
      } catch (error) {
        caught = error;
      }
      assert.instanceOf(caught, Error);
    });
  }

  it("Codex adapter returns incomplete without committing partial tool calls to the next request", async function () {
    const original = (globalThis as { ztoolkit?: unknown }).ztoolkit;
    const payloads: Array<{ input: unknown[] }> = [];
    const responses = [
      {
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [tool],
      },
      { status: "completed", output_text: "finished" },
    ];
    (globalThis as { ztoolkit?: unknown }).ztoolkit = {
      getGlobal: () => async (_url: string, init: RequestInit) => {
        payloads.push(JSON.parse(String(init.body)));
        return {
          ok: true,
          status: 200,
          body: null,
          json: async () => responses.shift(),
        };
      },
    };
    try {
      const adapter = new CodexResponsesAgentAdapter();
      const params = {
        request: {
          conversationKey: 1,
          mode: "agent" as const,
          userText: "question",
          model: "test",
          apiBase: "https://example.test/v1",
          authMode: "api_key" as const,
          apiKey: "fixture-key",
        },
        messages: [{ role: "user" as const, content: "question" }],
        tools: [],
        signal: new AbortController().signal,
      };
      const first = await adapter.runStep(params);
      assert.equal(first.kind, "incomplete");
      const next = await adapter.runStep(params);
      assert.equal(next.kind, "final");
      assert.notInclude(JSON.stringify(payloads[1].input), "call-1");
    } finally {
      (globalThis as { ztoolkit?: unknown }).ztoolkit = original;
    }
  });
});
