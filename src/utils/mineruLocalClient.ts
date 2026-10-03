import { appLogger } from "../core/logging";
import { MineruCancelledError } from "./mineruErrors";
import {
  normalizeMineruLocalApiBase,
  type MineruLocalOptions,
} from "./mineruConfig";
import { normalizeMineruV1Zip } from "./mineruV1Result";

export type MineruLocalService =
  | { api: "legacy"; version: string }
  | { api: "v1"; version: string; tiers: string[] };

type Json = Record<string, any>;
const REQUEST_TIMEOUT = 60_000;
const JOB_TIMEOUT = 2 * 60 * 60_000;

export function mineruErrorDetail(value: unknown): string {
  const data = value as Json | null;
  const message =
    data?.error?.message ?? data?.detail ?? data?.msg ?? data?.err_msg;
  if (typeof message !== "string") return "";
  // Server errors can include signed URLs or authorization strings.
  return message
    .replace(/https?:\/\/[^\s"<>]+/gi, "[URL]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\s+/g, " ")
    .slice(0, 240);
}

/** Bound the complete response, including its body, and release abort listeners. */
async function request<T>(
  url: string,
  init: RequestInit,
  read: (response: Response) => Promise<T>,
  signal?: AbortSignal,
  timeout = REQUEST_TIMEOUT,
): Promise<T> {
  if (signal?.aborted) throw new MineruCancelledError();
  const Controller = ztoolkit.getGlobal(
    "AbortController",
  ) as typeof AbortController;
  const controller = new Controller();
  let timer: ReturnType<typeof setTimeout>;
  let onAbort: () => void = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      controller.abort();
      reject(new MineruCancelledError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Local MinerU request timed out"));
    }, timeout);
  });
  try {
    const fetch = ztoolkit.getGlobal("fetch") as typeof globalThis.fetch;
    return await Promise.race([
      fetch(url, { ...init, signal: controller.signal }).then(read),
      interrupted,
    ]);
  } catch (error) {
    if (signal?.aborted) throw new MineruCancelledError();
    if (
      error instanceof TypeError ||
      (error as Error)?.name === "NetworkError"
    ) {
      throw new Error(
        "Cannot reach the local MinerU service. Check its address and start the MinerU API server.",
      );
    }
    throw error;
  } finally {
    clearTimeout(timer!);
    signal?.removeEventListener("abort", onAbort);
  }
}

function headers(apiKey: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

async function jsonRequest(
  base: string,
  path: string,
  apiKey: string,
  signal?: AbortSignal,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
  timeout = REQUEST_TIMEOUT,
): Promise<Json> {
  return request(
    `${base}${path}`,
    {
      method,
      headers: {
        ...headers(apiKey),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    async (response) => {
      const data = await response.json().catch(() => null);
      if (!response.ok)
        throw new Error(
          `Local MinerU ${path.split("/").slice(0, 3).join("/")}: HTTP ${response.status}${mineruErrorDetail(data) ? `: ${mineruErrorDetail(data)}` : ""}`,
        );
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw new Error("Local MinerU returned invalid JSON");
      return data;
    },
    signal,
    timeout,
  );
}

export async function detectMineruLocalService(
  baseUrl: string,
  apiKey = "",
  signal?: AbortSignal,
): Promise<MineruLocalService> {
  const base = normalizeMineruLocalApiBase(baseUrl);
  const probe = async (path: string) =>
    request(
      `${base}${path}`,
      { headers: headers(apiKey) },
      async (response) => ({
        status: response.status,
        data: (await response.json().catch(() => null)) as Json | null,
      }),
      signal,
      10_000,
    );
  const v1 = await probe("/v1/health");
  if (v1.status >= 200 && v1.status < 300) {
    if (v1.data?.status !== "ok" || typeof v1.data?.version !== "string")
      throw new Error(
        "The local address did not return a valid MinerU V1 health response",
      );
    if (
      !Array.isArray(v1.data.features?.sources) ||
      !v1.data.features.sources.includes("file_id") ||
      !Array.isArray(v1.data.features?.output_formats) ||
      !v1.data.features.output_formats.includes("zip")
    )
      throw new Error(
        "This MinerU V1 service must support file uploads and ZIP output",
      );
    const result = await jsonRequest(base, "/v1/tiers", apiKey, signal);
    if (
      !Array.isArray(result.data) ||
      !result.data.length ||
      result.data.some((tier: Json) => typeof tier?.id !== "string")
    )
      throw new Error("MinerU returned no valid parsing tiers");
    return {
      api: "v1",
      version: v1.data.version,
      tiers: result.data.map((tier: Json) => tier.id),
    };
  }
  // A reachable legacy server lacks this route. Never hide auth or service errors.
  if (v1.status !== 404 && v1.status !== 405)
    throw new Error(
      `Local MinerU health check: HTTP ${v1.status}${mineruErrorDetail(v1.data) ? `: ${mineruErrorDetail(v1.data)}` : ""}`,
    );
  const legacy = await probe("/health");
  if (legacy.status === 404 || legacy.status === 405) {
    // MinerU 2.x has /file_parse but no /health. Verify the API schema before
    // treating an arbitrary web server as a legacy parser.
    const schema = await jsonRequest(base, "/openapi.json", apiKey, signal);
    if (!schema.paths?.["/file_parse"]?.post)
      throw new Error(
        "This server exposes neither MinerU V1 nor the legacy parsing API",
      );
    return { api: "legacy", version: "unknown" };
  }

  if (legacy.status < 200 || legacy.status >= 300)
    throw new Error(
      `Local MinerU health check: HTTP ${legacy.status}${mineruErrorDetail(legacy.data) ? `: ${mineruErrorDetail(legacy.data)}` : ""}`,
    );
  if (
    !["healthy", "ok"].includes(legacy.data?.status) ||
    typeof legacy.data?.version !== "string"
  )
    throw new Error("The local address is not a recognized MinerU API server");
  return { api: "legacy", version: legacy.data.version };
}

function requiredId(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`MinerU response is missing ${field}`);
  return value;
}

async function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new MineruCancelledError();
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new MineruCancelledError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function parseMineruV1(params: {
  baseUrl: string;
  fileName: string;
  pdfBytes: Uint8Array;
  service: Extract<MineruLocalService, { api: "v1" }>;
  options: MineruLocalOptions;
  forceOcr: boolean;
  report: (message: string) => void;
  signal?: AbortSignal;
}) {
  const { options, service, report, signal } = params;
  const base = normalizeMineruLocalApiBase(params.baseUrl);
  if (options.tier !== "auto" && !service.tiers.includes(options.tier))
    throw new Error(
      `This MinerU server does not offer the ${options.tier} tier. Available: ${service.tiers.join(", ")}`,
    );
  if (
    options.tier === "auto" &&
    service.tiers.every((tier) => tier === "flash")
  )
    throw new Error(
      "This MinerU server only offers Flash. Select Flash explicitly or start a service with a quality tier.",
    );
  report("Uploading PDF to local MinerU V1…");
  let upload = await jsonRequest(base, "/v1/uploads", options.apiKey, signal, {
    filename: params.fileName,
    bytes: params.pdfBytes.length,
    mime_type: "application/pdf",
    purpose: "parse",
  });
  const uploadId = requiredId(upload.id, "upload id");
  if (upload.status === "pending") {
    const url = new URL(
      requiredId(upload.upload_url, "upload URL"),
      `${base}/`,
    );
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error("MinerU returned an invalid upload URL");
    if (upload.upload_method !== "PUT")
      throw new Error("MinerU returned an unsupported upload method");
    const uploadHeaders = upload.upload_headers;
    if (
      !uploadHeaders ||
      typeof uploadHeaders !== "object" ||
      Object.values(uploadHeaders).some((value) => typeof value !== "string")
    )
      throw new Error("MinerU returned invalid upload headers");
    await request(
      url.href,
      {
        method: upload.upload_method,
        headers: {
          ...(url.origin === new URL(base).origin
            ? headers(options.apiKey)
            : {}),
          ...uploadHeaders,
        },
        body: params.pdfBytes.slice().buffer as ArrayBuffer,
      },
      async (response) => {
        if (!response.ok)
          throw new Error(`MinerU byte upload failed: HTTP ${response.status}`);
        await response.arrayBuffer();
      },
      signal,
    );
    upload = await jsonRequest(
      base,
      `/v1/uploads/${encodeURIComponent(uploadId)}/complete`,
      options.apiKey,
      signal,
      {},
    );
  }
  if (upload.status !== "completed")
    throw new Error(
      `MinerU upload did not complete (${String(upload.status)})`,
    );
  const fileId = requiredId(upload.file?.id, "input file id");
  let job = await jsonRequest(base, "/v1/parse/jobs", options.apiKey, signal, {
    files: [
      { source: { type: "file_id", file_id: fileId }, page_range: "all" },
    ],
    tier: options.tier === "auto" ? null : options.tier,
    ocr_mode: params.forceOcr ? "ocr" : "auto",
    output_formats: ["zip"],
  });
  const jobId = requiredId(job.job_id, "job id");
  const jobPath = `/v1/parse/jobs/${encodeURIComponent(jobId)}`;
  const started = Date.now();
  let polls = 0;
  try {
    while (true) {
      if (signal?.aborted) throw new MineruCancelledError();
      if (job.job_id !== jobId)
        throw new Error("MinerU returned a different job id");
      if (job.status === "completed") break;
      if (["partial", "failed", "canceled"].includes(job.status)) {
        const detail = Array.isArray(job.files)
          ? job.files.map(mineruErrorDetail).filter(Boolean).join("; ")
          : "";
        throw new Error(
          `Local MinerU job ${job.status}${detail ? `: ${detail}` : ""}`,
        );
      }
      if (!["queued", "running"].includes(job.status))
        throw new Error(
          `MinerU returned an unknown job status: ${String(job.status)}`,
        );
      if (Date.now() - started >= JOB_TIMEOUT)
        throw new Error(
          "Local MinerU job timed out; check the server before retrying",
        );
      report(
        `${job.status === "queued" ? "Waiting for local MinerU to start" : "Processing on local MinerU"}… (${Math.round((Date.now() - started) / 1000)}s)`,
      );
      await wait(Math.min(2000 * 1.3 ** polls++, 15_000), signal);
      job = await jsonRequest(base, jobPath, options.apiKey, signal);
    }
    if (
      !Array.isArray(job.files) ||
      job.files.length !== 1 ||
      job.files[0].status !== "completed" ||
      job.files[0].file_id !== fileId
    )
      throw new Error("MinerU completed without the requested file result");
    const outputId = requiredId(
      job.files[0].output_files?.zip?.file_id,
      "ZIP output file id",
    );
    report("Downloading local MinerU result…");
    const bytes = await request(
      `${base}/v1/files/${encodeURIComponent(outputId)}/content`,
      { headers: headers(options.apiKey) },
      async (response) => {
        if (!response.ok)
          throw new Error(
            `MinerU result download failed: HTTP ${response.status}`,
          );
        return new Uint8Array(await response.arrayBuffer());
      },
      signal,
    );
    const result = normalizeMineruV1Zip(bytes);
    report(`Done (${result.files.length} files extracted)`);
    return result;
  } catch (error) {
    if (error instanceof MineruCancelledError) {
      // Use an independent bounded request: the caller's signal is already aborted.
      try {
        await jsonRequest(
          base,
          jobPath,
          options.apiKey,
          undefined,
          undefined,
          "DELETE",
          5000,
        );
      } catch {
        appLogger.warn(
          "MinerU V1 cancellation was not confirmed; check the local server",
        );
      }
    }
    throw error;
  }
}
