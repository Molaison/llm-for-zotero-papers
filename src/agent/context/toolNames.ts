/**
 * Single owner of the tool names that context pruning, coverage tracking,
 * read attestation, the MCP raw-PDF guard, and the Codex read ledger match
 * as strings.
 *
 * Facade names are what the model and MCP clients can call. The retired
 * primitive names are kept in separate LEGACY_* sets because the in-process
 * registry still executes an internal primitive when a model names it, and
 * stored conversation history written by older versions still carries those
 * names. Retired names: removed in Task 2.6.
 */

/** Facade tools that read one paper's own content. */
export const SINGLE_PAPER_READ_TOOL_NAMES: ReadonlySet<string> = new Set([
  "paper_read",
  "read_attachment",
]);

/** Facade tools whose results are paper evidence (passages, pages, files). */
export const PAPER_EVIDENCE_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...SINGLE_PAPER_READ_TOOL_NAMES,
  "library_retrieve",
]);

/** Facade tools that can reach a paper's text, including library reads. */
export const PAPER_RETRIEVAL_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...PAPER_EVIDENCE_TOOL_NAMES,
  "library_read",
]);

/** Facade tools that return catalog rows rather than paper content. */
export const CATALOG_TOOL_NAMES: ReadonlySet<string> = new Set([
  "library_search",
]);

/** Retired names: removed in Task 2.6. Text reads now `paper_read` targeted/full. */
export const LEGACY_PAPER_TEXT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "read_paper",
  "search_paper",
]);

/** Retired names: removed in Task 2.6. Page images now `paper_read` visual/capture. */
export const LEGACY_PAPER_VISUAL_TOOL_NAMES: ReadonlySet<string> = new Set([
  "view_pdf_pages",
]);

/** Retired names: removed in Task 2.6. */
export const LEGACY_PAPER_RETRIEVAL_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...LEGACY_PAPER_TEXT_TOOL_NAMES,
  ...LEGACY_PAPER_VISUAL_TOOL_NAMES,
]);

/** Retired names: removed in Task 2.6. Catalog reads now `library_search`. */
export const LEGACY_CATALOG_TOOL_NAMES: ReadonlySet<string> = new Set([
  "query_library",
]);

/** Retired names: removed in Task 2.6. Item reads now `library_read`. */
export const LEGACY_LIBRARY_READ_TOOL_NAMES: ReadonlySet<string> = new Set([
  "read_library",
]);

/** Facade tools the MCP raw-PDF guard must inspect. Facade names only. */
export function isRawPdfRetrievalTool(name: string): boolean {
  return PAPER_RETRIEVAL_TOOL_NAMES.has(name);
}

/** Catalog-row tools, facade or retired (stored history may carry either). */
export function isCatalogToolName(name: string): boolean {
  return CATALOG_TOOL_NAMES.has(name) || LEGACY_CATALOG_TOOL_NAMES.has(name);
}

/** Paper-evidence tools, facade or retired (stored history may carry either). */
export function isPaperEvidenceToolName(name: string): boolean {
  return (
    PAPER_EVIDENCE_TOOL_NAMES.has(name) ||
    LEGACY_PAPER_RETRIEVAL_TOOL_NAMES.has(name)
  );
}
