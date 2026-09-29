export const RAW_PDF_TRANSPORT_POLICY_BLOCK = [
  "Raw PDF transport policy (overrides conflicting paper-reading routes for this turn):",
  "Read each raw PDF from the exact current-turn local path using native runtime or shell file capabilities.",
  "Do not use `paper_read` (any mode), `library_retrieve`, Zotero indexed PDF text, MinerU `full.md`, sibling attachments, or paths from earlier turns for those PDF identities.",
  "Zotero metadata and write tools remain available. Text/MinerU papers in a mixed turn keep their normal reading route.",
  "If the runtime cannot read an exact path, report that failure. Never fall back to extracted or retrieved paper text.",
].join("\n");
