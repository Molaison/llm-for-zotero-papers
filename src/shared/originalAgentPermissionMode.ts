/**
 * Permission mode for the in-plugin Original Agent.
 *
 * Unlike the legacy library-write preference, this mode governs every
 * Original Agent capability: Zotero mutations, local files, commands,
 * privileged scripts, and agent-controlled network access.
 * Claude Code and Codex retain their own independent native profiles.
 */
export type OriginalAgentPermissionMode = "auto" | "safe" | "yolo";

export function normalizeOriginalAgentPermissionMode(
  value: unknown,
): OriginalAgentPermissionMode {
  if (value === "yolo") return "yolo";
  if (value === "safe") return "safe";
  return "auto";
}

export function getOriginalAgentPermissionModeDescription(): string {
  return "safe reviews every external write, including new-note creation. auto runs reads, ordinary writes and recoverable operations directly; other actions receive a bounded model review and ask for confirmation only when intent is unclear, risk is excessive, or review cannot complete. yolo delegates permission decisions without model review or permission prompts, including ambiguous or dangerous actions and filesystem or library expansion. Requested review workflows, database integrity and the change journal remain enforced. Claude Code, Codex, and external MCP callers keep their own permission controls.";
}
