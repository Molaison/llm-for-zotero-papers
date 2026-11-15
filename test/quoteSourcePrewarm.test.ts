import { assert } from "chai";
import {
  MAX_WARMED_QUOTE_SOURCE_PAPERS,
  warmQuoteSourceCachesForPaperContexts,
} from "../src/modules/contextPanel/quoteValidation/sourceEvidence";
import {
  MAX_PREWARMED_QUOTE_SOURCE_PAPERS,
  prewarmQuoteSourcePageText,
  waitForAssistantQuoteValidationForTests,
} from "../src/modules/contextPanel/quoteValidation/scheduling";
import { resetQuoteValidationDecisionCacheForTests } from "../src/modules/contextPanel/quoteValidation/caches";
import { resetQuoteValidationActivityForTests } from "../src/modules/contextPanel/quoteValidationActivity";
import {
  clearPageTextCache,
  getCachedPageTextForAttachment,
} from "../src/services/pdf/livePdfSelectionLocator";
import { hasVerifiedQuoteLocation } from "../src/services/quotes/quoteCitations";
import { chatHistory } from "../src/modules/contextPanel/state";
import {
  pdfTextCache,
  pdfTextLoadingTasks,
} from "../src/services/paperContent/contextCache";
import type {
  Message,
  PaperContextRef,
} from "../src/modules/contextPanel/types";

function installPdfWorker(
  pageTextFor: (itemId: number) => string | null,
  options: { throwOnItems?: boolean } = {},
): { calls: number[]; restore: () => void } {
  const g = globalThis as any;
  const originalZotero = g.Zotero;
  const originalZtoolkit = g.ztoolkit;
  const calls: number[] = [];
  g.Zotero = {
    Prefs: { get: () => undefined, set: () => undefined },
    Items: {
      get: (id: number) => {
        if (options.throwOnItems) throw new Error("Zotero is shutting down");
        return {
          id,
          parentID: undefined,
          attachmentContentType: "application/pdf",
          attachmentFilename: `${id}.pdf`,
          isAttachment: () => true,
          isNote: () => false,
          getField: (field: string) => (field === "title" ? `Paper ${id}` : ""),
        };
      },
    },
    PDFWorker: {
      getFullText: async (itemId: number) => {
        calls.push(itemId);
        const text = pageTextFor(itemId);
        return text ? { text, totalPages: 1, extractedPages: 1 } : null;
      },
    },
  };
  g.ztoolkit = { log: () => undefined };
  return {
    calls,
    restore: () => {
      if (originalZotero === undefined) delete g.Zotero;
      else g.Zotero = originalZotero;
      if (originalZtoolkit === undefined) delete g.ztoolkit;
      else g.ztoolkit = originalZtoolkit;
    },
  };
}

function paper(contextItemId: number): PaperContextRef {
  return {
    itemId: contextItemId + 50_000,
    contextItemId,
    title: `Paper ${contextItemId}`,
    firstCreator: "Eppler et al.",
    year: "2026",
  };
}

const range = (start: number, count: number) =>
  Array.from({ length: count }, (_value, index) => start + index);

describe("quote source warming order", function () {
  let restore = () => undefined as void;

  afterEach(function () {
    restore();
    restore = () => undefined;
    clearPageTextCache();
  });

  it("warms the papers a message cites first, then its context papers, within the cap", async function () {
    const worker = installPdfWorker((id) => `Page text of paper ${id}.`);
    restore = worker.restore;
    const contextPapers = range(1001, 45).map(paper);

    const result = await warmQuoteSourceCachesForPaperContexts(
      [contextPapers.slice(0, 20), contextPapers.slice(20)],
      { priorityContextItemIds: [1044, 2001, 1045, 1044] },
    );

    assert.equal(MAX_WARMED_QUOTE_SOURCE_PAPERS, 40);
    assert.deepEqual(result.attemptedContextItemIds, [
      1044,
      2001,
      1045,
      ...range(1001, 37),
    ]);
    assert.deepEqual(worker.calls, result.attemptedContextItemIds);
    assert.deepEqual(
      result.addedPageTextContextItemIds,
      result.attemptedContextItemIds,
    );
    assert.isNotNull(getCachedPageTextForAttachment(2001));
    assert.isNull(getCachedPageTextForAttachment(1038));
  });

  it("reports no added paper when every paper was already warm", async function () {
    const worker = installPdfWorker((id) => `Page text of paper ${id}.`);
    restore = worker.restore;

    await warmQuoteSourceCachesForPaperContexts([[paper(3001)]]);
    const second = await warmQuoteSourceCachesForPaperContexts([[paper(3001)]]);

    assert.deepEqual(second.attemptedContextItemIds, [3001]);
    assert.deepEqual(second.addedPageTextContextItemIds, []);
    assert.deepEqual(worker.calls, [3001]);
  });
});

describe("early quote source prewarm", function () {
  const conversationKey = 9_077;
  let restore = () => undefined as void;

  afterEach(async function () {
    await waitForAssistantQuoteValidationForTests(conversationKey);
    restore();
    restore = () => undefined;
    chatHistory.delete(conversationKey);
    clearPageTextCache();
    pdfTextCache.clear();
    pdfTextLoadingTasks.clear();
    resetQuoteValidationDecisionCacheForTests();
    resetQuoteValidationActivityForTests();
  });

  it("warms at most the first eight papers, attached papers first", async function () {
    const worker = installPdfWorker((id) => `Page text of paper ${id}.`);
    restore = worker.restore;

    const result = await prewarmQuoteSourcePageText({
      paperContexts: [[paper(4010)], range(4001, 9).map(paper)],
    });

    assert.equal(MAX_PREWARMED_QUOTE_SOURCE_PAPERS, 8);
    assert.deepEqual(worker.calls, [4010, ...range(4001, 7)]);
    assert.equal(result.addedPapers, 8);
    assert.isFalse(result.revalidationScheduled);
  });

  it("warms a bare attachment id, as the reader sidebar passes it", async function () {
    const worker = installPdfWorker((id) => `Page text of paper ${id}.`);
    restore = worker.restore;

    await prewarmQuoteSourcePageText({ contextItemIds: [4501] });

    assert.deepEqual(worker.calls, [4501]);
    assert.isNotNull(getCachedPageTextForAttachment(4501));
  });

  it("re-gates an unresolved quote once, after the warm adds its paper", async function () {
    const quote =
      "Noise correlation changed more favorably for neuron pairs with high signal correlation.";
    const worker = installPdfWorker((id) =>
      id === 5001 ? `Results. ${quote} The next result follows.` : null,
    );
    restore = worker.restore;
    const source = { ...paper(5001), contentSourceMode: "text" as const };
    const user: Message = {
      role: "user",
      text: "Explain the result.",
      timestamp: 1,
      paperContexts: [source],
    };
    const assistant: Message = {
      role: "assistant",
      text: `> ${quote}`,
      timestamp: 2,
    };
    chatHistory.set(conversationKey, [user, assistant]);

    const first = await prewarmQuoteSourcePageText({
      conversationKey,
      paperContexts: [[source]],
    });
    await waitForAssistantQuoteValidationForTests(conversationKey);
    const second = await prewarmQuoteSourcePageText({
      conversationKey,
      paperContexts: [[source]],
    });

    assert.deepEqual(first, { addedPapers: 1, revalidationScheduled: true });
    assert.deepEqual(second, { addedPapers: 0, revalidationScheduled: false });
    assert.deepEqual(worker.calls, [5001]);
    const verified =
      assistant.quoteDisplayOverride?.quoteCitations?.filter(
        hasVerifiedQuoteLocation,
      ) || [];
    assert.lengthOf(verified, 1, "the card is located on a PDF page");
    assert.equal(verified[0].sourceMatchSource, "pdf-page-text");
    assert.equal(verified[0].pageHintIndex, 0);
  });

  it("does not re-gate a message that is still streaming", async function () {
    const worker = installPdfWorker((id) => `Page text of paper ${id}.`);
    restore = worker.restore;
    chatHistory.set(conversationKey, [
      { role: "user", text: "Q", timestamp: 1 },
      {
        role: "assistant",
        text: "> A quote that is still being written",
        timestamp: 2,
        streaming: true,
      },
    ]);

    const result = await prewarmQuoteSourcePageText({
      conversationKey,
      paperContexts: [[paper(6001)]],
    });

    assert.deepEqual(result, { addedPapers: 1, revalidationScheduled: false });
  });

  it("never rejects into the turn", async function () {
    const worker = installPdfWorker(() => "unused", { throwOnItems: true });
    restore = worker.restore;

    const result = await prewarmQuoteSourcePageText({
      conversationKey,
      paperContexts: [[paper(7001)]],
    });

    assert.deepEqual(result, { addedPapers: 0, revalidationScheduled: false });
  });
});
