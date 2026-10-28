export type StandalonePaperTabLabel = "Paper chat" | "Note chat" | "Web chat";

/** Short navigation copy; stored conversation names keep their original keys. */
export function conversationScopeLabel(
  label: StandalonePaperTabLabel | "Library chat",
): "Paper" | "Library" | "Note" | "Web chat" {
  if (label === "Library chat") return "Library";
  if (label === "Note chat") return "Note";
  if (label === "Web chat") return "Web chat";
  return "Paper";
}

export function resolveStandalonePaperTabLabel(options?: {
  isWebChat?: boolean;
  isNoteSession?: boolean;
}): StandalonePaperTabLabel {
  if (options?.isWebChat) return "Web chat";
  if (options?.isNoteSession) return "Note chat";
  return "Paper chat";
}
