---
id: analyze-figures
description: Extract, crop, or analyze figures, tables, and diagrams from papers
version: 10
contexts: single-paper,visual-input
activation: auto
---

## Analyzing Figures and Tables

Use the figure labels, figure/table kind, supplemental selection, reading depth, and source boundary stated in the request and workspace facts.
Resolve ambiguity through read/search tools or `request_user_input`.

For a resolved figure selection, call `paper_read` in `figures` mode with concrete `figureLabels` (for example, `["Figure 2", "Figure 4b"]`, `["Supplementary Figure 3"]`, or `[]` for all figures).
Set `includeSupplementary` when requested.
The host reuses verified crops or runs its bundled Python source-PDF extractor; a MinerU cache is not required.
Treat that result as the authority for crop cache reuse or regeneration: use the returned crop paths as-is and do not inspect or validate `figure_crops` metadata before analysis or writing.
Do not read or embed MinerU source image paths for figures.
Keep the active PDF attachment as the source unless the user requests another one.
Sibling attachments may be different papers, even when both have the title "PDF"; compare their filenames and identities before changing the source.
Use the returned paths, captions, confidence, page numbers, and provenance as evidence.
For a resolved table selection, read the table text and surrounding discussion through `paper_read` in `targeted` mode.
For rendered-page intent, use `visual` mode on the resolved pages.

Inspect the complete crop and caption before drawing conclusions about a panel.
Do not infer panel identity from image order.
A model without image capability may still embed returned crop paths in notes, but must limit claims to the caption and surrounding text.
When crop extraction fails (`no_figures`, `mineru_required`, `error`, zero figures, or no image artifact), preserve the textual evidence and switch to text-only mode for analysis, notes, and follow-up artifacts.
In that state, do not include figure images, rendered PDF page screenshots, MinerU source images, or extracted-image placeholders; state that no extracted crops are available and that the explanation rests on captions, figure legends, and surrounding paper text.
User-provided images remain separate evidence inputs.

## Requested persistence

Save the analysis only when the user requests persistence, using the exact target and operation chosen through the direct tool loop.
Finalize requested document material with its host-issued asset identities.
Use the resolved note or file operation to persist it; the host owns image import/export and byte verification.
For a requested figure-only Zotero note, use `note_write` with the returned crop's `file://` image link and a short source caption.
Cropping and saving alone does not request scientific analysis; omit panel explanations and reading-note sections unless the user asks for them.
The native note tool imports and verifies the image; do not recreate extraction or note-image import with shell commands or Zotero scripts.
Preserve finalized material and report any action failure separately.
