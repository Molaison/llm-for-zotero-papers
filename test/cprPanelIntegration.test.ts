import { assert } from "chai";
import { readFileSync } from "node:fs";
import ts from "typescript";
import {
  setModelProviderGroups,
  getRuntimeModelEntries,
} from "../src/utils/modelProviders";
import { getModelPdfSupport } from "../src/modules/contextPanel/setupHandlers/controllers/modelReasoningController";
import { shouldDowngradePdfSourceForConversation } from "../src/modules/contextPanel/setupHandlers/controllers/paperSourceOptionsController";
import {
  resolvePdfModeModelInputs,
  type PdfPaperModelInputDeps,
} from "../src/modules/contextPanel/setupHandlers/controllers/pdfPaperModelInputController";
import {
  isCprHistoryRewrite,
  CPR_HISTORY_REWRITE_NOTICE,
} from "../src/modules/contextPanel/cprConversationPolicy";
import { isAnnotationReplyTurn } from "../src/services/pdf/annotationReplyService";
import { callLLMStream } from "../src/utils/llmClient";

describe("CPR panel route integration", function () {
  let original: typeof Zotero;
  beforeEach(function () {
    original = globalThis.Zotero;
    const prefs = new Map<string, unknown>();
    globalThis.Zotero = {
      Prefs: {
        get: (key: string) => prefs.get(key),
        set: (key: string, value: unknown) => prefs.set(key, value),
      },
    } as unknown as typeof Zotero;
    setModelProviderGroups([
      {
        id: "papers",
        apiBase: "https://papers.example/v1",
        apiKey: "",
        authMode: "api_key",
        providerProtocol: "responses_api",
        paperRegistry: true,
        models: [{ id: "papers-entry", model: "reading-model" }],
      },
      {
        id: "web",
        apiBase: "https://web.example/v1",
        apiKey: "",
        authMode: "api_key",
        providerProtocol: "responses_api",
        directWebPdf: true,
        models: [{ id: "web-entry", model: "web-model" }],
      },
      {
        id: "api",
        apiBase: "https://api.example/v1",
        apiKey: "",
        authMode: "api_key",
        providerProtocol: "responses_api",
        models: [{ id: "api-entry", model: "api-model" }],
      },
    ]);
  });
  afterEach(function () {
    globalThis.Zotero = original;
  });

  for (const id of ["papers-entry", "web-entry"]) {
    it(`keeps PDF sources after selecting ${id}, while respecting text-only mode`, function () {
      const entry = getRuntimeModelEntries().find(
        (item) => item.entryId === id,
      )!;
      const support = getModelPdfSupport(
        entry.model,
        entry.providerProtocol,
        entry.authMode,
        entry.apiBase,
      );
      assert.equal(support, "native");
      assert.isFalse(
        shouldDowngradePdfSourceForConversation({
          basePdfSupport: support,
          isClaudeCode: false,
          isCodex: false,
        }),
      );
      assert.equal(
        getModelPdfSupport(
          entry.model,
          entry.providerProtocol,
          entry.authMode,
          entry.apiBase,
          "text_only",
        ),
        "none",
      );
    });

    it(`hands ${id} PDF contexts to its own transport without a generic upload`, async function () {
      const entry = getRuntimeModelEntries().find(
        (item) => item.entryId === id,
      )!;
      let genericReads = 0;
      const deps = {
        getModelPdfSupport: () => "native",
        isScreenshotUnsupportedModel: () => false,
        resolvePdfPaperAttachments: async () => {
          genericReads++;
          return [];
        },
        resolveLocalPdfResources: async () => {
          genericReads++;
          return [];
        },
        renderPdfPagesAsImages: async () => {
          genericReads++;
          return [];
        },
        uploadPdfForProvider: async () => {
          genericReads++;
          return null;
        },
        resolvePdfBytes: async () => {
          genericReads++;
          return new Uint8Array();
        },
      } satisfies PdfPaperModelInputDeps;
      const result = await resolvePdfModeModelInputs({
        deps,
        paperContexts: [{ itemId: 1, contextItemId: 2, title: "Test paper" }],
        selectedBaseFiles: [],
        selectedImageCountForBudget: 0,
        profile: entry,
        currentModelName: entry.model,
      });
      assert.isTrue(result.ok);
      assert.equal(genericReads, 0);
      if (result.ok) assert.deepEqual(result.modelFiles, []);
    });
  }

  it("blocks both rewriting a remote turn and retrying an API turn onto a remote session", function () {
    assert.isTrue(
      isCprHistoryRewrite(
        { modelEntryId: "papers-entry", modelName: "reading-model" },
        { modelEntryId: "api-entry", model: "api-model" },
      ),
    );
    assert.isTrue(
      isCprHistoryRewrite(
        { modelEntryId: "api-entry", modelName: "api-model" },
        { modelEntryId: "web-entry", model: "web-model" },
      ),
    );
    assert.isFalse(
      isCprHistoryRewrite(
        { modelEntryId: "api-entry", modelName: "api-model" },
        { modelEntryId: "api-entry", model: "api-model" },
      ),
    );
  });

  it("rejects a text-only registry turn before looking up or reading its PDF", async function () {
    try {
      await callLLMStream(
        {
          prompt: "Text only",
          model: "reading-model",
          modelEntryId: "papers-entry",
          apiBase: "https://papers.example/v1",
          apiKey: "fixture-key",
          inputMode: "text_only",
          cprPaperItemId: 1,
          cprPaperSessionId: "retained-session",
        },
        () => undefined,
      );
      assert.fail("A text-only registry turn must not prepare a PDF");
    } catch (error) {
      assert.include(String(error), "不会读取或上传 PDF");
    }
  });

  it("preserves later remote turns when editing an earlier API question", async function () {
    const source = readFileSync(
      new URL("../src/modules/contextPanel/chat.ts", import.meta.url),
      "utf8",
    );
    const ast = ts.createSourceFile(
      "chat.ts",
      source,
      ts.ScriptTarget.Latest,
      true,
    );
    const declaration = ast.statements.find(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) &&
        node.name?.text === "editUserTurnAndRetry",
    );
    assert.exists(declaration);
    const code = ts.transpileModule(
      declaration!.getText(ast).replace(/^export\s+/, ""),
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
    ).outputText;
    const history = [
      {
        role: "user",
        timestamp: 10,
        text: "API question",
        modelEntryId: "api-entry",
        modelName: "api-model",
      },
      { role: "assistant", timestamp: 11, text: "API answer" },
      {
        role: "user",
        timestamp: 12,
        text: "Remote question",
        modelEntryId: "papers-entry",
        modelName: "reading-model",
      },
      { role: "assistant", timestamp: 13, text: "Remote answer" },
    ];
    const before = JSON.stringify(history);
    let deletions = 0;
    let notice = "";
    const deps = {
      getConversationKey: () => 42,
      ensureConversationLoaded: async () => undefined,
      pendingDeletionStore: {
        ensurePersistedFenceLoaded: async () => true,
        finalizeTurnsForConversation: async () => undefined,
        isConversationPendingDeletion: () => false,
      },
      awaitPendingTurnFinalize: async (value: Promise<unknown>) => value,
      chatHistory: new Map([[42, history]]),
      getConversationWriteGeneration: () => 1,
      isAnnotationReplyTurn,
      isCprHistoryRewrite,
      CPR_HISTORY_REWRITE_NOTICE,
      resolveSelectionSurfaceForBody: () => "test",
      resolveEffectiveRequestConfig: () => ({
        modelEntryId: "api-entry",
        model: "api-model",
      }),
      setStatus: (_status: unknown, message: string) => {
        notice = message;
      },
      deleteTrailingTurnPairs: async () => {
        deletions += 1;
      },
    };
    const edit = new Function(
      "deps",
      `with (deps) { ${code}; return editUserTurnAndRetry; }`,
    )(deps);
    const result = await edit({
      body: { querySelector: () => ({}) },
      item: { id: 42 },
      userTimestamp: 10,
      assistantTimestamp: 11,
      newText: "Edited API question",
    });
    assert.isFalse(result);
    assert.equal(deletions, 0);
    assert.equal(JSON.stringify(history), before);
    assert.equal(notice, CPR_HISTORY_REWRITE_NOTICE);
  });
});
