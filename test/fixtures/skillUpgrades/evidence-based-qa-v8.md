---
id: evidence-based-qa
description: Retrieve missing evidence for specific methods, results, or verification questions in selected papers or collections. Clarification or translation of sufficient supplied text needs no retrieval workflow.
version: 8
contexts: single-paper,paper-set,library-corpus
activation: auto
supersedes: simple-paper-qa
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
- For a specific question about one paper, start with `paper_read({ mode:'targeted', query:'<the question>' })`; use `sections` for a known section name. Use overview for broad understanding and outline only when section addresses are needed.
- For a single factual lookup, start with `topK:3`; use a larger set for multiple requested facts or comparison dimensions and expand only for a specific missing fact.
- For multiple selected papers, call `paper_read({ mode:'targeted', query:'<the specific question>', targets:[...] })` with explicit `targets`.
- For a selected collection/folder or whole-library evidence question, do not rely on the active-reader paper as an implicit target. Call `library_retrieve({ query:'<the specific question>', intent:'verify', depth:'evidence' })` for exact presence/absence, `intent:'enumerate'` when the user asks which papers contain evidence, or `intent:'summarize'` when the user asks for commonality, themes, comparison, or overview across the scoped pool. Then use `paper_read` only with explicit `targets` if close reading is still needed.
- For bounded selected or collection-scoped multi-paper synthesis, prefer the returned body evidence, paper synthesis digest, and coverage frontier over stopping at metadata or abstracts.

**Step 2 — Targeted retrieval (only if Step 1 is insufficient):**
For a single-paper turn, call `paper_read({ mode:'targeted', query:'<the specific question>' })` with a focused question. For paper sets or collection-selected candidates, call `paper_read({ mode:'targeted', query:'<the specific question>', targets:[...] })` with explicit `targets`. This returns the most relevant passages ranked by relevance.

**Step 3 — Answer from the evidence.**
Do NOT make additional retrieval calls just to decorate the answer.
If bounded multi-paper coverage is still insufficient, make the specific follow-up read needed for the missing paper/dimension, or say what is missing rather than pretending.
Follow `paperEvidenceProgress`: `advanced` means evaluate the accumulated evidence, `unchanged` means do not repeat the read and name a concrete missing dimension before retrieving again, and `unavailable` means answer with the source limitation.

Apply the system citation contract to paper-specific claims and direct quotations.
Use only high-signal passages that establish the requested method, result, dataset, or claim, and explain what each passage shows.

Use the evidence frontier rather than a call count to decide whether another retrieval is useful.
Retrieve again only when the frontier or the accumulated evidence identifies a concrete missing paper, method, result, qualification, comparison dimension, or section.
