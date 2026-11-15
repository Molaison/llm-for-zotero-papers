import { createElement } from "../../utils/domHelpers";
import { WEBCHAT_TARGETS } from "../../webchat/types";
import {
  resolveSidebarModeChipArrow,
  resolveSidebarModeChipPick,
  type SidebarChatModeTab,
} from "./sidebarChatModeToggle";

/**
 * The Stacked layout's mode chip. At rest it is a pill showing the current
 * mode; on hover or keyboard focus it drops down into a Paper chat | Library
 * chat switch that stays inside the chip's own column.
 *
 * The geometry lives in CSS, keyed off the attributes written here:
 * `data-mode` (the mode shown), `data-expanded`, `data-top` (the upper row
 * while open, fixed when it opened, so a click moves the pill and never the
 * words) and `data-static` (note sessions and WebChat, which never open).
 * Picks go back to the caller, which routes them through the tabs' switch
 * path; the chip itself holds no mode.
 */

/** How long the switch stays open after the pointer leaves it. */
export const SIDEBAR_MODE_SWITCH_CLOSE_DELAY_MS = 160;

export type SidebarModeSwitchState = {
  activeTab: SidebarChatModeTab;
  /** Paper chat; in a static state, Note chat or the WebChat site. */
  paperLabel: string;
  libraryLabel: string;
  /** Note sessions and WebChat hold the chip static. */
  disabled: boolean;
  /** The paper slot's tooltip: WebChat names its site there. */
  paperTitle?: string;
};

const TABS = ["paper", "library"] as const;
const FADE_CLASS = "llm-mode-switch-fade";

function findOption(
  capsule: Element,
  tab: SidebarChatModeTab,
): HTMLButtonElement | null {
  return (
    (
      Array.from(
        capsule.querySelectorAll(".llm-mode-switch-option"),
      ) as HTMLButtonElement[]
    ).find((option) => option.dataset.tab === tab) || null
  );
}

function setData(element: HTMLElement, key: string, value: string): void {
  if (element.dataset[key] !== value) element.dataset[key] = value;
}

/** Closed, only the chip is a tab stop; open, both rows are. */
function syncTabStops(capsule: HTMLElement): void {
  const expanded = capsule.dataset.expanded === "true";
  for (const tab of TABS) {
    const option = findOption(capsule, tab);
    if (!option) continue;
    const tabIndex = expanded || tab === capsule.dataset.mode ? 0 : -1;
    if (option.tabIndex !== tabIndex) option.tabIndex = tabIndex;
  }
}

export function createSidebarModeSwitch(
  doc: Document,
  state: SidebarModeSwitchState,
  options: {
    ariaLabel: string;
    /** Every plain label the paper or library slot can show. */
    fitLabels: readonly string[];
  },
): HTMLDivElement {
  const capsule = createElement(doc, "div", "llm-mode-switch", {
    id: "llm-mode-capsule",
  });
  capsule.setAttribute("role", "group");
  capsule.setAttribute("aria-label", options.ariaLabel);
  capsule.dataset.expanded = "false";
  // Laid out but never painted: it sizes the chip to the longest label it can
  // show, WebChat's site and dot included, so the chip keeps one width in
  // every state and the icons beside it never shift.
  const sizer = createElement(doc, "span", "llm-mode-switch-sizer");
  sizer.setAttribute("aria-hidden", "true");
  for (const label of options.fitLabels) {
    sizer.append(createElement(doc, "span", undefined, { textContent: label }));
  }
  for (const target of WEBCHAT_TARGETS) {
    const entry = createElement(doc, "span");
    entry.append(
      createElement(doc, "span", "llm-webchat-dot"),
      createElement(doc, "span", undefined, {
        textContent: target.displayName,
      }),
    );
    sizer.append(entry);
  }
  const track = createElement(doc, "span", "llm-mode-switch-track");
  track.setAttribute("aria-hidden", "true");
  const thumb = createElement(doc, "span", "llm-mode-switch-thumb");
  thumb.setAttribute("aria-hidden", "true");
  capsule.append(sizer, track, thumb);
  for (const tab of TABS) {
    const option = createElement(doc, "button", "llm-mode-switch-option", {
      id: `llm-mode-option-${tab}`,
      type: "button",
    });
    option.dataset.tab = tab;
    option.append(createElement(doc, "span", "llm-mode-switch-label"));
    capsule.append(option);
  }
  syncSidebarModeSwitch(capsule, state);
  return capsule;
}

/** Show the panel's mode; writes only what changed. */
export function syncSidebarModeSwitch(
  capsule: HTMLElement,
  state: SidebarModeSwitchState,
): void {
  setData(capsule, "mode", state.activeTab);
  setData(capsule, "static", state.disabled ? "true" : "false");
  // A static chip never stays open, e.g. when WebChat starts under the pointer.
  if (state.disabled) setData(capsule, "expanded", "false");
  for (const tab of TABS) {
    const option = findOption(capsule, tab);
    if (!option) continue;
    const label = option.querySelector(".llm-mode-switch-label");
    const text = tab === "paper" ? state.paperLabel : state.libraryLabel;
    if (label && label.textContent !== text) label.textContent = text;
    const pressed = tab === state.activeTab ? "true" : "false";
    if (option.getAttribute("aria-pressed") !== pressed) {
      option.setAttribute("aria-pressed", pressed);
    }
    if (option.disabled !== state.disabled) option.disabled = state.disabled;
    const title = tab === "paper" ? state.paperTitle || "" : "";
    if (option.title !== title) option.title = title;
  }
  syncTabStops(capsule);
}

/** WebChat: the paper slot shows its site after the connection dot. */
export function showSidebarModeSwitchDot(
  capsule: HTMLElement | null,
): HTMLElement | null {
  const option = capsule ? findOption(capsule, "paper") : null;
  if (!option) return null;
  let dot = option.querySelector(".llm-webchat-dot") as HTMLElement | null;
  if (!dot) {
    dot = createElement(
      option.ownerDocument,
      "span",
      "llm-webchat-dot llm-webchat-dot-disconnected",
    );
    option.insertBefore(dot, option.firstChild);
  }
  return dot;
}

export function removeSidebarModeSwitchDot(capsule: HTMLElement | null): void {
  const option = capsule ? findOption(capsule, "paper") : null;
  option?.querySelector(".llm-webchat-dot")?.remove();
}

/**
 * Hover, focus, click and keyboard for the chip. A mouse opens it on hover
 * and a pointer that leaves gets a short grace; a click with no hover (touch)
 * toggles. Keyboard focus opens it, ↑/↓ pick a row, Escape closes it.
 */
export function installSidebarModeSwitch(
  capsule: HTMLElement,
  onPick: (tab: SidebarChatModeTab) => void,
): () => void {
  const doc = capsule.ownerDocument;
  const win = doc.defaultView;
  let closeTimer: number | undefined;
  const activeTab = (): SidebarChatModeTab =>
    capsule.dataset.mode === "library" ? "library" : "paper";
  const isOpen = () => capsule.dataset.expanded === "true";
  const isStatic = () => capsule.dataset.static === "true";
  const rows = (): [SidebarChatModeTab, SidebarChatModeTab] =>
    capsule.dataset.top === "library"
      ? ["library", "paper"]
      : ["paper", "library"];
  const cancelClose = () => {
    if (closeTimer === undefined) return;
    win?.clearTimeout(closeTimer);
    closeTimer = undefined;
  };
  const open = () => {
    cancelClose();
    if (isOpen() || isStatic()) return;
    // The rows keep this order until the switch closes.
    capsule.dataset.top = activeTab();
    capsule.dataset.expanded = "true";
    syncTabStops(capsule);
  };
  const close = () => {
    cancelClose();
    if (!isOpen()) return;
    capsule.dataset.expanded = "false";
    syncTabStops(capsule);
  };
  const closeAfterGrace = () => {
    cancelClose();
    if (!win) {
      close();
      return;
    }
    closeTimer = win.setTimeout(() => {
      closeTimer = undefined;
      close();
    }, SIDEBAR_MODE_SWITCH_CLOSE_DELAY_MS);
  };

  // Hover is a mouse affordance; a touch tap reaches the click, which toggles.
  const onPointerEnter = (event: Event) => {
    if ((event as PointerEvent).pointerType === "mouse") open();
  };
  const onPointerLeave = (event: Event) => {
    if ((event as PointerEvent).pointerType === "mouse") closeAfterGrace();
  };
  const onFocusIn = (event: Event) => {
    const target = event.target as Element | null;
    if (target?.matches?.(":focus-visible")) open();
  };
  const onFocusOut = (event: Event) => {
    const next = (event as FocusEvent).relatedTarget as Node | null;
    if (next && capsule.contains(next)) return;
    if (capsule.matches(":hover")) return;
    close();
  };
  const onClick = (event: Event) => {
    const option = (event.target as Element | null)?.closest?.(
      ".llm-mode-switch-option",
    ) as HTMLElement | null;
    if (!option) return;
    event.preventDefault();
    event.stopPropagation();
    if (isStatic()) return;
    const pick = resolveSidebarModeChipPick({
      expanded: isOpen(),
      clicked: option.dataset.tab === "library" ? "library" : "paper",
      active: activeTab(),
    });
    if (pick) onPick(pick);
  };
  const onKeyDown = (event: Event) => {
    const keyEvent = event as KeyboardEvent;
    if (isStatic()) return;
    if (keyEvent.key === "ArrowUp" || keyEvent.key === "ArrowDown") {
      keyEvent.preventDefault();
      const step = resolveSidebarModeChipArrow({
        key: keyEvent.key,
        expanded: isOpen(),
        rows: rows(),
        active: activeTab(),
      });
      if (step.open) open();
      // A held key repeats; one press is one pick.
      if (step.pick && !keyEvent.repeat) onPick(step.pick);
      if (step.focus) findOption(capsule, step.focus)?.focus();
      return;
    }
    if (keyEvent.key === "Escape" && isOpen()) {
      // This Escape belongs to the switch, not to the panel's other handlers.
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      close();
      // Focus stays on what the chip now shows.
      if (capsule.contains(doc.activeElement)) {
        findOption(capsule, activeTab())?.focus();
      }
    }
  };

  const listeners: Array<[string, (event: Event) => void]> = [
    ["pointerenter", onPointerEnter],
    ["pointerleave", onPointerLeave],
    ["focusin", onFocusIn],
    ["focusout", onFocusOut],
    ["click", onClick],
    ["keydown", onKeyDown],
  ];
  for (const [type, listener] of listeners) {
    capsule.addEventListener(type, listener);
  }
  return () => {
    cancelClose();
    for (const [type, listener] of listeners) {
      capsule.removeEventListener(type, listener);
    }
  };
}

/**
 * The chat settles in (a short fade and rise) when the mode changes. CSS
 * plays it only in the Stacked sidebar and never under reduced motion.
 */
export function playSidebarModeChangeFade(chatBox: HTMLElement): void {
  chatBox.classList.remove(FADE_CLASS);
  // Restart the animation: the class stays on after the last change.
  void chatBox.offsetWidth;
  chatBox.classList.add(FADE_CLASS);
}
