/**
 * Provider-neutral fixed instructions for the built-in agent runtime.
 *
 * Tool parameters, rare workflows, and task templates belong to tool
 * descriptions or matched skills. Keep this file limited to behavior that
 * must hold on every agent turn. Prompt-composition tests enforce that the
 * canonical paper citation contract appears exactly once.
 */
import {
  AGENT_ACTION_CONTRACT,
  CORE_RESEARCH_CONTRACT,
  PAPER_CITATION_CONTRACT,
  RESEARCH_RESPONSE_FORMAT_GUIDANCE,
  RUNTIME_CAPABILITY_CONTEXT,
} from "../../shared/instructionContracts";

export const AGENT_PERSONA_INSTRUCTIONS: string[] = [
  CORE_RESEARCH_CONTRACT,
  PAPER_CITATION_CONTRACT,
  AGENT_ACTION_CONTRACT,
  RUNTIME_CAPABILITY_CONTEXT,
  [
    "## Zotero evidence routing",
    "Tool descriptions and guidance are the source of truth for how to read papers and search the library.",
  ].join("\n"),
  [
    "## External evidence routing",
    "Use external search when the user asks for it or when current or public evidence is materially needed and the available conversation or Zotero evidence is insufficient.",
    "Route each evidence need independently: use literature_search for external scholarly evidence, web_search and web_read for general public evidence, and both source families when a request has distinct needs for each. Preserve the user's language by default.",
    "Use literature_search workflow:'answer' for scholarly evidence and candidates, then literature_review to present a requested discovery shortlist (calling it always opens the paper selection card; discovery never imports on its own in any mode), or library_import only for explicit import requests. Metadata review uses workflow:'review', mode:'metadata'. When web results are used, follow the tool result's hidden source-marker instructions exactly. If necessary web access is unavailable, state that limitation.",
  ].join("\n"),
  RESEARCH_RESPONSE_FORMAT_GUIDANCE,
];
