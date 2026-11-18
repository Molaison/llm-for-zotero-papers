import assert from "node:assert/strict";
import { setAppLogSinkForTests } from "../src/core/logging";
import {
  callLLM,
  callLLMStream,
  parseResponsesStream,
} from "../src/utils/llmClient";

const completed = {
  type: "response.completed",
  response: { status: "completed", output: [] },
};
const chart = {
  version: 1,
  kind: "cartesian_chart",
  id: "chart-1",
  mark: "line",
  title: "Fixture",
  xField: "x",
  yField: "y",
  points: [{ x: "a", y: 1 }],
};
function stream(events: unknown[], finalNewline = true) {
  const text = events
    .map((event) => `data: ${JSON.stringify(event)}`)
    .join("\n\n");
  return new Response(text + (finalNewline ? "\n\n" : "")).body!;
}
const parse = (body: ReadableStream<Uint8Array>) =>
  parseResponsesStream(body, () => {}, undefined, undefined, {
    requireCompleted: true,
    collectRichWidgets: true,
  });

describe("CPR strict Responses transport", function () {
  for (const terminal of [
    [],
    [{ type: "response.output_text.done", text: "answer" }],
    [{ type: "response.incomplete", response: { status: "incomplete" } }],
  ]) {
    it(`requires response.completed after ${JSON.stringify(terminal)}`, async function () {
      await assert.rejects(parse(stream(terminal)), /response.completed/);
    });
  }
  it("does not accept DONE as a terminal completion", async function () {
    await assert.rejects(
      parse(new Response("data: [DONE]\n\n").body!),
      /response.completed/,
    );
  });
  it("rejects provider failures, invalid terminal status and malformed JSON", async function () {
    await assert.rejects(
      parse(
        stream([
          {
            type: "response.failed",
            response: { error: { message: "fixture failed" } },
          },
        ]),
      ),
      /fixture failed/,
    );
    await assert.rejects(
      parse(
        stream([
          { type: "response.completed", response: { status: "failed" } },
        ]),
      ),
      /invalid response status/,
    );
    await assert.rejects(
      parse(stream([{ type: "response.completed" }])),
      /invalid response status/,
    );
    await assert.rejects(
      parse(new Response("data: {broken}\n\n").body!),
      SyntaxError,
    );
  });
  it("reads a completed final line without newline and keeps only valid unique widgets", async function () {
    const outcome = await parse(
      stream(
        [
          { type: "response.rich_widget.done", widget: chart },
          {
            ...completed,
            response: {
              ...completed.response,
              rich_widgets: [chart, { ...chart, id: "untrusted" }],
            },
          },
        ],
        false,
      ),
    );
    assert.equal(outcome.completion.status, "complete");
    assert.deepEqual(outcome.richWidgets, [chart]);
  });
  it("settles on completion without waiting for a persistent SSE connection to close", async function () {
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(`data: ${JSON.stringify(completed)}\n\n`),
        );
      },
      cancel() {
        canceled = true;
      },
    });
    assert.equal((await parse(body)).completion.status, "complete");
    assert.equal(canceled, true);
  });
});

describe("CPR direct web dispatch including text-only turns", function () {
  const globals = globalThis as unknown as Record<string, unknown>;
  let saved: Record<string, unknown>;
  const params = {
    apiBase: "https://fixture.invalid/v1",
    apiKey: "fixture-only",
    model: "custom-alias",
    prompt: "Current question",
    directWebPdf: true,
    requestScope: { operationId: "stable-fixture-session" },
  };
  beforeEach(function () {
    saved = Object.fromEntries(
      ["Zotero", "ztoolkit"].map((key) => [key, globals[key]]),
    );
    const prefs = new Map();
    globals.Zotero = {
      Prefs: {
        get: (key: string) => prefs.get(key),
        set: (key: string, value: unknown) => prefs.set(key, value),
      },
    };
  });
  afterEach(function () {
    Object.assign(globals, saved);
  });
  it("uses the same session on text-only callLLM/callLLMStream and preserves annotated images", async function () {
    const calls: Array<Record<string, any>> = [];
    globals.ztoolkit = {
      getGlobal: () => async (_url: string, init: RequestInit) => {
        calls.push(JSON.parse(String(init.body)));
        return new Response(stream([completed]));
      },
    };
    const images = ["data:image/png;base64,YQ=="];
    await callLLM({ ...params, images });
    await callLLMStream(params, () => {});
    assert.equal(calls.length, 2);
    assert.equal(calls[0].prompt_cache_key, calls[1].prompt_cache_key);
    assert.equal(
      calls[0].prompt_cache_key,
      "zotero-cpr-stable-fixture-session",
    );
    assert.deepEqual(calls[0].input[0].content, [
      { type: "input_text", text: params.prompt },
      { type: "input_image", image_url: images[0], detail: "original" },
    ]);
  });
  for (const failure of ["network", "http", "truncated"] as const) {
    it(`does not retry a ${failure} failure on a text-only turn`, async function () {
      let calls = 0;
      globals.ztoolkit = {
        getGlobal: () => async () => {
          calls++;
          if (failure === "network") throw new Error("fixture network loss");
          if (failure === "http")
            return new Response("busy", {
              status: 429,
              headers: { "Retry-After": "0" },
            });
          return new Response(
            stream([{ type: "response.output_text.delta", delta: "partial" }]),
          );
        },
      };
      await assert.rejects(callLLMStream(params, () => {}));
      assert.equal(calls, 1);
    });
  }
});

// HTTP 200 Gamma round1 failure, captured 2026-11-11; no credentials.
const gammaFailure =
  ': keep-alive\n\nevent: response.failed\ndata: {"type":"response.failed","response":{"id":"resp_proxy_e4958cc99067445c9c37bd1523509d32","status":"failed","error":{"message":"Upstream request timed out.","type":"server_error","code":"request_timeout"}}}\n\n';

describe("Responses explicit failure semantics", function () {
  for (const requireCompleted of [false, true]) {
    for (const ending of ["DONE", "EOF", "unterminated EOF"] as const) {
      it(`rejects the captured Gamma failure with ${ending}, strict=${requireCompleted}`, async function () {
        const text =
          ending === "DONE"
            ? gammaFailure + "data: [DONE]\n\n"
            : ending === "EOF"
              ? gammaFailure
              : gammaFailure.trimEnd();
        const body = new Response(text).body!;
        await assert.rejects(
          parseResponsesStream(body, () => {}, undefined, undefined, {
            requireCompleted,
          }),
          (error: any) => {
            assert.match(error.message, /Upstream request timed out\./);
            assert.match(error.message, /code=request_timeout/);
            assert.match(error.message, /type=server_error/);
            assert.equal(error.code, "request_timeout");
            assert.equal(error.type, "server_error");
            return true;
          },
        );
        assert.equal(body.locked, false);
      });
    }
    for (const event of [
      {
        type: "error",
        error: {
          message: "busy",
          code: 502,
          type: "server_error",
          private: "secret-debug",
        },
      },
      { type: "error", message: "busy", code: 502 },
      { error: { message: "busy", code: 502, type: "server_error" } },
      {
        type: "error",
        error: {
          message: { private: "secret-debug" },
          code: { private: "secret-debug" },
          type: { private: "secret-debug" },
        },
      },
      { type: "response.failed" },
    ]) {
      it(`rejects explicit ${JSON.stringify(event)}, strict=${requireCompleted}`, async function () {
        const deltas: string[] = [];
        await assert.rejects(
          parseResponsesStream(
            stream([
              { type: "response.output_text.delta", delta: "Partial answer" },
              event,
              completed,
            ]),
            (delta) => deltas.push(delta),
            undefined,
            undefined,
            { requireCompleted },
          ),
          (error: any) => {
            assert.doesNotMatch(
              error.message,
              /secret-debug|\[object Object\]/,
            );
            assert.equal(
              error.code,
              typeof event.code === "number"
                ? event.code
                : typeof event.error?.code === "number"
                  ? event.error.code
                  : undefined,
            );
            assert.match(error.message, /busy|Responses request failed/);
            return true;
          },
        );
        assert.equal(deltas.join(""), "Partial answer");
      });
    }
  }
  it("fails immediately and cancels a still-open provider stream", async function () {
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(gammaFailure));
      },
      cancel() {
        canceled = true;
      },
    });
    await assert.rejects(
      parseResponsesStream(body, () => {}),
      /request_timeout/,
    );
    assert.equal(canceled, true);
  });
  it("keeps legacy success, malformed JSON skipping and permissive EOF", async function () {
    for (const text of [
      "data: [DONE]\n\n",
      'data: {broken}\n\ndata: {"type":"response.output_text.delta","delta":"answer"}\n\n',
      'data: {"type":"response.output_text.delta","delta":"answer"}\n\n',
      'data: {"type":"response.completed","response":{"output_text":"ignored legacy tail"}}',
    ]) {
      const outcome = await parseResponsesStream(
        new Response(text).body!,
        () => {},
      );
      assert.equal(outcome.completion.status, "complete");
      assert.equal(
        outcome.text,
        text.includes('"delta":"answer"') ? "answer" : "",
      );
    }
  });
});

describe("Responses tail callback cleanup", function () {
  for (const requireCompleted of [false, true]) {
    for (const providerFailed of [true, false]) {
      it(`cleans up after a throwing tail callback, strict=${requireCompleted}, providerFailed=${providerFailed}`, async function () {
        const callbackError = new Error("local callback failed");
        const logs: Array<readonly unknown[]> = [];
        let canceled = false;
        let cancelCalls = 0;
        let callbackCalls = 0;
        const keepOpen = providerFailed || requireCompleted;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"type":"response.output_text.delta","delta":"<thi"}\n\n' +
                  (providerFailed
                    ? gammaFailure
                    : requireCompleted
                      ? `data: ${JSON.stringify(completed)}\n\n`
                      : ""),
              ),
            );
            if (!keepOpen) controller.close();
          },
          cancel() {
            canceled = true;
          },
        });
        // Observe the native reader's cancel method even for a closed EOF
        // body, whose already-closed underlying source will not be canceled.
        const getReader = body.getReader.bind(body);
        body.getReader = (() => {
          const reader = getReader();
          const cancel = reader.cancel.bind(reader);
          reader.cancel = (reason?: unknown) => {
            cancelCalls++;
            return cancel(reason);
          };
          return reader;
        }) as typeof body.getReader;
        setAppLogSinkForTests((_level, args) => logs.push(args));
        try {
          await assert.rejects(
            parseResponsesStream(
              body,
              () => {
                callbackCalls++;
                throw callbackError;
              },
              undefined,
              undefined,
              { requireCompleted },
            ),
            (error: any) => {
              if (providerFailed) {
                assert.equal(
                  error.message,
                  "Responses stream error: Upstream request timed out.; code=request_timeout; type=server_error",
                );
                assert.equal(error.code, "request_timeout");
                assert.equal(error.type, "server_error");
                assert.notEqual(error, callbackError);
              } else {
                assert.equal(
                  error,
                  callbackError,
                  "a genuine callback failure must not become success",
                );
              }
              return true;
            },
          );
          assert.equal(
            callbackCalls,
            1,
            "the exception comes from finally's buffered tail",
          );
          assert.equal(body.locked, false);
          assert.equal(cancelCalls, 1);
          assert.equal(canceled, keepOpen);
          assert.equal(
            logs.some((args) => args.includes(callbackError)),
            providerFailed,
          );
        } finally {
          setAppLogSinkForTests(null);
        }
      });
    }
  }
});
