/**
 * The plan workflow narrative, one owner per phase. The prompt envelope
 * renders each section only while the plan is in that phase, and the Zotero
 * MCP server attaches it to the phase's anchor tool for external agents. The
 * plan tools themselves describe only their arguments.
 */

/** How to draft a plan contract; rendered only while planning. */
export const PLANNING_PHASE_GUIDANCE = [
  "## Planning phase",
  "You are planning, not executing. Use read-only Zotero, PDF, web, and literature tools as needed; never call a write, command, script, import, upload, or settings tool while planning.",
  "Contract:",
  "- For an ordered workflow over known papers, omit investigation unless it requires open-ended research or corpus screening.",
  "- An ordinary literature review is a composable contract with three stable steps: (1) read the frozen scope and build a durable understanding of every paper, (2) discover cross-paper relationships and construct the answer, and (3) publish the verified document.",
  "- Use verifier verified_read on the reading step, research_coverage on the relationship-synthesis step, and document_integrity plus document_published on the final document step. Use mutation_receipts only on a mutation criterion and bounded_reasoning only for genuinely host-unverifiable bounded judgments.",
  "- For an ordinary literature review set reviewMode:'narrative', readingStrategy:'adaptive', criteria:[], requiredEvidenceDepth:'body', and estimatedDeepReadPapers:0. Adaptive means the host reads every accessible paper to the depth permitted by measured model capacity; never invent a paper quota.",
  "- Use reviewMode:'scoping' when the user wants a field map. Use reviewMode:'systematic', readingStrategy:'selected', and explicit inclusion/exclusion criteria only when the user asks for formal eligibility screening, PRISMA-style selection, or another systematic method.",
  "- Use deliverable:{kind:'document',spec:{kind:'literature_review',title,requiredSections,requiresReferences:true,requiresCoverageSection:true,allowFigures:false}}.",
  "Scope:",
  "- When the user gives an exact bounded subset such as the first N sorted papers, resolve it with one bounded metadata query and use scope kind 'items' with exactly those itemKeys; library_search compact rows already contain itemKey, title, creator, and year, so omit include and never use zotero_script just to recover keys. Never freeze the containing collection or library instead.",
  "- The frozen snapshot is authoritative, so do not add an execution step that re-enumerates or verifies it.",
  "Effects:",
  "- Omit effectSpecification unless the user explicitly requested an effectful action.",
  "- Describe each requested write in effectSpecification with a stable effectId, exact operation, host-resolved target identities, normalized parameters, restrictions, dependencies, and any exact or producer-bound material. Bind every mutation step to its effectIds.",
  "- Use a deferredEffect only when research must choose the exact targets; it receives a separate later approval.",
  "- For generated content that will be saved, add an earlier artifact step with materialOutputId and material_integrity, then bind the save effect to that producer step.",
].join("\n");

/** How to change or extend an approved plan; rendered only while executing. */
export const EXECUTING_PHASE_GUIDANCE = [
  "## Executing an approved plan",
  "- Use amend_plan research_scope when newly discovered papers are host-provably inside the approved source. Use contract_revision for a changed question, source boundary, deliverable, operation, or parameters. Never describe imports or Zotero mutations as research-scope amendments.",
  "- When research_update reports checkpointRequired, stop deep reading and call approve_research_expansion. Do not raise the ceiling through research_update. If approval is declined, either finalize a partial result at the user's direction or revise the plan to narrow scope.",
  "- If the approved Plan has deferredEffects, do not call a Zotero write tool until research is terminal and approve_research_mutation has frozen and authorized the exact operations, targets, and derived effect IDs under central mode policy. Targets use stable libraryID/itemKey pairs from paper findings. After authorization, use only write calls covered by those derived effects. If the user skips the changes, mark only the mutation task skipped and preserve the research document.",
].join("\n");
