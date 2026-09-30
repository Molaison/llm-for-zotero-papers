import {
  resolveStandalonePaperTabLabel,
  type StandalonePaperTabLabel,
} from "./standaloneTabLabel";

export type SidebarChatModeTab = "paper" | "library";

export type SidebarChatModeToggleState = {
  activeTab: SidebarChatModeTab;
  /**
   * Untranslated labels, worded as the standalone window's tabs; callers pass
   * them through t().
   */
  paperTabLabel: StandalonePaperTabLabel;
  libraryTabLabel: "Library chat";
  disabled: boolean;
  showWebChatDot: boolean;
};

/**
 * The sidebar header's Paper chat | Library chat control. WebChat occupies the paper
 * slot and cannot switch mode; a note conversation navigates only within its
 * own history, so Library chat is unreachable from it.
 */
export function resolveSidebarChatModeToggleState(input: {
  isGlobalMode: boolean;
  isNoteSession: boolean;
  isWebChat: boolean;
}): SidebarChatModeToggleState {
  const isWebChat = Boolean(input.isWebChat);
  const isNoteSession = Boolean(input.isNoteSession);
  return {
    activeTab:
      !isWebChat && !isNoteSession && input.isGlobalMode ? "library" : "paper",
    paperTabLabel: resolveStandalonePaperTabLabel({ isWebChat, isNoteSession }),
    libraryTabLabel: "Library chat",
    disabled: isWebChat || isNoteSession,
    showWebChatDot: isWebChat,
  };
}

export type SidebarChatModeTabAction =
  | "noop"
  | "no-paper"
  | "switch-paper"
  | "switch-library";

export function resolveSidebarChatModeTabAction(input: {
  requested: SidebarChatModeTab;
  state: SidebarChatModeToggleState;
  hasPaper: boolean;
}): SidebarChatModeTabAction {
  if (input.state.disabled) return "noop";
  if (input.requested === input.state.activeTab) return "noop";
  if (input.requested === "library") return "switch-library";
  return input.hasPaper ? "switch-paper" : "no-paper";
}
