---
id: simple-paper-qa
description: Read one paper to answer open-ended questions when evidence is missing. Clarification, translation, or rewriting of sufficient supplied text needs no paper-reading workflow. Not for Zotero library operations.
version: 10
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
- For broad questions like "what is this paper about?", "summarize this", or "main message", read the paper broadly, evaluate the evidence, and answer when it supports the response.
- For a specific claim, method, result, or table, read targeted evidence for that question.
- Apply the system citation contract to paper-specific claims and direct quotations.
  When useful, select 1–3 high-signal passages and explain what each establishes rather than quoting decoratively.
- Do not call visual/page tools, `file_io`, or `run_command` just to improve citation anchors or page numbers.
