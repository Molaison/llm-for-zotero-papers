import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  CPR_PAPERS_API_BASE,
  prepareCprPaperRequest,
} from "../src/utils/cprPapers";
import { resetProviderSessionIdCacheForTests } from "../src/utils/providerSessionId";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const paperId = "doi:10.1234/identity";
const threadId = "existing-paper-thread";

function resolution(extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    status: "completed",
    output: [{ type: "message", role: "assistant", content: [{
      type: "output_text",
      text: JSON.stringify({
        paper_id: paperId,
        thread_id: threadId,
        status: "ready",
        upload_required: false,
        ...extra,
      }),
    }] }],
  }));
}

describe("CPR papers existing PDF identity", function () {
  let original: typeof Zotero;
  let hasAttachment: boolean;
  let bestPath: string | false;
  let doi: string;
  let contents: Map<string, string>;
  let reads: string[];
  let requests: Array<Record<string, any>>;
  let prepare: (
    overrides?: Partial<Parameters<typeof prepareCprPaperRequest>[0]>,
  ) => ReturnType<typeof prepareCprPaperRequest>;

  beforeEach(function () {
    original = globalThis.Zotero;
    hasAttachment = true;
    bestPath = "/paper.pdf";
    doi = "10.1234/identity";
    contents = new Map([["/paper.pdf", "%PDF-A"], ["/selected.pdf", "%PDF-B"]]);
    reads = [];
    requests = [];
    const prefs = new Map<string, unknown>();
    const attachment = {
      id: 8, parentID: 7, attachmentContentType: "application/pdf",
      isRegularItem: () => false, isAttachment: () => true,
      getFilePathAsync: async () => bestPath,
    };
    const selected = { ...attachment, id: 9, getFilePathAsync: async () => "/selected.pdf" };
    const paper = {
      id: 7, key: "PAPER", libraryID: 1,
      isRegularItem: () => true, isAttachment: () => false,
      getField: (field: string) => field === "DOI" ? doi : "Paper",
      getBestAttachment: async () => hasAttachment ? attachment : false,
    };
    globalThis.Zotero = {
      Prefs: { get: (key: string) => prefs.get(key), set: (key: string, value: unknown) => prefs.set(key, value) },
      Items: { get: (id: number) => id === 7 ? paper : id === 8 ? attachment : id === 9 ? selected : false },
    } as unknown as typeof Zotero;
    resetProviderSessionIdCacheForTests();
    const fetchFn: typeof fetch = async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      requests.push(request);
      const metadata = JSON.parse(request.client_metadata["x-codex-turn-metadata"]);
      if (metadata.paper_pdf_sha256 && metadata.paper_pdf_sha256 !== hash("%PDF-A")) {
        return new Response(JSON.stringify({ error: { code: "paper_identity_conflict" } }), { status: 409 });
      }
      return resolution({ paper_id: metadata.paper_id });
    };
    prepare = (overrides = {}) => prepareCprPaperRequest({
      itemId: 7, apiBase: CPR_PAPERS_API_BASE, apiKey: "fixture-only",
      model: "papers/gpt-6-sol", prompt: "Question",
      readBytes: async path => {
        reads.push(path);
        const content = contents.get(path);
        if (content === undefined) throw new Error("fixture file unavailable");
        return new TextEncoder().encode(content);
      },
      fetchFn,
      ...overrides,
    });
  });

  afterEach(function () {
    globalThis.Zotero = original;
    resetProviderSessionIdCacheForTests();
  });

  it("checks an available ready PDF and retains its hash on the text-only chat", async function () {
    const request = await prepare();
    assert.deepEqual(reads, ["/paper.pdf"]);
    assert.equal(requests.length, 2);
    const metadata = requests.map(body => JSON.parse(body.client_metadata["x-codex-turn-metadata"]));
    assert.equal(metadata[0].paper_pdf_sha256, undefined);
    assert.equal(metadata[1].paper_pdf_sha256, hash("%PDF-A"));
    assert.equal(metadata[1].paper_operation, "resolve");
    const chat = JSON.parse(request.payload.client_metadata["x-codex-turn-metadata"]);
    assert.equal(chat.paper_pdf_sha256, hash("%PDF-A"));
    assert.equal(chat.paper_upload_token, undefined);
    assert.equal(request.payload.prompt_cache_key, threadId);
    assert.deepEqual(request.payload.input[0].content, [{ type: "input_text", text: "Question" }]);
  });

  it("rejects a changed PDF at the same path before constructing a new chat", async function () {
    await prepare();
    contents.set("/paper.pdf", "%PDF-B");
    await assert.rejects(prepare(), /paper_identity_conflict/);
    assert.deepEqual(reads, ["/paper.pdf", "/paper.pdf"]);
    assert.equal(requests.length, 4);
    assert.ok(requests.every(body => JSON.parse(body.client_metadata["x-codex-turn-metadata"]).paper_operation === "resolve"));
    assert.ok(requests.every(body => !JSON.stringify(body).includes("input_file")));
  });

  it("checks the explicitly selected attachment instead of the parent's best PDF", async function () {
    await assert.rejects(prepare({ itemId: 9 }), /paper_identity_conflict/);
    assert.deepEqual(reads, ["/selected.pdf"]);
    assert.equal(requests.length, 2);
  });

  for (const missing of ["attachment", "local path"] as const) {
    it(`continues a ready remote paper when the ${missing} is missing`, async function () {
      if (missing === "attachment") hasAttachment = false;
      else bestPath = false;
      const request = await prepare();
      assert.deepEqual(reads, []);
      assert.equal(requests.length, 1);
      assert.equal(request.payload.prompt_cache_key, threadId);
      assert.deepEqual(request.payload.input[0].content, [{ type: "input_text", text: "Question" }]);
      assert.equal(JSON.parse(request.payload.client_metadata["x-codex-turn-metadata"]).paper_pdf_sha256, undefined);
    });
  }

  it("does not treat a local read error as proof that the attachment is absent", async function () {
    await assert.rejects(prepare({ readBytes: async () => { throw new Error("disk read failed"); } }), /disk read failed/);
    assert.equal(requests.length, 1);
  });

  it("rejects non-PDF bytes before sending a fingerprint claim", async function () {
    contents.set("/paper.pdf", "this is not a PDF");
    await assert.rejects(prepare(), /有效的 PDF/);
    assert.equal(requests.length, 1);
  });

  it("stops after a cancellation during the local read", async function () {
    const controller = new AbortController();
    await assert.rejects(prepare({
      signal: controller.signal,
      readBytes: async () => {
        controller.abort();
        return new TextEncoder().encode("%PDF-A");
      },
    }), { name: "AbortError" });
    assert.equal(requests.length, 1);
  });

  for (const changed of [
    { thread_id: "different-thread" },
    { status: "missing", upload_required: true, upload_token: "new-reservation" },
  ]) {
    it(`refuses a ready binding that changes during fingerprint validation: ${JSON.stringify(changed)}`, async function () {
      let calls = 0;
      await assert.rejects(prepare({
        fetchFn: async () => resolution(++calls === 1 ? {} : changed),
      }), /论文.*(会话|状态).*变化/);
      assert.equal(calls, 2);
    });
  }

  it("carries a no-DOI fingerprint on the first lookup and the later chat", async function () {
    doi = "";
    const request = await prepare();
    assert.equal(request.paperId, `sha256:${hash("%PDF-A")}`);
    assert.deepEqual(reads, ["/paper.pdf"]);
    assert.equal(requests.length, 1);
    assert.equal(JSON.parse(requests[0].client_metadata["x-codex-turn-metadata"]).paper_pdf_sha256, hash("%PDF-A"));
    assert.equal(JSON.parse(request.payload.client_metadata["x-codex-turn-metadata"]).paper_pdf_sha256, hash("%PDF-A"));
  });

  it("does not reinterpret a missing paper without a local PDF as ready", async function () {
    hasAttachment = false;
    let calls = 0;
    await assert.rejects(prepare({
      fetchFn: async () => {
        calls++;
        return resolution({ status: "missing", upload_required: true, upload_token: "reservation" });
      },
    }), /没有 PDF 附件/);
    assert.equal(calls, 1);
  });
});
