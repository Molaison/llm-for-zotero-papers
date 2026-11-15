import { parseDataUrl } from "../../shared/dataUrl";
import type { GeneratedChatImage } from "../../shared/types";
import {
  isRenderableGeneratedImageSrc,
  normalizeGeneratedChatImages,
} from "../../shared/generatedImages";
import { fileUrlToPath, toFileUrl } from "../../utils/localPath";
import {
  copyAttachmentFile,
  readAttachmentBytes,
  writeAttachmentBytes,
} from "../attachmentStorage";

export type ResolvedGeneratedImageAsset = {
  image: GeneratedChatImage;
  bytes: Uint8Array;
  mimeType: string;
  fileName: string;
  path?: string;
  fileUrl?: string;
};

function cleanText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function sanitizeFileName(name: string): string {
  const trimmed = cleanText(name, 240) || "generated-image";
  const withoutReserved = trimmed.replace(/[\\?%*:|"<>/]/g, "_");
  const safe = Array.from(withoutReserved, (ch) => {
    const code = ch.charCodeAt(0);
    return code < 32 || code === 127 ? "_" : ch;
  })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return safe || "generated-image";
}

export function inferGeneratedImageMimeType(value: string | undefined): string {
  const text = cleanText(value, 4000).toLowerCase();
  if (text.endsWith(".jpg") || text.endsWith(".jpeg")) return "image/jpeg";
  if (text.endsWith(".gif")) return "image/gif";
  if (text.endsWith(".webp")) return "image/webp";
  if (text.endsWith(".svg")) return "image/svg+xml";
  if (text.endsWith(".png")) return "image/png";
  return "image/png";
}

function extensionForMimeType(mimeType: string): string {
  switch (mimeType.trim().toLowerCase()) {
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "image/svg+xml":
      return ".svg";
    case "image/png":
    default:
      return ".png";
  }
}

function fileNameHasImageExtension(name: string): boolean {
  return /\.(?:png|jpe?g|gif|webp|svg)$/i.test(name);
}

function basenameFromPath(path: string | undefined): string {
  const text = cleanText(path, 4000);
  if (!text) return "";
  return text.split(/[\\/]/).filter(Boolean).pop() || text;
}

export function getGeneratedImageFileName(
  image: GeneratedChatImage,
  mimeType = inferGeneratedImageMimeType(image.path || image.label),
): string {
  const candidate =
    sanitizeFileName(image.label || basenameFromPath(image.path) || image.id) ||
    "generated-image";
  return fileNameHasImageExtension(candidate)
    ? candidate
    : `${candidate}${extensionForMimeType(mimeType)}`;
}

function normalizeImagePath(path: string | undefined): string {
  const text = cleanText(path, 4000);
  if (!text) return "";
  if (/^file:\/\//i.test(text)) return fileUrlToPath(text) || "";
  return text;
}

function resolveNormalizedGeneratedImageLocalPath(
  image: GeneratedChatImage,
): string {
  const path = normalizeImagePath(image.path);
  if (path) return path;
  const src = cleanText(image.src, Number.MAX_SAFE_INTEGER);
  return /^file:\/\//i.test(src) ? fileUrlToPath(src) || "" : "";
}

export function resolveGeneratedImageLocalPath(
  image: GeneratedChatImage,
): string {
  const normalized = normalizeGeneratedChatImages([image])[0];
  return normalized ? resolveNormalizedGeneratedImageLocalPath(normalized) : "";
}

function decodeBase64Bytes(base64: string): Uint8Array {
  const normalized = base64.replace(/\s+/g, "");
  const decoder = globalThis.atob;
  if (typeof decoder !== "function") {
    throw new Error("Base64 decoder unavailable");
  }
  const binary = decoder(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function isEmbeddableGeneratedImage(image: GeneratedChatImage): boolean {
  const normalized = normalizeGeneratedChatImages([image])[0];
  if (!normalized) return false;
  if (resolveNormalizedGeneratedImageLocalPath(normalized)) return true;
  const src = cleanText(normalized.src, Number.MAX_SAFE_INTEGER);
  return /^data:image\/[a-z0-9.+-]+;base64,/i.test(src);
}

export async function resolveGeneratedImageAsset(
  image: GeneratedChatImage,
): Promise<ResolvedGeneratedImageAsset | null> {
  const normalized = normalizeGeneratedChatImages([image])[0];
  if (!normalized) return null;

  const path = resolveNormalizedGeneratedImageLocalPath(normalized);
  if (path) {
    const bytes = await readAttachmentBytes(path);
    const mimeType = inferGeneratedImageMimeType(path || normalized.label);
    const imageWithPath = normalized.path
      ? normalized
      : { ...normalized, path };
    return {
      image: imageWithPath,
      bytes,
      mimeType,
      fileName: getGeneratedImageFileName(imageWithPath, mimeType),
      path,
      fileUrl: toFileUrl(path),
    };
  }

  const src = cleanText(normalized.src, Number.MAX_SAFE_INTEGER);
  if (!src || !isRenderableGeneratedImageSrc(src)) return null;
  const parsed = parseDataUrl(src);
  if (!parsed || !/^image\//i.test(parsed.mimeType)) return null;
  const bytes = decodeBase64Bytes(parsed.data);
  return {
    image: normalized,
    bytes,
    mimeType: parsed.mimeType,
    fileName: getGeneratedImageFileName(normalized, parsed.mimeType),
  };
}

export async function saveGeneratedImageAssetToPath(
  asset: ResolvedGeneratedImageAsset,
  targetPath: string,
): Promise<void> {
  const path = cleanText(targetPath, 4000);
  if (!path) throw new Error("No save path selected");
  if (asset.path) {
    try {
      await copyAttachmentFile(asset.path, path);
      return;
    } catch (_err) {
      void _err;
    }
  }
  await writeAttachmentBytes(path, asset.bytes);
}
