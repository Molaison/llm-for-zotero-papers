---
id: analyze-figures
description: Extract, crop, or analyze figures, tables, and diagrams from papers
version: 12
contexts: single-paper,paper-set,library-corpus,visual-input
activation: auto
---

## Analyze figures and tables

For a resolved figure selection, call `paper_read` in `figures` mode with `figureLabels` and `includeSupplementary` as needed.
Keep the requested source attachment; sibling PDFs may be different papers.
The tool owns crop extraction and cache reuse and does not require a MinerU cache.
Use the returned crop paths as-is; do not inspect or validate `figure_crops` metadata, and do not read or embed MinerU source image paths.
Read tables and surrounding discussion with `targeted` mode; use `visual` for requested rendered-page inspection.

Inspect the complete crop and caption before interpreting a panel.
Image order does not establish panel identity.
Ground claims in returned assets, captions, surrounding text, and provenance.
A model without image capability may still embed returned crop paths in notes, but must limit claims to the caption and surrounding text.
When crop extraction fails (`no_figures`, `mineru_required`, `error`, zero figures, or no image artifact), preserve the textual evidence and switch to text-only mode for analysis, notes, and follow-up artifacts.
In that state, include no figure images, rendered page screenshots, MinerU source images, or placeholders, and state that the explanation rests on captions, legends, and surrounding text.
User-provided images remain separate evidence inputs.

### Requested persistence

For a figure-only note, use the returned crop's `file://` image link and a short source caption with `note_write`.
Include analysis only when requested.
The note tool imports and verifies images; do not recreate this through shell commands or scripts.
For file export, finalize the document with its host-issued assets and pass the returned document identity and content to the file tool.
Report saving failures separately from the available analysis or crops.
