import {
  inspectMineruZipBytes,
  describeMineruZipInspectionFailure,
} from "./mineruZip";
import type { MineruContentListEntry } from "./mineruZip";

type RecordValue = Record<string, unknown>;
// Page furniture keeps its own type so running headers and page numbers never
// read as body text; cache consumers ignore types they do not handle.
const PAGE_FURNITURE_TYPES = new Set([
  "header",
  "footer",
  "page_number",
  "page_footnote",
  "aside_text",
]);
function record(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid MinerU V1 structured content");
  return value as RecordValue;
}
function path(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.split("/").some((part) => part === ".." || part === ".") ||
    /[:\x00]/.test(normalized)
  )
    throw new Error("Unsafe path in MinerU V1 output");
  return normalized;
}
function annotations(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Invalid MinerU V1 annotations");
  return value.map((item) => {
    const content = record(item).content;
    if (typeof content !== "string")
      throw new Error("Invalid MinerU V1 caption");
    return content;
  });
}

/** Adapt the released 4.x pages/blocks contract to the existing cache contract. */
export function normalizeMineruV1Zip(bytes: Uint8Array) {
  const zip = inspectMineruZipBytes(bytes);
  if (!zip.ok) throw new Error(describeMineruZipInspectionFailure(zip));
  const byPath = new Map(
    zip.files.map((file) => [path(file.relativePath), file]),
  );
  if (byPath.size !== zip.files.length)
    throw new Error("Duplicate paths in MinerU V1 output");
  const structured = byPath.get("structured_content.json");
  const markdown = byPath.get("markdown.md");
  if (!structured || !markdown)
    throw new Error("MinerU V1 ZIP is missing Markdown or structured content");
  const document = record(
    JSON.parse(new TextDecoder().decode(structured.data)),
  );
  if (!Array.isArray(document.pages) || !document.pages.length)
    throw new Error("MinerU V1 structured content has no pages");
  if (document.is_full_document === false)
    throw new Error("MinerU returned an incomplete document");
  const contentList: MineruContentListEntry[] = [];
  const assetPaths = new Map<string, string>();
  // Keep durable assets under images/, which the existing cache and chunk merger own.
  for (const name of byPath.keys()) {
    if (/\.(png|jpe?g|webp|gif|svg)$/i.test(name))
      assetPaths.set(
        name,
        name.startsWith("images/") ? name : `images/${name}`,
      );
  }
  if (new Set(assetPaths.values()).size !== assetPaths.size)
    throw new Error("Conflicting image paths in MinerU V1 output");
  const seenPages = new Set<number>();
  for (const value of document.pages) {
    const page = record(value);
    if (
      !Number.isInteger(page.page_idx) ||
      (page.page_idx as number) < 0 ||
      seenPages.has(page.page_idx as number) ||
      !Array.isArray(page.blocks)
    )
      throw new Error("Invalid MinerU V1 page metadata");
    const pageIndex = page.page_idx as number;
    if (pageIndex !== seenPages.size)
      throw new Error("MinerU V1 pages are incomplete or out of order");
    seenPages.add(pageIndex);
    for (const value of page.blocks) {
      const block = record(value);
      if (typeof block.type !== "string" || typeof block.content !== "string")
        throw new Error("Invalid MinerU V1 block");
      const text = block.content;
      let imagePath: string | undefined;
      if (block.image_source != null) {
        if (typeof block.image_source !== "string")
          throw new Error("Invalid MinerU V1 image path");
        const source = path(block.image_source);
        imagePath = assetPaths.get(source);
        if (!imagePath)
          throw new Error(`MinerU V1 ZIP is missing an image: ${source}`);
      }
      const entry: MineruContentListEntry = {
        type: "text",
        text,
        page_idx: pageIndex,
      };
      if (block.type === "doc_title" || block.type === "paragraph_title") {
        const level = block.level;
        entry.text_level =
          typeof level === "number" && Number.isInteger(level) && level > 0
            ? level
            : block.type === "doc_title"
              ? 1
              : 2;
      } else if (["image", "chart"].includes(block.type)) {
        entry.type = "image";
        entry.img_path = imagePath;
        entry.image_caption = annotations(block.captions);
        entry.image_footnote = annotations(block.footnotes);
      } else if (block.type === "table") {
        entry.type = "table";
        entry.img_path = imagePath;
        entry.table_body = text;
        entry.table_caption = annotations(block.captions);
        entry.table_footnote = annotations(block.footnotes);
      } else if (
        block.type === "equation" ||
        block.type === "equation_interline"
      ) {
        entry.type = "equation";
        if (imagePath) entry.img_path = imagePath;
      } else if (PAGE_FURNITURE_TYPES.has(block.type)) {
        entry.type = block.type;
      }
      contentList.push(entry);
    }
  }
  const rewrite = (source: string) => {
    if (/^(https?:|data:|#)/i.test(source)) return source;
    const normalized = path(source);
    const target = assetPaths.get(normalized);
    if (!target)
      throw new Error(`MinerU V1 ZIP is missing an image: ${normalized}`);
    return target;
  };
  const mdContent = new TextDecoder()
    .decode(markdown.data)
    .replace(
      /(!\[[^\]]*\]\()([^)]*)(\))/g,
      (_all, before, source, after) => `${before}${rewrite(source)}${after}`,
    )
    .replace(
      /(<img\b[^>]*\bsrc=["'])([^"']+)(["'])/gi,
      (_all, before, source, after) => `${before}${rewrite(source)}${after}`,
    );
  if (!mdContent.trim()) throw new Error("MinerU V1 Markdown is empty");
  const encoder = new TextEncoder();
  return {
    mdContent,
    pageCount: document.pages.length,
    files: [
      { relativePath: "full.md", data: encoder.encode(mdContent) },
      {
        relativePath: "content_list.json",
        data: encoder.encode(JSON.stringify(contentList)),
      },
      ...Array.from(assetPaths, ([source, target]) => ({
        relativePath: target,
        data: byPath.get(source)!.data,
      })),
    ],
  };
}
