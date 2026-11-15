import { config } from "../../../package.json";

export type SidebarLayout = "independent" | "stacked";
export const SIDEBAR_LAYOUT_PREF = `${config.prefsPrefix}.sidebarLayout`;

export function getSidebarLayout(): SidebarLayout {
  try {
    return Zotero.Prefs.get(SIDEBAR_LAYOUT_PREF, true) === "independent"
      ? "independent"
      : "stacked";
  } catch {
    return "stacked";
  }
}

export function syncSidebarSectionLayout(doc: Document): void {
  const stacked =
    doc.documentElement.getAttribute("data-llm-pane-view") === "stacked";
  for (const section of Array.from(
    doc.querySelectorAll(".llm-dedicated-chat-pane > collapsible-section"),
  )) {
    const collapsible = section as Element & { collapsible: boolean };
    collapsible.collapsible = stacked;
    if (!stacked) collapsible.setAttribute("open", "true");
  }
}

/** Switch only native presentation; retain each mounted conversation and draft. */
export function installSidebarLayoutPreference(doc: Document): () => void {
  const root = doc.documentElement;
  const apply = () => {
    const layout = getSidebarLayout();
    const current = root.getAttribute("data-llm-pane-view");
    root.setAttribute("data-llm-sidebar-layout", layout);
    root.setAttribute(
      "data-llm-pane-view",
      layout === "stacked"
        ? "stacked"
        : current === "stacked"
          ? "chat"
          : current || "details",
    );
    syncSidebarSectionLayout(doc);
  };
  apply();
  const prefs = typeof Zotero !== "undefined" ? Zotero.Prefs : undefined;
  const observer = prefs?.registerObserver?.(SIDEBAR_LAYOUT_PREF, apply, true);
  return () => {
    if (observer !== undefined) prefs?.unregisterObserver?.(observer);
    root.removeAttribute("data-llm-sidebar-layout");
  };
}
