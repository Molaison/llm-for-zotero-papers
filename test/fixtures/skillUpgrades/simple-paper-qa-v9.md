---
id: simple-paper-qa
description: Read one paper to answer open-ended questions when evidence is missing. Clarification, translation, or rewriting of sufficient supplied text needs no paper-reading workflow. Not for Zotero library operations.
version: 9
contexts: single-paper
activation: auto
---

<!--
  SKILL: Paper Q&A

  This skill activates for general questions about a paper (e.g., "what is
  this paper about?", "summarize this", "who are the authors?").

  You can customize:
  - Reading strategy: change when `paper_read` overview vs targeted mode is used
  - Escalation rules: adjust when to do deeper retrieval
  - Answer style: modify how responses are structured

  Your changes are preserved across plugin updates.
  To reset to default, delete this file — it will be recreated on next restart.
-->

## Simple Paper Q&A — retrieve evidence, then answer

Use Zotero paper tools as resources, not a ritual.

- For clarification of supplied text or a previous answer, reuse that evidence and answer directly when sufficient. Retrieve only for a concrete missing paper-specific fact.
- For broad questions like "what is this paper about?", "summarize this", or "main message", start with `paper_read({ mode:'overview' })`, evaluate the evidence, and answer when it supports the response.
- For a specific claim, method, result, or table, start with `paper_read({ mode:'targeted', query:'<the question>' })`.
  For a named section, pass `sections:['<section name>']`; an outline is needed only to resolve an unclear section address.
  For a single factual lookup, start with `topK:3`; increase the evidence set only when a specific requested fact remains missing.
  Use a larger set for multiple distinct questions or comparison dimensions.
- Follow `paperEvidenceProgress`: `advanced` means evaluate the accumulated evidence, `unchanged` means do not repeat the read and name a concrete missing dimension before retrieving again, and `unavailable` means answer with the source limitation.
- If overview reports `contentStatus:'no_pdf_attachment'`, answer from Zotero metadata/abstract if sufficient; otherwise use a specifically targeted external lookup when necessary and label it as external.
- If overview reports `contentStatus:'no_extractable_pdf_text'`, answer from metadata/abstract and state the limitation.
- Apply the system citation contract to paper-specific claims and direct quotations.
  When useful, select 1–3 high-signal passages and explain what each establishes rather than quoting decoratively.
- Do not call visual/page tools, `file_io`, or `run_command` just to improve citation anchors or page numbers.
