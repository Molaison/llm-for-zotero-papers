---
id: evidence-based-qa
description: Retrieve missing evidence for specific methods, results, or verification questions in selected papers or collections, including broad summaries of one paper. Clarification or translation of sufficient supplied text needs no retrieval workflow.
version: 10
contexts: single-paper,paper-set,library-corpus
activation: auto
---

<!--
  SKILL: Evidence-Based Q&A

  This skill activates for specific questions about methods, results, or
  evidence in a paper (e.g., "what method did they use?", "find where
  they discuss accuracy").

  You can customize:
  - Retrieval strategy: change how evidence is gathered
  - Retrieval strategy: change how concrete missing dimensions are pursued
  - Answer format: modify how evidence is presented

  Your changes are preserved across plugin updates.
  To reset to default, delete this file — it will be recreated on next restart.
-->

## Evidence-Based Paper Q&A — scoped acquisition, then answer

When the user asks about specific methods, results, data, or needs to locate
a particular claim in a paper or selected collection, use a scoped evidence
approach.

### Recipe

**Step 1 — Gather context:**

- Reuse sufficient supplied text and prior evidence for clarification or follow-up questions. Short wording alone does not determine difficulty.
- Scope each read to the specific question rather than reading the whole paper.
- For a selected collection/folder or whole-library evidence question, call `library_retrieve({ query:'<the specific question>', intent:'verify', depth:'evidence' })` for exact presence/absence, `intent:'enumerate'` when the user asks which papers contain evidence, or `intent:'summarize'` when the user asks for commonality, themes, comparison, or overview across the scoped pool. Then use `paper_read` with explicit `targets` only if close reading is still needed.

**Step 2 — Answer from the evidence.**
Do NOT make additional retrieval calls just to decorate the answer.
If the evidence is still insufficient, make the specific follow-up read needed for the missing paper or dimension, or say what is missing rather than pretending.

Apply the system citation contract to paper-specific claims and direct quotations.
Use only high-signal passages that establish the requested method, result, dataset, or claim, and explain what each passage shows.
