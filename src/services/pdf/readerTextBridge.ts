import { createSurfaceBridge } from "../surfaceBridge";
import type { QuoteTextIndex } from "../quotes/quoteTextNormalization";

export type PdfReaderPageText = {
  pageIndex: number;
  pageLabel?: string;
  text: string;
};

export type PdfReaderTextCoverage =
  | "full-pdfworker"
  | "full-viewer"
  | "partial-dom";

export type PdfReaderTextCache = {
  pages: PdfReaderPageText[];
  /** Pre-computed normalised text per page for O(1) reuse. */
  normalised: Array<{
    pageIndex: number;
    pageLabel?: string;
    normalizedText: string;
    textIndex: QuoteTextIndex;
  }>;
  coverage: PdfReaderTextCoverage;
  pageCount?: number;
  sourceFingerprint?: string;
};

export type PdfQuoteCertificate = {
  contextItemId: number;
  documentFingerprint: string;
  pageIndex: number;
  pageLabel?: string;
  sourceMatchText: string;
  sourceMatchKind: "exact" | "normalized-span";
  /** What was established, independently of formatting normalization. */
  verificationMode?: "complete-quote" | "inline-math-locator";
  sourceMatchPageOccurrence: number;
};

export type PdfQuoteVerification =
  | { status: "matched"; certificate: PdfQuoteCertificate }
  | { status: "literal-not-found"; documentFingerprint: string }
  | { status: "defer"; reason: string };

export type PdfReaderTextAdapter = {
  warmPageTextCache: (reader: any) => Promise<PdfReaderTextCache | null>;
  warmPageTextCacheForAttachment: (
    contextItemId: number,
    options?: {
      yieldToMain?: () => Promise<void>;
      shouldContinue?: () => boolean;
      reader?: any;
    },
  ) => Promise<PdfReaderTextCache | null>;
  verifyCompleteQuote: (
    reader: any,
    contextItemId: number,
    quoteText: string,
    options?: {
      yieldToMain?: () => Promise<void>;
      shouldContinue?: () => boolean;
      allowInlineMathLocator?: boolean;
    },
  ) => Promise<PdfQuoteVerification>;
};

const bridge = createSurfaceBridge<PdfReaderTextAdapter>(
  "Zotero PDF reader text",
);

export function configurePdfReaderTextBridge(
  adapter: PdfReaderTextAdapter | null,
): () => void {
  return bridge.configure(adapter);
}

export function warmPdfPageTextCache(
  reader: any,
): Promise<PdfReaderTextCache | null> {
  return bridge.require().warmPageTextCache(reader);
}

export function warmPdfPageTextCacheForAttachment(
  contextItemId: number,
  options?: Parameters<
    PdfReaderTextAdapter["warmPageTextCacheForAttachment"]
  >[1],
): Promise<PdfReaderTextCache | null> {
  return bridge
    .require()
    .warmPageTextCacheForAttachment(contextItemId, options);
}

export function verifyCompleteQuoteInLivePdf(
  reader: any,
  contextItemId: number,
  quoteText: string,
  options?: Parameters<PdfReaderTextAdapter["verifyCompleteQuote"]>[3],
): Promise<PdfQuoteVerification> {
  return bridge
    .require()
    .verifyCompleteQuote(reader, contextItemId, quoteText, options);
}
