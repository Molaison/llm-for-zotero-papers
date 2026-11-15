import { assert } from "chai";
import type { PaperContextRef } from "../src/modules/contextPanel/types";
import {
  formatPaperContextCardAttachmentLine,
  formatPaperContextChipLabel,
  formatPaperContextChipTitle,
  hasPaperChipSourceMenuOption,
  isPaperContextFullTextOnlySourceMode,
  isPaperContextReaderFocusableSourceMode,
  resolvePaperContextForcedSendMode,
  resolvePaperContextAttachmentLabel,
} from "../src/modules/contextPanel/setupHandlers/controllers/composeContextController";
import {
  clearPaperContentSourceOverrides,
  clearPaperModeOverrides,
  getPaperModeOverride,
  setPaperContentSourceOverride,
  setPaperModeOverride,
} from "../src/modules/contextPanel/contexts/paperContextState";

type MockAttachment = Zotero.Item & {
  titleText: string;
  attachmentFilename?: string;
};

const zoteroItems = new Map<number, Zotero.Item>();

function makeAttachment(options: {
  id: number;
  title?: string;
  filename?: string;
  parentID?: number;
}): MockAttachment {
  return {
    id: options.id,
    parentID: options.parentID ?? 1,
    titleText: options.title || "",
    attachmentContentType: "application/pdf",
    attachmentFilename: options.filename || "",
    isAttachment: () => true,
    isRegularItem: () => false,
    getField(field: string) {
      return field === "title" ? this.titleText : "";
    },
    getAttachments: () => [],
  } as unknown as MockAttachment;
}

function makePaperContext(options: {
  itemId?: number;
  contextItemId: number;
  attachmentTitle?: string;
}): PaperContextRef {
  return {
    itemId: options.itemId ?? 1,
    contextItemId: options.contextItemId,
    title: "Directional dynamics in the entorhinal cortex",
    attachmentTitle: options.attachmentTitle,
    firstCreator: "Liu et al.",
    year: "2026",
  };
}

describe("composeContextController paper card attachment labels", function () {
  const originalZotero = globalThis.Zotero;

  beforeEach(function () {
    zoteroItems.clear();
    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      Items: {
        get(id: number) {
          return zoteroItems.get(id) || null;
        },
      },
    } as unknown as typeof Zotero;
  });

  after(function () {
    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
      originalZotero;
  });

  afterEach(function () {
    clearPaperModeOverrides(9001);
    clearPaperContentSourceOverrides(9001);
  });

  it("shows the live attachment title for MinerU cards and tooltips", function () {
    zoteroItems.set(
      101,
      makeAttachment({
        id: 101,
        title: "Supplementary Material",
        filename: "supplement.pdf",
      }),
    );
    const paperContext = makePaperContext({
      contextItemId: 101,
      attachmentTitle: "Stored Attachment",
    });

    assert.equal(
      formatPaperContextCardAttachmentLine(paperContext, "mineru"),
      "Supplementary Material",
    );
    const tooltip = formatPaperContextChipTitle(paperContext, "mineru");
    assert.include(tooltip, "Attachment: Supplementary Material");
    assert.notInclude(tooltip, "full.md");
  });

  it("formats named source badges for text-like child attachments", function () {
    const paperContext = makePaperContext({
      contextItemId: 101,
      attachmentTitle: "notes.docx",
    });

    assert.equal(
      formatPaperContextChipLabel(paperContext, "html"),
      "Liu et al., 2026 - HTML",
    );
    assert.equal(
      formatPaperContextChipLabel(paperContext, "txt"),
      "Liu et al., 2026 - TXT",
    );
    assert.equal(
      formatPaperContextChipLabel(paperContext, "docx"),
      "Liu et al., 2026 - DOCX",
    );
    assert.include(formatPaperContextChipTitle(paperContext, "docx"), "Word");
  });

  it("uses attachment labels for metadata-free text attachment chips", function () {
    const paperContext: PaperContextRef = {
      itemId: 1,
      contextItemId: 101,
      title: "Saved web page",
      attachmentTitle: "snapshot.html",
    };

    assert.equal(
      formatPaperContextChipLabel(paperContext, "html"),
      "Attachment - HTML",
    );
    assert.equal(
      formatPaperContextChipLabel(paperContext, "docx"),
      "Attachment - DOCX",
    );
  });

  it("keeps a single selected HTML attachment available as a source-menu card", function () {
    const paperContext = makePaperContext({
      contextItemId: 101,
      attachmentTitle: "snapshot.html",
    });

    assert.isTrue(isPaperContextFullTextOnlySourceMode("html"));
    assert.isFalse(isPaperContextReaderFocusableSourceMode("html"));
    assert.isTrue(isPaperContextReaderFocusableSourceMode("text"));
    assert.isTrue(
      hasPaperChipSourceMenuOption([{ mode: "html", paperContext }]),
    );
  });

  it("forces raw PDF to full-file mode outside WebChat", function () {
    assert.equal(
      resolvePaperContextForcedSendMode("pdf", false),
      "full-sticky",
    );
    assert.isNull(resolvePaperContextForcedSendMode("pdf", true));
    assert.equal(
      resolvePaperContextForcedSendMode("html", false),
      "full-sticky",
    );
    assert.isNull(resolvePaperContextForcedSendMode("text", false));
  });

  it("masks but preserves the prior Text send-mode override", function () {
    const paperContext = makePaperContext({ contextItemId: 101 });
    setPaperModeOverride(9001, paperContext, "retrieval");

    setPaperContentSourceOverride(9001, paperContext, "pdf");
    assert.equal(
      resolvePaperContextForcedSendMode("pdf", false),
      "full-sticky",
    );
    assert.equal(getPaperModeOverride(9001, paperContext), "retrieval");

    setPaperContentSourceOverride(9001, paperContext, "text");
    assert.equal(getPaperModeOverride(9001, paperContext), "retrieval");
  });

  it("keeps the paper chip menu available when there is a real source switch", function () {
    const htmlContext = makePaperContext({
      contextItemId: 101,
      attachmentTitle: "snapshot.html",
    });
    const pdfContext = makePaperContext({
      contextItemId: 102,
      attachmentTitle: "paper.pdf",
    });

    assert.isTrue(
      hasPaperChipSourceMenuOption([
        { mode: "html", paperContext: htmlContext },
        { mode: "pdf", paperContext: pdfContext },
      ]),
    );
  });

  it("does not treat a disabled MinerU parse row as a clickable source option", function () {
    const paperContext = makePaperContext({
      contextItemId: 102,
      attachmentTitle: "paper.pdf",
    });

    assert.isFalse(
      hasPaperChipSourceMenuOption([
        {
          mode: "mineru",
          paperContext,
          mineruAction: "start",
          disabledReason: "enable MinerU to start PDF parsing",
        },
      ]),
    );
  });

  it("falls back to filename before stale stored attachment title", function () {
    zoteroItems.set(
      102,
      makeAttachment({
        id: 102,
        title: "",
        filename: "41467_2026_70289_MOESM1_ESM.pdf",
      }),
    );
    const paperContext = makePaperContext({
      contextItemId: 102,
      attachmentTitle: "Old Supplement Title",
    });

    assert.equal(
      resolvePaperContextAttachmentLabel(paperContext, { fallback: "full.md" }),
      "41467_2026_70289_MOESM1_ESM.pdf",
    );
  });

  it("distinguishes two attachments under the same parent item", function () {
    zoteroItems.set(
      201,
      makeAttachment({ id: 201, title: "Main Article PDF", parentID: 1 }),
    );
    zoteroItems.set(
      202,
      makeAttachment({
        id: 202,
        title: "Supplementary Figures PDF",
        parentID: 1,
      }),
    );

    assert.equal(
      formatPaperContextCardAttachmentLine(
        makePaperContext({ contextItemId: 201 }),
        "mineru",
      ),
      "Main Article PDF",
    );
    assert.equal(
      formatPaperContextCardAttachmentLine(
        makePaperContext({ contextItemId: 202 }),
        "mineru",
      ),
      "Supplementary Figures PDF",
    );
  });

  it("reflects a renamed Zotero attachment on the next render", function () {
    const attachment = makeAttachment({
      id: 301,
      title: "Original Supplement Title",
    });
    zoteroItems.set(301, attachment);
    const paperContext = makePaperContext({
      contextItemId: 301,
      attachmentTitle: "Original Supplement Title",
    });

    assert.equal(
      formatPaperContextCardAttachmentLine(paperContext, "mineru"),
      "Original Supplement Title",
    );

    attachment.titleText = "Renamed Supplement Title";

    assert.equal(
      formatPaperContextCardAttachmentLine(paperContext, "mineru"),
      "Renamed Supplement Title",
    );
  });

  it("falls back to stored context data, then full.md, when lookup fails", function () {
    const storedContext = makePaperContext({
      contextItemId: 404,
      attachmentTitle: "Stored Supplement Title",
    });
    assert.equal(
      formatPaperContextCardAttachmentLine(storedContext, "mineru"),
      "Stored Supplement Title",
    );

    const missingContext = makePaperContext({ contextItemId: 405 });
    assert.equal(
      formatPaperContextCardAttachmentLine(missingContext, "mineru"),
      "full.md",
    );
  });
});
