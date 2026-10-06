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

const otherSidebarChatModeTab = (
  tab: SidebarChatModeTab,
): SidebarChatModeTab => (tab === "paper" ? "library" : "paper");

/**
 * A click on the Stacked layout's mode chip. While its switch is open the
 * clicked option is the pick; closed (a click with no hover, as on touch) the
 * chip toggles. The mode already shown is no pick. Picks go through the same
 * switch path as the tabs.
 */
export function resolveSidebarModeChipPick(input: {
  expanded: boolean;
  clicked: SidebarChatModeTab;
  active: SidebarChatModeTab;
}): SidebarChatModeTab | null {
  const pick = input.expanded
    ? input.clicked
    : otherSidebarChatModeTab(input.active);
  return pick === input.active ? null : pick;
}

/**
 * ↑/↓ on the mode chip. A closed switch opens. An open one picks the row the
 * key points to, in the order the rows had when the switch opened, and moves
 * focus there.
 */
export function resolveSidebarModeChipArrow(input: {
  key: "ArrowUp" | "ArrowDown";
  expanded: boolean;
  /** The rows top to bottom, as the switch opened. */
  rows: readonly [SidebarChatModeTab, SidebarChatModeTab];
  active: SidebarChatModeTab;
}): {
  open: boolean;
  pick: SidebarChatModeTab | null;
  focus: SidebarChatModeTab | null;
} {
  if (!input.expanded) return { open: true, pick: null, focus: null };
  const target = input.key === "ArrowUp" ? input.rows[0] : input.rows[1];
  return {
    open: false,
    pick: target === input.active ? null : target,
    focus: target,
  };
}
