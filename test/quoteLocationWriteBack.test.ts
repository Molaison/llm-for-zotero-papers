import { assert } from "chai";
import {
  finalizeAssistantMessageQuoteCitationsForTests,
  validateLoadedConversationQuoteMessages,
  waitForAssistantQuoteValidationForTests,
} from "../src/modules/contextPanel/quoteValidation/scheduling";
import {
  configureQuoteLocationWriter,
  reconcilePersistedQuoteLocations,
  scheduleQuoteLocationWriteBack,
  setQuoteSourceFileStateReaderForTests,
  waitForQuoteLocationWriteBacksForTests,
  type QuoteLocationWriteRequest,
} from "../src/modules/contextPanel/quoteValidation/locationWriteBack";
import { assistantMarkdownNeedsBackgroundQuoteSearch } from "../src/modules/contextPanel/quoteValidation/sourceEvidence";
import { resetQuoteValidationDecisionCacheForTests } from "../src/modules/contextPanel/quoteValidation/caches";
import { resetQuoteValidationActivityForTests } from "../src/modules/contextPanel/quoteValidationActivity";
import { chatHistory } from "../src/modules/contextPanel/state";
import { clearPageTextCache } from "../src/services/pdf/livePdfSelectionLocator";
import {
  pdfTextCache,
  pdfTextLoadingTasks,
} from "../src/services/paperContent/contextCache";
import {
  buildQuoteCitation,
  hasVerifiedQuoteLocation,
} from "../src/services/quotes/quoteCitations";
import {
  mergeQuoteLocationWritesIntoStoredJson,
  restoreQuoteSourceFileStates,
  type QuoteCitationWithFileState,
  type QuoteSourceFileState,
} from "../src/services/quotes/quoteLocationPersistence";
import { normalizeQuoteCitations } from "../src/services/quotes/quoteCitations";
import {
  bumpConversationWriteGeneration,
  getConversationWriteGeneration,
  isConversationWriteGenerationCurrent,
} from "../src/shared/conversationWriteFence";
import type { QuoteCitation } from "../src/shared/types";
import type {
  Message,
  PaperContextRef,
} from "../src/modules/contextPanel/types";

/**
 * The gate's verified PDF-page locations are saved into the stored message
 * and trusted on reload only while the attachment file is unchanged.
 */

const KEY = 9_311;
const ATTACHMENT = 5001;
const QUOTE =
  "Noise correlation changed more favorably for neuron pairs with high signal correlation.";
const SECOND =
  "Place cells in CA1 remapped across days when the animals explored a novel environment.";
const FILE: QuoteSourceFileState = { size: 1234, mtime: 1_700_000_000_000 };
const REPLACED: QuoteSourceFileState = { size: 999, mtime: 1_800_000_000_000 };

function installPdf(pageText: string): { calls: number[]; restore(): void } {
  const g = globalThis as any;
  const originalZotero = g.Zotero;
  const originalZtoolkit = g.ztoolkit;
  const calls: number[] = [];
  g.Zotero = {
    Prefs: { get: () => undefined, set: () => undefined },
    Items: {
      get: (id: number) => ({
        id,
        attachmentContentType: "application/pdf",
        attachmentFilename: `${id}.pdf`,
        isAttachment: () => true,
        isNote: () => false,
        getField: () => "",
      }),
    },
    PDFWorker: {
      getFullText: async (itemId: number) => {
        calls.push(itemId);
        return { text: pageText, totalPages: 1, extractedPages: 1 };
      },
    },
  };
  g.ztoolkit = { log: () => undefined };
  return {
    calls,
    restore() {
      if (originalZotero === undefined) delete g.Zotero;
      else g.Zotero = originalZotero;
      if (originalZtoolkit === undefined) delete g.ztoolkit;
      else g.ztoolkit = originalZtoolkit;
    },
  };
}

const paper: PaperContextRef = {
  itemId: 55_001,
  contextItemId: ATTACHMENT,
  title: "Paper 5001",
  firstCreator: "Eppler et al.",
  year: "2026",
  contentSourceMode: "text",
} as PaperContextRef;

/** A record as an agent turn stores it, before any gate pass. */
function minted(quoteText: string): QuoteCitation {
  return buildQuoteCitation({
    quoteText,
    citationLabel: "(Eppler et al., 2026)",
    sourceMatchKind: "exact",
    sourceMatchSource: "context-text",
    contextItemId: ATTACHMENT,
    itemId: 55_001,
    sourceFingerprint: "fnv1a32-deadbeef",
  })!;
}

/**
 * A recording writer that also keeps a stored JSON column, so a test can
 * reload exactly what the store would hold.
 */
function recordingWriter(result = true) {
  const requests: QuoteLocationWriteRequest[] = [];
  let storedJson = "";
  return {
    requests,
    seed(citations: QuoteCitation[]) {
      storedJson = JSON.stringify(citations);
    },
    load(): QuoteCitation[] {
      const parsed = JSON.parse(storedJson);
      return restoreQuoteSourceFileStates(
        parsed,
        normalizeQuoteCitations(parsed),
      );
    },
    writer: async (request: QuoteLocationWriteRequest) => {
      requests.push(request);
      if (!result) return false;
      const next = mergeQuoteLocationWritesIntoStoredJson(
        storedJson,
        request.writes,
      );
      if (next === null) return false;
      storedJson = next;
      return true;
    },
  };
}

describe("quote location write-back after the display gate", function () {
  let pdf: { calls: number[]; restore(): void };
  let disposeWriter = () => undefined as void;
  let fileState: QuoteSourceFileState | null = FILE;

  beforeEach(function () {
    pdf = installPdf(`Results. ${QUOTE} Later, ${SECOND} The end.`);
    fileState = FILE;
    setQuoteSourceFileStateReaderForTests(async () => fileState);
  });

  afterEach(async function () {
    await waitForAssistantQuoteValidationForTests(KEY);
    disposeWriter();
    disposeWriter = () => undefined;
    setQuoteSourceFileStateReaderForTests(null);
    pdf.restore();
    chatHistory.delete(KEY);
    clearPageTextCache();
    pdfTextCache.clear();
    pdfTextLoadingTasks.clear();
    resetQuoteValidationDecisionCacheForTests();
    resetQuoteValidationActivityForTests();
  });

  function conversation(citations: QuoteCitation[]): {
    user: Message;
    assistant: Message;
  } {
    const user = {
      role: "user",
      text: "Explain the result.",
      timestamp: 1,
      paperContexts: [paper],
    } as Message;
    const assistant = {
      role: "assistant",
      text: [
        "The result.",
        ...citations.map((citation) => `[[quote:${citation.id}]]`),
      ].join("\n\n"),
      timestamp: 2,
      quoteCitations: citations,
    } as Message;
    chatHistory.set(KEY, [user, assistant]);
    return { user, assistant };
  }

  async function gate(user: Message, assistant: Message): Promise<void> {
    finalizeAssistantMessageQuoteCitationsForTests(assistant, {
      conversationKey: KEY,
      pairedUserMessage: user,
    });
    await waitForAssistantQuoteValidationForTests(KEY);
  }

  it("saves each located record into its stored record, in one write per message", async function () {
    const store = recordingWriter();
    disposeWriter = configureQuoteLocationWriter(store.writer);
    const first = minted(QUOTE);
    const second = minted(SECOND);
    store.seed([first, second]);
    const { user, assistant } = conversation([first, second]);

    await gate(user, assistant);

    assert.lengthOf(store.requests, 1, "one write for the gate pass");
    const [request] = store.requests;
    assert.equal(request.conversationKey, KEY);
    assert.equal(request.timestamp, 2);
    assert.equal(
      request.expectedGeneration,
      getConversationWriteGeneration(KEY),
    );
    assert.deepEqual(
      request.writes.map((write) => write.id),
      [first.id, second.id],
    );
    for (const write of request.writes) {
      assert.equal(write.location.sourceMatchSource, "pdf-page-text");
      assert.match(String(write.location.sourceFingerprint), /^page-text:/);
      assert.deepEqual(write.sourceFileState, FILE);
    }
    const saved = store.load();
    assert.isTrue(saved.every(hasVerifiedQuoteLocation), "saved as located");
    assert.isTrue(
      (assistant.quoteCitations || []).every(hasVerifiedQuoteLocation),
      "the in-memory records match the stored ones",
    );
    assert.equal(saved[0].quoteText, first.quoteText, "quote text unchanged");
    assert.equal(saved[0].itemId, first.itemId, "other fields unchanged");
  });

  it("runs no further pass and no further write once every anchor is saved", async function () {
    const store = recordingWriter();
    disposeWriter = configureQuoteLocationWriter(store.writer);
    const first = minted(QUOTE);
    const second = minted(SECOND);
    store.seed([first, second]);
    const { user, assistant } = conversation([first, second]);
    await gate(user, assistant);

    // A navigation re-gate of the same message.
    validateLoadedConversationQuoteMessages([user, assistant], KEY);
    await waitForAssistantQuoteValidationForTests(KEY);

    assert.lengthOf(store.requests, 1);
  });

  it("saves nothing without the attachment's file state", async function () {
    const store = recordingWriter();
    disposeWriter = configureQuoteLocationWriter(store.writer);
    fileState = null;
    const first = minted(QUOTE);
    store.seed([first]);
    const { user, assistant } = conversation([first]);

    await gate(user, assistant);

    assert.lengthOf(store.requests, 0);
    assert.isFalse(hasVerifiedQuoteLocation(assistant.quoteCitations![0]));
  });

  it("keeps the in-memory records when the store refuses the write", async function () {
    const store = recordingWriter(false);
    disposeWriter = configureQuoteLocationWriter(store.writer);
    const first = minted(QUOTE);
    store.seed([first]);
    const { user, assistant } = conversation([first]);

    await gate(user, assistant);

    assert.lengthOf(store.requests, 1);
    assert.strictEqual(assistant.quoteCitations![0], first);
  });

  it("never saves a MinerU-fingerprinted or unknown-id record as located", async function () {
    const store = recordingWriter();
    disposeWriter = configureQuoteLocationWriter(store.writer);
    const first = minted(QUOTE);
    const { assistant } = conversation([first]);
    const locatedOnMineru: QuoteCitation = {
      ...first,
      sourceMatchSource: "pdf-page-text",
      sourceMatchText: QUOTE,
      sourceFingerprint: "fnv1a32-0badf00d",
      pageHintIndex: 0,
      sourceMatchPageOccurrence: 0,
    };
    const unknownId: QuoteCitation = {
      ...locatedOnMineru,
      id: "Q_notstored",
      sourceFingerprint: "page-text:abc",
    };

    scheduleQuoteLocationWriteBack({
      conversationKey: KEY,
      message: assistant,
      rawMarkdown: assistant.text,
      finalizedQuoteCitations: [locatedOnMineru, unknownId],
    });
    await waitForQuoteLocationWriteBacksForTests();

    assert.lengthOf(store.requests, 0);
  });

  it("fences the write with the generation read when the gate pass ended", async function () {
    const first = minted(QUOTE);
    const { assistant } = conversation([first]);
    const located: QuoteCitation = {
      ...first,
      sourceMatchSource: "pdf-page-text",
      sourceMatchText: QUOTE,
      sourceFingerprint: "page-text:abc",
      pageHintIndex: 0,
      sourceMatchPageOccurrence: 0,
    };
    const requests: QuoteLocationWriteRequest[] = [];
    disposeWriter = configureQuoteLocationWriter(async (request) => {
      requests.push(request);
      return isConversationWriteGenerationCurrent(
        request.conversationKey,
        request.expectedGeneration,
      );
    });
    const atGateEnd = getConversationWriteGeneration(KEY);

    scheduleQuoteLocationWriteBack({
      conversationKey: KEY,
      message: assistant,
      rawMarkdown: assistant.text,
      finalizedQuoteCitations: [located],
    });
    // The conversation is cleared between the gate pass and the write.
    bumpConversationWriteGeneration(KEY);
    await waitForQuoteLocationWriteBacksForTests();

    assert.lengthOf(requests, 1);
    assert.equal(requests[0].expectedGeneration, atGateEnd);
    assert.strictEqual(assistant.quoteCitations![0], first, "nothing applied");
  });

  describe("on reload", function () {
    async function savedConversation(): Promise<{
      store: ReturnType<typeof recordingWriter>;
      loaded: () => { user: Message; assistant: Message };
    }> {
      const store = recordingWriter();
      disposeWriter = configureQuoteLocationWriter(store.writer);
      const first = minted(QUOTE);
      const second = minted(SECOND);
      store.seed([first, second]);
      const { user, assistant } = conversation([first, second]);
      await gate(user, assistant);
      assert.lengthOf(store.requests, 1);
      // A fresh process: nothing cached, only the stored row.
      chatHistory.delete(KEY);
      clearPageTextCache();
      pdfTextCache.clear();
      resetQuoteValidationDecisionCacheForTests();
      pdf.calls.length = 0;
      store.requests.length = 0;
      return {
        store,
        loaded: () => {
          const reloadedUser = { ...user } as Message;
          const reloaded = {
            role: "assistant",
            text: assistant.text,
            timestamp: assistant.timestamp,
            quoteCitations: store.load(),
          } as Message;
          return { user: reloadedUser, assistant: reloaded };
        },
      };
    }

    it("shows saved locations at once and schedules no validation while the file is unchanged", async function () {
      const { store, loaded } = await savedConversation();
      const { user, assistant } = loaded();

      await reconcilePersistedQuoteLocations([user, assistant]);
      assert.isTrue(
        (assistant.quoteCitations || []).every(hasVerifiedQuoteLocation),
        "saved locations kept",
      );
      assert.isFalse(
        assistantMarkdownNeedsBackgroundQuoteSearch(
          assistant.text,
          assistant.quoteCitations,
        ),
      );
      chatHistory.set(KEY, [user, assistant]);
      validateLoadedConversationQuoteMessages([user, assistant], KEY);
      await waitForAssistantQuoteValidationForTests(KEY);

      assert.deepEqual(pdf.calls, [], "no page text read: no gate pass ran");
      assert.isUndefined(assistant.quoteDisplayOverride);
      assert.lengthOf(store.requests, 0, "nothing written again");
    });

    it("drops the locations of a replaced PDF in memory, re-gates, and saves the new file state", async function () {
      const { store, loaded } = await savedConversation();
      const { user, assistant } = loaded();
      fileState = REPLACED;

      await reconcilePersistedQuoteLocations([user, assistant]);
      assert.isTrue(
        (assistant.quoteCitations || []).every(
          (citation) => !hasVerifiedQuoteLocation(citation),
        ),
        "no saved location trusted",
      );
      const storedNow = store.load();
      assert.isTrue(
        storedNow.every(hasVerifiedQuoteLocation),
        "the stored row is not changed by the load",
      );

      chatHistory.set(KEY, [user, assistant]);
      validateLoadedConversationQuoteMessages([user, assistant], KEY);
      await waitForAssistantQuoteValidationForTests(KEY);

      assert.deepEqual(pdf.calls, [ATTACHMENT], "the gate read the PDF again");
      assert.lengthOf(store.requests, 1);
      assert.deepEqual(
        store.requests[0].writes.map((write) => write.sourceFileState),
        [REPLACED, REPLACED],
      );
      assert.deepEqual(
        store
          .load()
          .map(
            (citation) =>
              (citation as QuoteCitationWithFileState).sourceFileState,
          ),
        [REPLACED, REPLACED],
      );
    });

    it("does not trust a saved location that has no file state", async function () {
      const first: QuoteCitation = {
        ...minted(QUOTE),
        sourceMatchSource: "pdf-page-text",
        sourceMatchText: QUOTE,
        sourceFingerprint: "page-text:abc",
        pageHintIndex: 0,
        sourceMatchPageOccurrence: 0,
      };
      assert.isTrue(hasVerifiedQuoteLocation(first));
      const message = {
        role: "assistant",
        text: `[[quote:${first.id}]]`,
        timestamp: 2,
        quoteCitations: [first],
      } as Message;

      await reconcilePersistedQuoteLocations([message]);

      assert.isFalse(hasVerifiedQuoteLocation(message.quoteCitations![0]));
      assert.equal(message.quoteCitations![0].pageHintIndex, 0);
      assert.isTrue(hasVerifiedQuoteLocation(first), "input not mutated");
    });

    it("leaves records without a saved location exactly as loaded", async function () {
      const first = minted(QUOTE);
      const citations = [first];
      const message = {
        role: "assistant",
        text: `[[quote:${first.id}]]`,
        timestamp: 2,
        quoteCitations: citations,
      } as Message;

      await reconcilePersistedQuoteLocations([message]);

      assert.strictEqual(message.quoteCitations, citations);
    });
  });
});
