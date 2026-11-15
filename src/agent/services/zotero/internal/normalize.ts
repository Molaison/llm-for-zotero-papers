/**
 * Value normalization shared by every gateway capability.
 *
 * Zotero field reads return whatever the schema happens to hold — `null`,
 * a number, a string with newlines in it — so almost every read in this
 * directory passes through one of these before it is compared or reported.
 */

import type {
  PaperContentSourceMode,
  PaperContextRef,
} from "../../../../shared/types";

export function normalizeMetadataValue(value: unknown): string {
  return `${value ?? ""}`.trim();
}

export function normalizeText(value: unknown): string {
  return `${value ?? ""}`.replace(/\s+/g, " ").trim();
}

export function normalizeResultLimit(limit: unknown): number | undefined {
  return Number.isFinite(limit) && Number(limit) > 0
    ? Math.max(1, Math.floor(Number(limit)))
    : undefined;
}

export function isPaperContentSourceMode(
  value: unknown,
): value is PaperContentSourceMode {
  return (
    value === "text" ||
    value === "mineru" ||
    value === "pdf" ||
    value === "markdown" ||
    value === "html" ||
    value === "txt" ||
    value === "docx"
  );
}

export function normalizePaperContexts(
  entries: PaperContextRef[] | undefined,
): PaperContextRef[] {
  if (!Array.isArray(entries)) return [];
  const out: PaperContextRef[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry) continue;
    const libraryID = Number(entry.libraryID);
    const itemId = Number(entry.itemId);
    const contextItemId = Number(entry.contextItemId);
    if (!Number.isFinite(itemId) || !Number.isFinite(contextItemId)) continue;
    const normalized: PaperContextRef = {
      ...(Number.isFinite(libraryID) && libraryID > 0
        ? { libraryID: Math.floor(libraryID) }
        : {}),
      itemId: Math.floor(itemId),
      contextItemId: Math.floor(contextItemId),
      title: `${entry.title || `Paper ${Math.floor(itemId)}`}`.trim(),
      attachmentTitle: entry.attachmentTitle?.trim() || undefined,
      citationKey: entry.citationKey?.trim() || undefined,
      firstCreator: entry.firstCreator?.trim() || undefined,
      year: entry.year?.trim() || undefined,
    };
    if (isPaperContentSourceMode(entry.contentSourceMode)) {
      normalized.contentSourceMode = entry.contentSourceMode;
    }
    if (entry.mineruCacheDir?.trim()) {
      normalized.mineruCacheDir = entry.mineruCacheDir.trim();
    }
    const key = `${normalized.libraryID || 0}:${normalized.itemId}:${normalized.contextItemId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}
