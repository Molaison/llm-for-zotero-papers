---
id: analyze-figures
description: Extract, crop, or analyze figures, tables, and diagrams from papers
version: 10
contexts: single-paper,visual-input
activation: auto
---

## Analyze figures and tables

For a resolved figure selection, call `paper_read` in `figures` mode with `figureLabels` and `includeSupplementary` as needed.
Keep the requested source attachment; sibling PDFs may be different papers.
The tool owns crop extraction and cache reuse and does not require a MinerU cache.
Read tables and surrounding discussion with `targeted` mode; use `visual` for requested rendered-page inspection.

Inspect the complete crop and caption before interpreting a panel.
Image order does not establish panel identity.
Ground claims in returned assets, captions, surrounding text, and provenance.
A model without image capability must limit interpretation to textual evidence.
When crop extraction fails, preserve the textual evidence and disclose that visual evidence is unavailable; do not invent placeholders or substitute unrelated images.
User-provided images remain separate evidence inputs.

### Requested persistence

For a figure-only note, use the returned crop's `file://` image link and a short source caption with `note_write`.
Include analysis only when requested.
The note tool imports and verifies images; do not recreate this through shell commands or scripts.
For file export, finalize the document with its host-issued assets and pass the returned document identity and content to the file tool.
Report saving failures separately from the available analysis or crops.
