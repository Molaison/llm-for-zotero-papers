import { assert } from "chai";
import { createHash } from "node:crypto";
import {
  CPR_DIRECT_WEB_UNCERTAIN_MESSAGE,
  isCprDirectWebModel,
  prepareCprDirectWebRequest,
  resolveCprDirectWebSessionId,
  type CprDirectWebPrepareParams,
  type CprDirectWebPayload,
} from "../src/utils/cprDirectWeb";
import { CPR_PAPERS_API_BASE } from "../src/utils/cprPapers";
import { resetProviderSessionIdCacheForTests } from "../src/utils/providerSessionId";
import type { PaperContextRef } from "../src/shared/types";

const WEB_MODEL = "chatgpt-web/gpt-5.6-sol";
const MIB = 1024 * 1024;

const pdfBytes = (marker: string, size = 0): Uint8Array => {
  const head = new TextEncoder().encode(`%PDF-1.4 ${marker}\n`);
  const bytes = new Uint8Array(head.length + size);
  bytes.set(head);
  return bytes;
};
const digestOf = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
const refOf = (itemId: number, contextItemId: number, title = "Paper"): PaperContextRef => ({
  itemId,
  contextItemId,
  title,
});

type StoredLedger = {
  version: number;
  entries: Array<Record<string, unknown>>;
  pending: Array<Record<string, unknown>>;
  uncertain: Array<Record<string, unknown>>;
};

describe("CPR direct web multi-PDF preparation", function () {
  let original: typeof Zotero;
  let prefs: Map<string, unknown>;
  let papers: Map<number, string>;
  let attachments: Map<number, { parent: number; contentType: string; path: string }>;
  let files: Map<string, Uint8Array>;
  let reads: string[];

  const addPaper = (itemId: number, doi: string): void => void papers.set(itemId, doi);
  const addAttachment = (
    id: number,
    parent: number,
    path: string,
    contentType = "application/pdf",
  ): void => void attachments.set(id, { parent, contentType, path });

  const reader = async (path: string): Promise<Uint8Array> => {
    reads.push(path);
    const bytes = files.get(path);
    if (!bytes) throw new Error(`unexpected read of ${path}`);
    return bytes;
  };

  const prepare = (
    over: Partial<CprDirectWebPrepareParams> = {},
  ): ReturnType<typeof prepareCprDirectWebRequest> =>
    prepareCprDirectWebRequest({
      refs: [],
      apiBase: CPR_PAPERS_API_BASE,
      model: WEB_MODEL,
      prompt: "总结这两篇",
      requestScope: { operationId: "op-1" },
      reasoning: { provider: "openai", level: "high" },
      readBytes: reader,
      ...over,
    });

  const contentTypes = (payload: CprDirectWebPayload): string[] =>
    payload.input[0].content.map((part) => part.type);
  const filesOf = (payload: CprDirectWebPayload): string[] =>
    payload.input[0].content.flatMap((part) =>
      part.type === "input_file" ? [part.filename] : [],
    );
  const textOf = (payload: CprDirectWebPayload): string => {
    const last = payload.input[0].content[payload.input[0].content.length - 1];
    assert.equal(last.type, "input_text");
    return last.type === "input_text" ? last.text : "";
  };
  const metadataOf = (payload: CprDirectWebPayload): Record<string, unknown> =>
    JSON.parse(payload.client_metadata["x-codex-turn-metadata"]);
  const ledgerKey = (sessionId?: string): string => {
    const keys = [...prefs.keys()].filter((key) => key.includes(".cprDirectWebLedger."));
    assert.lengthOf(keys, 1);
    if (sessionId) assert.include(keys[0], encodeURIComponent(sessionId));
    return keys[0];
  };
  const ledgerOf = (sessionId?: string): StoredLedger =>
    JSON.parse(String(prefs.get(ledgerKey(sessionId))));

  beforeEach(function () {
    original = globalThis.Zotero;
    prefs = new Map();
    papers = new Map();
    attachments = new Map();
    files = new Map();
    reads = [];
    resetProviderSessionIdCacheForTests();
    globalThis.Zotero = {
      Prefs: {
        get: (key: string) => prefs.get(key),
        set: (key: string, value: unknown) => prefs.set(key, value),
      },
      Items: {
        get: (id: number) => {
          if (papers.has(id)) {
            const doi = papers.get(id);
            return {
              id,
              libraryID: 1,
              isRegularItem: () => true,
              isAttachment: () => false,
              getField: (field: string) => (field === "DOI" ? doi : ""),
              getBestAttachment: async () => {
                throw new Error("must never fall back to the best attachment");
              },
            };
          }
          const attachment = attachments.get(id);
          if (attachment) {
            return {
              id,
              libraryID: 1,
              parentID: attachment.parent,
              isRegularItem: () => false,
              isAttachment: () => true,
              attachmentContentType: attachment.contentType,
              getFilePathAsync: async () => attachment.path,
            };
          }
          // Zotero returns false for an unknown id.
          return false;
        },
      },
    } as unknown as typeof Zotero;
  });

  afterEach(function () {
    globalThis.Zotero = original;
    resetProviderSessionIdCacheForTests();
  });

  it("orders two new PDFs and one numbered instruction text behind them", async function () {
    addPaper(11, "https://doi.org/10.1000/AAA");
    addPaper(12, "https://doi.org/10.1000/bbb");
    addAttachment(101, 11, "/library/first.pdf");
    addAttachment(102, 12, "/library/second.pdf");
    files.set("/library/first.pdf", pdfBytes("A"));
    files.set("/library/second.pdf", pdfBytes("B"));

    const prepared = await prepare({
      refs: [refOf(11, 101, "First"), refOf(12, 102, "Second")],
    });

    assert.deepEqual(contentTypes(prepared.payload), [
      "input_file",
      "input_file",
      "input_text",
    ]);
    assert.deepEqual(filesOf(prepared.payload), ["first.pdf", "second.pdf"]);
    assert.deepEqual(
      prepared.uploaded.map((file) => [file.paperId, file.order]),
      [
        ["doi:10.1000/aaa", 0],
        ["doi:10.1000/bbb", 1],
      ],
    );
    assert.match(textOf(prepared.payload), /1\. first\.pdf[\s\S]*2\. second\.pdf/);
    assert.match(textOf(prepared.payload), /总结这两篇$/);
    assert.equal(prepared.payload.model, WEB_MODEL);
    assert.equal(prepared.payload.stream, true);
    assert.equal(prepared.payload.reasoning.effort, "high");
    assert.equal(prepared.payload.prompt_cache_key, prepared.sessionId);
    assert.notProperty(prepared.payload, "previous_response_id");
    assert.deepEqual(contentTypes(prepared.payload).length, 3);
    const metadata = metadataOf(prepared.payload);
    assert.deepEqual(Object.keys(metadata), [
      "thread_id",
      "turn_id",
      "zotero_pdf_contexts",
    ]);
    assert.notProperty(metadata, "paper_operation");
    assert.notProperty(metadata, "paper_id");
    assert.equal(metadata.thread_id, prepared.sessionId);
    assert.notEqual(metadata.turn_id, prepared.sessionId);
    assert.deepEqual(
      (metadata.zotero_pdf_contexts as Array<Record<string, string>>).map(
        (entry) => entry.paper_id,
      ),
      ["doi:10.1000/aaa", "doi:10.1000/bbb"],
    );
    assert.deepEqual(
      (metadata.zotero_pdf_contexts as Array<Record<string, string>>).map(
        (entry) => entry.pdf_sha256,
      ),
      prepared.uploaded.map((file) => file.pdfSha256),
    );
  });

  it("keeps one session for a conversation and reuses a registered DOI without reading", async function () {
    addPaper(11, "https://doi.org/10.1000/aaa");
    addAttachment(101, 11, "/library/first.pdf");
    files.set("/library/first.pdf", pdfBytes("A"));
    const scope = { conversationKey: 42 };
    const refs = [refOf(11, 101, "First")];

    const first = await prepare({ refs, requestScope: scope });
    first.accept();
    assert.lengthOf(reads, 1);

    const second = await prepare({ refs, requestScope: scope, prompt: "继续" });
    assert.lengthOf(reads, 1);
    assert.lengthOf(second.uploaded, 0);
    assert.deepEqual(second.reused, ["doi:10.1000/aaa"]);
    assert.deepEqual(contentTypes(second.payload), ["input_text"]);
    assert.equal(textOf(second.payload), "继续");
    assert.equal(second.payload.prompt_cache_key, first.payload.prompt_cache_key);
    assert.equal(second.sessionId, first.sessionId);
  });

  it("resolves DOI and no-DOI identities in one request and dedupes a repeated paper", async function () {
    const withoutDoi = pdfBytes("no-doi");
    addPaper(11, "https://doi.org/10.1000/aaa");
    addPaper(12, "");
    addAttachment(101, 11, "/library/first.pdf");
    addAttachment(102, 12, "/library/second.pdf");
    addAttachment(103, 12, "/library/second-copy.pdf");
    files.set("/library/first.pdf", pdfBytes("A"));
    files.set("/library/second.pdf", withoutDoi);
    files.set("/library/second-copy.pdf", withoutDoi);

    const prepared = await prepare({
      refs: [refOf(11, 101), refOf(12, 102), refOf(12, 103)],
    });

    assert.deepEqual(
      prepared.uploaded.map((file) => file.paperId),
      ["doi:10.1000/aaa", `sha256:${digestOf(withoutDoi)}`],
    );
    assert.deepEqual(filesOf(prepared.payload), ["first.pdf", "second.pdf"]);
    assert.lengthOf(reads, 3);
  });

  it("refuses a different hash for a DOI that already has a record", async function () {
    addPaper(11, "https://doi.org/10.1000/aaa");
    addAttachment(101, 11, "/library/first.pdf");
    files.set("/library/first.pdf", pdfBytes("A"));
    const scope = { conversationKey: 7 };
    const refs = [refOf(11, 101, "First")];

    const pending = await prepare({ refs, requestScope: scope });
    assert.lengthOf(pending.uploaded, 1);
    assert.equal(pending.uploaded[0].pdfSha256, digestOf(pdfBytes("A")));

    files.set("/library/first.pdf", pdfBytes("A-different-content"));
    let caught: unknown;
    try {
      await prepare({ refs, requestScope: scope });
    } catch (error) {
      caught = error;
    }
    assert.include(String(caught), "同一 DOI 已登记不同的 PDF 指纹");
  });

  it("treats an uncertain upload as not re-sendable but still chats without files", async function () {
    addPaper(11, "https://doi.org/10.1000/aaa");
    addAttachment(101, 11, "/library/first.pdf");
    files.set("/library/first.pdf", pdfBytes("A"));
    const scope = { conversationKey: 9 };
    const refs = [refOf(11, 101, "First")];

    const first = await prepare({ refs, requestScope: scope });
    first.markUncertain("响应中断");
    assert.lengthOf(reads, 1);
    assert.deepEqual(ledgerOf(first.sessionId).uncertain, [
      {
        paperId: "doi:10.1000/aaa",
        pdfSha256: digestOf(pdfBytes("A")),
        filename: "first.pdf",
        order: 0,
        reason: "响应中断",
      },
    ]);

    const followUp = await prepare({ refs, requestScope: scope, prompt: "继续" });
    assert.lengthOf(reads, 1);
    assert.lengthOf(followUp.uploaded, 0);
    assert.deepEqual(contentTypes(followUp.payload), ["input_text"]);
    assert.equal(followUp.payload.prompt_cache_key, first.payload.prompt_cache_key);
    assert.deepEqual(followUp.uncertain, [
      {
        paperId: "doi:10.1000/aaa",
        filename: "first.pdf",
        message: CPR_DIRECT_WEB_UNCERTAIN_MESSAGE,
      },
    ]);
  });

  it("records pending before the request and settles it on accept or markUncertain", async function () {
    addPaper(11, "https://doi.org/10.1000/aaa");
    addAttachment(101, 11, "/library/first.pdf");
    files.set("/library/first.pdf", pdfBytes("A"));
    const scope = { conversationKey: 5 };
    const refs = [refOf(11, 101, "First")];

    const accepted = await prepare({ refs, requestScope: scope });
    const fingerprint = accepted.uploaded[0].pdfSha256;
    const before = ledgerOf(accepted.sessionId);
    assert.lengthOf(before.entries, 0);
    assert.deepEqual(before.pending, [
      {
        paperId: "doi:10.1000/aaa",
        pdfSha256: fingerprint,
        filename: "first.pdf",
        order: 0,
      },
    ]);
    assert.lengthOf(before.uncertain, 0);
    accepted.accept();
    const afterAccept = ledgerOf(accepted.sessionId);
    assert.deepEqual(afterAccept.entries, [
      {
        paperId: "doi:10.1000/aaa",
        pdfSha256: fingerprint,
        filename: "first.pdf",
        order: 0,
      },
    ]);
    assert.lengthOf(afterAccept.pending, 0);

    addPaper(12, "https://doi.org/10.1000/bbb");
    addAttachment(102, 12, "/library/second.pdf");
    files.set("/library/second.pdf", pdfBytes("B"));
    const blocked = await prepare({ refs: [refOf(12, 102, "Second")], requestScope: scope });
    blocked.markUncertain();
    const afterUnknown = ledgerOf(accepted.sessionId);
    assert.lengthOf(afterUnknown.entries, 1);
    assert.deepEqual(afterUnknown.uncertain, [
      {
        paperId: "doi:10.1000/bbb",
        pdfSha256: blocked.uploaded[0].pdfSha256,
        filename: "second.pdf",
        order: 0,
        reason: CPR_DIRECT_WEB_UNCERTAIN_MESSAGE,
      },
    ]);
    assert.lengthOf(afterUnknown.pending, 0);
  });

  it("keeps the same session and ledger across a provider cache reset", async function () {
    addPaper(11, "https://doi.org/10.1000/aaa");
    addAttachment(101, 11, "/library/first.pdf");
    files.set("/library/first.pdf", pdfBytes("A"));
    const scope = { conversationKey: 99 };
    const refs = [refOf(11, 101, "First")];

    const first = await prepare({ refs, requestScope: scope });
    first.accept();
    assert.match(first.sessionId, /^zotero-cpr-[a-f0-9]{32}$/);
    resetProviderSessionIdCacheForTests();

    const afterReset = await prepare({ refs, requestScope: scope, prompt: "继续" });
    assert.equal(afterReset.sessionId, first.sessionId);
    assert.lengthOf(reads, 1);
    assert.lengthOf(afterReset.uploaded, 0);
    assert.deepEqual(afterReset.reused, ["doi:10.1000/aaa"]);
    assert.equal(ledgerKey(first.sessionId), ledgerKey(afterReset.sessionId));
  });

  it("uses only the paper's own PDF attachment, never a sibling or another paper's file", async function () {
    addPaper(11, "https://doi.org/10.1000/aaa");
    addPaper(12, "https://doi.org/10.1000/bbb");
    addAttachment(101, 11, "/library/first.pdf");
    addAttachment(111, 11, "/library/notes.txt", "text/plain");
    addAttachment(102, 12, "/library/other.pdf");
    files.set("/library/first.pdf", pdfBytes("A"));
    files.set("/library/other.pdf", pdfBytes("B"));

    for (const ref of [refOf(11, 111), refOf(11, 102), refOf(11, 999)]) {
      let caught: unknown;
      try {
        await prepare({ refs: [ref] });
      } catch (error) {
        caught = error;
      }
      assert.include(String(caught), "application/pdf 附件");
    }
    assert.lengthOf(reads, 0);
    assert.lengthOf([...prefs.keys()], 0);
  });

  it("rejects a non-PDF payload and an unsupported model or effort before reading anything", async function () {
    addPaper(11, "https://doi.org/10.1000/aaa");
    addAttachment(101, 11, "/library/first.pdf");
    files.set("/library/first.pdf", new TextEncoder().encode("not a pdf at all"));
    let caught: unknown;
    try {
      await prepare({ refs: [refOf(11, 101)] });
    } catch (error) {
      caught = error;
    }
    assert.include(String(caught), "不是有效的 PDF");

    for (const over of [
      { model: "papers/gpt-6-sol" },
      { apiBase: "https://api.openai.com/v1" },
      { reasoning: { provider: "openai" as const, level: "high" as const, effort: "turbo" } },
    ]) {
      reads = [];
      let refused: unknown;
      try {
        await prepare({ refs: [refOf(11, 101)], ...over });
      } catch (error) {
        refused = error;
      }
      assert.instanceOf(refused, Error);
      assert.lengthOf(reads, 0);
    }
  });

  it("names files by basename, caps the name and falls back to paper.pdf", async function () {
    const longName = `${"n".repeat(300)}.pdf`;
    addPaper(11, "https://doi.org/10.1000/aaa");
    addPaper(12, "https://doi.org/10.1000/bbb");
    addPaper(13, "https://doi.org/10.1000/ccc");
    addAttachment(101, 11, `/library/sub dir/${longName}`);
    addAttachment(102, 12, "/library/trailing/");
    addAttachment(103, 13, "/library\\windows.pdf");
    files.set(`/library/sub dir/${longName}`, pdfBytes("A"));
    files.set("/library/trailing/", pdfBytes("B"));
    files.set("/library\\windows.pdf", pdfBytes("C"));

    const prepared = await prepare({
      refs: [refOf(11, 101), refOf(12, 102), refOf(13, 103)],
    });

    const names = filesOf(prepared.payload);
    assert.lengthOf(names[0], 255);
    assert.isTrue(longName.startsWith(names[0]));
    assert.equal(names[1], "paper.pdf");
    assert.equal(names[2], "windows.pdf");
  });

  it("refuses to send more than 8 new PDFs or oversized files", async function () {
    const refs: PaperContextRef[] = [];
    for (let index = 0; index < 9; index++) {
      // IDs must not overlap the paper ids used below (an attachment id that is
      // also a paper id would be resolved as a regular item, not an attachment).
      const id = 300 + index;
      addPaper(id, `https://doi.org/10.1000/p${index}`);
      addAttachment(id * 10, id, `/library/p${index}.pdf`);
      files.set(`/library/p${index}.pdf`, pdfBytes(`p${index}`, 1024));
      refs.push(refOf(id, id * 10));
    }
    let caught: unknown;
    try {
      await prepare({ refs });
    } catch (error) {
      caught = error;
    }
    assert.include(String(caught), "超过 8 个上限");
    assert.lengthOf([...prefs.keys()].filter((k) => k.includes("cprDirectWebLedger")), 0);

    addPaper(11, "https://doi.org/10.1000/big");
    addAttachment(101, 11, "/library/big.pdf");
    files.set("/library/big.pdf", pdfBytes("big", 50 * MIB + 1));
    caught = undefined;
    try {
      await prepare({ refs: [refOf(11, 101)] });
    } catch (error) {
      caught = error;
    }
    assert.include(String(caught), "单个 PDF 超过 50 MiB");

    const wideRefs: PaperContextRef[] = [];
    for (let index = 0; index < 3; index++) {
      const id = 200 + index;
      addPaper(id, `https://doi.org/10.1000/wide${index}`);
      addAttachment(id * 10, id, `/library/wide${index}.pdf`);
      files.set(`/library/wide${index}.pdf`, pdfBytes(`wide${index}`, 40 * MIB));
      wideRefs.push(refOf(id, id * 10));
    }
    caught = undefined;
    try {
      await prepare({ refs: wideRefs });
    } catch (error) {
      caught = error;
    }
    assert.include(String(caught), "合计超过 100 MiB");
  });

  it("matches only the CPR papers target with a chatgpt-web model", function () {
    assert.isTrue(isCprDirectWebModel(WEB_MODEL, CPR_PAPERS_API_BASE));
    assert.isTrue(isCprDirectWebModel(` ${WEB_MODEL} `, "http://127.0.0.1:18082/v1"));
    assert.isFalse(isCprDirectWebModel("papers/gpt-6-sol", CPR_PAPERS_API_BASE));
    assert.isFalse(isCprDirectWebModel("gpt-5.6-sol", CPR_PAPERS_API_BASE));
    assert.isFalse(isCprDirectWebModel("chatgpt-web", CPR_PAPERS_API_BASE));
    assert.isFalse(isCprDirectWebModel(WEB_MODEL, "https://api.openai.com/v1"));
  });

  it("refuses an empty session and keeps standalone and conversation ids distinct", async function () {
    assert.equal(await resolveCprDirectWebSessionId({ operationId: "op-9" }), "zotero-cpr-op-9");
    for (const scope of [
      { conversationKey: "   " },
      { conversationKey: "" },
      { operationId: "" },
      { operationId: "  " },
    ]) {
      let caught: unknown;
      try {
        await resolveCprDirectWebSessionId(scope);
      } catch (error) {
        caught = error;
      }
      assert.include(String(caught), "缺少稳定的 CPR direct web 会话 id");
    }
    const conversation = await resolveCprDirectWebSessionId({ conversationKey: 3 });
    const other = await resolveCprDirectWebSessionId({ conversationKey: 4 });
    assert.notEqual(conversation, other);
    assert.notEqual(conversation, await resolveCprDirectWebSessionId({ operationId: conversation }));
  });

  it("fails closed on a corrupted ledger instead of re-uploading", async function () {
    addPaper(11, "https://doi.org/10.1000/aaa");
    addAttachment(101, 11, "/library/first.pdf");
    files.set("/library/first.pdf", pdfBytes("A"));
    const scope = { conversationKey: 11 };
    const refs = [refOf(11, 101, "First")];
    const first = await prepare({ refs, requestScope: scope });
    prefs.set(ledgerKey(first.sessionId), "{not json");

    let caught: unknown;
    try {
      await prepare({ refs, requestScope: scope });
    } catch (error) {
      caught = error;
    }
    assert.include(String(caught), "本地 CPR direct web 记录损坏");
    assert.lengthOf(reads, 1);
  });
});
