import type { ConversationSystem } from "./types";
import { classifyConversationKey } from "./conversationKeySpace";

export function resolveConversationStorageSystem(params: {
  conversationKey: number;
  conversationSystem?: ConversationSystem | null;
}): ConversationSystem | null {
  if (
    params.conversationSystem === "claude_code" ||
    params.conversationSystem === "codex" ||
    params.conversationSystem === "upstream"
  ) {
    return params.conversationSystem;
  }
  return classifyConversationKey(params.conversationKey)?.system || null;
}
