import { assert } from "chai";
import { gunzipSync } from "fflate";
import { config } from "../package.json";
import { callLLMStream } from "../src/utils/llmClient";
import { resolveCprPaperSessionId } from "../src/utils/cprPapers";
import { resetProviderSessionIdCacheForTests } from "../src/utils/providerSessionId";

// Protocol-only fixture. No network, production registry, UI or model is used.
describe("Papers session dispatch boundary", function () {
  let saved: Record<string, unknown>;
  let prefs: Map<string, unknown>;
  let calls: Array<{
    operation: string;
    sid: string;
    thread?: string;
    files: number;
  }>;
  let threads: Map<string, string>;
  let uploads: Set<string>;
  let failChat: boolean;
  let wrongSession: boolean;
  let truncateChat: boolean;
  const globals = globalThis as unknown as Record<string, unknown>;
  beforeEach(function () {
    saved = Object.fromEntries(
      ["Zotero", "IOUtils", "ztoolkit"].map((k) => [k, globals[k]]),
    );
    prefs = new Map();
    calls = [];
    threads = new Map();
    uploads = new Set();
    failChat = false;
    wrongSession = false;
    truncateChat = false;
    resetProviderSessionIdCacheForTests();
    globals.Zotero = {
      Prefs: {
        get: (k: string) => prefs.get(k),
        set: (k: string, v: unknown) => prefs.set(k, v),
      },
      Items: {
        get: () => ({
          id: 7,
          libraryID: 1,
          key: "PAPER7",
          isRegularItem: () => true,
          isAttachment: () => false,
          getField: (field: string) => (field === "DOI" ? "" : "Paper"),
          getBestAttachment: async () => ({
            attachmentContentType: "application/pdf",
            getFilePathAsync: async () => "/paper.pdf",
          }),
        }),
      },
    };
    // Large enough to exercise the real gzip dispatch body, unlike a tiny PDF canary.
    const bytes = new TextEncoder().encode(
      "%PDF-1.4\n" + "paper bytes ".repeat(40000),
    );
    globals.IOUtils = { read: async () => bytes };
    const fetchFn: typeof fetch = async (_url, init) => {
      const body =
        typeof init?.body === "string"
          ? init.body
          : new TextDecoder().decode(
              gunzipSync(new Uint8Array(init?.body as ArrayBuffer)),
            );
      const payload = JSON.parse(body);
      const meta = JSON.parse(payload.client_metadata["x-codex-turn-metadata"]);
      const sid = meta.paper_session_id;
      const files = Array.isArray(payload.input)
        ? payload.input[0].content.filter(
            (part: { type: string }) => part.type === "input_file",
          ).length
        : 0;
      calls.push({
        operation: meta.paper_operation,
        sid,
        thread: meta.thread_id,
        files,
      });
      if (meta.paper_operation === "resolve") {
        if (!threads.has(sid)) threads.set(sid, `thread-${threads.size + 1}`);
        const result = {
          paper_id: meta.paper_id,
          paper_registry_version: 2,
          paper_session_id: wrongSession ? "foreign-session" : sid,
          thread_id: threads.get(sid),
          status: uploads.has(sid) ? "ready" : "missing",
          upload_required: !uploads.has(sid),
          ...(uploads.has(sid)
            ? { conversation_url: `https://chatgpt.com/c/${threads.get(sid)}` }
            : { upload_token: `reservation-${sid}` }),
        };
        return new Response(
          JSON.stringify({
            status: "completed",
            output: [
              {
                type: "message",
                content: [
                  { type: "output_text", text: JSON.stringify(result) },
                ],
              },
            ],
          }),
        );
      }
      assert.equal(meta.paper_operation, "chat");
      assert.equal(meta.thread_id, threads.get(sid));
      assert.equal(payload.prompt_cache_key, threads.get(sid));
      if (failChat) throw new Error("fixture transport failed after dispatch");
      if (!uploads.has(sid))
        assert.equal(meta.paper_upload_token, `reservation-${sid}`);
      uploads.add(sid);
      return new Response(
        'data: {"type":"response.output_text.delta","delta":"answer"}\n\n' +
          (truncateChat
            ? ""
            : 'data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n'),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    };
    globals.ztoolkit = {
      getGlobal: (name: string) => (name === "fetch" ? fetchFn : undefined),
    };
  });
  afterEach(function () {
    Object.assign(globals, saved);
    resetProviderSessionIdCacheForTests();
  });
  const send = (sid?: string) =>
    callLLMStream(
      {
        apiBase: "https://papers.example/v1",
        apiKey: "fixture-only",
        model: "chatgpt-web/gpt-6-sol",
        prompt: "Current user question",
        paperRegistry: true,
        cprPaperItemId: 7,
        cprPaperSessionId: sid,
      },
      () => {},
    );

  it("mints a durable sid without using prior-message history as a freshness proxy", function () {
    const first = resolveCprPaperSessionId(41);
    assert.match(String(first), /^[a-f0-9]{32}$/);
    assert.equal(resolveCprPaperSessionId(41), first);
    assert.equal(resolveCprPaperSessionId(41, false), first);
    assert.notEqual(resolveCprPaperSessionId(42), first);
    assert.isUndefined(resolveCprPaperSessionId(43, false));
    assert.isFalse(prefs.has(`${config.prefsPrefix}.cprPaperSession.43`));
  });
  it("rejects an absent sid before resolve or PDF reads instead of joining the paper default", async function () {
    let reads = 0;
    globals.IOUtils = {
      read: async () => {
        reads++;
        throw new Error("unexpected PDF read");
      },
    };
    let caught: unknown;
    try {
      await send();
    } catch (error) {
      caught = error;
    }
    assert.include(String(caught), "会话");
    assert.equal(reads, 0);
    assert.lengthOf(calls, 0);
  });
  it("dispatches one first PDF, reuses the same sid thread, and isolates another sid for identical bytes", async function () {
    const a = resolveCprPaperSessionId(41)!;
    const b = resolveCprPaperSessionId(42)!;
    const outcomes = [await send(a), await send(a), await send(b)];
    assert.isTrue(outcomes.every((o) => o.completion.status === "complete"));
    assert.deepEqual(
      calls.map((c) => c.operation),
      ["resolve", "chat", "resolve", "chat", "resolve", "chat"],
    );
    const chats = calls.filter((c) => c.operation === "chat");
    assert.deepEqual(
      chats.map((c) => c.files),
      [1, 0, 1],
    );
    assert.equal(chats[0].thread, chats[1].thread);
    assert.notEqual(chats[0].thread, chats[2].thread);
    assert.deepEqual(
      chats.map((c) => c.sid),
      [a, a, b],
    );
  });
  it("does not dispatch when resolve echoes a different sid", async function () {
    wrongSession = true;
    let caught: unknown;
    try {
      await send("session-a");
    } catch (error) {
      caught = error;
    }
    assert.include(String(caught), "会话身份");
    assert.deepEqual(
      calls.map((c) => c.operation),
      ["resolve"],
    );
  });
  it("does not accept a truncated chat or retry it, retaining the upload reservation", async function () {
    truncateChat = true;
    let caught: unknown;
    try {
      await send("session-truncated");
    } catch (error) {
      caught = error;
    }
    assert.include(String(caught), "response.completed");
    assert.deepEqual(
      calls.map((c) => c.operation),
      ["resolve", "chat"],
    );
    assert.isTrue(
      [...prefs.values()].includes("reservation-session-truncated"),
    );
  });
  it("preserves the reservation and never replays an ambiguous chat failure", async function () {
    failChat = true;
    let caught: unknown;
    try {
      await send("session-a");
    } catch (error) {
      caught = error;
    }
    assert.include(String(caught), "fixture transport failed after dispatch");
    assert.deepEqual(
      calls.map((c) => c.operation),
      ["resolve", "chat"],
    );
    assert.isTrue([...prefs.values()].includes("reservation-session-a"));
  });
});
