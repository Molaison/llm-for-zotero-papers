import { assert } from "chai";
import { fetchCprPaperHistory, parseCprPaperHistory, prepareCprPaperRequest, normalizePaperDoi, cprPaperConversationTitle, CPR_PAPERS_API_BASE, CPR_PAPERS_MODELS } from "../src/utils/cprPapers";
import { resetProviderSessionIdCacheForTests } from "../src/utils/providerSessionId";
import { createPaperPortalItem, resolveConversationBaseItem } from "../src/modules/contextPanel/portalScope";

const ready = (paperId: string, status = "ready", extra = {}) => new Response(JSON.stringify({
  status: "completed", output: [{type: "message", role: "assistant", content: [{type: "output_text", text: JSON.stringify({
    paper_id: paperId, thread_id: "permanent-server-thread", status, upload_required: status === "missing", ...extra,
  })}]}],
}), {headers: {"content-type": "application/json"}});

describe("CPR server-owned paper registry client", function () {
  let original: typeof Zotero;
  let prefs: Map<string, unknown>;
  let doi: string;
  let itemId: number;
  let shortTitle: string;
  beforeEach(function () {
    original = globalThis.Zotero;
    prefs = new Map(); doi = "https://doi.org/10.1234/ABC"; itemId = 7;
    shortTitle = "";
    resetProviderSessionIdCacheForTests();
    globalThis.Zotero = {Prefs: {get: (k: string) => prefs.get(k), set: (k: string, v: unknown) => prefs.set(k, v)},
      Items: {get: () => ({id: itemId, key: String(itemId), libraryID: itemId, isRegularItem: () => true,
        isAttachment: () => false, getField: (field: string) => field === "DOI" ? doi : field === "shortTitle" ? shortTitle : "Paper title",
        getBestAttachment: async () => ({attachmentContentType: "application/pdf", getFilePathAsync: async () => "/paper.pdf"}),
      })},
    } as unknown as typeof Zotero;
  });
  afterEach(function () {globalThis.Zotero = original; resetProviderSessionIdCacheForTests();});
  it("rejects a missing Zotero item before lookup instead of calling a method on false", async function () {
    // Zotero returns false for an unknown ID, including a portal conversation ID.
    Zotero.Items.get = (() => false) as typeof Zotero.Items.get;
    let caught: unknown;
    let fetches = 0;
    try {
      await prepareCprPaperRequest({itemId: 1500000126, apiBase: CPR_PAPERS_API_BASE, apiKey: "test", prompt: "q",
        fetchFn: async () => {fetches++; return ready("doi:10.1234/abc");},
        readBytes: async () => {throw new Error("must not read PDF");}});
    } catch (error) {caught = error;}
    assert.instanceOf(caught, Error);
    assert.notInstanceOf(caught, TypeError);
    assert.include(String(caught), "需要先选择一篇论文");
    assert.equal(fetches, 0);
  });
  it("rejects another paper's reservation before reading or fingerprinting the PDF", async function () {
    let calls = 0;
    let reads = 0;
    let caught: unknown;
    try {
      await prepareCprPaperRequest({
        itemId,
        apiBase: CPR_PAPERS_API_BASE,
        apiKey: "test",
        prompt: "q",
        fetchFn: async () => {
          calls++;
          return calls === 1
            ? ready("doi:10.1234/other", "missing", { upload_token: "wrong-paper-token" })
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
    assert.isFalse([...prefs.keys()].some(key => key.includes(".cprPaperReservation.")));
  });
  it("rejects a different paper returned by the fingerprint lookup", async function () {
    let calls = 0;
    let caught: unknown;
    try {
      await prepareCprPaperRequest({
        itemId,
        apiBase: CPR_PAPERS_API_BASE,
        apiKey: "test",
        prompt: "q",
        fetchFn: async () => {
          calls++;
          return calls === 1
            ? ready("doi:10.1234/abc", "missing", { upload_token: "own-paper-token" })
            : ready("doi:10.1234/other", "missing", { upload_token: "wrong-paper-token" });
        },
        readBytes: async () => new TextEncoder().encode("%PDF-test"),
      });
    } catch (error) {
      caught = error;
    }
    assert.include(String(caught), "不同的论文身份");
    assert.equal(calls, 2);
    const reservations = [...prefs.entries()].filter(([key]) => key.includes(".cprPaperReservation."));
    assert.lengthOf(reservations, 1);
    assert.equal(reservations[0][1], "own-paper-token");
  });
  it("resolves different paper portal sessions to the real item and same saved thread", async function () {
    const paper = Zotero.Items.get(itemId);
    const lookups: number[] = [];
    Zotero.Items.get = ((id: number) => {
      lookups.push(id);
      return id === paper.id ? paper : false;
    }) as typeof Zotero.Items.get;
    for (const key of [1500000126, 1500000127]) {
      const portal = createPaperPortalItem(paper, key, 1);
      const request = await prepareCprPaperRequest({itemId: resolveConversationBaseItem(portal)?.id,
        apiBase: CPR_PAPERS_API_BASE, apiKey: "test", prompt: "q",
        fetchFn: async () => ready("doi:10.1234/abc"),
        readBytes: async () => {throw new Error("must not read ready PDF");}});
      assert.equal(request.paperId, "doi:10.1234/abc");
      assert.equal(request.payload.prompt_cache_key, "permanent-server-thread");
      assert.deepEqual(request.payload.input[0].content, [{type: "input_text", text: "q"}]);
    }
    assert.isNotEmpty(lookups);
    assert.isTrue(lookups.every(id => id === itemId));
  });
  it("normalizes DOI forms without using a device identity", function () {
    assert.equal(normalizePaperDoi(" DOI:10.1234/AbC "), "doi:10.1234/abc");
    assert.equal(normalizePaperDoi("https://dx.doi.org/10.1234/AbC"), "doi:10.1234/abc");
    assert.throws(() => normalizePaperDoi("not-a-doi"));
  });
  it("reads history without a resolve, reservation, inference, or PDF upload", async function () {
    const bodies: Array<Record<string, unknown>> = [];
    const message = {id: "remote-1", role: "assistant", text: "Saved answer", created_at: 1700000000000};
    const history = await fetchCprPaperHistory({itemId, apiBase: CPR_PAPERS_API_BASE, apiKey: "test",
      model: CPR_PAPERS_MODELS[0], readBytes: async () => {throw new Error("must not read DOI PDF");},
      fetchFn: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return ready("doi:10.1234/abc", "ready", {title: "Paper title", messages: [message],
          conversation_url: "https://chatgpt.com/g/g-p-6ac1534524788191a340f2407c76f370/c/test-chat"});
      }});
    assert.deepEqual(history.messages, [message]);
    assert.lengthOf(bodies, 1);
    assert.deepEqual(JSON.parse((bodies[0].client_metadata as Record<string, string>)["x-codex-turn-metadata"]),
      {paper_id: "doi:10.1234/abc", paper_operation: "history"});
    assert.isString(bodies[0].input);
    assert.notProperty(bodies[0], "reasoning");
    assert.equal(prefs.size, 0);
  });
  it("only hashes a no-DOI PDF locally for history and never transmits it", async function () {
    doi = "";
    let reads = 0;
    await fetchCprPaperHistory({itemId, apiBase: CPR_PAPERS_API_BASE, apiKey: "test", model: CPR_PAPERS_MODELS[0],
      readBytes: async () => {reads++; return new TextEncoder().encode("abc");},
      fetchFn: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        const metadata = JSON.parse(body.client_metadata["x-codex-turn-metadata"]);
        assert.equal(metadata.paper_id, "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert.notInclude(String(init?.body), "input_file");
        return ready(metadata.paper_id, "ready", {title: "Paper title", messages: [],
          conversation_url: "https://chatgpt.com/g/g-p-6ac1534524788191a340f2407c76f370/c/test-chat"});
      }});
    assert.equal(reads, 1);
    assert.equal(prefs.size, 0);
  });
  it("rejects mismatched, duplicate or hidden-role history before import", async function () {
    const base = {title: "Paper title", conversation_url: "https://chatgpt.com/g/g-p-6ac1534524788191a340f2407c76f370/c/test-chat"};
    const message = {id: "remote-1", role: "user", text: "q", created_at: null};
    for (const messages of [[message, message], [{...message, role: "system"}], [{...message, created_at: -1}]]) {
      assert.throws(() => parseCprPaperHistory({status: "completed", output: [{content: [{type: "output_text",
        text: JSON.stringify({...base, paper_id: "doi:10.1234/abc", thread_id: "thread", messages})}]}]}, "doi:10.1234/abc"));
    }
    const value = await ready("doi:10.1234/other", "ready", {...base, messages: [message]}).json();
    assert.throws(() => parseCprPaperHistory(value, "doi:10.1234/abc"), /不同的论文身份/);
  });
  it("reports an old server without retrying history as a chat", async function () {
    let calls = 0;
    let caught: unknown;
    try {
      await fetchCprPaperHistory({itemId, apiBase: CPR_PAPERS_API_BASE, apiKey: "test", model: CPR_PAPERS_MODELS[0],
        readBytes: async () => {throw new Error("must not read PDF");},
        fetchFn: async () => {calls++; return new Response(JSON.stringify({error: {code: "paper_operation_invalid"}}), {status: 400});}});
    } catch (error) {caught = error;}
    assert.include(String(caught), "服务端尚未启用");
    assert.equal(calls, 1);
    assert.equal(prefs.size, 0);
  });
  it("uses the short title for display without changing the paper identity", async function () {
    shortTitle = "  MaSIF-neosurf\n paper  ";
    const request = await prepareCprPaperRequest({itemId, apiBase: CPR_PAPERS_API_BASE, apiKey: "test", prompt: "q",
      fetchFn: async () => ready("doi:10.1234/abc"), readBytes: async () => {throw new Error("must not read ready PDF");}});
    const metadata = JSON.parse(request.payload.client_metadata["x-codex-turn-metadata"]);
    assert.equal(metadata.paper_title, "MaSIF-neosurf paper");
    assert.equal(metadata.paper_id, "doi:10.1234/abc");
    assert.equal(request.payload.prompt_cache_key, "permanent-server-thread");
    assert.equal(cprPaperConversationTitle("", " Paper title "), "Paper title");
    assert.lengthOf(cprPaperConversationTitle("x".repeat(100), "unused"), 80);
  });
  it("uses the same server thread across devices and does not read or transmit PDF on ready", async function () {
    const queries: unknown[] = [];
    const fetchFn: typeof fetch = async (_url, init) => {queries.push(JSON.parse(String(init?.body)));return ready("doi:10.1234/abc");};
    const first = await prepareCprPaperRequest({itemId, apiBase: CPR_PAPERS_API_BASE, apiKey: "test", prompt: "first", fetchFn,
      readBytes: async () => {throw new Error("must not read ready PDF");}});
    prefs.clear(); resetProviderSessionIdCacheForTests(); itemId = 900;
    const second = await prepareCprPaperRequest({itemId, apiBase: CPR_PAPERS_API_BASE, apiKey: "test", prompt: "second", fetchFn,
      readBytes: async () => {throw new Error("must not read ready PDF");}});
    assert.equal(first.paperId, second.paperId);
    assert.equal(first.payload.prompt_cache_key, second.payload.prompt_cache_key);
    assert.equal(queries.length, 2);
    assert.deepEqual(second.payload.input[0].content, [{type: "input_text", text: "second"}]);
  });
  it("keeps one paper identity, thread and reservation across all four papers models", async function () {
    const bodies: Array<Record<string, any>> = [];
    const identities: string[] = [];
    const fetchFn: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      const metadata = JSON.parse(body.client_metadata["x-codex-turn-metadata"]);
      identities.push(metadata.paper_id);
      return ready(metadata.paper_id);
    };
    const requests = [];
    for (const model of CPR_PAPERS_MODELS) {
      requests.push(
        await prepareCprPaperRequest({
          itemId, apiBase: CPR_PAPERS_API_BASE, apiKey: "test", model, prompt: "question", fetchFn,
          readBytes: async () => {throw new Error("must not read ready PDF");},
        }),
      );
    }
    // Same paper, same permanent thread, same question — only the model differs.
    assert.deepEqual(requests.map((req) => req.payload.model), [...CPR_PAPERS_MODELS]);
    assert.deepEqual(bodies.map((body) => body.model), [...CPR_PAPERS_MODELS]);
    assert.deepEqual(requests.map((req) => req.payload.prompt_cache_key), Array(4).fill("permanent-server-thread"));
    assert.equal(new Set(identities).size, 1);
    assert.equal(identities[0], "doi:10.1234/abc");
    assert.deepEqual(requests.map((req) => req.payload.input[0].content), Array(4).fill([{type: "input_text", text: "question"}]));
    // Identity and reservation keys never carry the model: switching models
    // must not look like a new paper or a new upload.
    for (const key of prefs.keys()) assert.notInclude(String(key), "papers/gpt");
  });

  it("sends the selected papers model's own effort, and none on the lookup", async function () {
    const efforts: unknown[] = [];
    const fetchFn: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      efforts.push(body.reasoning?.effort);
      return ready("doi:10.1234/abc");
    };
    const send = (model: string, reasoning?: any) =>
      prepareCprPaperRequest({itemId, apiBase: CPR_PAPERS_API_BASE, apiKey: "test", model, reasoning, prompt: "q", fetchFn,
        readBytes: async () => {throw new Error("must not read ready PDF");}});
    const sol = await send("papers/gpt-5.6-sol", {provider: "openai", level: "xhigh", effort: "xhigh"});
    assert.equal(sol.payload.reasoning.effort, "xhigh");
    const instant = await send("papers/gpt-5.6-sol-instant", {provider: "openai", level: "low"});
    assert.equal(instant.payload.reasoning.effort, "low");
    const pro = await send("papers/gpt-6-pro", {provider: "openai", level: "max"});
    assert.equal(pro.payload.reasoning.effort, "max");
    const unselected = await send("papers/gpt-5.6-sol");
    assert.equal(unselected.payload.reasoning.effort, "high");
    // Preparation sends only lookups; the chat payloads were asserted above.
    assert.deepEqual(efforts, Array(4).fill(undefined));
  });

  it("refuses an unsupported or mode-suffixed level before sending anything", async function () {
    let calls = 0;
    const fetchFn: typeof fetch = async () => {calls++; return ready("doi:10.1234/abc");};
    const cases: Array<[string, string]> = [
      ["papers/gpt-5.6-sol-instant", "xhigh"],
      ["papers/gpt-5.6-pro", "high"],
      ["papers/gpt-5.6-sol", "high-temporary"],
      ["papers/gpt-5.6-sol", "ultra"],
    ];
    for (const [model, level] of cases) {
      let caught: unknown;
      try {
        await prepareCprPaperRequest({itemId, apiBase: CPR_PAPERS_API_BASE, apiKey: "test", model,
          reasoning: {provider: "openai", level}, prompt: "q", fetchFn,
          readBytes: async () => new TextEncoder().encode("%PDF-test")});
      } catch (error) {caught = error;}
      assert.match(String(caught), /不支持思考强度/, `${model} ${level}`);
    }
    assert.equal(calls, 0);
  });

  it("uploads only with the server reservation, including its PDF hash", async function () {
    const req = await prepareCprPaperRequest({itemId, apiBase: CPR_PAPERS_API_BASE, apiKey: "test", prompt: "read", fetchFn: async () => ready("doi:10.1234/abc", "missing", {upload_token: "reservation"}),
      readBytes: async () => new TextEncoder().encode("%PDF-test")});
    assert.equal(req.payload.input[0].content.filter(p => p.type === "input_file").length, 1);
    const metadata = JSON.parse(req.payload.client_metadata["x-codex-turn-metadata"]);
    assert.equal(metadata.paper_upload_token, "reservation");
    assert.match(metadata.paper_pdf_sha256, /^[a-f0-9]{64}$/);
    assert.equal(metadata.paper_id, "doi:10.1234/abc");
  });
  it("checks a new DOI's fingerprint before uploading an already-known PDF", async function () {
    let calls = 0;
    const req = await prepareCprPaperRequest({itemId, apiBase: CPR_PAPERS_API_BASE, apiKey: "test", prompt: "read", fetchFn: async (_url, init) => {
      calls++;
      const metadata = JSON.parse(JSON.parse(String(init?.body)).client_metadata["x-codex-turn-metadata"]);
      if (calls === 1) return ready("doi:10.1234/abc", "missing", {upload_token: "reservation"});
      assert.match(metadata.paper_pdf_sha256, /^[a-f0-9]{64}$/);
      assert.equal(metadata.paper_upload_token, "reservation");
      return ready("doi:10.1234/abc");
    }, readBytes: async () => new TextEncoder().encode("%PDF-known")});
    assert.equal(calls, 2);
    assert.equal(req.payload.input[0].content.length, 1);
  });
  it("derives no-DOI identity from PDF bytes, not the filename", async function () {
    doi = "";let queried = "";
    const req = await prepareCprPaperRequest({itemId, apiBase: CPR_PAPERS_API_BASE, apiKey: "test", prompt: "read", fetchFn: async (_url, init) => {
      queried = JSON.parse(JSON.parse(String(init?.body)).client_metadata["x-codex-turn-metadata"]).paper_id;
      return ready(queried);
    }, readBytes: async () => new TextEncoder().encode("abc")});
    assert.equal(queried, "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    assert.equal(req.payload.input[0].content.length, 1);
  });
  it("does not upload when a different client is pending or the prior send is uncertain", async function () {
    for (const status of ["pending", "uncertain"]) {
      let caught: unknown;
      try {await prepareCprPaperRequest({itemId, apiBase: CPR_PAPERS_API_BASE, apiKey: "test", prompt: "read", fetchFn: async () => ready("doi:10.1234/abc", status),
        readBytes: async () => {throw new Error("must not read PDF");}});} catch (error) {caught = error;}
      assert.instanceOf(caught, Error);
      assert.notInclude(String(caught), "must not read PDF");
    }
  });
});
