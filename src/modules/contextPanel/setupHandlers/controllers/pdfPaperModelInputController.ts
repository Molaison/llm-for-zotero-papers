import type { PdfSupport } from "../../../../providers";
import type {
  LocalDocumentResource,
  ModelInputMode,
} from "../../../../shared/types";
import type { ProviderProtocol } from "../../../../utils/providerProtocol";
import type { ChatAttachment, PaperContextRef } from "../../types";
import { FULL_PDF_UNSUPPORTED_MESSAGE } from "../../pdfSupportMessages";

type StatusLevel = "ready" | "warning" | "error";

export type PdfPaperModelInputProfile = {
  model?: string;
  apiBase?: string;
  apiKey?: string;
  authMode?:
    | "api_key"
    | "codex_auth"
    | "codex_app_server"
    | "copilot_auth"
    | "webchat";
  providerProtocol?: ProviderProtocol;
  inputMode?: ModelInputMode;
  paperRegistry?: boolean;
  directWebPdf?: boolean;
} | null;

export type PdfPaperModelInputDeps = {
  setInputDisabled?: (disabled: boolean) => void;
  setStatusMessage?: (message: string, level: StatusLevel) => void;
  logError?: (message: string, ...args: unknown[]) => void;
  isScreenshotUnsupportedModel: (modelName: string) => boolean;
  getModelPdfSupport: (
    modelName: string,
    providerProtocol?: string,
    authMode?: string,
    apiBase?: string,
    inputMode?: ModelInputMode,
  ) => PdfSupport;
  resolvePdfPaperAttachments: (
    paperContexts: PaperContextRef[],
  ) => Promise<ChatAttachment[]>;
  resolveLocalPdfResources: (
    paperContexts: PaperContextRef[],
  ) => Promise<readonly LocalDocumentResource[]>;
  renderPdfPagesAsImages: (
    paperContexts: PaperContextRef[],
    maxImages?: number,
  ) => Promise<string[]>;
  uploadPdfForProvider: (params: {
    apiBase: string;
    apiKey: string;
    pdfBytes: Uint8Array<ArrayBufferLike>;
    fileName: string;
  }) => Promise<{ systemMessageContent: string; label: string } | null>;
  resolvePdfBytes: (
    paperContext: PaperContextRef,
  ) => Promise<Uint8Array<ArrayBufferLike>>;
};

export type PdfPaperModelInputResult =
  | {
      ok: true;
      pdfSupport: PdfSupport;
      selectedFiles: ChatAttachment[];
      modelFiles: ChatAttachment[];
      displayPdfPaperAttachments: ChatAttachment[];
      modelPdfPaperAttachments: ChatAttachment[];
      modelSelectedPdfAttachments: ChatAttachment[];
      selectedPdfFiles: ChatAttachment[];
      selectedNonPdfFiles: ChatAttachment[];
      pdfPageImageDataUrls: string[];
      pdfUploadSystemMessages: string[];
      localDocuments: readonly LocalDocumentResource[];
    }
  | {
      ok: false;
      pdfSupport: PdfSupport;
    };

export function isPdfAttachment(attachment: ChatAttachment): boolean {
  const name = typeof attachment.name === "string" ? attachment.name : "";
  const mime =
    typeof attachment.mimeType === "string"
      ? attachment.mimeType.trim().toLowerCase()
      : "";
  return (
    attachment.category === "pdf" ||
    mime === "application/pdf" ||
    /\.pdf$/i.test(name)
  );
}

function fail(
  deps: PdfPaperModelInputDeps,
  pdfSupport: PdfSupport,
  message: string,
  level: StatusLevel = "error",
): PdfPaperModelInputResult {
  deps.setInputDisabled?.(false);
  deps.setStatusMessage?.(message, level);
  return { ok: false, pdfSupport };
}

export async function resolvePdfModeModelInputs(params: {
  deps: PdfPaperModelInputDeps;
  paperContexts: PaperContextRef[];
  selectedBaseFiles: ChatAttachment[];
  selectedImageCountForBudget: number;
  profile: PdfPaperModelInputProfile;
  currentModelName: string;
  isWebChat?: boolean;
  useCodexAttachmentPolicy?: boolean;
}): Promise<PdfPaperModelInputResult> {
  const {
    deps,
    paperContexts,
    selectedBaseFiles,
    profile,
    currentModelName,
    isWebChat = false,
  } = params;
  const modelName = (profile?.model || currentModelName || "").trim();
  const selectedPdfFiles = selectedBaseFiles.filter(isPdfAttachment);
  const selectedNonPdfFiles = selectedBaseFiles.filter(
    (attachment) => !isPdfAttachment(attachment),
  );
  const pdfSupport = deps.getModelPdfSupport(
    modelName,
    profile?.providerProtocol,
    profile?.authMode,
    profile?.apiBase,
    profile?.inputMode,
  );
  // CPR owns first upload and the durable session binding. Keep the upstream
  // composer while avoiding a second, generic PDF upload.
  if (
    !isWebChat &&
    (profile?.paperRegistry === true || profile?.directWebPdf === true)
  ) {
    if (selectedPdfFiles.length) {
      return fail(
        deps,
        pdfSupport,
        "请在论文来源中选择 PDF；当前会话不支持单独拖入 PDF 文件。",
      );
    }
    if (paperContexts.length && profile?.inputMode === "text_only") {
      return fail(deps, pdfSupport, FULL_PDF_UNSUPPORTED_MESSAGE);
    }
    if (profile?.paperRegistry === true && paperContexts.length > 1) {
      return fail(
        deps,
        pdfSupport,
        "论文会话仅使用当前论文的 PDF；请移除其他 PDF 后发送。",
      );
    }
    return {
      ok: true,
      pdfSupport,
      selectedFiles: selectedNonPdfFiles,
      modelFiles: selectedNonPdfFiles,
      displayPdfPaperAttachments: [],
      modelPdfPaperAttachments: [],
      modelSelectedPdfAttachments: [],
      selectedPdfFiles,
      selectedNonPdfFiles,
      pdfPageImageDataUrls: [],
      pdfUploadSystemMessages: [],
      localDocuments: [],
    };
  }
  let displayPdfPaperAttachments: ChatAttachment[] = [];
  let modelPdfPaperAttachments: ChatAttachment[] = [];
  let modelSelectedPdfAttachments = selectedPdfFiles;
  const pdfPageImageDataUrls: string[] = [];
  const pdfUploadSystemMessages: string[] = [];
  let localDocuments: readonly LocalDocumentResource[] = [];
  const hasProviderProcessedPdfs =
    paperContexts.length > 0 && !isWebChat && pdfSupport === "native";

  if (
    !isWebChat &&
    ((paperContexts.length > 0 &&
      pdfSupport !== "native" &&
      pdfSupport !== "local_path") ||
      (selectedPdfFiles.length > 0 && pdfSupport !== "native"))
  ) {
    return fail(deps, pdfSupport, FULL_PDF_UNSUPPORTED_MESSAGE);
  }

  if (!isWebChat && pdfSupport === "local_path" && paperContexts.length > 0) {
    try {
      localDocuments = await deps.resolveLocalPdfResources(paperContexts);
    } catch (error) {
      return fail(
        deps,
        pdfSupport,
        error instanceof Error && error.message.trim()
          ? error.message
          : "Could not resolve the selected paper PDF attachment.",
      );
    }
    if (localDocuments.length !== paperContexts.length) {
      return fail(
        deps,
        pdfSupport,
        "Could not resolve the selected paper PDF attachment.",
      );
    }
    deps.setStatusMessage?.(`Sending raw PDF to ${modelName}...`, "ready");
  }

  if (hasProviderProcessedPdfs) {
    displayPdfPaperAttachments =
      await deps.resolvePdfPaperAttachments(paperContexts);
    if (displayPdfPaperAttachments.length !== paperContexts.length) {
      return fail(
        deps,
        pdfSupport,
        "Could not resolve the selected paper PDF attachment.",
      );
    }

    deps.setStatusMessage?.(`Sending native PDF to ${modelName}...`, "ready");
    modelPdfPaperAttachments = displayPdfPaperAttachments;
    modelSelectedPdfAttachments = selectedPdfFiles;
  }

  const selectedFiles = [
    ...selectedNonPdfFiles,
    ...selectedPdfFiles,
    ...displayPdfPaperAttachments,
  ];
  const modelFiles = [
    ...selectedNonPdfFiles,
    ...modelSelectedPdfAttachments,
    ...modelPdfPaperAttachments,
  ];

  return {
    ok: true,
    pdfSupport,
    selectedFiles,
    modelFiles,
    displayPdfPaperAttachments,
    modelPdfPaperAttachments,
    modelSelectedPdfAttachments,
    selectedPdfFiles,
    selectedNonPdfFiles,
    pdfPageImageDataUrls,
    pdfUploadSystemMessages,
    localDocuments,
  };
}
