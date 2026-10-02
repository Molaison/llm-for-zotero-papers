import { appLogger } from "../../core/logging";
import { readAttachmentBytes } from "../../services/attachmentStorage";
import type {
  AgentAdapterToolCallResult,
  AgentAdapterToolContentItem,
} from "./adapter";
import {
  normalizeAgentContentInputs,
  resolveCapabilitiesContentInputs,
} from "./contentCapabilities";
import { encodeBytesBase64 } from "./shared";
import type {
  AgentContentInputCapabilities,
  AgentModelCapabilities,
  AgentModelContentPart,
  AgentModelMessage,
  AgentToolArtifact,
  AgentToolResult,
} from "../types";

type OmittedContentInputCounts = {
  images: number;
  pdfDocuments: number;
  nativeFiles: number;
};

export type ToolWorkflowDelivery = {
  callId: string;
  name: string;
  content: unknown;
  followupMessages: AgentModelMessage[];
};

export type ToolWorkflowOutcome = {
  failed?: boolean;
  /**
   * Stop kept the call from starting: it ran nothing, and is neither a
   * success nor a failure of the round.
   */
  notStarted?: true;
  toolResult: AgentToolResult;
  delivery?: ToolWorkflowDelivery;
  stopRun?: boolean;
  finalText?: string;
  documentId?: string;
  preserveToolOnlyTranscript?: boolean;
};

async function toDataUrl(
  storedPath: string,
  mimeType: string,
): Promise<string> {
  const bytes = await readAttachmentBytes(storedPath);
  return `data:${mimeType};base64,${encodeBytesBase64(bytes)}`;
}

function summarizeArtifacts(artifacts: AgentToolArtifact[]): string {
  const imagePages = artifacts
    .filter(
      (artifact): artifact is Extract<AgentToolArtifact, { kind: "image" }> =>
        artifact.kind === "image",
    )
    .map(
      (artifact) =>
        artifact.pageLabel ||
        (Number.isFinite(artifact.pageIndex)
          ? `${artifact.pageIndex! + 1}`
          : ""),
    );
  const fileTitles = artifacts
    .filter(
      (
        artifact,
      ): artifact is Extract<AgentToolArtifact, { kind: "file_ref" }> =>
        artifact.kind === "file_ref",
    )
    .map((artifact) => artifact.title || artifact.name);
  const parts: string[] = [];
  if (imagePages.length) {
    parts.push(
      `Prepared PDF page image${imagePages.length === 1 ? "" : "s"} (${
        imagePages
          .filter(Boolean)
          .map((entry) => `p${entry}`)
          .join(", ") ||
        `${imagePages.length} page${imagePages.length === 1 ? "" : "s"}`
      }) for visual inspection.`,
    );
  }
  if (fileTitles.length) {
    parts.push(
      `Prepared the PDF file${fileTitles.length === 1 ? "" : "s"} ${fileTitles
        .map((entry) => `"${entry}"`)
        .join(", ")} for direct reading.`,
    );
  }
  parts.push(
    "Use the attached pages or PDF directly when answering. Do not ask the user to re-upload them.",
  );
  return parts.join(" ");
}

function hasOmittedContentInputs(counts: OmittedContentInputCounts): boolean {
  return counts.images > 0 || counts.pdfDocuments > 0 || counts.nativeFiles > 0;
}

function summarizeUnsupportedContentInputs(
  counts: OmittedContentInputCounts,
  modelName?: string,
): string {
  const omitted: string[] = [];
  const unsupportedKinds: string[] = [];
  if (counts.images) {
    omitted.push(
      `${counts.images} image input${counts.images === 1 ? "" : "s"}`,
    );
    unsupportedKinds.push("image input");
  }
  if (counts.pdfDocuments) {
    omitted.push(
      `${counts.pdfDocuments} PDF/document input${
        counts.pdfDocuments === 1 ? "" : "s"
      }`,
    );
    unsupportedKinds.push("PDF/document input");
  }
  if (counts.nativeFiles) {
    omitted.push(
      `${counts.nativeFiles} native file input${
        counts.nativeFiles === 1 ? "" : "s"
      }`,
    );
    unsupportedKinds.push("native file input");
  }
  const target = (modelName || "The selected model").trim();
  const omittedLabel = omitted.length ? omitted.join(" and ") : "artifacts";
  const unsupportedLabel = unsupportedKinds.length
    ? unsupportedKinds.join(" or ")
    : "that content type";
  return (
    `${omittedLabel} prepared by the tool were not attached because ${target} does not support ${unsupportedLabel}. ` +
    "Use the tool result text, MinerU manifest/full.md content, captions, and surrounding extracted text instead. " +
    "If direct visual or document inspection is required, say that a model with the needed content-input support is required."
  );
}

function isPdfFileRefPart(
  part: Extract<AgentModelContentPart, { type: "file_ref" }>,
): boolean {
  return part.file_ref.mimeType.trim().toLowerCase() === "application/pdf";
}

function supportsFileRefPart(
  part: Extract<AgentModelContentPart, { type: "file_ref" }>,
  contentInputs: AgentContentInputCapabilities,
): boolean {
  if (contentInputs.nativeFiles) return true;
  return isPdfFileRefPart(part) && contentInputs.pdfDocuments;
}

function countOmittedFileRefPart(
  part: Extract<AgentModelContentPart, { type: "file_ref" }>,
  counts: OmittedContentInputCounts,
): void {
  if (isPdfFileRefPart(part)) {
    counts.pdfDocuments += 1;
  } else {
    counts.nativeFiles += 1;
  }
}

export async function buildArtifactFollowupMessage(
  result: AgentToolResult,
  options: {
    contentInputs?: AgentContentInputCapabilities;
    modelName?: string;
  } = {},
): Promise<AgentModelMessage | null> {
  const artifacts = Array.isArray(result.artifacts) ? result.artifacts : [];
  if (!artifacts.length || !result.ok) return null;
  const contentInputs = normalizeAgentContentInputs(options.contentInputs);
  const parts: AgentModelContentPart[] = [];
  const attachedArtifacts: AgentToolArtifact[] = [];
  const omitted: OmittedContentInputCounts = {
    images: 0,
    pdfDocuments: 0,
    nativeFiles: 0,
  };
  for (const artifact of artifacts) {
    if (artifact.kind === "image") {
      if (!contentInputs.images) {
        omitted.images += 1;
        continue;
      }
      if (!artifact.storedPath || !artifact.mimeType) continue;
      try {
        const url = await toDataUrl(artifact.storedPath, artifact.mimeType);
        attachedArtifacts.push(artifact);
        parts.push({
          type: "image_url",
          image_url: {
            url,
            detail: "high",
          },
        });
      } catch (error) {
        appLogger.warn(
          "LLM Agent: Failed to load image artifact",
          artifact,
          error,
        );
      }
      continue;
    }
    const fileRefPart: Extract<AgentModelContentPart, { type: "file_ref" }> = {
      type: "file_ref",
      file_ref: {
        name: artifact.name,
        mimeType: artifact.mimeType,
        storedPath: artifact.storedPath,
        contentHash: artifact.contentHash,
      },
    };
    if (!supportsFileRefPart(fileRefPart, contentInputs)) {
      countOmittedFileRefPart(fileRefPart, omitted);
      continue;
    }
    attachedArtifacts.push(artifact);
    parts.push(fileRefPart);
  }
  const textParts: string[] = [];
  if (attachedArtifacts.length) {
    textParts.push(summarizeArtifacts(attachedArtifacts));
  }
  if (hasOmittedContentInputs(omitted)) {
    textParts.push(
      summarizeUnsupportedContentInputs(omitted, options.modelName),
    );
  }
  if (textParts.length) {
    parts.unshift({
      type: "text",
      text: textParts.join("\n\n"),
    });
  }
  if (parts.length === 1 && parts[0].type === "text") {
    return {
      role: "user",
      content: parts[0].text,
    };
  }
  return parts.length
    ? {
        role: "user",
        content: parts,
      }
    : null;
}

export function filterFollowupMessageForCapabilities(
  message: AgentModelMessage | null,
  capabilities: AgentModelCapabilities,
  modelName?: string,
): AgentModelMessage | null {
  if (!message) return null;
  if (message.role === "tool") return message;
  if (typeof message.content === "string") return message;

  const contentInputs = resolveCapabilitiesContentInputs(capabilities);
  const parts: AgentModelContentPart[] = [];
  const omitted: OmittedContentInputCounts = {
    images: 0,
    pdfDocuments: 0,
    nativeFiles: 0,
  };
  for (const part of message.content) {
    if (part.type === "text") {
      if (part.text.trim()) parts.push(part);
      continue;
    }
    if (part.type === "image_url") {
      if (contentInputs.images) {
        parts.push(part);
      } else {
        omitted.images += 1;
      }
      continue;
    }
    if (supportsFileRefPart(part, contentInputs)) {
      parts.push(part);
    } else {
      countOmittedFileRefPart(part, omitted);
    }
  }

  if (hasOmittedContentInputs(omitted)) {
    parts.push({
      type: "text",
      text: summarizeUnsupportedContentInputs(omitted, modelName),
    });
  }

  const hasNonTextPart = parts.some((part) => part.type !== "text");
  if (!hasNonTextPart) {
    return {
      ...message,
      content: parts
        .filter(
          (part): part is Extract<AgentModelContentPart, { type: "text" }> =>
            part.type === "text",
        )
        .map((part) => part.text)
        .filter(Boolean)
        .join("\n\n"),
    };
  }
  return parts.length
    ? {
        ...message,
        content: parts,
      }
    : null;
}

function stringifyToolDeliveryContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === null || content === undefined) return "";
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function pushAdapterTextItem(
  target: AgentAdapterToolContentItem[],
  text: string,
): void {
  if (!text) return;
  target.push({ type: "inputText", text });
}

function pushAdapterMessageItems(
  target: AgentAdapterToolContentItem[],
  message: AgentModelMessage,
): void {
  if (typeof message.content === "string") {
    pushAdapterTextItem(target, message.content);
    return;
  }
  for (const part of message.content) {
    if (part.type === "text") {
      pushAdapterTextItem(target, part.text);
    } else if (part.type === "image_url") {
      target.push({ type: "inputImage", imageUrl: part.image_url.url });
    } else {
      pushAdapterTextItem(target, `[Prepared file: ${part.file_ref.name}]`);
    }
  }
}

export function buildAdapterToolCallResult(
  outcome: ToolWorkflowOutcome,
): AgentAdapterToolCallResult {
  const contentItems: AgentAdapterToolContentItem[] = [];
  if (outcome.delivery) {
    pushAdapterTextItem(
      contentItems,
      stringifyToolDeliveryContent(outcome.delivery.content),
    );
    for (const followupMessage of outcome.delivery.followupMessages) {
      pushAdapterMessageItems(contentItems, followupMessage);
    }
  } else if (outcome.finalText) {
    pushAdapterTextItem(contentItems, outcome.finalText);
  } else {
    pushAdapterTextItem(
      contentItems,
      stringifyToolDeliveryContent(outcome.toolResult.content),
    );
  }
  if (!contentItems.length) {
    pushAdapterTextItem(
      contentItems,
      outcome.toolResult.ok ? "Tool completed successfully." : "Tool failed.",
    );
  }
  return {
    contentItems,
    success: outcome.toolResult.ok,
  };
}
