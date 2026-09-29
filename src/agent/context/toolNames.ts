/**
 * Single owner of the tool names that context pruning, coverage tracking,
 * read attestation, the MCP raw-PDF guard, and the Codex read ledger match
 * as strings.
 *
 * The sets hold model-visible tool names; MCP exposes a curated subset.
 * Retired primitive names appear only in RETIRED_TOOL_HINTS, which the
 * registry uses to point a model that names one at its facade. Stored
 * history that still carries a retired name is treated as an ordinary tool
 * result.
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

/** Facade tools the MCP raw-PDF guard must inspect. Facade names only. */
export function isRawPdfRetrievalTool(name: string): boolean {
  return PAPER_RETRIEVAL_TOOL_NAMES.has(name);
}

/** Tools whose results are catalog rows. */
export function isCatalogToolName(name: string): boolean {
  return CATALOG_TOOL_NAMES.has(name);
}

/** Tools whose results are paper evidence. */
export function isPaperEvidenceToolName(name: string): boolean {
  return PAPER_EVIDENCE_TOOL_NAMES.has(name);
}

/**
 * Retired tool name -> the facade call that replaced it. Only the unknown-tool
 * error reads this; none of these names is registered.
 */
export const RETIRED_TOOL_HINTS: Readonly<Record<string, string>> = {
  apply_tags: "library_update kind:'tags'",
  set_item_tags: "library_update kind:'tags' action:'set'",
  tag_update: "library_update kind:'tag'",
  move_to_collection: "library_update kind:'collections'",
  update_metadata: "library_update kind:'metadata'",
  reparent_items: "library_update kind:'parent'",
  relate_items: "library_update kind:'related'",
  manage_collections: "library_update kind:'collection'",
  manage_attachments: "library_update kind:'attachment'",
  collection_update: "library_update kind:'collection'",
  attachment_update: "library_update kind:'attachment'",
  saved_search_update: "library_update kind:'savedSearch'",
  import_identifiers: "library_import kind:'identifiers'",
  import_local_files: "library_import kind:'files'",
  create_items: "library_import kind:'manual'",
  trash_items: "library_delete mode:'trash'",
  restore_from_trash: "library_delete mode:'restore'",
  merge_items: "library_delete mode:'merge'",
  query_library: "library_search",
  read_library: "library_read",
  read_paper: "paper_read",
  search_paper: "paper_read mode:'targeted'",
  view_pdf_pages: "paper_read mode:'visual'",
  search_literature_online: "literature_search",
  edit_current_note: "note_write",
  write_notes_batch: "note_write_batch",
  undo_last_action: "undo",
  revert_changes: "undo count:N or actionIds:[...]",
};
