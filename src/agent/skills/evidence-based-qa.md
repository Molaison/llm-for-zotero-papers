---
id: evidence-based-qa
description: Retrieve missing evidence for specific methods, results, or verification questions in selected papers or collections. Clarification or translation of sufficient supplied text needs no retrieval workflow.
version: 12
contexts: single-paper,paper-set,library-corpus
activation: auto
---

## Check a paper-specific question

Establish what the supplied text and prior evidence support before retrieving more.
For methods, results, or claim verification, distinguish a direct statement from an inference and from information the source does not report.
A failed passage search does not establish that a claim is absent from the paper.

Use `paper_read` for a missing passage or section in known papers, batching explicit `targets` when useful.
For collection or library questions, use `library_retrieve` within that scope, then close-read identified papers as needed.

Use the returned paper ledger, body evidence, and coverage frontier to assess multi-paper answers.
Follow up on concrete missing facts or qualifications; neither a fixed call count nor additional decorative quotes determine completeness.
Disclose partial or unavailable evidence.
