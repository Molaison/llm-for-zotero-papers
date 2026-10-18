/**
 * [webchat] Dedicated send pipeline for WebChat providers.
 *
 * Unlike the normal LLM pipeline, this:
 *   - Attaches the exact selected PDFs in their explicit UI order
 *   - Sends only the raw question text (no system messages, no history)
 *   - Submits via the embedded Zotero relay → Chrome extension → provider site
 */

import { appLogger } from "../core/logging";
import { readLocalFileBytes } from "../utils/llmClient";
import { isAbsoluteLocalPath } from "../utils/localPath";
import type { PaperContextRef } from "../modules/contextPanel/types";
import {
  getZoteroAttachmentFilename,
  isZoteroPdfAttachmentCandidate,
} from "../modules/contextPanel/setupHandlers/controllers/pdfAttachmentPolicy";
import {
  MAX_WEBCHAT_PDF_COUNT,
  MAX_WEBCHAT_PDF_SIZE_BYTES,
  MAX_WEBCHAT_PDF_TOTAL_BYTES,
  type WebChatPdfAttachment,
} from "./types";
import {
  submitQuery,
  pollForResponse,
  webChatResponseTimeoutMs,
  waitForRemoteReadyIfNavigating,
  bytesToBase64,
  type WebChatAnswerSnapshot,
  type WebChatPollResult,
  type WebChatThinkingSnapshot,
} from "./client";

// ---------------------------------------------------------------------------
// PDF resolution helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the exact Zotero attachment identities selected by the user.
 *
 * Do not search parents or siblings here. A WebChat PDF request must either use
 * the selected attachment or fail before anything is submitted to the relay.
 */
export async function resolveSelectedWebChatPdfBatch(
  paperContexts: readonly PaperContextRef[],
): Promise<ReadonlyArray<{ path: string; filename: string }>> {
  if (!paperContexts.length) {
    throw new Error("No selected PDF attachment was provided for WebChat.");
  }
  if (paperContexts.length > MAX_WEBCHAT_PDF_COUNT) {
    throw new Error(
      `WebChat supports at most ${MAX_WEBCHAT_PDF_COUNT} PDF attachments per send.`,
    );
  }

  const seen = new Set<string>();
  const resolved: Array<{ path: string; filename: string }> = [];

  for (const paperContext of paperContexts) {
    const itemId = paperContext?.itemId;
    const contextItemId = paperContext?.contextItemId;
    if (
      !Number.isSafeInteger(itemId) ||
      itemId <= 0 ||
      !Number.isSafeInteger(contextItemId) ||
      contextItemId <= 0
    ) {
      throw new Error("The selected WebChat PDF identity is invalid.");
    }

    const sourceKey = String(contextItemId);
    if (seen.has(sourceKey)) {
      throw new Error("The selected WebChat PDF list contains a duplicate.");
    }
    seen.add(sourceKey);

    const attachment = Zotero.Items.get(contextItemId);
    if (!isZoteroPdfAttachmentCandidate(attachment)) {
      throw new Error("The selected WebChat PDF attachment is unavailable.");
    }
    if ((attachment as unknown as { deleted?: unknown }).deleted) {
      throw new Error("The selected WebChat PDF attachment is in the trash.");
    }

    const parentId = Number(attachment.parentID || 0);
    if (parentId) {
      const parent = Zotero.Items.get(itemId);
      if (parentId !== itemId || !parent?.isRegularItem?.()) {
        throw new Error(
          "The selected WebChat PDF attachment identity changed.",
        );
      }
      if ((parent as unknown as { deleted?: unknown }).deleted) {
        throw new Error("The selected WebChat PDF parent is in the trash.");
      }
    } else if (itemId !== contextItemId) {
      throw new Error("The selected WebChat PDF attachment identity changed.");
    }

    let path: string | null;
    try {
      path = await getFilePath(attachment);
    } catch {
      throw new Error("The selected WebChat PDF file is unavailable.");
    }
    if (!path || !isAbsoluteLocalPath(path)) {
      throw new Error("The selected WebChat PDF file is unavailable.");
    }
    resolved.push({
      path,
      filename:
        getZoteroAttachmentFilename(attachment) || extractFilename(path),
    });
  }

  return resolved;
}

async function getFilePath(att: Zotero.Item): Promise<string | null> {
  // Zotero 7+: getFilePathAsync
  const asyncPath = await (
    att as unknown as { getFilePathAsync?: () => Promise<string | false> }
  ).getFilePathAsync?.();
  if (asyncPath) return asyncPath as string;

  // Fallback: getFilePath (sync)
  if (
    typeof (att as unknown as { getFilePath?: () => string | undefined })
      .getFilePath === "function"
  ) {
    const syncPath = (
      att as unknown as { getFilePath: () => string | undefined }
    ).getFilePath();
    if (syncPath) return syncPath;
  }

  // Fallback: attachmentPath property
  const rawPath = (att as unknown as { attachmentPath?: string })
    .attachmentPath;
  return rawPath || null;
}

function extractFilename(path: string): string {
  return path.split(/[\\/]/).pop() || "document.pdf";
}

// ---------------------------------------------------------------------------
// Main send function
// ---------------------------------------------------------------------------

export type WebChatSendOptions = {
  item: Zotero.Item;
  question: string;
  host: string;
  /**
   * Explicit PDF selection in UI order. The boolean form is retained for old
   * callers and uses pdfPaperContexts as its legacy single-PDF source.
   */
  sendPdf?: boolean | readonly PaperContextRef[];
  /** Legacy selected PDF identities, in UI order. */
  pdfPaperContexts?: readonly PaperContextRef[];
  /** When true, force the next query into a fresh conversation. */
  forceNewChat?: boolean;
  /** Screenshot images as base64 data URLs to attach. */
  images?: string[];
  /** ChatGPT mode: "instant", "thinking_standard", or "thinking_extended". */
  chatgptMode?: string;
  /** Which registered webchat target to use. */
  target?: string;
  /** Existing remote conversation that a follow-up must remain bound to. */
  expectedChatUrl?: string | null;
  expectedChatId?: string | null;
  signal?: AbortSignal;
  onAnswerSnapshot: (text: string, snapshot: WebChatAnswerSnapshot) => void;
  onThinkingSnapshot?: (
    text: string,
    snapshot: WebChatThinkingSnapshot,
  ) => void;
};

export function selectWebChatExpectedConversation(input: {
  explicitUrl?: string;
  explicitId?: string;
  historicalUrl?: string;
  historicalId?: string;
}): { expectedChatUrl?: string; expectedChatId?: string } {
  if (input.explicitUrl || input.explicitId) {
    return {
      expectedChatUrl: input.explicitUrl,
      expectedChatId: input.explicitId,
    };
  }
  return {
    expectedChatUrl: input.historicalUrl,
    expectedChatId: input.historicalId,
  };
}

/**
 * Send a question to a registered web provider via the embedded Zotero relay.
 * Attaches the exact selected paper PDFs only when `sendPdf` requests them.
 * The caller determines whether to send PDF based on the paper chip state.
 *
 * Returns the final response text.
 */
export async function sendWebChatQuestion(
  opts: WebChatSendOptions,
): Promise<WebChatPollResult> {
  const {
    question,
    host,
    sendPdf,
    pdfPaperContexts,
    forceNewChat,
    images,
    chatgptMode,
    target,
    expectedChatUrl,
    expectedChatId,
    signal,
    onAnswerSnapshot,
    onThinkingSnapshot,
  } = opts;

  appLogger.debug(
    `[webchat] sendWebChatQuestion: sendPdf=${Array.isArray(sendPdf) ? sendPdf.length : sendPdf}`,
  );

  // --- Resolve and read every selected PDF before contacting the relay. ---
  let pdfAttachments: WebChatPdfAttachment[] | undefined;

  const selectedContexts = Array.isArray(sendPdf)
    ? sendPdf
    : sendPdf === true
      ? pdfPaperContexts || []
      : null;

  if (selectedContexts !== null) {
    const pdfs = await resolveSelectedWebChatPdfBatch(selectedContexts);
    let totalBytes = 0;
    pdfAttachments = [];
    for (const pdf of pdfs) {
      let bytes: Uint8Array;
      try {
        bytes = await readLocalFileBytes(pdf.path);
      } catch {
        throw new Error("The selected WebChat PDF file could not be read.");
      }
      if (!bytes.byteLength) {
        throw new Error("The selected WebChat PDF file is empty.");
      }
      if (bytes.byteLength > MAX_WEBCHAT_PDF_SIZE_BYTES) {
        throw new Error(
          `A selected WebChat PDF exceeds the ${MAX_WEBCHAT_PDF_SIZE_BYTES / (1024 * 1024)}MB size limit.`,
        );
      }
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_WEBCHAT_PDF_TOTAL_BYTES) {
        throw new Error(
          `Selected WebChat PDFs exceed the ${MAX_WEBCHAT_PDF_TOTAL_BYTES / (1024 * 1024)}MB total size limit.`,
        );
      }
      if (
        bytes.byteLength < 5 ||
        String.fromCharCode(...bytes.subarray(0, 5)) !== "%PDF-"
      ) {
        throw new Error("The selected WebChat file is not a valid PDF.");
      }
      pdfAttachments.push({
        pdf_base64: bytesToBase64(bytes),
        pdf_filename: pdf.filename,
      });
    }

    // Re-check the Zotero identities after reading. This closes the normal
    // delete/move race without contacting the relay when the selection changed.
    const currentPdfs = await resolveSelectedWebChatPdfBatch(selectedContexts);
    if (
      currentPdfs.length !== pdfs.length ||
      currentPdfs.some(
        (pdf, index) =>
          pdf.path !== pdfs[index]!.path ||
          pdf.filename !== pdfs[index]!.filename,
      )
    ) {
      throw new Error(
        "The selected WebChat PDF attachment changed before send.",
      );
    }
  }

  // If the extension is still navigating to a loaded history item or a fresh
  // chat, wait for the remote composer/transcript to settle before submitting.
  await waitForRemoteReadyIfNavigating(host, signal);

  // --- Submit to the embedded relay ---
  const { seq } = await submitQuery(
    host,
    question,
    pdfAttachments?.length === 1 ? pdfAttachments[0]!.pdf_base64 : null,
    pdfAttachments?.length === 1 ? pdfAttachments[0]!.pdf_filename : null,
    signal,
    images,
    chatgptMode,
    forceNewChat,
    target,
    expectedChatUrl,
    expectedChatId,
    pdfAttachments,
  );

  // --- Poll for streaming response ---
  return pollForResponse(
    host,
    seq,
    onAnswerSnapshot,
    onThinkingSnapshot,
    signal,
    webChatResponseTimeoutMs(pdfAttachments || []),
  );
}
