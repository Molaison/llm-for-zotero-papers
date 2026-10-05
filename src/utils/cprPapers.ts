import { config } from "../../package.json";
import type { ReasoningConfig } from "../shared/llm";
import { resolveEndpoint, RESPONSES_ENDPOINT } from "./apiHelpers";
import { resolveProviderSessionId, createProviderOperationId } from "./providerSessionId";
import { getOpenAIReasoningProfileForModel } from "./reasoningProfiles";

/**
 * The papers route serves exactly these four canonical aliases. They are
 * distinct upstream models with distinct effort ladders, so the id is chosen
 * per request and never rewritten to another alias.
 */
export const CPR_PAPERS_MODELS = [
  "papers/gpt-5.6-sol",
  "papers/gpt-5.6-sol-instant",
  "papers/gpt-5.6-pro",
  "papers/gpt-6-pro",
] as const;
/** Default papers model; a caller that names no model keeps Sol. */
export const CPR_PAPERS_MODEL = CPR_PAPERS_MODELS[0];
export const CPR_PAPERS_API_BASE = "https://cpr.molaisonz.dpdns.org/v1";

export function cprPaperConversationTitle(shortTitle: string, title: string): string {
  const value = shortTitle.trim() || title.trim();
  return Array.from(value.replace(/\s+/g, " ")).slice(0, 80).join("");
}

/** Exact membership: a near-miss alias is not a papers model. */
export function isCprPapersModel(modelName: string): boolean {
  return (CPR_PAPERS_MODELS as readonly string[]).includes(modelName.trim());
}

/**
 * The effort to send for one papers model.
 *
 * Each alias has its own ladder, so the effort comes from that model's profile
 * rather than from a shared OpenAI default. An explicit level the model does
 * not offer is an error: quietly sending another ladder would make a
 * cross-model switch look like it worked while the page runs a different
 * strength. Levels that add a temporary/persistent mode suffix are refused
 * here too — papers conversations are persistent, and a suffix must never
 * decide that. No selection sends the model's own default.
 */
export function resolveCprPapersReasoningEffort(
  model: string,
  reasoning?: ReasoningConfig,
): string {
  const profile = getOpenAIReasoningProfileForModel(model);
  const ladder = Object.entries(profile.levelToEffort)
    .filter(([, effort]) => typeof effort === "string" && effort)
    .map(([level]) => level);
  const requested = (reasoning?.effort || reasoning?.level || "").trim().toLowerCase();
  if (!requested || requested === "auto" || requested === "default") {
    const fallback = profile.defaultEffort;
    if (typeof fallback === "string" && fallback && fallback !== "default") {
      return fallback;
    }
    throw new Error(`${model} 没有声明默认思考强度；已停止发送。`);
  }
  const mapped = profile.levelToEffort[requested];
  if (typeof mapped === "string" && mapped) return mapped;
  throw new Error(
    `${model} 不支持思考强度 "${requested}"；该模型只支持：${ladder.join(" / ")}。请改用受支持的档位。`,
  );
}

export function normalizeCprPapersTarget(base: string): string {
  const target = base.replace(/\/+$/, "").replace(/\/responses$/, "");
  return ["http://127.0.0.1:18082/v1", "http://192.168.233.231:18082/v1", CPR_PAPERS_API_BASE].includes(target)
    ? CPR_PAPERS_API_BASE : target;
}

export function normalizePaperDoi(value: string): string | undefined {
  if (!value.trim()) return undefined;
  const doi = decodeURIComponent(value.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "")).trim().toLowerCase();
  if (!/^10\.\d{4,9}\/\S+$/.test(doi)) throw new Error("论文 DOI 格式不正确；请先修正，避免建立重复对话。");
  return `doi:${doi}`;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const buffer = new Uint8Array(bytes.length);
  buffer.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buffer.buffer);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parsePaperOutput(value: unknown): unknown {
  if (!isRecord(value) || value.status !== "completed" || !Array.isArray(value.output)) {
    throw new Error("CPR 未返回完整的论文登记结果；没有上传 PDF。");
  }
  let text: string | undefined;
  for (const item of value.output) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (isRecord(part) && part.type === "output_text" && typeof part.text === "string") text = part.text;
    }
  }
  return text ? JSON.parse(text) : null;
}

export function parsePaperResolution(value: unknown) {
  const result = parsePaperOutput(value);
  if (!isRecord(result) || typeof result.paper_id !== "string" || typeof result.thread_id !== "string"
    || !["missing", "ready", "pending", "uncertain"].includes(String(result.status))
    || typeof result.upload_required !== "boolean") throw new Error("CPR 论文登记格式不正确；没有上传 PDF。");
  return result;
}

function getCprPaper(itemId?: number) {
  const item = itemId ? Zotero.Items.get(itemId) || undefined : undefined;
  const paper = item?.parentID ? Zotero.Items.get(item.parentID) : item;
  if (!paper || !paper.isRegularItem()) throw new Error("papers 模式需要先选择一篇论文，不能用于全局或 Agent 对话。");
  return { item, paper };
}

async function readCprPaperPdf(item: Zotero.Item | undefined, paper: Zotero.Item,
  readBytes: (path: string) => Promise<Uint8Array>) {
  const attachment = item?.isAttachment() && item.attachmentContentType === "application/pdf"
    ? item : await paper.getBestAttachment();
  if (!attachment || attachment.attachmentContentType !== "application/pdf") {
    throw new Error("这篇论文没有 PDF 附件；请先添加或下载 PDF，不会改用摘要。");
  }
  const path = await attachment.getFilePathAsync();
  if (!path) throw new Error("PDF 尚未下载到本机，请先同步附件。");
  const bytes = await readBytes(path);
  return { path, bytes, hash: await sha256(bytes) };
}

export type CprPaperHistoryMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  created_at: number | null;
};

export type CprPaperHistory = {
  paper_id: string;
  thread_id: string;
  conversation_url: string;
  title: string;
  messages: CprPaperHistoryMessage[];
};

export function parseCprPaperHistory(value: unknown, paperId: string): CprPaperHistory {
  const result = parsePaperOutput(value);
  if (!isRecord(result) || result.paper_id !== paperId
    || typeof result.thread_id !== "string" || !result.thread_id
    || typeof result.conversation_url !== "string"
    || !/^https:\/\/chatgpt\.com\/g\/g-p-[a-f0-9]{32}\/c\/[^/?#]+$/.test(result.conversation_url)
    || typeof result.title !== "string" || !Array.isArray(result.messages)) {
    throw new Error("CPR 返回了无效的论文历史或不同的论文身份；本地记录未修改。");
  }
  const messages: CprPaperHistoryMessage[] = [];
  const ids = new Set<string>();
  for (const message of result.messages) {
    if (!isRecord(message) || typeof message.id !== "string" || !message.id || ids.has(message.id)
      || (message.role !== "user" && message.role !== "assistant") || typeof message.text !== "string"
      || (message.created_at !== null && (typeof message.created_at !== "number" || !Number.isFinite(message.created_at) || message.created_at < 0))) {
      throw new Error("CPR 论文历史消息格式不正确；本地记录未修改。");
    }
    ids.add(message.id);
    messages.push({id: message.id, role: message.role, text: message.text, created_at: message.created_at});
  }
  return {paper_id: paperId, thread_id: result.thread_id, conversation_url: result.conversation_url,
    title: result.title, messages};
}

/** Read an existing remote chat; never reserve a paper or send PDF bytes. */
export async function fetchCprPaperHistory(params: {
  itemId?: number; apiBase: string; apiKey: string; model: string; signal?: AbortSignal;
  readBytes: (path: string) => Promise<Uint8Array>; fetchFn: typeof fetch;
}): Promise<CprPaperHistory> {
  if (!isCprPapersModel(params.model)) throw new Error("远端记录仅支持 CPR papers 模型。");
  const {item, paper} = getCprPaper(params.itemId);
  const doi = normalizePaperDoi(String(paper.getField("DOI") || ""));
  const paperId = doi || `sha256:${(await readCprPaperPdf(item, paper, params.readBytes)).hash}`;
  const response = await params.fetchFn(resolveEndpoint(params.apiBase, RESPONSES_ENDPOINT), {
    method: "POST", headers: {"Content-Type": "application/json", Authorization: `Bearer ${params.apiKey}`},
    body: JSON.stringify({model: params.model, stream: false, input: "paper history lookup",
      client_metadata: {"x-codex-turn-metadata": JSON.stringify({paper_id: paperId, paper_operation: "history"})}}),
    signal: params.signal,
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 600);
    if (detail.includes("paper_operation_invalid")) {
      throw new Error("服务端尚未启用远端历史读取；请等待服务端更新，本地记录未修改。");
    }
    if (detail.includes("paper_history_unavailable")) {
      throw new Error("远端历史暂不可用，请检查服务端读取配置或登录状态；本地记录未修改。");
    }
    throw new Error(`读取远端记录 HTTP ${response.status}: ${detail}`);
  }
  return parseCprPaperHistory(await response.json(), paperId);
}

/** Resolve the server's permanent paper binding before reading or uploading a PDF. */
export async function prepareCprPaperRequest(params: {
  itemId?: number;
  apiBase: string;
  apiKey: string;
  /** Canonical papers alias; missing keeps the Sol default. */
  model?: string;
  /** Effort selection for the chat turn; the lookup carries none. */
  reasoning?: ReasoningConfig;
  prompt: string;
  signal?: AbortSignal;
  readBytes: (path: string) => Promise<Uint8Array>;
  fetchFn: typeof fetch;
}) {
  const model = params.model?.trim() || CPR_PAPERS_MODEL;
  if (!isCprPapersModel(model)) throw new Error(`不支持 papers 模型：${model}`);
  // Resolved before any identity lookup or upload: an unsupported level must
  // fail without touching the server.
  const reasoningEffort = resolveCprPapersReasoningEffort(model, params.reasoning);
  const {item, paper} = getCprPaper(params.itemId);
  const paperTitle = cprPaperConversationTitle(
    String(paper.getField("shortTitle") || ""), String(paper.getField("title") || ""),
  );
  let path: string | undefined;
  let bytes: Uint8Array | undefined;
  let pdfHash: string | undefined;
  const loadPdf = async () => {
    if (bytes) return;
    const pdf = await readCprPaperPdf(item, paper, params.readBytes);
    path = pdf.path; bytes = pdf.bytes; pdfHash = pdf.hash;
  };
  let paperId = normalizePaperDoi(String(paper.getField("DOI") || ""));
  if (!paperId) {
    await loadPdf();
    paperId = `sha256:${pdfHash}`;
  }
  const target = normalizeCprPapersTarget(params.apiBase);
  const reservationKey = `${config.prefsPrefix}.cprPaperReservation.${encodeURIComponent(target + ":" + paperId)}`;
  const cachedToken = Zotero.Prefs.get(reservationKey, true);
  // Local salt is retained only to adopt an existing v1/v2 chat. It no longer selects new chats.
  const legacy = await resolveProviderSessionId(`papers:${paper.libraryID}:${paper.key}`);
  const legacyTarget = legacy ? Zotero.Prefs.get(`${config.prefsPrefix}.cprPapersUploaded.${legacy}`, true) : undefined;
  const legacyUploaded = typeof legacyTarget === "string" && normalizeCprPapersTarget(legacyTarget) === target;
  const lookupIdentity = {
    paper_id: paperId, paper_operation: "resolve",
    ...(typeof cachedToken === "string" && cachedToken ? {paper_upload_token: cachedToken} : {}),
    ...(legacyUploaded ? {paper_legacy_thread_id: legacy, paper_legacy_uploaded: true} : {}),
  };
  const resolveRegistry = async (identity: Record<string, unknown>) => {
    const response = await params.fetchFn(resolveEndpoint(params.apiBase, RESPONSES_ENDPOINT), {
      method: "POST", headers: {"Content-Type": "application/json", Authorization: `Bearer ${params.apiKey}`},
      body: JSON.stringify({model, stream: false, input: "paper registry lookup",
        client_metadata: {"x-codex-turn-metadata": JSON.stringify(identity)}}),
      signal: params.signal,
    });
    if (!response.ok) throw new Error(`CPR 论文登记 HTTP ${response.status}: ${(await response.text()).slice(0, 600)}`);
    return parsePaperResolution(await response.json());
  };
  let registry = await resolveRegistry(lookupIdentity);
  // A DOI added on another device must reuse an existing hash-only binding before uploading bytes.
  if (paperId.startsWith("doi:") && registry.status === "missing" && registry.upload_required === true && typeof registry.upload_token === "string") {
    Zotero.Prefs.set(reservationKey, registry.upload_token, true);
    await loadPdf();
    registry = await resolveRegistry({...lookupIdentity, paper_upload_token: registry.upload_token, paper_pdf_sha256: pdfHash});
  }
  if (registry.paper_id !== paperId) throw new Error("CPR 返回了不同的论文身份；已停止发送。");
  if (registry.status === "pending") throw new Error("这篇论文正由另一请求处理；请稍后再试，不会重复上传 PDF。");
  if (registry.status === "uncertain") throw new Error("服务端需要核对这篇论文的原对话；已停止发送，不会自动重传 PDF。");
  const content: Array<{type: "input_text"; text: string} | {type: "input_file"; filename: string; file_data: string}> = [];
  let uploadToken: string | undefined;
  if (registry.status === "missing" && registry.upload_required === true && typeof registry.upload_token === "string") {
    uploadToken = registry.upload_token;
    Zotero.Prefs.set(reservationKey, uploadToken, true);
    await loadPdf();
    if (!bytes || !path || !pdfHash) throw new Error("无法读取 PDF；没有发送请求。");
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    content.push({type: "input_file", filename: path.split(/[\\/]/).pop() || "paper.pdf", file_data: `data:application/pdf;base64,${btoa(binary)}`});
  } else if (registry.status !== "ready" || registry.upload_required !== false) {
    throw new Error("CPR 论文上传状态矛盾；已停止发送。");
  } else {
    Zotero.Prefs.set(reservationKey, "", true);
  }
  content.push({type: "input_text", text: uploadToken
    ? `论文：${String(paper.getField("title"))}\n请基于本对话上传的 PDF 回答。\n${params.prompt}` : params.prompt});
  const turn = createProviderOperationId();
  return {
    paperId, registry,
    payload: {
      model, stream: true, prompt_cache_key: registry.thread_id,
      reasoning: {effort: reasoningEffort},
      client_metadata: {"x-codex-turn-metadata": JSON.stringify({thread_id: registry.thread_id, turn_id: turn,
        paper_id: paperId, paper_operation: "chat",
        ...(paperTitle ? {paper_title: paperTitle} : {}),
        ...(uploadToken ? {paper_upload_token: uploadToken, paper_pdf_sha256: pdfHash} : {})})},
      input: [{type: "message", role: "user", id: `paper-${turn}`, content}],
    },
    accept: () => Zotero.Prefs.set(reservationKey, "", true),
  };
}
