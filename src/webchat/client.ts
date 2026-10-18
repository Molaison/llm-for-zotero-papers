/**
 * [webchat] Client for the embedded relay server.
 *
 * Uses direct in-memory state access (not HTTP) to avoid deadlock — Zotero's
 * single-threaded server cannot serve requests from its own fetch().
 *
 * The Chrome extension communicates via HTTP; the plugin communicates directly.
 */

import {
  ATTACHMENT_DELIVERY_CONTRACT_VERSION,
  relaySubmitQuery,
  relayGetExtensionStatus,
  relayPollResponse,
  relayNewChat,
  relayLoadChat,
  relayGetHistorySnapshot,
  relayGetScrapedTranscriptSnapshot,
  relayGetScrapedMessages,
  relayGetStateSnapshot,
  relayGetReportedMode,
  type RelayHistorySiteSyncEntry,
  type RelayCompletionReason,
  type RelayRunState,
  type RelayTurnStatus,
  type RelayTurnDiagnostic,
  type ScrapedTranscriptSnapshot,
} from "./relayServer";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import {
  MAX_WEBCHAT_PDF_SIZE_BYTES,
  MULTI_PDF_DELIVERY_CONTRACT_VERSION,
  type WebChatPdfAttachment,
} from "./types";

const POLL_INTERVAL_MS = 500;
const REMOTE_READY_POLL_INTERVAL_MS = 250;
const REMOTE_READY_TIMEOUT_MS = 30_000;
const DEEPSEEK_SCRAPE_TIMEOUT_MS = 45_000;
const HISTORY_REFRESH_POLL_INTERVAL_MS = 500;
const HISTORY_REFRESH_TIMEOUT_MS = 25_000;
const TIMEOUT_MS = 300_000; // 5 minutes
const RESPONSE_TIMEOUT_PER_ATTACHMENT_MS = 60_000;
const RESPONSE_TIMEOUT_PER_ATTACHMENT_MB_MS = 1_500;
const RESPONSE_TIMEOUT_MAX_MS = 900_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createAbortError(): Error {
  const err = new Error("Aborted");
  err.name = "AbortError";
  return err;
}

function normalizeWebChatAnswerText(text: string | null | undefined): string {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function hasMeaningfulWebChatAnswerText(
  text: string | null | undefined,
): boolean {
  const normalized = normalizeWebChatAnswerText(text).toLowerCase();
  if (normalized.length <= 1) return false;
  if (
    normalized === "thinking" ||
    normalized === "thinking..." ||
    normalized === "stopped thinking" ||
    normalized === "quick answer" ||
    normalized === "stopped thinking quick answer"
  ) {
    return false;
  }
  if (
    /^thought for .+$/.test(normalized) ||
    /^reading\s+documents?\.?$/i.test(normalized) ||
    /^searching(\s+the\s+web)?\.?$/i.test(normalized) ||
    /^analyzing\.?$/i.test(normalized) ||
    /^browsing\.?$/i.test(normalized)
  ) {
    return false;
  }
  // Chinese equivalents (DeepSeek Chinese UI)
  const raw = normalizeWebChatAnswerText(text);
  if (
    raw === "思考中" ||
    raw === "思考中..." ||
    raw === "深度思考" ||
    raw === "停止思考"
  ) {
    return false;
  }
  if (
    /^已深度思考/.test(raw) ||
    /^已思考/.test(raw) ||
    /^思考了/.test(raw) ||
    /^正在阅读/.test(raw) ||
    /^正在搜索/.test(raw) ||
    /^正在分析/.test(raw) ||
    /^正在浏览/.test(raw)
  ) {
    return false;
  }
  return true;
}

function normalizeHistoryHostname(hostname: string | null | undefined): string {
  return String(hostname || "")
    .trim()
    .toLowerCase();
}

/** Convert a Uint8Array to base64, safe for large buffers. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binaryStr = "";
  const chunkSize = 0x8000; // 32 KB chunks
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binaryStr += String.fromCharCode(
      ...bytes.subarray(i, Math.min(bytes.length, i + chunkSize)),
    );
  }
  return btoa(binaryStr);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function printablePdfLabel(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, "?").slice(0, 96);
}

/** Estimated decoded byte length of a base64 string, without decoding it. */
export function estimateBase64ByteLength(value: string): number {
  const length = value.length;
  if (length === 0) return 0;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((length * 3) / 4) - padding);
}

/** Keep the Zotero-side poll budget aligned with the relay's multi-PDF idle budget. */
export function webChatResponseTimeoutMs(
  attachments: readonly WebChatPdfAttachment[] = [],
): number {
  if (attachments.length === 0) return TIMEOUT_MS;
  const totalBytes = attachments.reduce(
    (total, attachment) =>
      total + estimateBase64ByteLength(attachment.pdf_base64),
    0,
  );
  const extended =
    TIMEOUT_MS +
    attachments.length * RESPONSE_TIMEOUT_PER_ATTACHMENT_MS +
    (totalBytes / (1024 * 1024)) * RESPONSE_TIMEOUT_PER_ATTACHMENT_MB_MS;
  return Math.min(Math.round(extended), RESPONSE_TIMEOUT_MAX_MS);
}

/**
 * Explain why a combined multi-PDF bundle cannot satisfy the single-PDF size
 * limit, or null while it still fits. The bundled PDF carries every selected
 * page, so this is checked both on the raw inputs and on the final bytes.
 */
export function webChatBundleSizeError(
  attachmentCount: number,
  totalBytes: number,
): string | null {
  if (
    !Number.isFinite(totalBytes) ||
    totalBytes <= MAX_WEBCHAT_PDF_SIZE_BYTES
  ) {
    return null;
  }
  const limitMb = MAX_WEBCHAT_PDF_SIZE_BYTES / (1024 * 1024);
  const totalMb = (totalBytes / (1024 * 1024)).toFixed(1);
  return (
    `The selected ${attachmentCount} PDFs total about ${totalMb}MB, which is over the ${limitMb}MB limit for a single WebChat PDF. ` +
    `This browser extension can only send one PDF per turn, so the combined papers must fit within ${limitMb}MB. ` +
    `Deselect papers or update the browser extension to send multiple PDFs directly.`
  );
}

/**
 * Keep multi-PDF sends usable with the installed contract-1 extension. The
 * bundle is one real PDF with a small filename cover page, so the provider
 * still receives every selected document in the requested order. Oversized
 * combinations fail fast with a clear size message instead of a misleading
 * single-PDF error after every page has been re-encoded.
 */
async function bundlePdfAttachments(
  attachments: readonly WebChatPdfAttachment[],
): Promise<WebChatPdfAttachment> {
  const estimatedInputBytes = attachments.reduce(
    (total, attachment) =>
      total + estimateBase64ByteLength(attachment.pdf_base64),
    0,
  );
  const estimatedError = webChatBundleSizeError(
    attachments.length,
    estimatedInputBytes,
  );
  if (estimatedError) throw new Error(estimatedError);

  const output = await PDFDocument.create();
  output.setTitle("Selected Zotero papers");
  output.setSubject(attachments.map((entry) => entry.pdf_filename).join("\n"));
  const font = await output.embedFont(StandardFonts.Helvetica);
  const cover = output.addPage([612, 792]);
  cover.drawText("Selected Zotero papers", {
    x: 48,
    y: 744,
    size: 18,
    font,
    color: rgb(0.12, 0.12, 0.12),
  });
  cover.drawText("The following PDFs were selected for this question:", {
    x: 48,
    y: 712,
    size: 10,
    font,
    color: rgb(0.25, 0.25, 0.25),
  });

  for (const [index, attachment] of attachments.entries()) {
    const filename = attachment.pdf_filename.trim();
    cover.drawText(`${index + 1}. ${printablePdfLabel(filename)}`, {
      x: 64,
      y: 680 - index * 22,
      size: 11,
      font,
      color: rgb(0.12, 0.12, 0.12),
    });
    let source: PDFDocument;
    try {
      source = await PDFDocument.load(base64ToBytes(attachment.pdf_base64));
    } catch {
      throw new Error(
        `The selected PDF "${filename}" could not be combined for this WebChat extension. Update the browser extension or send this PDF alone.`,
      );
    }
    const pages = await output.copyPages(source, source.getPageIndices());
    for (const page of pages) output.addPage(page);
  }

  const bundleBytes = await output.save();
  const bundleError = webChatBundleSizeError(
    attachments.length,
    bundleBytes.byteLength,
  );
  if (bundleError) throw new Error(bundleError);

  return {
    pdf_base64: bytesToBase64(bundleBytes),
    pdf_filename: "selected-zotero-papers.pdf",
  };
}

// ---------------------------------------------------------------------------
// Submit query (direct state access)
// ---------------------------------------------------------------------------

export type SubmitQueryResult = { seq: number; sessionId?: string };

export type WebChatTurnMetadata = {
  remoteChatUrl: string | null;
  remoteChatId: string | null;
  userTurnKey: string | null;
  assistantTurnKey: string | null;
  baselineTranscriptCount: number;
  baselineTranscriptHash: string | null;
  turnStatus: RelayTurnStatus | null;
};

export async function submitQuery(
  _host: string,
  prompt: string,
  pdfBase64: string | null,
  pdfFilename: string | null,
  signal?: AbortSignal,
  images?: string[],
  chatgptMode?: string,
  forceNewChat?: boolean,
  target?: string,
  expectedChatUrl?: string | null,
  expectedChatId?: string | null,
  pdfAttachments?: readonly WebChatPdfAttachment[],
): Promise<SubmitQueryResult> {
  if (signal?.aborted) throw createAbortError();

  const effectivePdfAttachments =
    pdfAttachments ??
    (pdfBase64 && pdfFilename
      ? [{ pdf_base64: pdfBase64, pdf_filename: pdfFilename }]
      : []);
  const extensionSupportsMultiPdf = Boolean(
    relayGetExtensionStatus()?.supportedDeliveryContracts.includes(
      MULTI_PDF_DELIVERY_CONTRACT_VERSION,
    ),
  );
  const deliveredPdfAttachments =
    effectivePdfAttachments.length > 1 && !extensionSupportsMultiPdf
      ? [await bundlePdfAttachments(effectivePdfAttachments)]
      : effectivePdfAttachments;
  const deliveryContractVersion =
    deliveredPdfAttachments.length > 1
      ? MULTI_PDF_DELIVERY_CONTRACT_VERSION
      : ATTACHMENT_DELIVERY_CONTRACT_VERSION;

  const result = relaySubmitQuery({
    prompt,
    pdf_base64:
      deliveredPdfAttachments.length === 1
        ? deliveredPdfAttachments[0]!.pdf_base64
        : null,
    pdf_filename:
      deliveredPdfAttachments.length === 1
        ? deliveredPdfAttachments[0]!.pdf_filename
        : null,
    pdf_attachments:
      pdfAttachments === undefined ? undefined : [...deliveredPdfAttachments],
    images: images || null,
    chatgpt_mode: chatgptMode || null,
    target: target || null,
    ...(expectedChatUrl !== undefined
      ? { expected_chat_url: expectedChatUrl }
      : {}),
    ...(expectedChatId !== undefined
      ? { expected_chat_id: expectedChatId }
      : {}),
    force_new_chat: forceNewChat === true,
    delivery_contract_version: deliveryContractVersion,
  });

  if (!result.ok) {
    if (result.error === "pipeline_busy") {
      throw new Error(
        "Webchat pipeline is busy. Please wait for the current query to finish.",
      );
    }
    throw new Error(result.error || "submit_query failed");
  }

  return { seq: result.seq };
}

// ---------------------------------------------------------------------------
// Poll for response (direct state access)
// ---------------------------------------------------------------------------

type PollResponseData = {
  status: string;
  responses: Array<{
    seq: number;
    attempt?: number;
    text?: string;
    error?: string;
    thinking?: string;
    answer_anchor_id?: string | null;
    answer_revision?: number;
    thinking_revision?: number;
    run_state?: RelayRunState;
    completion_reason?: RelayCompletionReason | null;
    remote_chat_url?: string | null;
    remote_chat_id?: string | null;
    user_turn_key?: string | null;
    assistant_turn_key?: string | null;
    baseline_transcript_count?: number;
    baseline_transcript_hash?: string | null;
    turn_status?: RelayTurnStatus | null;
    diagnostic?: RelayTurnDiagnostic | null;
  }>;
  partial_text: string | null;
  partial_thinking: string | null;
  answer_anchor_id: string | null;
  answer_revision: number;
  thinking_revision: number;
  run_state: RelayRunState | null;
  completion_reason: RelayCompletionReason | null;
  remote_chat_url: string | null;
  remote_chat_id: string | null;
  user_turn_key: string | null;
  assistant_turn_key: string | null;
  baseline_transcript_count: number;
  baseline_transcript_hash: string | null;
  turn_status: RelayTurnStatus | null;
  diagnostic: RelayTurnDiagnostic | null;
  current_seq: number;
};

export type WebChatAnswerSnapshot = WebChatTurnMetadata & {
  answerAnchorId: string | null;
  answerRevision: number;
  runState: RelayRunState | null;
  completionReason: RelayCompletionReason | null;
};

export type WebChatThinkingSnapshot = WebChatTurnMetadata & {
  thinkingRevision: number;
  runState: RelayRunState | null;
  completionReason: RelayCompletionReason | null;
};

export type WebChatPollResult = WebChatTurnMetadata & {
  text: string;
  thinking: string;
  answerAnchorId: string | null;
  answerRevision: number;
  thinkingRevision: number;
  runState: RelayRunState;
  completionReason: RelayCompletionReason | null;
  diagnostic: RelayTurnDiagnostic | null;
};

export type WebChatRemoteState = WebChatTurnMetadata;

function normalizeChatUrl(url: string | null | undefined): string {
  return String(url || "")
    .replace(/#.*$/, "")
    .replace(/\/+$/, "");
}

function buildRemoteState(): WebChatRemoteState {
  const snapshot = relayGetStateSnapshot();
  return {
    remoteChatUrl: snapshot.remote_chat_url || null,
    remoteChatId: snapshot.remote_chat_id || null,
    userTurnKey: snapshot.user_turn_key || null,
    assistantTurnKey: snapshot.assistant_turn_key || null,
    baselineTranscriptCount: snapshot.baseline_transcript_count || 0,
    baselineTranscriptHash: snapshot.baseline_transcript_hash || null,
    turnStatus: snapshot.turn_status || null,
  };
}

function withRemoteState<T extends Partial<WebChatRemoteState>>(
  data: T,
): T & WebChatRemoteState {
  return {
    ...buildRemoteState(),
    ...data,
  };
}

export async function waitForRemoteReady(
  _host: string,
  timeoutMs = REMOTE_READY_TIMEOUT_MS,
  signal?: AbortSignal,
  expectedChatUrl?: string | null,
): Promise<WebChatRemoteState> {
  const deadline = Date.now() + timeoutMs;
  const normalizedExpected = normalizeChatUrl(expectedChatUrl);

  while (Date.now() < deadline) {
    if (signal?.aborted) throw createAbortError();
    const state = buildRemoteState();

    if (state.turnStatus === "error" || state.turnStatus === "incomplete") {
      throw new Error("Chat conversation did not reach a ready state.");
    }

    const urlMatches =
      !normalizedExpected ||
      normalizeChatUrl(state.remoteChatUrl) === normalizedExpected;
    if (state.turnStatus === "ready" && urlMatches) {
      return state;
    }

    await new Promise((r) => setTimeout(r, REMOTE_READY_POLL_INTERVAL_MS));
  }

  throw new Error("Timed out waiting for chat conversation to load.");
}

export async function waitForRemoteReadyIfNavigating(
  host: string,
  signal?: AbortSignal,
): Promise<WebChatRemoteState> {
  const state = buildRemoteState();
  if (state.turnStatus !== "navigating") {
    return state;
  }
  return waitForRemoteReady(
    host,
    REMOTE_READY_TIMEOUT_MS,
    signal,
    state.remoteChatUrl,
  );
}

export async function pollForResponse(
  _host: string,
  seq: number,
  onAnswerSnapshot: (text: string, snapshot: WebChatAnswerSnapshot) => void,
  onThinkingSnapshot:
    | ((text: string, snapshot: WebChatThinkingSnapshot) => void)
    | undefined,
  signal: AbortSignal | undefined,
  timeoutMs = TIMEOUT_MS,
): Promise<WebChatPollResult> {
  let lastAnswerText = "";
  let lastThinkingText = "";
  let lastAnswerAnchorId: string | null = null;
  let lastAnswerRevision = 0;
  let lastThinkingRevision = 0;
  let lastRunState: RelayRunState | null = null;
  let lastCompletionReason: RelayCompletionReason | null = null;
  const startTime = Date.now();

  const buildTerminalResult = (
    match: PollResponseData["responses"][number],
    data: PollResponseData,
  ): WebChatPollResult => {
    const finalText =
      hasMeaningfulWebChatAnswerText(match.text) ||
      !hasMeaningfulWebChatAnswerText(lastAnswerText)
        ? typeof match.text === "string"
          ? match.text
          : lastAnswerText
        : lastAnswerText;
    const finalThinking =
      typeof match.thinking === "string" && match.thinking.length > 0
        ? match.thinking
        : lastThinkingText;
    const requestedRunState = match.run_state || "done";
    const finalAnswerRevision =
      Number.isFinite(match.answer_revision) &&
      Number(match.answer_revision) >= 0
        ? Number(match.answer_revision)
        : lastAnswerRevision;
    const finalThinkingRevision =
      Number.isFinite(match.thinking_revision) &&
      Number(match.thinking_revision) >= 0
        ? Number(match.thinking_revision)
        : lastThinkingRevision;
    const hasAnswer = hasMeaningfulWebChatAnswerText(finalText);
    const hasPartialContext =
      finalAnswerRevision > 0 ||
      finalThinkingRevision > 0 ||
      hasMeaningfulWebChatAnswerText(lastAnswerText) ||
      normalizeWebChatAnswerText(finalThinking).length > 0;
    const runState =
      requestedRunState === "done" && !hasAnswer && hasPartialContext
        ? "incomplete"
        : requestedRunState;
    const completionReason =
      runState === "incomplete"
        ? match.completion_reason || "error"
        : match.completion_reason || null;
    const result = withRemoteState({
      text: finalText || "",
      thinking: finalThinking || "",
      answerAnchorId: match.answer_anchor_id || lastAnswerAnchorId,
      answerRevision: finalAnswerRevision,
      thinkingRevision: finalThinkingRevision,
      runState,
      completionReason,
      remoteChatUrl: match.remote_chat_url || data.remote_chat_url || null,
      remoteChatId: match.remote_chat_id || data.remote_chat_id || null,
      userTurnKey: match.user_turn_key || data.user_turn_key || null,
      assistantTurnKey:
        match.assistant_turn_key || data.assistant_turn_key || null,
      baselineTranscriptCount:
        match.baseline_transcript_count ?? data.baseline_transcript_count ?? 0,
      baselineTranscriptHash:
        match.baseline_transcript_hash || data.baseline_transcript_hash || null,
      turnStatus:
        match.turn_status ||
        data.turn_status ||
        (runState === "incomplete" ? "incomplete" : null),
      diagnostic: match.diagnostic || data.diagnostic || null,
    });

    emitAnswerSnapshot(result.text, {
      answerAnchorId: result.answerAnchorId,
      answerRevision: result.answerRevision,
      runState: result.runState,
      completionReason: result.completionReason,
      remoteChatUrl: result.remoteChatUrl,
      remoteChatId: result.remoteChatId,
      userTurnKey: result.userTurnKey,
      assistantTurnKey: result.assistantTurnKey,
      baselineTranscriptCount: result.baselineTranscriptCount,
      baselineTranscriptHash: result.baselineTranscriptHash,
      turnStatus: result.turnStatus,
    });
    emitThinkingSnapshot(result.thinking, {
      thinkingRevision: result.thinkingRevision,
      runState: result.runState,
      completionReason: result.completionReason,
      remoteChatUrl: result.remoteChatUrl,
      remoteChatId: result.remoteChatId,
      userTurnKey: result.userTurnKey,
      assistantTurnKey: result.assistantTurnKey,
      baselineTranscriptCount: result.baselineTranscriptCount,
      baselineTranscriptHash: result.baselineTranscriptHash,
      turnStatus: result.turnStatus,
    });

    if (result.runState !== "incomplete" && !hasAnswer) {
      throw new Error("Chat finished without a visible final answer.");
    }

    return result;
  };

  const emitAnswerSnapshot = (
    text: string | null | undefined,
    snapshot: WebChatAnswerSnapshot,
  ) => {
    const nextText = typeof text === "string" ? text : "";
    const nextRevision = Number.isFinite(snapshot.answerRevision)
      ? Math.max(0, Math.floor(snapshot.answerRevision))
      : lastAnswerRevision;
    const changed =
      nextText !== lastAnswerText ||
      nextRevision !== lastAnswerRevision ||
      snapshot.answerAnchorId !== lastAnswerAnchorId ||
      snapshot.runState !== lastRunState ||
      snapshot.completionReason !== lastCompletionReason;
    if (!changed) return;

    lastAnswerText = nextText;
    lastAnswerRevision = nextRevision;
    lastAnswerAnchorId = snapshot.answerAnchorId;
    lastRunState = snapshot.runState;
    lastCompletionReason = snapshot.completionReason;
    onAnswerSnapshot(nextText, snapshot);
  };

  const emitThinkingSnapshot = (
    text: string | null | undefined,
    snapshot: WebChatThinkingSnapshot,
  ) => {
    if (!onThinkingSnapshot) return;
    const nextText = typeof text === "string" ? text : "";
    const nextRevision = Number.isFinite(snapshot.thinkingRevision)
      ? Math.max(0, Math.floor(snapshot.thinkingRevision))
      : lastThinkingRevision;
    const changed =
      nextText !== lastThinkingText ||
      nextRevision !== lastThinkingRevision ||
      snapshot.runState !== lastRunState ||
      snapshot.completionReason !== lastCompletionReason;
    if (!changed) return;

    lastThinkingText = nextText;
    lastThinkingRevision = nextRevision;
    onThinkingSnapshot(nextText, snapshot);
  };

  while (Date.now() - startTime < timeoutMs) {
    if (signal?.aborted) throw createAbortError();

    const data: PollResponseData = relayPollResponse();

    if (data.current_seq === seq) {
      if (
        typeof data.partial_text === "string" ||
        (data.answer_revision || 0) > lastAnswerRevision
      ) {
        emitAnswerSnapshot(
          data.partial_text,
          withRemoteState({
            answerAnchorId: data.answer_anchor_id || null,
            answerRevision: data.answer_revision || 0,
            runState: data.run_state,
            completionReason: data.completion_reason,
            remoteChatUrl: data.remote_chat_url || null,
            remoteChatId: data.remote_chat_id || null,
            userTurnKey: data.user_turn_key || null,
            assistantTurnKey: data.assistant_turn_key || null,
            baselineTranscriptCount: data.baseline_transcript_count || 0,
            baselineTranscriptHash: data.baseline_transcript_hash || null,
            turnStatus: data.turn_status || null,
          }),
        );
      }
      if (
        typeof data.partial_thinking === "string" ||
        (data.thinking_revision || 0) > lastThinkingRevision
      ) {
        emitThinkingSnapshot(
          data.partial_thinking,
          withRemoteState({
            thinkingRevision: data.thinking_revision || 0,
            runState: data.run_state,
            completionReason: data.completion_reason,
            remoteChatUrl: data.remote_chat_url || null,
            remoteChatId: data.remote_chat_id || null,
            userTurnKey: data.user_turn_key || null,
            assistantTurnKey: data.assistant_turn_key || null,
            baselineTranscriptCount: data.baseline_transcript_count || 0,
            baselineTranscriptHash: data.baseline_transcript_hash || null,
            turnStatus: data.turn_status || null,
          }),
        );
      }
    }

    if (data.current_seq !== seq) {
      const match = (data.responses || []).find((r) => r.seq === seq);
      if (match) {
        if (match.error) throw new Error(match.error);
        return buildTerminalResult(match, data);
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      continue;
    }

    // Check for final response
    const match = (data.responses || []).find((r) => r.seq === seq);
    if (match) {
      if (match.error) throw new Error(match.error);
      return buildTerminalResult(match, data);
    }

    if (data.status === "error") {
      throw new Error("Webchat pipeline encountered an error.");
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  throw new Error(
    `Timed out waiting for webchat response (${Math.round(timeoutMs / 1000)} seconds).`,
  );
}

// ---------------------------------------------------------------------------
// New chat command (direct state access)
// ---------------------------------------------------------------------------

export async function sendNewChat(_host: string): Promise<void> {
  relayNewChat();
}

// ---------------------------------------------------------------------------
// Chat history (direct state access)
// ---------------------------------------------------------------------------

export type WebChatHistorySession = {
  id: string;
  title: string;
  chatUrl: string | null;
};

export type WebChatHistorySnapshot = {
  sessions: WebChatHistorySession[];
  siteSync: Record<string, RelayHistorySiteSyncEntry>;
};

export type WebChatScrapedTranscriptSnapshot = ScrapedTranscriptSnapshot;

export async function fetchChatHistory(
  host: string,
): Promise<WebChatHistorySession[]> {
  return (await fetchChatHistorySnapshot(host)).sessions;
}

export async function fetchChatHistorySnapshot(
  _host: string,
): Promise<WebChatHistorySnapshot> {
  const snapshot = relayGetHistorySnapshot();
  return {
    sessions: snapshot.sessions,
    siteSync: snapshot.siteSync,
  };
}

export function getWebChatHistorySiteSyncEntry(
  snapshot: WebChatHistorySnapshot,
  siteHostname: string | null | undefined,
): RelayHistorySiteSyncEntry | null {
  const normalizedHostname = normalizeHistoryHostname(siteHostname);
  if (!normalizedHostname) return null;
  return (
    Object.entries(snapshot.siteSync).find(
      ([hostname]) => normalizeHistoryHostname(hostname) === normalizedHostname,
    )?.[1] || null
  );
}

export function getWebChatHistorySiteStatus(
  snapshot: WebChatHistorySnapshot,
  siteHostname: string | null | undefined,
): RelayHistorySiteSyncEntry["status"] | null {
  return getWebChatHistorySiteSyncEntry(snapshot, siteHostname)?.status || null;
}

export function isWebChatHistorySiteFailure(
  entry: RelayHistorySiteSyncEntry | null | undefined,
): boolean {
  return entry?.status === "invalid_source" || entry?.status === "timeout";
}

export async function fetchScrapedTranscriptSnapshot(
  _host: string,
): Promise<WebChatScrapedTranscriptSnapshot | null> {
  return relayGetScrapedTranscriptSnapshot();
}

export function filterWebChatHistorySessionsForHostname(
  sessions: WebChatHistorySession[],
  hostname: string | null | undefined,
): WebChatHistorySession[] {
  const normalizedHostname = normalizeHistoryHostname(hostname);
  if (!normalizedHostname) return sessions;

  return sessions.filter((session) => {
    try {
      return (
        normalizeHistoryHostname(new URL(session.chatUrl || "").hostname) ===
        normalizedHostname
      );
    } catch {
      return false;
    }
  });
}

function getScrapedTranscriptSnapshotHostname(
  snapshot: WebChatScrapedTranscriptSnapshot | null | undefined,
): string {
  if (!snapshot) return "";
  if (snapshot.siteHostname) {
    return normalizeHistoryHostname(snapshot.siteHostname);
  }
  if (!snapshot.chatUrl) return "";
  try {
    return normalizeHistoryHostname(new URL(snapshot.chatUrl).hostname);
  } catch {
    return "";
  }
}

function scrapedTranscriptSnapshotMatches(
  snapshot: WebChatScrapedTranscriptSnapshot | null | undefined,
  options: {
    expectedChatUrl?: string | null;
    expectedChatId?: string | null;
    siteHostname?: string | null;
    minCapturedAt?: number;
  },
): boolean {
  if (!snapshot) return false;
  const minCapturedAt = Number(options.minCapturedAt) || 0;
  if ((snapshot.capturedAt || 0) < minCapturedAt) return false;

  const expectedChatId = String(options.expectedChatId || "").trim();
  const actualChatId = String(snapshot.chatId || "").trim();
  if (expectedChatId) {
    if (actualChatId) {
      if (actualChatId !== expectedChatId) {
        return false;
      }
    } else {
      const expectedChatUrl = normalizeChatUrl(options.expectedChatUrl);
      if (
        expectedChatUrl &&
        normalizeChatUrl(snapshot.chatUrl) !== expectedChatUrl
      ) {
        return false;
      }
    }
  } else {
    const expectedChatUrl = normalizeChatUrl(options.expectedChatUrl);
    if (
      expectedChatUrl &&
      normalizeChatUrl(snapshot.chatUrl) !== expectedChatUrl
    ) {
      return false;
    }
  }

  const expectedSiteHostname = normalizeHistoryHostname(options.siteHostname);
  if (
    expectedSiteHostname &&
    getScrapedTranscriptSnapshotHostname(snapshot) !== expectedSiteHostname
  ) {
    return false;
  }

  return true;
}

export async function waitForFreshScrapedTranscriptSnapshot(
  host: string,
  options: {
    expectedChatUrl?: string | null;
    expectedChatId?: string | null;
    siteHostname?: string | null;
    minCapturedAt?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<WebChatScrapedTranscriptSnapshot | null> {
  const timeoutMs = Number(options.timeoutMs) || HISTORY_REFRESH_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let latest = await fetchScrapedTranscriptSnapshot(host);

  while (true) {
    if (scrapedTranscriptSnapshotMatches(latest, options)) {
      return latest;
    }
    if (Date.now() >= deadline) {
      return fetchLatestMatchingScrapedTranscriptSnapshot(host, {
        expectedChatUrl: options.expectedChatUrl,
        expectedChatId: options.expectedChatId,
        siteHostname: options.siteHostname,
      });
    }
    if (options.signal?.aborted) throw createAbortError();
    await new Promise((r) => setTimeout(r, REMOTE_READY_POLL_INTERVAL_MS));
    latest = await fetchScrapedTranscriptSnapshot(host);
  }
}

async function fetchLatestMatchingScrapedTranscriptSnapshot(
  host: string,
  options: {
    expectedChatUrl?: string | null;
    expectedChatId?: string | null;
    siteHostname?: string | null;
  },
): Promise<WebChatScrapedTranscriptSnapshot | null> {
  const latest = await fetchScrapedTranscriptSnapshot(host);
  return scrapedTranscriptSnapshotMatches(latest, {
    ...options,
    minCapturedAt: 0,
  })
    ? latest
    : null;
}

async function waitForFreshScrapedMessagesForChat(
  host: string,
  options: {
    expectedChatUrl?: string | null;
    expectedChatId?: string | null;
    minCapturedAt: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<RefreshResult> {
  const siteHostname = options.expectedChatUrl
    ? (() => {
        try {
          return new URL(options.expectedChatUrl).hostname;
        } catch {
          return null;
        }
      })()
    : null;
  const isDeepSeekChat =
    normalizeHistoryHostname(siteHostname) === "chat.deepseek.com";
  const snapshot = await waitForFreshScrapedTranscriptSnapshot(host, {
    expectedChatUrl: options.expectedChatUrl,
    expectedChatId: options.expectedChatId,
    siteHostname,
    minCapturedAt: options.minCapturedAt,
    timeoutMs:
      options.timeoutMs ||
      (isDeepSeekChat ? DEEPSEEK_SCRAPE_TIMEOUT_MS : REMOTE_READY_TIMEOUT_MS),
    signal: options.signal,
  });

  const fallbackSnapshot = async () =>
    fetchLatestMatchingScrapedTranscriptSnapshot(host, {
      expectedChatUrl: options.expectedChatUrl,
      expectedChatId: options.expectedChatId,
      siteHostname,
    });

  const matchedSnapshot = snapshot || (await fallbackSnapshot());
  if (!matchedSnapshot) {
    throw new Error("Timed out waiting for a fresh scraped chat transcript.");
  }
  if (!matchedSnapshot.messages.length) {
    const fallback = await fallbackSnapshot();
    if (fallback?.messages.length) {
      return fallback.messages.map(mapScrapedMessage);
    }
    throw new Error(
      "Selected chat loaded, but no transcript messages were captured.",
    );
  }
  return matchedSnapshot.messages.map(mapScrapedMessage);
}

export async function waitForFreshChatHistorySnapshot(
  host: string,
  siteHostname: string | null | undefined,
  minLastUpdatedAt: number,
  timeoutMs = HISTORY_REFRESH_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<WebChatHistorySnapshot> {
  const normalizedHostname = normalizeHistoryHostname(siteHostname);
  const deadline = Date.now() + timeoutMs;
  let latest = await fetchChatHistorySnapshot(host);

  if (!normalizedHostname) {
    return latest;
  }

  while (true) {
    const siteSyncEntry = getWebChatHistorySiteSyncEntry(
      latest,
      normalizedHostname,
    );
    if ((siteSyncEntry?.lastUpdatedAt || 0) >= minLastUpdatedAt) {
      return latest;
    }
    if (Date.now() >= deadline) {
      return latest;
    }
    if (signal?.aborted) throw createAbortError();
    await new Promise((r) => setTimeout(r, HISTORY_REFRESH_POLL_INTERVAL_MS));
    latest = await fetchChatHistorySnapshot(host);
  }
}

export async function loadChatSession(
  _host: string,
  sessionId: string,
): Promise<{
  messages: Array<{
    speaker: string;
    text: string;
    kind: string;
    thinking?: string;
    timestamp?: string;
  }>;
} | null> {
  const loadStartedAt = Date.now();
  const result = relayLoadChat(sessionId);
  if (!result.ok) return null;

  const scraped = await waitForFreshScrapedMessagesForChat(_host, {
    expectedChatUrl: result.session.chatUrl || null,
    expectedChatId: result.session.id || null,
    minCapturedAt: loadStartedAt,
  });

  return {
    messages: scraped.map((message) => ({
      speaker: message.speaker,
      text: message.text || "",
      kind: message.kind,
      thinking: message.thinking,
    })),
  };
}

// ---------------------------------------------------------------------------
// Refresh current conversation (re-scrape from ChatGPT)
// ---------------------------------------------------------------------------

type RefreshResult = Array<{
  speaker: string;
  text: string;
  kind: string;
  thinking?: string;
}>;

/**
 * Navigate to a provider conversation and re-scrape messages.
 *
 * Priority for finding the target conversation:
 * 1. Explicit `chatUrl` / `chatId` (from the persisted message metadata)
 * 2. Relay state's `remote_chat_url` (volatile, may be stale)
 * 3. Mirrored history lookup by chat ID
 */
export async function refreshCurrentConversation(
  _host: string,
  chatUrl?: string | null,
  chatId?: string | null,
): Promise<RefreshResult> {
  const {
    relayRefreshChat,
    relaySetCommand,
    relayUpdateTurnState,
    relayLoadChat: relayLoadChatFn,
  } = await import("./relayServer");

  // Strategy 1: explicit URL from message metadata
  if (chatUrl) {
    const scraped = await navigateAndScrape(
      _host,
      chatUrl,
      chatId || undefined,
      relaySetCommand,
      relayUpdateTurnState,
    );
    if (scraped.length > 0) return scraped;
  }

  // Strategy 2: relay state's current URL
  const refreshStartedAt = Date.now();
  const result = relayRefreshChat();
  if (result.ok) {
    try {
      return await waitForFreshScrapedMessagesForChat(_host, {
        expectedChatUrl: result.chatUrl || null,
        expectedChatId:
          chatId || relayGetStateSnapshot().remote_chat_id || null,
        minCapturedAt: refreshStartedAt,
      });
    } catch {
      /* fall through */
    }
  }

  // Strategy 3: mirrored history lookup
  const fallbackId = chatId || relayGetStateSnapshot().remote_chat_id;
  if (fallbackId) {
    const fallbackStartedAt = Date.now();
    const loaded = relayLoadChatFn(fallbackId);
    if (loaded.ok && loaded.session.chatUrl) {
      try {
        return await waitForFreshScrapedMessagesForChat(_host, {
          expectedChatUrl: loaded.session.chatUrl || null,
          expectedChatId: fallbackId || null,
          minCapturedAt: fallbackStartedAt,
        });
      } catch {
        /* exhausted */
      }
    }
  }

  return [];
}

async function navigateAndScrape(
  host: string,
  chatUrl: string,
  chatId: string | undefined,
  relaySetCommandFn: typeof import("./relayServer").relaySetCommand,
  relayUpdateTurnStateFn: typeof import("./relayServer").relayUpdateTurnState,
): Promise<RefreshResult> {
  const startedAt = Date.now();
  relayUpdateTurnStateFn({ turn_status: "navigating" });
  relaySetCommandFn({ type: "LOAD_CHAT", chatUrl, chatId });
  try {
    return await waitForFreshScrapedMessagesForChat(host, {
      expectedChatUrl: chatUrl || null,
      expectedChatId: chatId || null,
      minCapturedAt: startedAt,
    });
  } catch {
    /* navigation failed */
  }
  return [];
}

function mapScrapedMessage(m: {
  role: string;
  text: string;
  thinking?: string;
}) {
  return {
    speaker: m.role === "user" ? "user" : "assistant",
    text: m.text || "",
    kind: m.role === "user" ? "user" : "bot",
    thinking: m.thinking,
  };
}

// ---------------------------------------------------------------------------
// Scraped messages (direct state access)
// ---------------------------------------------------------------------------

export async function fetchScrapedMessages(
  _host: string,
  timeoutMs = 10_000,
): Promise<Array<{ role: string; text: string }>> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const messages =
      relayGetScrapedTranscriptSnapshot()?.messages ||
      relayGetScrapedMessages();
    if (messages && messages.length > 0) {
      return messages;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return [];
}

// ---------------------------------------------------------------------------
// Reported mode (direct state access)
// ---------------------------------------------------------------------------

/** Get the ChatGPT mode reported back by the extension. */
export function getReportedMode(): string | null {
  return relayGetReportedMode();
}

// ---------------------------------------------------------------------------
// Connection test
// ---------------------------------------------------------------------------

/** Returns true if the Chrome extension has contacted the relay recently. */
export async function testConnection(_host: string): Promise<boolean> {
  try {
    const { relayGetExtensionLiveness } = await import("./relayServer");
    return relayGetExtensionLiveness().aliveSinceMs < 15_000;
  } catch {
    return false;
  }
}
