import { assert } from "chai";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { strToU8, zipSync } from "fflate";
import { createPaperReadTool } from "../src/agent/tools/read/paperRead";
import { createReadAttachmentTool } from "../src/agent/tools/read/readAttachment";
import type { AgentToolContext, AgentToolResult } from "../src/agent/types";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";

/** Former search_paper(retrieval, pdf, gateway) construction, now paper_read. */
function searchPaperViaPaperRead(
  retrievalService: unknown,
  pdfService: unknown,
  zoteroGateway: unknown,
) {
  return createPaperReadTool(
    pdfService as never,
    retrievalService as never,
    {} as never,
    zoteroGateway as never,
  );
}

/** Former view_pdf_pages(pageService, gateway) construction, now paper_read. */
function viewPdfPagesViaPaperRead(
  pdfPageService: unknown,
  zoteroGateway: unknown,
) {
  return createPaperReadTool(
    {} as never,
    {} as never,
    pdfPageService as never,
    zoteroGateway as never,
  );
}

describe("paper_read targeted evidence", function () {
  const baseContext: AgentToolContext = {
    request: resolvedAgentRequest({
      conversationKey: 5,
      mode: "agent",
      userText: "Explain what I'm looking at",
      libraryID: 1,
      selectedPaperContexts: [
        { itemId: 1, contextItemId: 101, title: "Paper One" },
        { itemId: 2, contextItemId: 202, title: "Paper Two" },
      ],
    }),
    item: null,
    currentAnswerText: "",
    modelName: "gpt-5.4",
  };

  it("retrieves evidence across multiple paper contexts", async function () {
    const tool = searchPaperViaPaperRead(
      {
        retrieveEvidence: async ({
          papers,
        }: {
          papers: Array<{ itemId: number; contextItemId: number }>;
        }) =>
          papers.map((paper, index) => ({
            paperContext: {
              itemId: paper.itemId,
              contextItemId: paper.contextItemId,
              title: `Paper ${paper.itemId}`,
            },
            chunkIndex: index,
            text: `Evidence ${paper.itemId}`,
            score: 0.9 - index * 0.1,
            sourceLabel: `Paper ${paper.itemId}`,
          })),
      } as never,
      {
        ensurePaperContext: async () => {},
      } as never,
      {
        resolvePaperContextTarget: ({
          itemId,
          contextItemId,
        }: {
          itemId?: number;
          contextItemId?: number;
        }) =>
          baseContext.request.turnPaperScope.papers.find(
            (entry) =>
              (!itemId || entry.paper.itemId === itemId) &&
              (!contextItemId || entry.paper.contextItemId === contextItemId),
          )?.paper || null,
      } as never,
    );

    const validated = tool.validate({
      mode: "targeted",
      query: "What is the method?",
      targets: [
        { itemId: 1, contextItemId: 101 },
        { itemId: 2, contextItemId: 202 },
      ],
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;

    const result = await tool.execute(validated.value, baseContext);
    assert.deepEqual(
      (
        result as {
          results: Array<{
            paperContext: { itemId: number; contextItemId: number };
            text: string;
          }>;
        }
      ).results.map(({ paperContext, text }) => ({
        itemId: paperContext.itemId,
        contextItemId: paperContext.contextItemId,
        text,
      })),
      [
        { itemId: 1, contextItemId: 101, text: "Evidence 1" },
        { itemId: 2, contextItemId: 202, text: "Evidence 2" },
      ],
    );
  });

  it("resolves evidence targets from explicit item and attachment IDs", async function () {
    const tool = searchPaperViaPaperRead(
      {
        retrieveEvidence: async ({
          papers,
        }: {
          papers: Array<{ itemId: number; contextItemId: number }>;
        }) =>
          papers.map((paper, index) => ({
            paperContext: {
              itemId: paper.itemId,
              contextItemId: paper.contextItemId,
              title: `Paper ${paper.itemId}`,
            },
            chunkIndex: index,
            text: `Evidence ${paper.contextItemId}`,
            score: 0.9 - index * 0.1,
            sourceLabel: `Paper ${paper.itemId}`,
          })),
      } as never,
      {
        ensurePaperContext: async () => {},
      } as never,
      {
        resolvePaperContextTarget: ({
          itemId,
          contextItemId,
        }: {
          itemId?: number;
          contextItemId?: number;
        }) =>
          itemId && contextItemId
            ? { itemId, contextItemId, title: `Paper ${itemId}` }
            : null,
        listPaperContexts: () => [],
      } as never,
    );

    const validated = tool.validate({
      mode: "targeted",
      query: "What is the method?",
      targets: [
        { itemId: 1, contextItemId: 101 },
        { itemId: 2, contextItemId: 202 },
      ],
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;

    const result = await tool.execute(validated.value, baseContext);
    const results = (result as { results: Array<{ paperContext: unknown }> })
      .results;
    assert.lengthOf(results, 2);
    assert.deepEqual(
      results.map((entry) => entry.paperContext),
      [
        { itemId: 1, contextItemId: 101, title: "Paper 1" },
        { itemId: 2, contextItemId: 202, title: "Paper 2" },
      ],
    );
  });

  it("does not fall back to ambient paper context for invalid evidence targets", async function () {
    let reads = 0;
    const tool = searchPaperViaPaperRead(
      {
        retrieveEvidence: async () => {
          reads += 1;
          return [];
        },
      } as never,
      {
        ensurePaperContext: async () => {},
      } as never,
      {
        resolvePaperContextTarget: () => null,
        listPaperContexts: (request: AgentToolContext["request"]) =>
          request.turnPaperScope.papers.map((entry) => entry.paper),
      } as never,
    );

    const validated = tool.validate({
      mode: "targeted",
      query: "What is the method?",
      target: { itemId: 9, contextItemId: 909 },
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;

    try {
      await tool.execute(validated.value, baseContext);
      assert.fail("Expected explicit target resolution to fail");
    } catch (error) {
      assert.match(
        error instanceof Error ? error.message : String(error),
        /Could not resolve paper target itemId=9, contextItemId=909/,
      );
    }
    assert.equal(reads, 0);
  });

  it("uses presentation summaries for evidence retrieval", function () {
    const tool = searchPaperViaPaperRead(
      {} as never,
      {} as never,
      {
        listPaperContexts: () => [],
      } as never,
    );

    const onSuccess = tool.presentation?.summaries?.onSuccess;
    assert.equal(
      typeof onSuccess === "function"
        ? onSuccess({
            content: {
              mode: "targeted",
              results: [{}, {}],
            },
          } as never)
        : "",
      "Read 2 passages",
    );
  });
});

describe("read_attachment tool", function () {
  const baseContext: AgentToolContext = {
    request: {
      conversationKey: 5,
      mode: "agent",
      userText: "Explain what I'm looking at",
      attachments: [
        {
          id: "att-1",
          name: "notes.txt",
          mimeType: "text/plain",
          category: "text",
          textContent: "Attached notes",
          storedPath: "/tmp/notes.txt",
        },
      ],
      selectedPaperContexts: [
        { itemId: 1, contextItemId: 101, title: "Paper One" },
        { itemId: 2, contextItemId: 202, title: "Paper Two" },
      ],
    },
    item: null,
    currentAnswerText: "",
    modelName: "gpt-5.4",
  };

  it("does not require confirmation before sending an attached file to the model", function () {
    const tool = createReadAttachmentTool({} as never, {} as never);

    const validated = tool.validate({
      attachFile: true,
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;

    assert.notProperty(tool.spec, "requiresConfirmation");
    assert.isUndefined(tool.shouldRequireConfirmation);
  });

  it("still builds a review card when the host forces confirmation", async function () {
    // read_attachment never asks on its own, but the controller falls back to
    // createPendingAction whenever a caller forces a review, so the card the
    // user would see there has to stay correct.
    const tool = createReadAttachmentTool({} as never, {} as never);
    const validated = tool.validate({ attachFile: true });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;

    const pending = await tool.createPendingAction?.(
      validated.value,
      baseContext,
    );
    assert.exists(pending);
    assert.equal(pending?.toolName, "read_attachment");
    assert.equal(pending?.title, "notes.txt");
    assert.equal(pending?.confirmLabel, "Send to model");
    assert.equal(pending?.cancelLabel, "Cancel");
    const review = pending?.fields?.[0];
    assert.equal(review?.type, "review_table");
    assert.deepEqual(
      review?.type === "review_table"
        ? review.rows.map((row) => [row.key, row.after])
        : [],
      [
        ["file", "notes.txt"],
        ["mimeType", "text/plain"],
      ],
    );
  });

  it("reads markdown child attachments with parent-aware source metadata", async function () {
    const originalIOUtils = (globalThis as { IOUtils?: unknown }).IOUtils;
    (globalThis as { IOUtils?: unknown }).IOUtils = {
      read: async () =>
        new TextEncoder().encode("Translated markdown content."),
    };
    try {
      const parent = {
        id: 1,
        isRegularItem: () => true,
        getField: (field: string) =>
          field === "title"
            ? "Episodic memory paper"
            : field === "firstCreator"
              ? "Chandra et al."
              : field === "date"
                ? "2025"
                : "",
        getDisplayTitle: () => "Episodic memory paper",
      };
      const attachment = {
        id: 77,
        isAttachment: () => true,
        getFilePath: () => "/tmp/translation.md",
      };
      const tool = createReadAttachmentTool(
        {
          getAttachmentInfo: () => ({
            attachmentId: 77,
            parentItemId: 1,
            title: "translation.md",
            contentType: "text/markdown",
            filename: "translation.md",
            hasFile: true,
            linkMode: "imported_file",
          }),
          getItem: (itemId: number) =>
            itemId === 1 ? parent : itemId === 77 ? attachment : null,
        } as never,
        {} as never,
      );

      const validated = tool.validate({ target: { contextItemId: 77 } });
      assert.isTrue(validated.ok);
      if (!validated.ok) return;
      const result = (await tool.execute(
        validated.value,
        baseContext,
      )) as Record<string, unknown>;
      assert.equal(result.textContent, "Translated markdown content.");
      assert.equal(result.sourceMode, "markdown");
      assert.equal(result.sourceType, "Markdown attachment");
      assert.equal(
        result.sourceLabel,
        "(translation.md, attachment under Chandra et al., 2025)",
      );
      assert.deepInclude(result.parentItem as Record<string, unknown>, {
        itemId: 1,
        title: "Episodic memory paper",
      });
      assert.include(String(result.relationship), "translated file");
      assert.deepInclude(result.paperContext as Record<string, unknown>, {
        itemId: 1,
        contextItemId: 77,
        contentSourceMode: "markdown",
      });
    } finally {
      (globalThis as { IOUtils?: unknown }).IOUtils = originalIOUtils;
    }
  });

  it("extracts plain text from DOCX child attachments", async function () {
    const docxBytes = zipSync({
      "word/document.xml": strToU8(
        '<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>Alpha</w:t></w:r></w:p><w:p><w:r><w:t>Beta</w:t></w:r></w:p></w:body></w:document>',
      ),
    });
    const originalIOUtils = (globalThis as { IOUtils?: unknown }).IOUtils;
    (globalThis as { IOUtils?: unknown }).IOUtils = {
      read: async () => docxBytes,
    };
    try {
      const parent = {
        id: 2,
        isRegularItem: () => true,
        getField: (field: string) =>
          field === "title"
            ? "Word Parent"
            : field === "firstCreator"
              ? "Rivera"
              : field === "year"
                ? "2024"
                : "",
        getDisplayTitle: () => "Word Parent",
      };
      const attachment = {
        id: 88,
        isAttachment: () => true,
        getFilePath: () => "/tmp/notes.docx",
      };
      const tool = createReadAttachmentTool(
        {
          getAttachmentInfo: () => ({
            attachmentId: 88,
            parentItemId: 2,
            title: "notes.docx",
            contentType:
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            filename: "notes.docx",
            hasFile: true,
            linkMode: "imported_file",
          }),
          getItem: (itemId: number) =>
            itemId === 2 ? parent : itemId === 88 ? attachment : null,
        } as never,
        {} as never,
      );

      const validated = tool.validate({ target: { contextItemId: 88 } });
      assert.isTrue(validated.ok);
      if (!validated.ok) return;
      const result = (await tool.execute(
        validated.value,
        baseContext,
      )) as Record<string, unknown>;
      assert.equal(result.textContent, "Alpha\nBeta");
      assert.equal(result.sourceMode, "docx");
      assert.equal(result.sourceType, "DOCX attachment");
      assert.equal(
        result.sourceLabel,
        "(notes.docx, attachment under Rivera, 2024)",
      );
    } finally {
      (globalThis as { IOUtils?: unknown }).IOUtils = originalIOUtils;
    }
  });

  it("keeps PDF attachments on the explicit PDF tool path", async function () {
    const tool = createReadAttachmentTool(
      {
        getAttachmentInfo: () => ({
          attachmentId: 99,
          parentItemId: 2,
          title: "Main PDF",
          contentType: "application/pdf",
          filename: "paper.pdf",
          hasFile: true,
          linkMode: "imported_file",
        }),
      } as never,
      {} as never,
    );

    const validated = tool.validate({ target: { contextItemId: 99 } });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;
    const result = (await tool.execute(validated.value, baseContext)) as Record<
      string,
      unknown
    >;
    assert.equal(result.category, "pdf");
    assert.include(String(result.note), "Use paper_read");
    assert.notProperty(result, "textContent");
  });
});

describe("paper_read page rendering", function () {
  const baseContext: AgentToolContext = {
    request: {
      conversationKey: 5,
      mode: "agent",
      userText: "Explain what I'm looking at",
      selectedPaperContexts: [
        { itemId: 1, contextItemId: 101, title: "Paper One" },
        { itemId: 2, contextItemId: 202, title: "Paper Two" },
      ],
    },
    item: null,
    currentAnswerText: "",
    modelName: "gpt-5.4",
  };

  it("builds a multimodal follow-up message for capture", async function () {
    const tempDir = mkdtempSync(join(tmpdir(), "llm-zotero-view-pdf-pages-"));
    const imagePath = join(tempDir, "capture.png");
    const restoreIOUtils = (
      globalThis as typeof globalThis & {
        IOUtils?: { read?: (path: string) => Promise<Uint8Array> };
      }
    ).IOUtils;
    const restoreBtoa = (
      globalThis as typeof globalThis & { btoa?: (value: string) => string }
    ).btoa;
    writeFileSync(imagePath, Uint8Array.from([137, 80, 78, 71, 1, 2, 3, 4]));
    try {
      (
        globalThis as typeof globalThis & {
          IOUtils?: { read?: (path: string) => Promise<Uint8Array> };
        }
      ).IOUtils = {
        read: async (path: string) => new Uint8Array(readFileSync(path)),
      };
      (
        globalThis as typeof globalThis & { btoa?: (value: string) => string }
      ).btoa = (value: string) =>
        Buffer.from(value, "binary").toString("base64");

      const tool = viewPdfPagesViaPaperRead(
        {
          getActivePageIndex: () => 3,
          captureActiveView: async () => ({
            target: {
              source: "library" as const,
              title: "Paper One",
              contextItemId: 101,
              itemId: 1,
              paperContext: {
                itemId: 1,
                contextItemId: 101,
                title: "Paper One",
              },
            },
            capturedPage: {
              pageIndex: 3,
              pageLabel: "4",
              imagePath,
              contentHash: "hash-1",
            },
            artifacts: [
              {
                kind: "image" as const,
                mimeType: "image/png",
                storedPath: imagePath,
                pageIndex: 3,
                pageLabel: "4",
              },
            ],
            pageText: "Visible equation text",
          }),
        } as never,
        {
          listPaperContexts: () => [],
        } as never,
      );

      const validated = tool.validate({ mode: "capture" });
      assert.isTrue(validated.ok);
      if (!validated.ok) return;
      const execution = (await tool.execute(validated.value, baseContext)) as {
        content: Record<string, unknown>;
        artifacts: AgentToolResult["artifacts"];
      };
      const followup = await tool.buildFollowupMessage?.(
        {
          callId: "call-1",
          name: "paper_read",
          ok: true,
          content: execution.content,
          artifacts: execution.artifacts,
        },
        baseContext,
      );
      assert.exists(followup);
      assert.isArray(followup?.content);
      const parts = followup?.content as Array<{
        type: string;
        text?: string;
        image_url?: { url: string };
      }>;
      assert.equal(
        parts[1].image_url?.url,
        "data:image/png;base64,iVBORwECAwQ=",
      );
      assert.include(parts[0].text || "", "4");
      assert.deepInclude(execution.artifacts?.[0], {
        pageIndex: 3,
        pageLabel: "4",
        storedPath: imagePath,
      });
      assert.deepEqual(
        parts.map((part) => part.type),
        ["text", "image_url"],
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      (
        globalThis as typeof globalThis & {
          IOUtils?: { read?: (path: string) => Promise<Uint8Array> };
        }
      ).IOUtils = restoreIOUtils;
      (
        globalThis as typeof globalThis & { btoa?: (value: string) => string }
      ).btoa = restoreBtoa;
    }
  });

  it("uses presentation summaries for page results", function () {
    const tool = viewPdfPagesViaPaperRead(
      {} as never,
      {
        listPaperContexts: () => [],
      } as never,
    );

    // The trace summarizes a result without its call arguments, so the
    // label must come from the result content alone.
    const summarize = (content: Record<string, unknown>) => {
      const onSuccess = tool.presentation?.summaries?.onSuccess;
      return typeof onSuccess === "function"
        ? onSuccess({ label: "Read Paper", content })
        : "";
    };
    const target = { source: "library", title: "Paper One", itemId: 1 };
    assert.equal(
      summarize({
        target,
        pageCount: 1,
        results: [{ pageIndex: 2, pageLabel: "3" }],
        pageTexts: ["Page three"],
      }),
      "Prepared 1 PDF page image",
    );
    assert.equal(
      summarize({
        target,
        pageCount: 2,
        results: [
          { pageIndex: 2, pageLabel: "3" },
          { pageIndex: 3, pageLabel: "4" },
        ],
        pageTexts: ["Page three", "Page four"],
      }),
      "Prepared 2 PDF page images",
    );
    assert.equal(
      summarize({
        target,
        capturedPageIndex: 3,
        pageLabel: "4",
        pageCount: 1,
        pageText: "Visible equation text",
      }),
      "Captured the current reader page",
    );
    assert.equal(
      summarize({
        mode: "targeted",
        results: [{ text: "Evidence 1" }, { text: "Evidence 2" }],
      }),
      "Read 2 passages",
    );
  });
});
