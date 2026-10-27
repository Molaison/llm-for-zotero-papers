/**
 * CPR direct web: request preparation for the ChatGPT Web Responses route.
 *
 * The papers route owns a server-side registry that says what to upload. The
 * ChatGPT Web route has none: PDFs travel as `input_file` parts once, upstream
 * remembers them per conversation, and every later turn must simply not send
 * them again. That "which PDFs already travelled" decision is local, so this
 * module keeps a per conversation ledger in `Zotero.Prefs` and prepares the
 * request body from it.
 *
 * Nothing here talks to the network, a browser or cookies: it reads Zotero
 * attachments, hashes them, records the ledger, and returns a payload. The
 * caller owns dispatch, and owns settling the turn afterwards with
 * `accept()` (complete response) or `markUncertain()` (failed or incomplete
 * response, which must never trigger a silent re-upload).
 */
import { config } from "../../package.json";
import type { ReasoningConfig } from "../shared/llm";
import type { PaperContextRef } from "../shared/types";
import {
  normalizePaperRouteTarget,
  normalizePaperDoi,
  resolvePaperReasoningEffort,
} from "./cprPapers";
import {
  createProviderOperationId,
  resolveProviderSessionId,
} from "./providerSessionId";
import type { ProviderRequestScope } from "./providerTransport";
import type { ModelProfileOverride } from "../modelCapabilities";

/** Ceilings for one turn's new PDFs; order is preserved and never re-sorted. */
const MAX_NEW_FILES = 8;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const FILENAME_LIMIT = 255;
const DEFAULT_FILENAME = "paper.pdf";
const SESSION_PREFIX = "zotero-cpr-";
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-

/**
 * The one state a caller must be able to recognise without reading the ledger:
 * an earlier attempt for this PDF ended with an unknown outcome, so the file is
 * not sent again and the conversation continues without it.
 */
export const CPR_DIRECT_WEB_UNCERTAIN_MESSAGE =
  "这篇 PDF 上次上传的结果不确定；本次不会自动重传文件，仅继续不带文件的对话。";

const LEDGER_BROKEN =
  "本地 CPR direct web 记录损坏，无法确认哪些 PDF 已上传；为避免重复上传已停止发送。";
const PREFS_UNAVAILABLE =
  "本地记录不可用，无法保证 PDF 只上传一次；没有发送请求。";
const PDF_MISSING = "PDF 尚未下载到本机，请先同步附件。";
const PDF_INVALID = "附件不是有效的 PDF（缺少 %PDF- 头）；没有发送请求。";
const IDENTITY_CHANGED =
  "同一 DOI 已登记不同的 PDF 指纹；已停止发送，避免把两篇不同 PDF 混进同一对话。";
const SESSION_MISSING = "缺少稳定的 CPR direct web 会话 id；没有发送请求。";

export type CprDirectWebUploadedFile = {
  paperId: string;
  pdfSha256: string;
  filename: string;
  /** Position among this turn's uploads, matching the input part order. */
  order: number;
};

export type CprDirectWebUncertainEntry = {
  paperId: string;
  filename: string;
  message: string;
};

type ContentPart =
  | { type: "input_file"; filename: string; file_data: string }
  | { type: "input_text"; text: string };

export type CprDirectWebPayload = {
  model: string;
  stream: boolean;
  prompt_cache_key: string;
  reasoning?: { effort: string };
  client_metadata: { "x-codex-turn-metadata": string };
  input: Array<{
    type: "message";
    role: "user";
    id: string;
    content: ContentPart[];
  }>;
};

export type CprDirectWebPreparedRequest = {
  payload: CprDirectWebPayload;
  sessionId: string;
  /** Newly uploaded files, in the order they appear in `payload`. */
  uploaded: CprDirectWebUploadedFile[];
  /** Identities already registered upstream: served without reading bytes. */
  reused: string[];
  /** Identities an earlier turn left unresolved: no automatic re-upload. */
  uncertain: CprDirectWebUncertainEntry[];
  /** Call once the response completed, so later turns skip the upload. */
  accept: () => void;
  /** Call when the response failed or was incomplete; blocks a re-upload. */
  markUncertain: (reason?: string) => void;
};

export type CprDirectWebPrepareParams = {
  /** UI order; a repeated paper identity keeps its first position only. */
  refs: PaperContextRef[];
  apiBase: string;
  model: string;
  prompt: string;
  requestScope: ProviderRequestScope;
  reasoning?: ReasoningConfig;
  /** User-authored capability override for this model, when present. */
  profileOverride?: ModelProfileOverride;
  /** Defaults to true; the caller may override it on the returned payload. */
  stream?: boolean;
  readBytes: (path: string) => Promise<Uint8Array>;
};

type LedgerEntry = {
  paperId: string;
  pdfSha256: string;
  filename: string;
  order?: number;
  reason?: string;
};

type Ledger = {
  version: 1;
  entries: LedgerEntry[];
  pending: LedgerEntry[];
  uncertain: LedgerEntry[];
};

type LedgerPrefs = {
  get?: (key: string, global?: boolean) => unknown;
  set?: (key: string, value: unknown, global?: boolean) => void;
};

/**
 * The conversation's direct web session, prefixed so it cannot be mistaken for
 * another route's id. A conversation derives it from its stable key, so every
 * turn of one conversation reuses one upstream cache entry; a standalone turn
 * uses its own operation id. The caller injects the same value as the generic
 * CPR request's `prompt_cache_key` so both land on one conversation.
 */
export async function resolveCprDirectWebSessionId(
  requestScope: ProviderRequestScope,
): Promise<string> {
  const derived =
    "conversationKey" in requestScope
      ? await resolveProviderSessionId(requestScope.conversationKey)
      : requestScope.operationId;
  const id = typeof derived === "string" ? derived.trim() : "";
  if (!id) throw new Error(SESSION_MISSING);
  return `${SESSION_PREFIX}${id}`;
}

function prefs(): LedgerPrefs | undefined {
  return (globalThis as { Zotero?: { Prefs?: LedgerPrefs } }).Zotero?.Prefs;
}

/** One ledger per CPR target and session; the session is what keeps turns together. */
function ledgerKeyFor(target: string, sessionId: string): string {
  return `${config.prefsPrefix}.cprDirectWebLedger.${encodeURIComponent(`${target}:${sessionId}`)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseEntry(value: unknown): LedgerEntry {
  if (
    !isRecord(value) ||
    typeof value.paperId !== "string" ||
    !value.paperId.trim() ||
    typeof value.pdfSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.pdfSha256) ||
    typeof value.filename !== "string" ||
    !value.filename.trim() ||
    (value.order !== undefined &&
      (typeof value.order !== "number" || !Number.isFinite(value.order))) ||
    (value.reason !== undefined && typeof value.reason !== "string")
  ) {
    throw new Error(LEDGER_BROKEN);
  }
  return {
    paperId: value.paperId,
    pdfSha256: value.pdfSha256,
    filename: value.filename,
    ...(value.order === undefined ? {} : { order: value.order }),
    ...(value.reason === undefined ? {} : { reason: value.reason }),
  };
}

function parseEntries(value: unknown): LedgerEntry[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(LEDGER_BROKEN);
  return value.map(parseEntry);
}

function readLedger(key: string): Ledger {
  const raw = prefs()?.get?.(key, true);
  if (raw === undefined || raw === null || raw === "") {
    return { version: 1, entries: [], pending: [], uncertain: [] };
  }
  // A record that cannot be trusted must fail closed: guessing would re-upload
  // a PDF whose earlier outcome is exactly what the record was holding.
  if (typeof raw !== "string") throw new Error(LEDGER_BROKEN);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(LEDGER_BROKEN);
  }
  if (!isRecord(parsed) || parsed.version !== 1) throw new Error(LEDGER_BROKEN);
  return {
    version: 1,
    entries: parseEntries(parsed.entries),
    pending: parseEntries(parsed.pending),
    uncertain: parseEntries(parsed.uncertain),
  };
}

function writeLedger(key: string, ledger: Ledger): void {
  prefs()?.set?.(key, JSON.stringify(ledger), true);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const stable = new Uint8Array(bytes.byteLength);
  stable.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", stable.buffer);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function assertPdfBytes(bytes: Uint8Array): void {
  if (
    bytes.length < PDF_MAGIC.length ||
    PDF_MAGIC.some((byte, index) => bytes[index] !== byte)
  ) {
    throw new Error(PDF_INVALID);
  }
}

function pdfFilename(path: string): string {
  const base = (path.split(/[\\/]/).pop() || "").trim();
  return base ? base.slice(0, FILENAME_LIMIT) : DEFAULT_FILENAME;
}

function requirePaper(ref: PaperContextRef): Zotero.Item {
  const paper = ref.itemId ? Zotero.Items.get(ref.itemId) || undefined : undefined;
  if (!paper || !paper.isRegularItem()) {
    throw new Error("CPR direct web 需要上下文里的父条目仍在当前资料库；不会改用其他条目。");
  }
  return paper;
}

/**
 * The ref names exactly one attachment. Another PDF of the same paper is a
 * different file, so a fallback to the paper's best attachment would upload
 * something the user never selected.
 */
function requirePdfAttachment(ref: PaperContextRef): Zotero.Item {
  const attachment = ref.contextItemId
    ? Zotero.Items.get(ref.contextItemId) || undefined
    : undefined;
  if (
    !attachment ||
    !attachment.isAttachment() ||
    attachment.attachmentContentType !== "application/pdf" ||
    attachment.parentID !== ref.itemId
  ) {
    throw new Error("所选上下文不是该论文的 application/pdf 附件；不会回退到其他附件。");
  }
  return attachment;
}

type PdfPayload = { path: string; bytes: Uint8Array; hash: string };

async function readPdf(
  attachment: Zotero.Item,
  readBytes: (path: string) => Promise<Uint8Array>,
): Promise<PdfPayload> {
  const path = await attachment.getFilePathAsync();
  if (!path) throw new Error(PDF_MISSING);
  const bytes = await readBytes(path);
  assertPdfBytes(bytes);
  return { path, bytes, hash: await sha256(bytes) };
}

/**
 * Build the direct web request for one turn.
 *
 * A PDF travels exactly once per identity and session: a registered identity is
 * served without reading its bytes, an unresolved one is never re-sent, and a
 * new one is uploaded once and recorded as pending before this function
 * returns. The returned payload carries no previous response id, so the caller
 * decides how far back upstream should look.
 */
export async function prepareCprDirectWebRequest(
  params: CprDirectWebPrepareParams,
): Promise<CprDirectWebPreparedRequest> {
  const model = String(params.model || "").trim();
  if (!model) throw new Error("CPR direct web 请求缺少模型；没有发送请求。");
  // Resolved before any file is read: an unsupported level must fail untouched.
  const effort = resolvePaperReasoningEffort({
    model,
    apiBase: params.apiBase,
    reasoning: params.reasoning,
    profileOverride: params.profileOverride,
  });
  const sessionId = await resolveCprDirectWebSessionId(params.requestScope);
  if (!prefs()) throw new Error(PREFS_UNAVAILABLE);
  const target = normalizePaperRouteTarget(String(params.apiBase || ""));
  const ledgerKey = ledgerKeyFor(target, sessionId);
  const ledger = readLedger(ledgerKey);
  const registered = new Set(ledger.entries.map((entry) => entry.paperId));
  const pending = new Map(
    ledger.pending.map((entry) => [entry.paperId, entry]),
  );
  const unresolved = new Map(
    ledger.uncertain.map((entry) => [entry.paperId, entry]),
  );
  const known = new Map<string, LedgerEntry>();
  for (const entry of [...ledger.entries, ...ledger.pending, ...ledger.uncertain]) {
    known.set(entry.paperId, entry);
  }

  const reused: string[] = [];
  const uncertain: CprDirectWebUncertainEntry[] = [];
  const uploads: Array<CprDirectWebUploadedFile & { bytes: Uint8Array }> = [];
  const seen = new Set<string>();
  let totalBytes = 0;

  for (const ref of params.refs) {
    const paper = requirePaper(ref);
    const attachment = requirePdfAttachment(ref);
    let pdf: PdfPayload | undefined;
    const loadPdf = async () => (pdf ??= await readPdf(attachment, params.readBytes));
    let paperId = normalizePaperDoi(String(paper.getField("DOI") || ""));
    // Without a DOI the bytes are the identity, so they have to be read — even
    // for an already registered PDF, which is the only case that reads twice.
    if (!paperId) paperId = `sha256:${(await loadPdf()).hash}`;
    if (seen.has(paperId)) continue;
    seen.add(paperId);
    if (registered.has(paperId)) {
      reused.push(paperId);
      continue;
    }
    const inFlight = pending.get(paperId);
    if (inFlight) {
      const resolvedPendingPdf = await loadPdf();
      if (inFlight.pdfSha256 !== resolvedPendingPdf.hash) {
        throw new Error(IDENTITY_CHANGED);
      }
      uncertain.push({
        paperId,
        filename: inFlight.filename,
        message: CPR_DIRECT_WEB_UNCERTAIN_MESSAGE,
      });
      continue;
    }
    const blocked = unresolved.get(paperId);
    if (blocked) {
      uncertain.push({
        paperId,
        filename: blocked.filename,
        message: CPR_DIRECT_WEB_UNCERTAIN_MESSAGE,
      });
      continue;
    }
    const resolvedPdf = await loadPdf();
    const earlier = known.get(paperId);
    if (earlier && earlier.pdfSha256 !== resolvedPdf.hash) {
      throw new Error(IDENTITY_CHANGED);
    }
    if (resolvedPdf.bytes.length > MAX_FILE_BYTES) {
      throw new Error("单个 PDF 超过 50 MiB 上限；没有发送请求。");
    }
    if (uploads.length + 1 > MAX_NEW_FILES) {
      throw new Error("本次新增 PDF 超过 8 个上限；没有发送请求。");
    }
    totalBytes += resolvedPdf.bytes.length;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error("本次新增 PDF 合计超过 100 MiB 上限；没有发送请求。");
    }
    uploads.push({
      paperId,
      pdfSha256: resolvedPdf.hash,
      filename: pdfFilename(resolvedPdf.path),
      order: uploads.length,
      bytes: resolvedPdf.bytes,
    });
  }

  const content: ContentPart[] = uploads.map((file) => ({
    type: "input_file",
    filename: file.filename,
    file_data: `data:application/pdf;base64,${base64(file.bytes)}`,
  }));
  content.push({
    type: "input_text",
    text: uploads.length
      ? `本次对话新增 ${uploads.length} 个 PDF 附件：\n${uploads
          .map((file, index) => `${index + 1}. ${file.filename}`)
          .join("\n")}\n\n${params.prompt}`
      : params.prompt,
  });

  const turnId = createProviderOperationId();
  const uploaded: CprDirectWebUploadedFile[] = uploads.map(
    ({ paperId, pdfSha256, filename, order }) => ({
      paperId,
      pdfSha256,
      filename,
      order,
    }),
  );
  const payload: CprDirectWebPayload = {
    model,
    stream: params.stream ?? true,
    prompt_cache_key: sessionId,
    ...(effort ? { reasoning: { effort } } : {}),
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({
        thread_id: sessionId,
        turn_id: turnId,
        zotero_pdf_contexts: uploaded.map((file) => ({
          paper_id: file.paperId,
          pdf_sha256: file.pdfSha256,
          filename: file.filename,
        })),
      }),
    },
    input: [
      { type: "message", role: "user", id: `cpr-direct-web-${turnId}`, content },
    ],
  };

  const pendingIds = new Set(uploaded.map((file) => file.paperId));
  if (uploaded.length) {
    // Written before anything is sent: a turn that never reports back stays
    // pending rather than looking like it uploaded nothing.
    const current = readLedger(ledgerKey);
    writeLedger(ledgerKey, {
      version: 1,
      entries: current.entries,
      pending: [
        ...current.pending.filter((entry) => !pendingIds.has(entry.paperId)),
        ...uploaded,
      ],
      uncertain: current.uncertain,
    });
  }
  const settle = (status: "ready" | "uncertain", reason?: string): void => {
    if (!uploaded.length) return;
    const current = readLedger(ledgerKey);
    const keep = (entry: LedgerEntry) => !pendingIds.has(entry.paperId);
    const settled = uploaded.map((file) => ({
      ...file,
      ...(status === "uncertain"
        ? { reason: reason?.trim() || CPR_DIRECT_WEB_UNCERTAIN_MESSAGE }
        : {}),
    }));
    if (status === "ready") {
      writeLedger(ledgerKey, {
        version: 1,
        entries: [...current.entries.filter(keep), ...settled],
        pending: current.pending.filter(keep),
        uncertain: current.uncertain.filter(keep),
      });
      return;
    }
    const ready = new Set(current.entries.map((entry) => entry.paperId));
    writeLedger(ledgerKey, {
      version: 1,
      entries: current.entries,
      pending: current.pending.filter(keep),
      // A complete response elsewhere already settled this identity; keep it out
      // of `uncertain` so a registered PDF does not also read as unresolved.
      uncertain: [
        ...current.uncertain.filter(keep),
        ...settled.filter((file) => !ready.has(file.paperId)),
      ],
    });
  };

  return {
    payload,
    sessionId,
    uploaded,
    reused,
    uncertain,
    accept: () => settle("ready"),
    markUncertain: (reason?: string) => settle("uncertain", reason),
  };
}
