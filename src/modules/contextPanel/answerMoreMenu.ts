import { positionFloatingMenu, setFloatingMenuOpen } from "./setupHandlers/controllers/menuController";

const activeMenus = new WeakMap<Element, () => void>();

export function closeAnswerMoreMenu(owner: Element): void {
  activeMenus.get(owner)?.();
}

/** Portal outside the scrolling answer; preserve the original action nodes/handlers. */
export function attachAnswerMoreMenu(
  owner: Element, more: HTMLDetailsElement, summary: HTMLElement, menu: HTMLDivElement,
): void {
  const doc = owner.ownerDocument, win = doc.defaultView;
  let cleanup: (() => void) | undefined;
  let pendingClose: number | undefined;
  const close = (restoreFocus = false) => {
    if (pendingClose !== undefined) win?.clearTimeout(pendingClose);
    pendingClose = undefined;
    cleanup?.(); cleanup = undefined;
    more.open = false;
    setFloatingMenuOpen(menu, "llm-answer-menu-open", false);
    more.append(menu);
    if (restoreFocus && summary.isConnected) summary.focus({preventScroll: true});
  };
  const escape = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault(); event.stopPropagation(); close(true);
  };
  more.addEventListener("keydown", escape);
  menu.addEventListener("keydown", escape);
  more.addEventListener("toggle", () => {
    if (!more.open) { if (cleanup) close(); return; }
    if (cleanup) return;
    closeAnswerMoreMenu(owner);
    owner.append(menu);
    setFloatingMenuOpen(menu, "llm-answer-menu-open", true);
    positionFloatingMenu(owner, menu, summary as HTMLButtonElement);
    const outside = (event: Event) => {
      const target = event.target as Node;
      if (!menu.contains(target) && !more.contains(target)) close();
    };
    const scroll = (event: Event) => {
      if (!menu.contains(event.target as Node)) close();
    };
    const resize = () => close();
    const observer = win ? new win.MutationObserver(() => {
      if (!summary.isConnected) close();
    }) : undefined;
    observer?.observe(owner, {childList: true, subtree: true});
    doc.addEventListener("pointerdown", outside, true);
    doc.addEventListener("scroll", scroll, true);
    win?.addEventListener("resize", resize);
    const dismiss = () => close();
    activeMenus.set(owner, dismiss);
    cleanup = () => {
      observer?.disconnect();
      doc.removeEventListener("pointerdown", outside, true);
      doc.removeEventListener("scroll", scroll, true);
      win?.removeEventListener("resize", resize);
      if (activeMenus.get(owner) === dismiss) activeMenus.delete(owner);
    };
    menu.querySelector<HTMLElement>("button:not(:disabled)")?.focus({preventScroll: true});
  });
  menu.addEventListener("click", (event: Event) => {
    if ((event.target as Element).closest("button")) {
      // Trusted event listeners can have intervening microtask checkpoints.
      // Keep the anchor visible until all click handlers finish in this task.
      if (pendingClose !== undefined) win?.clearTimeout(pendingClose);
      pendingClose = win?.setTimeout(() => {
        pendingClose = undefined;
        close();
      }, 0);
    }
  }, true);
}
