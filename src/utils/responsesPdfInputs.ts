import { resolveProviderCapabilities, type ProviderParams } from "../providers";
import { parseDataUrl } from "../shared/dataUrl";
import { t } from "./i18n";
import type { ModelRecoveryError } from "./modelErrorRecovery";

export type ResponsesInlineFilePart = {
  type: "input_file";
  filename: string;
  file_data: string;
};

type PdfAttachment = {
  name: string;
  storedPath?: string;
  mimeType?: string;
};

// Strict decimal 50 MB total, below the existing 50 MiB PDF intake limit.
const RESPONSES_PDF_TOTAL_BYTES_LIMIT = 50_000_000;

export function isPdfDataUrl(url: string): boolean {
  return /^data:application\/pdf;base64,/i.test(url);
}

export function isResponsesPdfAttachment(file: PdfAttachment): boolean {
  return (
    file.mimeType?.trim().toLowerCase() === "application/pdf" ||
    /\.pdf$/i.test(file.name)
  );
}

/** Shared by ordinary chat and Agent file_ref/legacy-history delivery. */
export function createResponsesPdfPreparation(
  params: ProviderParams & {
    signal?: AbortSignal;
    readBytes: (path: string) => Promise<Uint8Array>;
    encodeBase64: (bytes: Uint8Array) => string;
  },
) {
  let preparedBytes = 0;
  const checkAbort = () => {
    if (!params.signal?.aborted) return;
    const error = new Error("Aborted");
    error.name = "AbortError";
    throw error;
  };
  const assertSupport = () => {
    checkAbort();
    if (
      params.protocol !== "responses_api" ||
      (params.authMode && params.authMode !== "api_key") ||
      resolveProviderCapabilities(params).pdf !== "native"
    ) {
      throw new Error(
        t(
          "PDF input is not confirmed for this model and provider; no request was sent.",
        ),
      );
    }
  };
  const addBytes = (total: number, size: number) => {
    const next = total + size;
    if (next >= RESPONSES_PDF_TOTAL_BYTES_LIMIT) {
      throw new Error(
        t(
          "Responses PDF inputs must total less than 50 MB of raw file data; no request was sent.",
        ),
      );
    }
    return next;
  };
  const dataUrlBytes = (url: string) => {
    assertSupport();
    const data = parseDataUrl(url)?.data || "";
    if (
      !isPdfDataUrl(url) ||
      !data ||
      data.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(data) ||
      !atob(data.slice(0, 8)).startsWith("%PDF-")
    ) {
      throw new Error(
        t(
          "Invalid inline PDF data in conversation history; no request was sent.",
        ),
      );
    }
    const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
    return (data.length / 4) * 3 - padding;
  };

  // Optional identity decision runs on the validated bytes from this read,
  // before budget accounting/encoding. Existing one-argument callers are unchanged.
  async function prepareFile(
    file: PdfAttachment,
  ): Promise<ResponsesInlineFilePart>;
  async function prepareFile(
    file: PdfAttachment,
    includeBytes: (bytes: Uint8Array) => Promise<boolean>,
  ): Promise<ResponsesInlineFilePart | undefined>;
  async function prepareFile(
    file: PdfAttachment,
    includeBytes?: (bytes: Uint8Array) => Promise<boolean>,
  ): Promise<ResponsesInlineFilePart | undefined> {
    assertSupport();
    const path = file?.storedPath?.trim();
    const filename = file?.name?.trim();
    if (!path || !filename) {
      throw new Error(
        t("PDF attachment path or filename is missing; no request was sent."),
      );
    }
    if (!isResponsesPdfAttachment(file)) {
      throw new Error(
        t(
          "Inline Responses attachments must be PDFs: {filename}; no request was sent.",
        ).replace("{filename}", filename),
      );
    }
    checkAbort();
    const bytes = await params.readBytes(path);
    checkAbort();
    if (String.fromCharCode(...bytes.subarray(0, 5)) !== "%PDF-") {
      throw new Error(
        t(
          "Invalid PDF attachment: {filename} (missing %PDF- header); no request was sent.",
        ).replace("{filename}", filename),
      );
    }
    if (includeBytes) {
      const include = await includeBytes(bytes);
      checkAbort();
      if (!include) return undefined;
    }
    preparedBytes = addBytes(preparedBytes, bytes.byteLength);
    const file_data = `data:application/pdf;base64,${params.encodeBase64(bytes)}`;
    checkAbort();
    return { type: "input_file", filename, file_data };
  }

  return {
    get hasPdf() {
      return preparedBytes > 0;
    },
    includeDataUrl(url: string) {
      preparedBytes = addBytes(preparedBytes, dataUrlBytes(url));
    },
    prepareFile,
    /** Validate the actual replay + continuation wire, not just new files. */
    validateWireInput(input: readonly unknown[]): boolean {
      checkAbort();
      let total = 0;
      for (const item of input) {
        if (!item || typeof item !== "object") continue;
        const content = (item as { content?: unknown }).content;
        if (!Array.isArray(content)) continue;
        for (const part of content) {
          if (
            part?.type === "input_file" &&
            typeof part.file_data === "string" &&
            isPdfDataUrl(part.file_data)
          ) {
            total = addBytes(total, dataUrlBytes(part.file_data));
          }
        }
      }
      checkAbort();
      return total > 0;
    },
  };
}

/** Keep the original Error, HTTP prefix/status/body and retry-after metadata. */
export function explainResponsesPdfRejection(error: unknown): unknown {
  if (error instanceof Error && error.name !== "AbortError") {
    (error as ModelRecoveryError).modelRecovery = {
      automaticRecovery: "none",
      source: "pdf_input",
    };
  }
  if (
    error instanceof Error &&
    [400, 413, 415, 422].includes(
      (error as Error & { status?: number }).status || 0,
    )
  ) {
    error.message +=
      "\n\n" +
      t(
        "PDF request rejected. Check this API/model's PDF support and file size, or choose another model. No automatic resend was attempted.",
      );
  }
  return error;
}
