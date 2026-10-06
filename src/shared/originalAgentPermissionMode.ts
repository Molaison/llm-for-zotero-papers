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
