import { assert } from "chai";
import { createHash } from "node:crypto";
import {
  fetchCprPaperHistory,
  parseCprPaperHistory,
  prepareCprPaperRequest,
  normalizePaperDoi,
  cprPaperConversationTitle,
  resolveCprPaperSessionId,
} from "../src/utils/cprPapers";

const TEST_API_BASE = "https://papers.example/v1";
const TEST_MODELS = ["gpt-5.6-sol", "gpt-5.4", "gpt-5.6-pro"];
import { resetProviderSessionIdCacheForTests } from "../src/utils/providerSessionId";
import { config } from "../package.json";
import {
  createPaperPortalItem,
  resolveConversationBaseItem,
} from "../src/modules/contextPanel/portalScope";

const ready = (
  paperId: string,
  status = "ready",
  extra = {},
  paperSessionId = "",
) =>
  new Response(
    JSON.stringify({
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: JSON.stringify({
                paper_id: paperId,
                paper_registry_version: 2,
                paper_session_id: paperSessionId,
                thread_id: "permanent-server-thread",
                status,
                upload_required: status === "missing",
                ...extra,
              }),
            },
          ],
        },
      ],
    }),
    { headers: { "content-type": "application/json" } },
  );

describe("CPR server-owned paper registry client", function () {
  let original: typeof Zotero;
  let prefs: Map<string, unknown>;
  let doi: string;
  let itemId: number;
  let shortTitle: string;
  let pdfPath: string | false;
  beforeEach(function () {
    original = globalThis.Zotero;
    prefs = new Map();
    doi = "https://doi.org/10.1234/ABC";
    itemId = 7;
    shortTitle = "";
    pdfPath = "/paper.pdf";
    resetProviderSessionIdCacheForTests();
    globalThis.Zotero = {
      Prefs: {
        get: (k: string) => prefs.get(k),
        set: (k: string, v: unknown) => prefs.set(k, v),
      },
      Items: {
        get: () => ({
          id: itemId,
          key: String(itemId),
          libraryID: itemId,
          isRegularItem: () => true,
          isAttachment: () => false,
          getField: (field: string) =>
            field === "DOI"
              ? doi
              : field === "shortTitle"
                ? shortTitle
                : "Paper title",
          getBestAttachment: async () => ({
            attachmentContentType: "application/pdf",
            getFilePathAsync: async () => pdfPath,
          }),
        }),
      },
    } as unknown as typeof Zotero;
  });
  afterEach(function () {
    globalThis.Zotero = original;
    resetProviderSessionIdCacheForTests();
  });
  it("retains this turns annotated input_image PNG on a ready Papers conversation", async function () {
    pdfPath = false;
    const image = "data:image/png;base64,AA==";
    const result = await prepareCprPaperRequest({
      itemId,
      apiBase: TEST_API_BASE,
      apiKey: "test",
      model: TEST_MODELS[0],
      prompt: "annotation batch",
      images: [image],
      fetchFn: async () => ready("doi:10.1234/abc"),
      readBytes: async () => {
        throw new Error("ready does not upload PDF");
      },
    });
    const content = result.payload.input[0].content;
    assert.deepInclude(content, {
      type: "input_image",
      image_url: image,
      detail: "original",
    });
    assert.isFalse(content.some((part) => part.type === "input_file"));
  });
  it("retains annotation images alongside the first PDF upload", async function () {
    const result = await prepareCprPaperRequest({
      itemId,
      apiBase: TEST_API_BASE,
      apiKey: "test",
      model: TEST_MODELS[0],
      prompt: "annotation batch",
      images: ["data:image/png;base64,AA=="],
      fetchFn: async () =>
        ready("doi:10.1234/abc", "missing", { upload_token: "reserved" }),
      readBytes: async () => new TextEncoder().encode("%PDF-fixture"),
    });
    const content = result.payload.input[0].content;
    assert.equal(content.filter((p) => p.type === "input_file").length, 1);
    assert.equal(content.filter((p) => p.type === "input_image").length, 1);
  });
  it("rejects image overflow before a registry request instead of silently truncating", async function () {
    let calls = 0;
    let error: unknown;
    try {
      await prepareCprPaperRequest({
        itemId,
        apiBase: TEST_API_BASE,
        apiKey: "test",
        model: TEST_MODELS[0],
        prompt: "batch",
        images: Array(11).fill("data:image/png;base64,AA=="),
        fetchFn: async () => {
          calls++;
          return ready("doi:10.1234/abc");
        },
        readBytes: async () => new Uint8Array(),
      });
    } catch (e) {
      error = e;
    }
    assert.instanceOf(error, Error);
    assert.equal(calls, 0);
  });
  it("rejects a missing Zotero item before lookup instead of calling a method on false", async function () {
    // Zotero returns false for an unknown ID, including a portal conversation ID.
    Zotero.Items.get = (() => false) as typeof Zotero.Items.get;
    let caught: unknown;
    let fetches = 0;
    try {
      await prepareCprPaperRequest({
        itemId: 1500000126,
        apiBase: TEST_API_BASE,
        apiKey: "test",
        model: TEST_MODELS[0],
        prompt: "q",
        fetchFn: async () => {
          fetches++;
          return ready("doi:10.1234/abc");
        },
        readBytes: async () => {
          throw new Error("must not read PDF");
        },
      });
    } catch (error) {
      caught = error;
    }
    assert.instanceOf(caught, Error);
    assert.notInstanceOf(caught, TypeError);
    assert.include(String(caught), "需要先选择一篇论文");
    assert.equal(fetches, 0);
  });
  for (const threadId of ["", "   "]) {
    it(`rejects a blank server thread ${JSON.stringify(threadId)} before constructing a chat request`, async function () {
      let calls = 0;
      let reads = 0;
      let caught: unknown;
      try {
        await prepareCprPaperRequest({
          itemId,
          apiBase: TEST_API_BASE,
          apiKey: "test",
          model: TEST_MODELS[0],
          prompt: "q",
          fetchFn: async () => {
            calls++;
            return ready("doi:10.1234/abc", "ready", { thread_id: threadId });
          },
          readBytes: async () => {
            reads++;
            return new TextEncoder().encode("%PDF-test");
          },
        });
      } catch (error) {
        caught = error;
      }
      assert.include(String(caught), "CPR 论文登记格式不正确");
      assert.equal(calls, 1);
      assert.equal(reads, 0);
      assert.isFalse(
        [...prefs.keys()].some((key) => key.includes(".cprPaperReservation.")),
      );
    });
  }
  it("rejects another paper's reservation before reading or fingerprinting the PDF", async function () {
    let calls = 0;
    let reads = 0;
    let caught: unknown;
    try {
      await prepareCprPaperRequest({
        itemId,
        apiBase: TEST_API_BASE,
        apiKey: "test",
        model: TEST_MODELS[0],
        prompt: "q",
        fetchFn: async () => {
          calls++;
          return calls === 1
            ? ready("doi:10.1234/other", "missing", {
                upload_token: "wrong-paper-token",
              })
            : ready("doi:10.1234/abc");
        },
        readBytes: async () => {
          reads++;
          return new TextEncoder().encode("%PDF-test");
        },
      });
    } catch (error) {
      caught = error;
    }
    assert.include(String(caught), "不同的论文身份");
    assert.equal(calls, 1);
    assert.equal(reads, 0);
    assert.isFalse(
      [...prefs.keys()].some((key) => key.includes(".cprPaperReservation.")),
    );
  });
  it("rejects a different paper returned by the fingerprint lookup", async function () {
    let calls = 0;
    let caught: unknown;
    try {
      await prepareCprPaperRequest({
        itemId,
        apiBase: TEST_API_BASE,
        apiKey: "test",
        model: TEST_MODELS[0],
        prompt: "q",
        fetchFn: async () => {
          calls++;
          return calls === 1
            ? ready("doi:10.1234/abc", "missing", {
                upload_token: "own-paper-token",
              })
            : ready("doi:10.1234/other", "missing", {
                upload_token: "wrong-paper-token",
              });
        },
        readBytes: async () => new TextEncoder().encode("%PDF-test"),
      });
    } catch (error) {
      caught = error;
    }
    assert.include(String(caught), "不同的论文身份");
    assert.equal(calls, 2);
    const reservations = [...prefs.entries()].filter(([key]) =>
      key.includes(".cprPaperReservation."),
    );
    assert.lengthOf(reservations, 1);
    assert.equal(reservations[0][1], "own-paper-token");
  });
  it("resolves different paper portal sessions to the real item and same saved thread", async function () {
    pdfPath = false;
    const paper = Zotero.Items.get(itemId);
    const lookups: number[] = [];
    Zotero.Items.get = ((id: number) => {
      lookups.push(id);
      return id === paper.id ? paper : false;
    }) as typeof Zotero.Items.get;
    for (const key of [1500000126, 1500000127]) {
      const portal = createPaperPortalItem(paper, key, 1);
      const request = await prepareCprPaperRequest({
        itemId: resolveConversationBaseItem(portal)?.id,
        apiBase: TEST_API_BASE,
        apiKey: "test",
        model: TEST_MODELS[0],
        prompt: "q",
        fetchFn: async () => ready("doi:10.1234/abc"),
        readBytes: async () => {
          throw new Error("must not read ready PDF");
        },
      });
      assert.equal(request.paperId, "doi:10.1234/abc");
      assert.equal(request.payload.prompt_cache_key, "permanent-server-thread");
      assert.deepEqual(request.payload.input[0].content, [
        { type: "input_text", text: "q" },
      ]);
    }
    assert.isNotEmpty(lookups);
    assert.isTrue(lookups.every((id) => id === itemId));
  });
  it("normalizes DOI forms without using a device identity", function () {
    assert.equal(normalizePaperDoi(" DOI:10.1234/AbC "), "doi:10.1234/abc");
    assert.equal(
      normalizePaperDoi("https://dx.doi.org/10.1234/AbC"),
      "doi:10.1234/abc",
    );
    assert.throws(() => normalizePaperDoi("not-a-doi"));
  });
  it("reads history without a resolve, reservation, inference, or PDF upload", async function () {
    const bodies: Array<Record<string, unknown>> = [];
    const message = {
      id: "remote-1",
      role: "assistant",
      text: "Saved answer",
      created_at: 1700000000000,
    };
    const history = await fetchCprPaperHistory({
      itemId,
      apiBase: TEST_API_BASE,
      apiKey: "test",
      model: TEST_MODELS[0],
      readBytes: async () => {
        throw new Error("must not read DOI PDF");
      },
      fetchFn: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return ready("doi:10.1234/abc", "ready", {
          title: "Paper title",
          messages: [message],
          conversation_url:
            "https://chatgpt.com/g/g-p-6ac1534524788191a340f2407c76f370/c/test-chat",
        });
      },
    });
    assert.deepEqual(history.messages, [message]);
    assert.lengthOf(bodies, 1);
    assert.deepEqual(
      JSON.parse(
        (bodies[0].client_metadata as Record<string, string>)[
          "x-codex-turn-metadata"
        ],
      ),
      {
        paper_registry_version: 2,
        paper_id: "doi:10.1234/abc",
        paper_session_id: "",
        paper_operation: "history",
      },
    );
    assert.isString(bodies[0].input);
    assert.notProperty(bodies[0], "reasoning");
    assert.equal(prefs.size, 0);
  });
  it("only hashes a no-DOI PDF locally for history and never transmits it", async function () {
    doi = "";
    let reads = 0;
    await fetchCprPaperHistory({
      itemId,
      apiBase: TEST_API_BASE,
      apiKey: "test",
      model: TEST_MODELS[0],
      readBytes: async () => {
        reads++;
        return new TextEncoder().encode("%PDF-history");
      },
      fetchFn: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        const metadata = JSON.parse(
          body.client_metadata["x-codex-turn-metadata"],
        );
        assert.equal(
          metadata.paper_id,
          `sha256:${createHash("sha256").update("%PDF-history").digest("hex")}`,
        );
        assert.notInclude(String(init?.body), "input_file");
        return ready(metadata.paper_id, "ready", {
          title: "Paper title",
          messages: [],
          conversation_url:
            "https://chatgpt.com/g/g-p-6ac1534524788191a340f2407c76f370/c/test-chat",
        });
      },
    });
    assert.equal(reads, 1);
    assert.equal(prefs.size, 0);
  });
  it("rejects mismatched, duplicate or hidden-role history before import", async function () {
    const base = {
      title: "Paper title",
      conversation_url:
        "https://chatgpt.com/g/g-p-6ac1534524788191a340f2407c76f370/c/test-chat",
    };
    const message = {
      id: "remote-1",
      role: "user",
      text: "q",
      created_at: null,
    };
    for (const messages of [
      [message, message],
      [{ ...message, role: "system" }],
      [{ ...message, created_at: -1 }],
    ]) {
      assert.throws(() =>
        parseCprPaperHistory(
          {
            status: "completed",
            output: [
              {
                content: [
                  {
                    type: "output_text",
                    text: JSON.stringify({
                      ...base,
                      paper_id: "doi:10.1234/abc",
                      paper_registry_version: 2,
                      paper_session_id: "",
                      thread_id: "thread",
                      messages,
                    }),
                  },
                ],
              },
            ],
          },
          "doi:10.1234/abc",
        ),
      );
    }
    const value = await ready("doi:10.1234/other", "ready", {
      ...base,
      messages: [message],
    }).json();
    assert.throws(
      () => parseCprPaperHistory(value, "doi:10.1234/abc"),
      /不同的论文身份/,
    );
  });
  it("accepts canonical non-project history URLs without relaxing identity checks", function () {
    const parse = (conversationUrl: string) => {
      const text = JSON.stringify({
        paper_id: "doi:10.1234/abc",
        paper_registry_version: 2,
        paper_session_id: "session-a",
        thread_id: "thread",
        title: "Paper title",
        conversation_url: conversationUrl,
        messages: [],
      });
      return parseCprPaperHistory(
        {
          status: "completed",
          output: [{ content: [{ type: "output_text", text }] }],
        },
        "doi:10.1234/abc",
        "session-a",
      );
    };
    for (const url of [
      "https://chatgpt.com/g/g-p-6ac1534524788191a340f2407c76f370/c/test-chat",
      "https://chatgpt.com/c/test-chat",
    ]) {
      assert.equal(parse(url).conversation_url, url);
    }
    for (const url of [
      "http://chatgpt.com/c/test-chat",
      "https://www.chatgpt.com/c/test-chat",
      "https://chatgpt.com/c/",
      "https://chatgpt.com/c/test-chat?view=full",
      "https://chatgpt.com/c/test-chat#latest",
      "https://chatgpt.com/c/test-chat/extra",
      "https://chatgpt.com/g/g-p-not-a-project/c/test-chat",
      "https://chatgpt.com/g/g-p-6ac1534524788191a340f2407c76f370/c/test-chat/extra",
    ]) {
      assert.throws(parse.bind(null, url), /无效的论文历史/);
    }
    const text = JSON.stringify({
      paper_id: "doi:10.1234/abc",
      paper_registry_version: 2,
      paper_session_id: "session-a",
      thread_id: "thread",
      title: "Paper title",
      conversation_url: "https://chatgpt.com/c/test-chat",
      messages: [],
    });
    const value = {
      status: "completed",
      output: [{ content: [{ type: "output_text", text }] }],
    };
    assert.throws(
      () => parseCprPaperHistory(value, "doi:10.1234/other", "session-a"),
      /不同的论文身份/,
    );
    assert.throws(
      () => parseCprPaperHistory(value, "doi:10.1234/abc", "session-b"),
      /无效的论文历史/,
    );
  });
  it("reports an old server without retrying history as a chat", async function () {
    let calls = 0;
    let caught: unknown;
    try {
      await fetchCprPaperHistory({
        itemId,
        apiBase: TEST_API_BASE,
        apiKey: "test",
        model: TEST_MODELS[0],
        readBytes: async () => {
          throw new Error("must not read PDF");
        },
        fetchFn: async () => {
          calls++;
          return new Response(
            JSON.stringify({ error: { code: "paper_operation_invalid" } }),
            { status: 400 },
          );
        },
      });
    } catch (error) {
      caught = error;
    }
    assert.include(String(caught), "服务端尚未启用");
    assert.equal(calls, 1);
    assert.equal(prefs.size, 0);
  });
  it("uses the short title for display without changing the paper identity", async function () {
    pdfPath = false;
    shortTitle = "  MaSIF-neosurf\n paper  ";
    const request = await prepareCprPaperRequest({
      itemId,
      apiBase: TEST_API_BASE,
      apiKey: "test",
      model: TEST_MODELS[0],
      prompt: "q",
      fetchFn: async () => ready("doi:10.1234/abc"),
      readBytes: async () => {
        throw new Error("must not read ready PDF");
      },
    });
    const metadata = JSON.parse(
      request.payload.client_metadata["x-codex-turn-metadata"],
    );
    assert.equal(metadata.paper_title, "MaSIF-neosurf paper");
    assert.equal(metadata.paper_id, "doi:10.1234/abc");
    assert.equal(request.payload.prompt_cache_key, "permanent-server-thread");
    assert.equal(cprPaperConversationTitle("", " Paper title "), "Paper title");
    assert.lengthOf(cprPaperConversationTitle("x".repeat(100), "unused"), 80);
  });
  it("uses the same server thread across devices without requiring a local ready PDF", async function () {
    pdfPath = false;
    const queries: unknown[] = [];
    const fetchFn: typeof fetch = async (_url, init) => {
      queries.push(JSON.parse(String(init?.body)));
      return ready("doi:10.1234/abc");
    };
    const first = await prepareCprPaperRequest({
      itemId,
      apiBase: TEST_API_BASE,
      apiKey: "test",
      model: TEST_MODELS[0],
      prompt: "first",
      fetchFn,
      readBytes: async () => {
        throw new Error("must not read ready PDF");
      },
    });
    prefs.clear();
    resetProviderSessionIdCacheForTests();
    itemId = 900;
    const second = await prepareCprPaperRequest({
      itemId,
      apiBase: TEST_API_BASE,
      apiKey: "test",
      model: TEST_MODELS[0],
      prompt: "second",
      fetchFn,
      readBytes: async () => {
        throw new Error("must not read ready PDF");
      },
    });
    assert.equal(first.paperId, second.paperId);
    assert.equal(
      first.payload.prompt_cache_key,
      second.payload.prompt_cache_key,
    );
    assert.equal(queries.length, 2);
    assert.deepEqual(second.payload.input[0].content, [
      { type: "input_text", text: "second" },
    ]);
  });
  it("keeps one paper identity, thread and reservation across all papers models", async function () {
    pdfPath = false;
    const bodies: Array<Record<string, any>> = [];
    const identities: string[] = [];
    const fetchFn: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      const metadata = JSON.parse(
        body.client_metadata["x-codex-turn-metadata"],
      );
      identities.push(metadata.paper_id);
      return ready(metadata.paper_id);
    };
    const requests = [];
    for (const model of TEST_MODELS) {
      requests.push(
        await prepareCprPaperRequest({
          itemId,
          apiBase: TEST_API_BASE,
          apiKey: "test",
          model,
          prompt: "question",
          fetchFn,
          readBytes: async () => {
            throw new Error("must not read ready PDF");
          },
        }),
      );
    }
    // Same paper, same permanent thread, same question — only the model differs.
    assert.deepEqual(
      requests.map((req) => req.payload.model),
      [...TEST_MODELS],
    );
    assert.deepEqual(
      bodies.map((body) => body.model),
      [...TEST_MODELS],
    );
    assert.deepEqual(
      requests.map((req) => req.payload.prompt_cache_key),
      Array(TEST_MODELS.length).fill("permanent-server-thread"),
    );
    assert.equal(new Set(identities).size, 1);
    assert.equal(identities[0], "doi:10.1234/abc");
    assert.deepEqual(
      requests.map((req) => req.payload.input[0].content),
      Array(TEST_MODELS.length).fill([
        { type: "input_text", text: "question" },
      ]),
    );
    // Identity and reservation keys never carry the model: switching models
    // must not look like a new paper or a new upload.
    for (const key of prefs.keys()) assert.notInclude(String(key), "gpt-5.6");
  });

  it("forwards explicit effort and does not keep a papers-specific ladder", async function () {
    pdfPath = false;
    const efforts: unknown[] = [];
    const fetchFn: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      efforts.push(body.reasoning?.effort);
      return ready("doi:10.1234/abc");
    };
    const send = (model: string, reasoning?: any) =>
      prepareCprPaperRequest({
        itemId,
        apiBase: TEST_API_BASE,
        apiKey: "test",
        model,
        reasoning,
        prompt: "q",
        fetchFn,
        readBytes: async () => {
          throw new Error("must not read ready PDF");
        },
      });
    const selected = await send("arbitrary-reading-alias", {
      provider: "openai",
      level: "xhigh",
      effort: "xhigh",
    });
    assert.equal(selected.payload.reasoning.effort, "xhigh");
    const paperShaped = await send("papers/gpt-6-sol", {
      provider: "openai",
      level: "medium",
      effort: "medium",
    });
    assert.equal(paperShaped.payload.reasoning.effort, "medium");
    const unknown = await send("papers/gpt-5.6-sol", {
      provider: "openai",
      level: "future-level",
    });
    assert.equal(unknown.payload.reasoning.effort, "future-level");
    const undeclared = await send("chatgpt-web/gpt-6-sol");
    assert.notProperty(undeclared.payload, "reasoning");
    // Preparation sends only lookups; the lookup carries no reasoning.
    assert.deepEqual(efforts, Array(4).fill(undefined));
  });

  it("forwards an unrecognized level to the server instead of rejecting it locally", async function () {
    const fetchFn: typeof fetch = async () => ready("doi:10.1234/abc");
    const cases: Array<[string, string]> = [
      ["papers/gpt-5.6-sol-instant", "xhigh"],
      ["papers/gpt-5.6-pro", "high"],
      ["papers/gpt-5.6-sol", "high-temporary"],
      ["papers/gpt-5.6-sol", "ultra"],
    ];
    const efforts: string[] = [];
    for (const [model, level] of cases) {
      const request = await prepareCprPaperRequest({
        itemId,
        apiBase: TEST_API_BASE,
        apiKey: "test",
        model,
        reasoning: { provider: "openai", level },
        prompt: "q",
        fetchFn,
        readBytes: async () => new TextEncoder().encode("%PDF-test"),
      });
      efforts.push(request.payload.reasoning.effort);
    }
    assert.deepEqual(
      efforts,
      cases.map(([, level]) => level),
    );
  });

  for (const uploadToken of ["", "   "]) {
    it(`rejects a blank upload reservation ${JSON.stringify(uploadToken)} before reading the PDF`, async function () {
      let calls = 0;
      let reads = 0;
      let caught: unknown;
      try {
        await prepareCprPaperRequest({
          itemId,
          apiBase: TEST_API_BASE,
          apiKey: "test",
          model: TEST_MODELS[0],
          prompt: "read",
          fetchFn: async () => {
            calls++;
            return ready("doi:10.1234/abc", "missing", {
              upload_token: uploadToken,
            });
          },
          readBytes: async () => {
            reads++;
            return new TextEncoder().encode("%PDF-test");
          },
        });
      } catch (error) {
        caught = error;
      }
      assert.include(String(caught), "CPR 论文登记格式不正确");
      assert.equal(calls, 1);
      assert.equal(reads, 0);
      assert.isFalse(
        [...prefs.keys()].some((key) => key.includes(".cprPaperReservation.")),
      );
    });
  }
  it("preserves the valid reservation when the fingerprint lookup returns a blank token", async function () {
    let calls = 0;
    let caught: unknown;
    try {
      await prepareCprPaperRequest({
        itemId,
        apiBase: TEST_API_BASE,
        apiKey: "test",
        model: TEST_MODELS[0],
        prompt: "read",
        fetchFn: async () =>
          ready("doi:10.1234/abc", "missing", {
            upload_token: ++calls === 1 ? "valid-reservation" : "",
          }),
        readBytes: async () => new TextEncoder().encode("%PDF-test"),
      });
    } catch (error) {
      caught = error;
    }
    assert.include(String(caught), "CPR 论文登记格式不正确");
    assert.equal(calls, 2);
    const reservations = [...prefs.entries()].filter(([key]) =>
      key.includes(".cprPaperReservation."),
    );
    assert.lengthOf(reservations, 1);
    assert.equal(reservations[0][1], "valid-reservation");
  });
  it("uploads only with the server reservation, including its PDF hash", async function () {
    const req = await prepareCprPaperRequest({
      itemId,
      apiBase: TEST_API_BASE,
      apiKey: "test",
      model: TEST_MODELS[0],
      prompt: "read",
      fetchFn: async () =>
        ready("doi:10.1234/abc", "missing", { upload_token: "reservation" }),
      readBytes: async () => new TextEncoder().encode("%PDF-test"),
    });
    assert.equal(
      req.payload.input[0].content.filter((p) => p.type === "input_file")
        .length,
      1,
    );
    const metadata = JSON.parse(
      req.payload.client_metadata["x-codex-turn-metadata"],
    );
    assert.equal(metadata.paper_upload_token, "reservation");
    assert.match(metadata.paper_pdf_sha256, /^[a-f0-9]{64}$/);
    assert.equal(metadata.paper_id, "doi:10.1234/abc");
  });
  it("checks a new DOI's fingerprint before uploading an already-known PDF", async function () {
    let calls = 0;
    const req = await prepareCprPaperRequest({
      itemId,
      apiBase: TEST_API_BASE,
      apiKey: "test",
      model: TEST_MODELS[0],
      prompt: "read",
      fetchFn: async (_url, init) => {
        calls++;
        const metadata = JSON.parse(
          JSON.parse(String(init?.body)).client_metadata[
            "x-codex-turn-metadata"
          ],
        );
        if (calls === 1)
          return ready("doi:10.1234/abc", "missing", {
            upload_token: "reservation",
          });
        assert.match(metadata.paper_pdf_sha256, /^[a-f0-9]{64}$/);
        assert.equal(metadata.paper_upload_token, "reservation");
        return ready("doi:10.1234/abc");
      },
      readBytes: async () => new TextEncoder().encode("%PDF-known"),
    });
    assert.equal(calls, 2);
    assert.equal(req.payload.input[0].content.length, 1);
  });
  it("derives no-DOI identity from PDF bytes, not the filename", async function () {
    doi = "";
    let queried = "";
    const pdfBytes = new TextEncoder().encode("%PDF-test");
    const req = await prepareCprPaperRequest({
      itemId,
      apiBase: TEST_API_BASE,
      apiKey: "test",
      model: TEST_MODELS[0],
      prompt: "read",
      fetchFn: async (_url, init) => {
        queried = JSON.parse(
          JSON.parse(String(init?.body)).client_metadata[
            "x-codex-turn-metadata"
          ],
        ).paper_id;
        return ready(queried);
      },
      readBytes: async () => pdfBytes,
    });
    assert.equal(
      queried,
      `sha256:${createHash("sha256").update(pdfBytes).digest("hex")}`,
    );
    assert.equal(req.payload.input[0].content.length, 1);
  });
  it("keeps a durable paper session per fresh local conversation and leaves legacy chats on the default session", function () {
    assert.isUndefined(resolveCprPaperSessionId(41, false));
    const first = resolveCprPaperSessionId(41, true);
    assert.match(String(first), /^[a-f0-9]{32}$/);
    assert.equal(resolveCprPaperSessionId(41, false), first);
    assert.equal(resolveCprPaperSessionId(41, true), first);
    const second = resolveCprPaperSessionId(42, true);
    assert.match(String(second), /^[a-f0-9]{32}$/);
    assert.notEqual(second, first);
    assert.equal(
      prefs.get(`${config.prefsPrefix}.cprPaperSession.41`),
      first,
    );
    assert.equal(
      prefs.get(`${config.prefsPrefix}.cprPaperSession.42`),
      second,
    );
  });
  it("scopes the registry, chat and upload reservation to the paper session", async function () {
    const seen: Array<Record<string, unknown>> = [];
    const tokens = new Map<string, string>();
    const fetchFn: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const metadata = JSON.parse(
        body.client_metadata["x-codex-turn-metadata"],
      );
      seen.push(metadata);
      const token = `token-${metadata.paper_session_id}`;
      tokens.set(String(metadata.paper_session_id), token);
      return ready(
        "doi:10.1234/abc",
        "missing",
        { upload_token: token },
        String(metadata.paper_session_id),
      );
    };
    const prepare = (paperSessionId: string) =>
      prepareCprPaperRequest({
        itemId,
        apiBase: TEST_API_BASE,
        apiKey: "test",
        model: TEST_MODELS[0],
        paperSessionId,
        prompt: "question",
        fetchFn,
        readBytes: async () => new TextEncoder().encode("%PDF-session"),
      });
    const first = await prepare("session-a");
    const second = await prepare("session-b");
    assert.equal(first.registry.paper_session_id, "session-a");
    assert.equal(second.registry.paper_session_id, "session-b");
    assert.deepEqual(tokens, new Map([
      ["session-a", "token-session-a"],
      ["session-b", "token-session-b"],
    ]));
    assert.isTrue(
      seen.every(
        (metadata) =>
          metadata.paper_registry_version === 2 &&
          (metadata.paper_session_id === "session-a" ||
            metadata.paper_session_id === "session-b"),
      ),
    );
    for (const request of [first, second]) {
      const metadata = JSON.parse(
        request.payload.client_metadata["x-codex-turn-metadata"],
      );
      assert.equal(metadata.paper_registry_version, 2);
      assert.equal(metadata.paper_session_id, request.registry.paper_session_id);
    }
    const reservations = [...prefs.entries()].filter(([key]) =>
      key.includes(".cprPaperReservation."),
    );
    assert.lengthOf(reservations, 2);
    assert.isTrue(
      reservations.every(
        ([key, value]) =>
          (String(key).includes("session-a") &&
            value === "token-session-a") ||
          (String(key).includes("session-b") &&
            value === "token-session-b"),
      ),
    );
  });
  it("does not upload when a different client is pending or the prior send is uncertain", async function () {
    for (const status of ["pending", "uncertain"]) {
      let caught: unknown;
      try {
        await prepareCprPaperRequest({
          itemId,
          apiBase: TEST_API_BASE,
          apiKey: "test",
          model: TEST_MODELS[0],
          prompt: "read",
          fetchFn: async () => ready("doi:10.1234/abc", status),
          readBytes: async () => {
            throw new Error("must not read PDF");
          },
        });
      } catch (error) {
        caught = error;
      }
      assert.instanceOf(caught, Error);
      assert.notInclude(String(caught), "must not read PDF");
    }
  });
});
