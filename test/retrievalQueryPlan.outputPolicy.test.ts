import { assert } from "chai";
import {
  generateRetrievalProbeReformulation,
  resolveRetrievalQueryPlan,
} from "../src/services/retrieval/retrievalQueryPlan";

describe("retrieval planner output policy", function () {
  const originalZotero = globalThis.Zotero;
  const globals = globalThis as typeof globalThis & { ztoolkit?: unknown };
  const originalToolkit = globals.ztoolkit;
  const query = "哪些论文讨论了表征漂移？";
  const variants = ["representational drift", "neural population stability"];
  let requests: Record<string, any>[];
  let respond: (body: Record<string, any>) => unknown;
  const identity = {
    model: "deepseek-v4.1-flash",
    apiBase: "https://issue-462.example.invalid/v1",
    apiKey: "fixture",
    providerProtocol: "openai_chat_compat" as const,
  };
  const completed = () => ({
    choices: [
      {
        message: { content: JSON.stringify({ variants }) },
        finish_reason: "stop",
      },
    ],
  });
  const exhausted = () => ({
    choices: [
      {
        message: { content: "", reasoning_content: "Still reasoning." },
        finish_reason: "length",
      },
    ],
  });

  beforeEach(function () {
    requests = [];
    respond = completed;
    globalThis.Zotero = {
      Prefs: { get: () => "", set: () => undefined },
    } as unknown as typeof Zotero;
    globals.ztoolkit = {
      getGlobal: (name: string) =>
        name === "fetch"
          ? async (_url: string, init?: RequestInit) => {
              const body = JSON.parse(String(init?.body || "{}"));
              requests.push(body);
              return {
                ok: true,
                status: 200,
                statusText: "OK",
                json: async () => respond(body),
                text: async () => "",
              };
            }
          : undefined,
      log: () => undefined,
    };
  });

  afterEach(function () {
    globalThis.Zotero = originalZotero;
    globals.ztoolkit = originalToolkit;
  });

  it("finishes search expansion when a relay keeps reasoning enabled", async function () {
    // The relay ignores thinking:disabled and needs more than a tiny JSON cap.
    respond = (body) =>
      typeof body.max_tokens === "number" && body.max_tokens < 4096
        ? exhausted()
        : completed();
    const plan = await resolveRetrievalQueryPlan({
      ...identity,
      query,
      hasRetrievalContext: true,
    });

    assert.deepEqual(plan.variants, variants);
    assert.deepEqual(plan.effectiveQueries, [query, ...variants]);
    assert.lengthOf(requests, 1);
    assert.notProperty(requests[0], "max_tokens");
    assert.deepEqual(requests[0].thinking, { type: "disabled" });
  });

  it("uses a known model output ceiling rather than the expected JSON size", async function () {
    const plan = await resolveRetrievalQueryPlan({
      ...identity,
      query,
      hasRetrievalContext: true,
      profileOverride: {
        forModel: identity.model,
        limits: { outputTokens: 16_384 },
      },
    });

    assert.deepEqual(plan.variants, variants);
    assert.equal(requests[0].max_tokens, 16_384);
  });

  it("uses the required Auto allowance on an Anthropic-compatible relay", async function () {
    respond = () => ({
      content: [{ type: "text", text: JSON.stringify({ variants }) }],
      stop_reason: "end_turn",
    });
    const plan = await resolveRetrievalQueryPlan({
      ...identity,
      apiBase: "https://issue-462.example.invalid/anthropic",
      providerProtocol: "anthropic_messages",
      query,
      hasRetrievalContext: true,
    });

    assert.deepEqual(plan.variants, variants);
    assert.equal(requests[0].max_tokens, 8192);
    assert.deepEqual(requests[0].thinking, { type: "disabled" });
  });

  it("also lets follow-up search probes use Auto", async function () {
    const result = await generateRetrievalProbeReformulation({
      ...identity,
      query,
      triedProbes: [query],
      matchedProbes: [],
      scopeTitles: ["Neural population stability"],
    });

    assert.deepEqual(result.variants, variants);
    assert.notProperty(requests[0], "max_tokens");
  });

  it("preserves the original query without repeating an exhausted Auto request", async function () {
    respond = exhausted;
    const plan = await resolveRetrievalQueryPlan({
      ...identity,
      query,
      hasRetrievalContext: true,
    });

    assert.lengthOf(requests, 1);
    assert.deepEqual(plan.variants, []);
    assert.deepEqual(plan.effectiveQueries, [query]);
    assert.include(plan.notes.join(" "), "planning failed");
  });

  it("still falls back when the Auto request times out", async function () {
    respond = () => new Promise(() => {});
    const plan = await resolveRetrievalQueryPlan({
      ...identity,
      query,
      hasRetrievalContext: true,
      timeoutMs: 20,
    });

    assert.lengthOf(requests, 1);
    assert.deepEqual(plan.effectiveQueries, [query]);
    assert.include(plan.notes.join(" "), "planning failed");
  });
});
