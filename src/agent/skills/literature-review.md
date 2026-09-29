---
id: literature-review
description: Structured scientific review with thematic synthesis and citations
version: 9
contexts: paper-set,library-corpus
activation: auto
---

## Synthesize a body of research

Build an evidence-based argument around the review question, connecting specific findings across papers rather than cataloging summaries.
Use the selected corpus as the evidence pool and preserve disagreements, negative evidence, and uncertainty.
Distinguish source claims, your interpretations, and the strength of the supporting study designs.

Default to a narrative review; use a scoping review when the goal is to map concepts, methods, and evidence gaps.
Only use formal inclusion/exclusion screening for an explicitly requested systematic-review protocol or equivalent eligibility method.
Expand the question into useful subquestions without silently turning them into exclusion criteria.
Do not choose a fixed number of papers to read: use available evidence, relevance, and actual capacity, and report per-paper coverage.
Missing or unreadable sources remain unresolved, not automatically excluded.

### Evidence and execution

Reuse supplied evidence and read further to resolve important gaps or conflicting claims.
Within an approved investigation, follow the available `research_update` guidance and returned checkpoints for durable records, reading groups, verification, and phase transitions.
Outside that workflow, use ordinary paper and library tools; do not call unavailable Plan tools or invent a research ledger.
The host owns capacity management and evidence validation.

### Deliverable

Organize the review around its question, scope and method, thematic synthesis, disagreements and limitations, research gaps, and conclusion; adapt to the requested structure.
Apply SANRA-style checks to narrative reviews: clear aims, transparent scope, accurate outcome data, referenced claims, and reasoning calibrated to evidence strength.
Scoping reviews should map breadth and gaps without implying systematic screening unless performed.

In Agent mode, finish with `submit_document` using item-key mappings and host-issued evidence IDs returned by read tools for `[[cite:C1]]` citations.
The centralized CSL service resolves citations and References; do not hand-format them or cite unsupported items.
Include a `## Scope and limitations` section stating actual coverage and unresolved limitations, and preserve any requested document contract.
The document card provides saving and export actions; skill activation alone does not request persistence.
