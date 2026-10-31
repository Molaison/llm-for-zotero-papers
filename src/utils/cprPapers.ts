import { config } from "../../package.json";
import { gzipSync, strToU8 } from "fflate";
import type { ReasoningConfig } from "../shared/llm";
import { resolveEndpoint, RESPONSES_ENDPOINT } from "./apiHelpers";
import {
  resolveProviderSessionId,
  createProviderOperationId,
} from "./providerSessionId";
import { getModelCapabilities } from "../modelCapabilities";
import type { ModelProfileOverride } from "../modelCapabilities";
import { parseCprChartWidget, type CprChartWidget } from "./cprRichWidgets";

export function cprPaperConversationTitle(
  shortTitle: string,
  title: string,
): string {
  const value = shortTitle.trim() || title.trim();
  return Array.from(value.replace(/\s+/g, " ")).slice(0, 80).join("");
}

/**
 * Fresh Zotero paper conversations get a durable server-side session token.
 * Existing conversations without one remain on the legacy paper session so
 * upgrading the plugin does not silently move their remote history.
 */
export function resolveCprPaperSessionId(
  conversationKey: number | null | undefined,
  fresh: boolean,
): string | undefined {
  const normalizedKey = Number(conversationKey);
  if (!Number.isFinite(normalizedKey) || normalizedKey <= 0) return undefined;
  const prefKey = `${config.prefsPrefix}.cprPaperSession.${Math.floor(normalizedKey)}`;
  const stored = Zotero.Prefs.get(prefKey, true);
  if (typeof stored === "string" && stored.trim()) return stored.trim();
  if (!fresh) return undefined;
  const sessionId = createProviderOperationId();
  Zotero.Prefs.set(prefKey, sessionId, true);
  return sessionId;
}

/** Compress only first-turn PDF bodies above this serialized UTF-8 size. */
export const CPR_PAPERS_GZIP_THRESHOLD_BYTES = 256 * 1024;

export type CprPapersRequestEncoding = {
  body: string | ArrayBuffer;
  contentEncoding: "identity" | "gzip";
  wireBytes: number;
  jsonBytes: number;
};

function containsInputFile(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsInputFile);
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.type === "input_file") return true;
  return Object.values(record).some(containsInputFile);
}

/** Encode the exact JSON body; only a large first-turn PDF request is gzipped. */
export function encodeCprPapersRequestBody(
  payload: unknown,
): CprPapersRequestEncoding {
  const json = JSON.stringify(payload);
  if (typeof json !== "string")
    throw new Error("CPR papers 请求体无法序列化。");
  const jsonUtf8 = strToU8(json);
  if (
    !containsInputFile(payload) ||
    jsonUtf8.byteLength <= CPR_PAPERS_GZIP_THRESHOLD_BYTES
  ) {
    return {
      body: json,
      contentEncoding: "identity",
      wireBytes: jsonUtf8.byteLength,
      jsonBytes: jsonUtf8.byteLength,
    };
  }
  const compressed = gzipSync(jsonUtf8, { level: 1, mtime: 0 });
  const body =
    compressed.byteOffset === 0 &&
    compressed.byteLength === compressed.buffer.byteLength
      ? (compressed.buffer as ArrayBuffer)
      : (compressed.buffer.slice(
          compressed.byteOffset,
          compressed.byteOffset + compressed.byteLength,
        ) as ArrayBuffer);
  return {
    body,
    contentEncoding: "gzip",
    wireBytes: compressed.byteLength,
    jsonBytes: jsonUtf8.byteLength,
  };
}

export type CprPapersHttpFailure = {
  error: string;
  status: number;
  wireBytes: number;
  contentEncoding: CprPapersRequestEncoding["contentEncoding"];
  cfRay?: string;
  requestId?: string;
  responseMessage?: string;
};

function sanitizeResponseMessage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return undefined;
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

function extractResponseMessage(bodyText: string): string | undefined {
  const trimmed = bodyText.trim();
  if (!trimmed || trimmed.startsWith("<")) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object") return undefined;
    const record = parsed as Record<string, unknown>;
    if (typeof record.error === "string") {
      return sanitizeResponseMessage(record.error);
    }
    if (record.error && typeof record.error === "object") {
      const errorRecord = record.error as Record<string, unknown>;
      const errorMessage =
        sanitizeResponseMessage(errorRecord.message) ||
        sanitizeResponseMessage(errorRecord.detail);
      if (errorMessage) return errorMessage;
    }
    return (
      sanitizeResponseMessage(record.message) ||
      sanitizeResponseMessage(record.detail)
    );
  } catch {
    return undefined;
  }
}

function normalizeTraceId(
  value: string | null | undefined,
): string | undefined {
  const text = String(value || "").trim();
  return text ? text.slice(0, 200) : undefined;
}

/** Describe a failed Papers POST without echoing HTML or a large response body. */
export function describeCprPapersHttpFailure(params: {
  status: number;
  bodyText: string;
  wireBytes: number;
  contentEncoding: CprPapersRequestEncoding["contentEncoding"];
  cfRay?: string | null;
  requestId?: string | null;
}): CprPapersHttpFailure {
  const cfRay = normalizeTraceId(params.cfRay);
  const requestId = normalizeTraceId(params.requestId);
  const responseMessage = extractResponseMessage(params.bodyText);
  const details = [
    `HTTP ${params.status}`,
    `wire=${params.wireBytes} bytes`,
    `encoding=${params.contentEncoding}`,
    cfRay ? `cf-ray=${cfRay}` : requestId ? `x-request-id=${requestId}` : "",
    responseMessage ? `message=${responseMessage}` : "",
  ].filter(Boolean);
  return {
    error: `CPR papers 请求失败：${details.join("；")}`,
    status: params.status,
    wireBytes: params.wireBytes,
    contentEncoding: params.contentEncoding,
    cfRay,
    requestId,
    responseMessage,
  };
}

/**
 * Resolve the effort for a paper request from the selected capability option.
 * The model catalog / user profile owns the ladder; this function does not
 * carry a route-specific alias table. When no default is declared, omit the
 * field and let the route apply its own default. The server remains the final
 * validator.
 */
export function resolvePaperReasoningEffort(params: {
  model: string;
  apiBase: string;
  reasoning?: ReasoningConfig;
  profileOverride?: ModelProfileOverride;
}): string | undefined {
  const explicit = params.reasoning?.effort?.trim();
  if (explicit) return explicit;

  const requested = (params.reasoning?.level || "").trim().toLowerCase();
  const capabilities = getModelCapabilities({
    model: params.model,
    apiBase: params.apiBase,
    protocol: "responses_api",
    profileOverride: params.profileOverride,
  });
  const options = capabilities.reasoning.options;
  if (requested && requested !== "auto" && requested !== "default") {
    // A known id uses the catalog's wire value when it declares one.
    const exact = options.find((option) => option.id === requested);
    if (exact?.effort) return exact.effort;
    if (exact?.id) return exact.id;
    // An unknown level is not rewritten here. Forward it and let the selected
    // route reject or accept it, so a new server-side ladder needs no client
    // change.
    return requested;
  }
  const selected =
    options.find(
      (option) => option.id === capabilities.reasoning.defaultOptionId,
    ) || options[0];
  if (selected?.effort) return selected.effort;
  if (selected?.id) return selected.id;
  return undefined;
}

/** Normalize a configured endpoint without rewriting it to another host. */
export function normalizePaperRouteTarget(base: string): string {
  return String(base || "")
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/responses$/, "");
}

export function normalizePaperDoi(value: string): string | undefined {
  if (!value.trim()) return undefined;
  const doi = decodeURIComponent(
    value
      .trim()
      .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
      .replace(/^doi:\s*/i, ""),
  )
    .trim()
    .toLowerCase();
  if (!/^10\.\d{4,9}\/\S+$/.test(doi))
    throw new Error("论文 DOI 格式不正确；请先修正，避免建立重复对话。");
  return `doi:${doi}`;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const buffer = new Uint8Array(bytes.length);
  buffer.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buffer.buffer);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parsePaperOutput(value: unknown): unknown {
  if (
    !isRecord(value) ||
    value.status !== "completed" ||
    !Array.isArray(value.output)
  ) {
    throw new Error("CPR 未返回完整的论文登记结果；没有上传 PDF。");
  }
  let text: string | undefined;
  for (const item of value.output) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (
        isRecord(part) &&
        part.type === "output_text" &&
        typeof part.text === "string"
      )
        text = part.text;
    }
  }
  return text ? JSON.parse(text) : null;
}

export function parsePaperResolution(value: unknown) {
  const result = parsePaperOutput(value);
  if (
    !isRecord(result) ||
    typeof result.paper_id !== "string" ||
    typeof result.thread_id !== "string" ||
    !result.thread_id.trim() ||
    !["missing", "ready", "pending", "uncertain"].includes(
      String(result.status),
    ) ||
    typeof result.upload_required !== "boolean" ||
    (result.status === "missing" &&
      result.upload_required === true &&
      (typeof result.upload_token !== "string" || !result.upload_token.trim()))
  ) {
    throw new Error("CPR 论文登记格式不正确；没有上传 PDF。");
  }
  return result;
}

function getCprPaper(itemId?: number) {
  const item = itemId ? Zotero.Items.get(itemId) || undefined : undefined;
  const paper = item?.parentID ? Zotero.Items.get(item.parentID) : item;
  if (!paper || !paper.isRegularItem())
    throw new Error(
      "papers 模式需要先选择一篇论文，不能用于全局或 Agent 对话。",
    );
  return { item, paper };
}

type CprPaperPdf = { path: string; bytes: Uint8Array; hash: string };

async function readCprPaperPdf(item: Zotero.Item | undefined, paper: Zotero.Item,
  readBytes: (path: string) => Promise<Uint8Array>): Promise<CprPaperPdf>;
async function readCprPaperPdf(item: Zotero.Item | undefined, paper: Zotero.Item,
  readBytes: (path: string) => Promise<Uint8Array>, allowMissing: true): Promise<CprPaperPdf | undefined>;
async function readCprPaperPdf(item: Zotero.Item | undefined, paper: Zotero.Item,
  readBytes: (path: string) => Promise<Uint8Array>, allowMissing = false): Promise<CprPaperPdf | undefined> {
  const attachment = item?.isAttachment() && item.attachmentContentType === "application/pdf"
    ? item : await paper.getBestAttachment();
  if (!attachment) {
    if (allowMissing) return undefined;
    throw new Error("这篇论文没有 PDF 附件；请先添加或下载 PDF，不会改用摘要。");
  }
  if (attachment.attachmentContentType !== "application/pdf") {
    throw new Error("这篇论文没有 PDF 附件；请先添加或下载 PDF，不会改用摘要。");
  }
  const path = await attachment.getFilePathAsync();
  if (!path) {
    if (allowMissing) return undefined;
    throw new Error("PDF 尚未下载到本机，请先同步附件。");
  }
  const bytes = await readBytes(path);
  return { path, bytes, hash: await sha256(bytes) };
}

export type CprPaperHistoryMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  created_at: number | null;
  rich_widgets?: CprChartWidget[];
};

export type CprPaperHistory = {
  paper_id: string;
  thread_id: string;
  conversation_url: string;
  title: string;
  messages: CprPaperHistoryMessage[];
};

function isCprPaperConversationUrl(value: string): boolean {
  return (
    /^https:\/\/chatgpt\.com\/g\/g-p-[a-f0-9]{32}\/c\/[^/?#]+$/.test(value) ||
    /^https:\/\/chatgpt\.com\/c\/[^/?#]+$/.test(value)
  );
}

export function parseCprPaperHistory(
  value: unknown,
  paperId: string,
  expectedSessionId = "",
): CprPaperHistory {
  const result = parsePaperOutput(value);
  if (
    !isRecord(result) ||
    result.paper_id !== paperId ||
    result.paper_registry_version !== 2 ||
    result.paper_session_id !== expectedSessionId ||
    typeof result.thread_id !== "string" ||
    !result.thread_id ||
    typeof result.conversation_url !== "string" ||
    !isCprPaperConversationUrl(result.conversation_url) ||
    typeof result.title !== "string" ||
    !Array.isArray(result.messages)
  ) {
    throw new Error(
      "CPR 返回了无效的论文历史或不同的论文身份；本地记录未修改。",
    );
  }
  const messages: CprPaperHistoryMessage[] = [];
  const ids = new Set<string>();
  for (const message of result.messages) {
    if (
      !isRecord(message) ||
      typeof message.id !== "string" ||
      !message.id ||
      ids.has(message.id) ||
      (message.role !== "user" && message.role !== "assistant") ||
      typeof message.text !== "string" ||
      (message.created_at !== null &&
        (typeof message.created_at !== "number" ||
          !Number.isFinite(message.created_at) ||
          message.created_at < 0))
    ) {
      throw new Error("CPR 论文历史消息格式不正确；本地记录未修改。");
    }
    ids.add(message.id);
    const rich_widgets =
      message.role === "assistant" && Array.isArray(message.rich_widgets)
        ? message.rich_widgets.slice(0, 4).flatMap((value) => {
            const chart = parseCprChartWidget(value);
            return chart ? [chart] : [];
          })
        : [];
    messages.push({
      id: message.id,
      role: message.role,
      text: message.text,
      created_at: message.created_at,
      ...(rich_widgets.length ? { rich_widgets } : {}),
    });
  }
  return {
    paper_id: paperId,
    thread_id: result.thread_id,
    conversation_url: result.conversation_url,
    title: result.title,
    messages,
  };
}

/** Read an existing remote chat; never reserve a paper or send PDF bytes. */
export async function fetchCprPaperHistory(params: {
  itemId?: number;
  apiBase: string;
  apiKey: string;
  model: string;
  paperSessionId?: string;
  signal?: AbortSignal;
  readBytes: (path: string) => Promise<Uint8Array>;
  fetchFn: typeof fetch;
}): Promise<CprPaperHistory> {
  if (!params.model.trim())
    throw new Error("远端记录请求缺少模型；没有发送请求。");
  const { item, paper } = getCprPaper(params.itemId);
  const doi = normalizePaperDoi(String(paper.getField("DOI") || ""));
  const paperId =
    doi ||
    `sha256:${(await readCprPaperPdf(item, paper, params.readBytes)).hash}`;
  const response = await params.fetchFn(
    resolveEndpoint(params.apiBase, RESPONSES_ENDPOINT),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.apiKey}`,
      },
      body: JSON.stringify({
        model: params.model,
        stream: false,
        input: "paper history lookup",
        client_metadata: {
          "x-codex-turn-metadata": JSON.stringify({
            paper_registry_version: 2,
            paper_id: paperId,
            paper_session_id: params.paperSessionId || "",
            paper_operation: "history",
          }),
        },
      }),
      signal: params.signal,
    },
  );
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 600);
    if (detail.includes("paper_operation_invalid")) {
      throw new Error(
        "服务端尚未启用远端历史读取；请等待服务端更新，本地记录未修改。",
      );
    }
    if (detail.includes("paper_history_unavailable")) {
      throw new Error(
        "远端历史暂不可用，请检查服务端读取配置或登录状态；本地记录未修改。",
      );
    }
    throw new Error(`读取远端记录 HTTP ${response.status}: ${detail}`);
  }
  return parseCprPaperHistory(
    await response.json(),
    paperId,
    params.paperSessionId || "",
  );
}

/** Resolve the server's permanent paper binding before reading or uploading a PDF. */
export async function prepareCprPaperRequest(params: {
  itemId?: number;
  apiBase: string;
  apiKey: string;
  paperSessionId?: string;
  /** Alias configured on the capability-enabled route. */
  model?: string;
  /** Effort selection for the chat turn; the lookup carries none. */
  reasoning?: ReasoningConfig;
  /** User-authored capability override for this model, when present. */
  profileOverride?: ModelProfileOverride;
  prompt: string;
  images?: string[];
  signal?: AbortSignal;
  readBytes: (path: string) => Promise<Uint8Array>;
  fetchFn: typeof fetch;
}) {
  const imageBytes = (params.images || []).map((image) => {
    if (!/^data:image\/(?:png|jpeg|webp);base64,/.test(image))
      throw new Error("Papers 图片必须使用 inline data URL；没有发送模型。");
    return Math.floor((image.slice(image.indexOf(",") + 1).length * 3) / 4);
  });
  if (
    imageBytes.length > 10 ||
    imageBytes.some((size) => size > 20 * 1024 * 1024) ||
    imageBytes.reduce((a, b) => a + b, 0) > 50 * 1024 * 1024
  ) {
    throw new Error(
      "Papers 图片限制为最多 10 张、每张 20MB、合计 50MB；请缩小本批。没有发送模型。",
    );
  }
  const model = params.model?.trim();
  if (!model) throw new Error("论文请求缺少模型；没有发送请求。");
  // Resolved before any identity lookup or upload: an unsupported level must
  // fail without touching the server.
  const reasoningEffort = resolvePaperReasoningEffort({
    model,
    apiBase: params.apiBase,
    reasoning: params.reasoning,
    profileOverride: params.profileOverride,
  });
  params.signal?.throwIfAborted();
  const { item, paper } = getCprPaper(params.itemId);
  const paperTitle = cprPaperConversationTitle(
    String(paper.getField("shortTitle") || ""),
    String(paper.getField("title") || ""),
  );
  let path: string | undefined;
  let bytes: Uint8Array | undefined;
  let pdfHash: string | undefined;
  const loadPdf = async (required = true) => {
    if (bytes) return;
    const pdf = required
      ? await readCprPaperPdf(item, paper, params.readBytes)
      : await readCprPaperPdf(item, paper, params.readBytes, true);
    params.signal?.throwIfAborted();
    if (!pdf) return;
    const magic = [0x25, 0x50, 0x44, 0x46, 0x2d];
    if (pdf.bytes.length < magic.length || magic.some((byte, index) => pdf.bytes[index] !== byte)) {
      throw new Error("附件不是有效的 PDF（缺少 %PDF- 头）；没有发送聊天请求。");
    }
    path = pdf.path; bytes = pdf.bytes; pdfHash = pdf.hash;
  };
  let paperId = normalizePaperDoi(String(paper.getField("DOI") || ""));
  if (!paperId) {
    await loadPdf();
    if (!pdfHash) throw new Error("无法读取 PDF；没有发送请求。");
    paperId = `sha256:${pdfHash}`;
  }
  const target = normalizePaperRouteTarget(params.apiBase);
  const paperSessionId = params.paperSessionId?.trim() || undefined;
  const reservationKey = `${config.prefsPrefix}.cprPaperReservation.${encodeURIComponent(target + ":" + paperId + (paperSessionId ? ":" + paperSessionId : ""))}`;
  const cachedToken = Zotero.Prefs.get(reservationKey, true);
  // Local salt is retained only to adopt an existing v1/v2 chat. It no longer selects new chats.
  const legacy = await resolveProviderSessionId(
    `papers:${paper.libraryID}:${paper.key}`,
  );
  const legacyTarget = legacy
    ? Zotero.Prefs.get(
        `${config.prefsPrefix}.cprPapersUploaded.${legacy}`,
        true,
      )
    : undefined;
  const legacyUploaded =
    typeof legacyTarget === "string" &&
    normalizePaperRouteTarget(legacyTarget) === target;
  const lookupIdentity = {
    paper_registry_version: 2,
    paper_id: paperId,
    paper_session_id: paperSessionId || "",
    paper_operation: "resolve",
    ...(pdfHash ? { paper_pdf_sha256: pdfHash } : {}),
    ...(typeof cachedToken === "string" && cachedToken
      ? { paper_upload_token: cachedToken }
      : {}),
    ...(legacyUploaded && !paperSessionId
      ? { paper_legacy_thread_id: legacy, paper_legacy_uploaded: true }
      : {}),
  };
  const resolveRegistry = async (identity: Record<string, unknown>) => {
    params.signal?.throwIfAborted();
    const response = await params.fetchFn(
      resolveEndpoint(params.apiBase, RESPONSES_ENDPOINT),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${params.apiKey}`,
        },
        body: JSON.stringify({
          model,
          stream: false,
          input: "paper registry lookup",
          client_metadata: {
            "x-codex-turn-metadata": JSON.stringify(identity),
          },
        }),
        signal: params.signal,
      },
    );
    if (!response.ok)
      throw new Error(
        `CPR 论文登记 HTTP ${response.status}: ${(await response.text()).slice(0, 600)}`,
      );
    const result = parsePaperResolution(await response.json());
    if (result.paper_id !== paperId)
      throw new Error("CPR 返回了不同的论文身份；已停止发送。");
    if (
      result.paper_registry_version !== 2 ||
      result.paper_session_id !== (paperSessionId || "")
    )
      throw new Error(
        "CPR 未确认论文会话身份；请先升级服务端，已停止发送。",
      );
    return result;
  };
  let registry = await resolveRegistry(lookupIdentity);
  if (registry.status === "ready" && registry.upload_required === false && !pdfHash) {
    // A remote-ready DOI remains usable on a device without a local PDF. When
    // bytes are available, however, the current attachment must agree with the
    // server's saved content before this question can reuse that conversation.
    const originalThread = registry.thread_id;
    await loadPdf(false);
    if (pdfHash) {
      registry = await resolveRegistry({...lookupIdentity, paper_pdf_sha256: pdfHash});
      if (registry.status !== "ready" || registry.upload_required !== false || registry.thread_id !== originalThread) {
        throw new Error("论文会话或状态在内容校验期间发生变化；已停止发送，不会自动重新上传 PDF。");
      }
    }
  }
  // A DOI added on another device must reuse an existing hash-only binding before uploading bytes.
  if (
    paperId.startsWith("doi:") &&
    registry.status === "missing" &&
    registry.upload_required === true &&
    typeof registry.upload_token === "string"
  ) {
    Zotero.Prefs.set(reservationKey, registry.upload_token, true);
    await loadPdf();
    registry = await resolveRegistry({
      ...lookupIdentity,
      paper_upload_token: registry.upload_token,
      paper_pdf_sha256: pdfHash,
    });
  }
  if (registry.status === "pending")
    throw new Error("这篇论文正由另一请求处理；请稍后再试，不会重复上传 PDF。");
  if (registry.status === "uncertain")
    throw new Error(
      "服务端需要核对这篇论文的原对话；已停止发送，不会自动重传 PDF。",
    );
  const content: Array<
    | { type: "input_text"; text: string }
    | { type: "input_file"; filename: string; file_data: string }
    | { type: "input_image"; image_url: string; detail: "original" }
  > = [];
  let uploadToken: string | undefined;
  if (
    registry.status === "missing" &&
    registry.upload_required === true &&
    typeof registry.upload_token === "string"
  ) {
    uploadToken = registry.upload_token;
    Zotero.Prefs.set(reservationKey, uploadToken, true);
    await loadPdf();
    if (!bytes || !path || !pdfHash)
      throw new Error("无法读取 PDF；没有发送请求。");
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000)
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    content.push({
      type: "input_file",
      filename: path.split(/[\\/]/).pop() || "paper.pdf",
      file_data: `data:application/pdf;base64,${btoa(binary)}`,
    });
  } else if (
    registry.status !== "ready" ||
    registry.upload_required !== false
  ) {
    throw new Error("CPR 论文上传状态矛盾；已停止发送。");
  } else {
    Zotero.Prefs.set(reservationKey, "", true);
  }
  content.push({
    type: "input_text",
    text: uploadToken
      ? `论文：${String(paper.getField("title"))}\n请基于本对话上传的 PDF 回答。\n${params.prompt}`
      : params.prompt,
  });
  for (const image of params.images || []) {
    content.push({ type: "input_image", image_url: image, detail: "original" });
  }
  if (content.filter((part) => part.type !== "input_text").length > 10)
    throw new Error(
      "首次 PDF 与图片合计最多 10 个附件；本轮请选择最多 9 页。没有发送模型。",
    );
  const turn = createProviderOperationId();
  return {
    paperId,
    registry,
    payload: {
      model,
      stream: true,
      prompt_cache_key: registry.thread_id,
      ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({
          paper_registry_version: 2,
          thread_id: registry.thread_id,
          turn_id: turn,
          paper_id: paperId,
          paper_session_id: paperSessionId || "",
          paper_operation: "chat",
          ...(paperTitle ? { paper_title: paperTitle } : {}),
          ...(uploadToken ? { paper_upload_token: uploadToken } : {}),
          ...(pdfHash ? { paper_pdf_sha256: pdfHash } : {}),
        }),
      },
      input: [{ type: "message", role: "user", id: `paper-${turn}`, content }],
    },
    accept: () => Zotero.Prefs.set(reservationKey, "", true),
  };
}
