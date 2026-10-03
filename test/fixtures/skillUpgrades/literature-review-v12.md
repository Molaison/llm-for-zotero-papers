---
id: literature-review
description: Structured scientific review with thematic synthesis and citations
version: 12
contexts: paper-set,library-corpus
activation: auto
---

## Literature Review — read the papers, then write one cited document

A review is an argument about a body of work, not a catalog of it: a faithful account of each paper, true relationships between specific papers, a structure that emerges from those relationships, and honest calibration about what was read.
`paper_read` owns reading capacity; do not invent a paper cap, a group size, or a tool-call budget.

### Workflow

1. **Scope.** The host states the turn's papers or collection in the context.
   If only a collection or a search is named, list its papers once with `library_search` and work from that list.
   Treat an explicitly selected corpus as the evidence pool, not as a sample.
2. **Parts.** In your first step, declare the parts with `task_update`.
   When the user asked for something per paper (summaries, each paper's method, a table with a row per paper), or when the review must account for more than four papers, declare a digest part: `{ taskId:'summaries', description:'Summarize each selected paper', expectedEffect:'digest', scope:true }` (or explicit `targetIds`), and do not also declare a read part over the same papers.
   The host then summarizes each paper itself inside that call and returns the summaries; do not read those papers with `paper_read` first.
   Then declare the review (`expectedEffect:'artifact'`) and, only when the user asked to save it, the note (`expectedEffect:'mutation'`, `expectedCapability:'zotero.notes'`).
   For four papers or fewer without a per-paper request, declare a read part (`expectedEffect:'read'`) instead and read them with `paper_read`.
   The host marks each part done from the tools' results.
3. **Read.** With a digest part, write from the digests the host returned: each has the paper's summary, contributions, methods, limitations and verified quotes with section labels, and a handle for `context_read source:'tool_result'` when you need the full record.
   Use `paper_read({ mode:'targeted', query:'...' })` only to verify a decisive cross-paper claim or an apparent contradiction; never re-read a paper whose digest succeeded in overview or full mode.
   If the host reports digest failures, declare the part again once with `targetIds` of the failed papers only.
   Then a paper whose digest failed twice may be read with an overview `paper_read` instead; name it as not read only if that read fails too.
   If the part is still open after a Stop and the user says continue, call `task_update` again with the same `taskId` and no description to finish the remaining papers.
   Without a digest part, read the scope's papers with `paper_read`, passing them as `targets` and grouping related papers in one call.
   The host fits each paper's text to the remaining context, and each result reports which papers came back complete, sampled, abstract only, or metadata only.
   When papers come back sampled, read fewer at a time or read their missing sections rather than moving on.
   As you go, note each paper's main claims, methods, and evidence, and its role in the argument: central, supporting, contradictory, theoretical, methodological, or context.
   Use `paper_read({ mode:'targeted', query:'...' })` only to check a decisive claim, test an apparent contradiction against both papers, or find a precise location.
4. **Write.** Write one cited document and finish with `submit_document`, as described under Document; pass the `taskId` of the review part.
   When the user asked for summaries, the document opens with a 'Paper summaries' section: one paragraph per paper, in scope order, each from that paper's digest, before the review sections below.
5. **Save.** Save it with `note_write` and the returned `documentId` only when the user asked; do not offer afterward, because the document card owns Copy Markdown, Save Note, Export, and Expand.

### Scope and method

- Expand the question into explicit subquestions and read every paper against them; they are not eligibility criteria.
- Write a narrative review by default; write a scoping review when the goal is to map the breadth, concepts, methods, and gaps of a field.
- Use formal inclusion and exclusion screening only when the user asks for a systematic-review method, PRISMA-style selection, or reproducible eligibility decisions, and then report each paper's decision and its reason.
- Missing abstracts, unindexed PDFs, OCR failures, and unreadable files stay unresolved unless metadata alone clearly excludes the paper; report the depth actually reached.
- Preserve contradictions and negative evidence rather than forcing agreement.

### Synthesis

- Organize by ideas, methods, or findings, not paper by paper.
- A sentence that relates two papers rests on what you read in both: state what the text supports as established, and hedge what you could not verify.
- Every paper-specific claim traces to that paper's text.
- Turn what the reading left open (isolated papers, thinly covered subquestions, unresolved contradictions, open questions) into the research gaps.
- Use `paper_read({ mode:'figures', ... })` only when a figure materially improves the synthesis; a generated figure is never source evidence.

### Quality checks

- Apply SANRA-style narrative-review checks: explain importance and aims, describe the reviewed scope, support key claims with references, reason from the strength and type of evidence, and present outcome data accurately.
- For scoping reviews, map the breadth, concepts, evidence types, and gaps in line with JBI's purpose for scoping evidence synthesis.
- Keep PRISMA-style eligibility screening and exclusion accounting to systematic-review requests.

### Document

Prefer these sections unless the user asks for another structure:

1. Introduction and review question
2. Scope and method
3. Thematic synthesis
4. Agreements, contradictions, and limitations
5. Research gaps and future directions
6. Conclusion
7. Scope and limitations

- Put `[[cite:C1]]` tokens at supported claims and identify each citation source by `libraryID` and `itemKey`; the host binds the evidence your reads produced.
- Cite only papers you read for this review; a direct quotation uses a `[[quote:Q1]]` token whose mapping carries the verbatim text and the evidence IDs the read returned.
- Never hand-format author-year citations or a References section; Zotero's CSL service formats both.
- In Scope and limitations, name each paper whose digest failed and the reason the host gave.
- In Scope and limitations, state the coverage: how many papers were read in full, in part, and from metadata only, as `paper_read` reported them, and name any paper that stayed unread.
- State the actual coverage frontier and its limitations, and never imply an exhaustive review from sampled text.
