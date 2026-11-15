import { syncSidebarSectionLayout } from "./sidebarLayout";
import { installLibraryPaperDrop } from "./libraryPaperDrop";
import { appLogger } from "../../core/logging";
type NativeChatSection = Element & {
  item: Zotero.Item | null;
  tabType: string;
  skipRender: boolean;
  _forceRenderAll: () => Promise<void>;
};

/** Keep the library rail available for selected items, including multi-paper drops. */
export function installPersistentLibraryChatPane(doc: Document) {
  const win = doc.defaultView;
  const pane = doc.getElementById("zotero-item-pane") as
    | (Element & { data?: Zotero.Item[] })
    | null;
  const details = doc.getElementById("zotero-item-details") as
    | (Element & { renderCustomSections: () => void; item: Zotero.Item | null })
    | null;
  const nav = doc.getElementById("zotero-view-item-sidenav") as Element | null;
  if (!win || !pane || !details || !nav)
    return { refresh: () => {}, dispose: () => {} };
  const isLibraryTab = () =>
    (win as Window & { Zotero_Tabs?: { selectedID?: string } }).Zotero_Tabs
      ?.selectedID === "zotero-pane";
  let section: NativeChatSection | null = null;
  let lastEmpty = false;
  let wasChat = false;
  const reconcile = () => {
    details.renderCustomSections();
    section = details.querySelector(".llm-dedicated-chat-pane");
    if (!section) return;
    const paneID = section.getAttribute("data-pane");
    const button = Array.from<Element>(
      nav.querySelectorAll("[data-pane]") as NodeListOf<Element>,
    ).find((node) => node.getAttribute("data-pane") === paneID);
    button?.parentElement?.classList.add("llm-persistent-rail-entry");
    const available = Boolean(
      pane.data?.some(
        (item) =>
          item.isRegularItem?.() || item.isAttachment?.() || item.isNote?.(),
      ),
    );
    if (button && button.hasAttribute("disabled") === available) {
      if (available) button.removeAttribute("disabled");
      else button.setAttribute("disabled", "true");
    }
    if (!isLibraryTab()) return;
    if (!available) {
      if (doc.documentElement.getAttribute("data-llm-pane-view") === "chat") {
        doc.documentElement.setAttribute(
          "data-llm-pane-view",
          doc.documentElement.getAttribute("data-llm-sidebar-layout") ===
            "stacked"
            ? "stacked"
            : "details",
        );
        syncSidebarSectionLayout(doc);
      }
      lastEmpty = true;
      wasChat = false;
      return;
    }
    const empty = pane.getAttribute("view-type") !== "item";
    const root = doc.documentElement;
    if (
      !empty &&
      root.getAttribute("data-llm-sidebar-layout") === "stacked" &&
      root.getAttribute("data-llm-pane-view") === "chat"
    ) {
      root.setAttribute("data-llm-pane-view", "stacked");
      syncSidebarSectionLayout(doc);
    }
    const chat =
      doc.documentElement.getAttribute("data-llm-pane-view") === "chat";
    if (empty && (!lastEmpty || (chat && !wasChat))) {
      // Native message/note views retain the old item-details item. Clear it
      // before invoking the existing chat lifecycle, never borrow that paper.
      details.item = null;
      section.tabType = "library";
      section.skipRender = false;
      section.item = null;
      if (chat)
        void section._forceRenderAll().catch((error: unknown) => {
          appLogger.warn(
            `LLM: empty library pane render failed: ${String(error)}`,
          );
        });
    }
    lastEmpty = empty;
    wasChat = chat;
  };
  const disposeDrop = installLibraryPaperDrop(pane, {
    getSection: () => section,
    isLibraryTab,
  });
  const Observer = (
    win as Window & { MutationObserver: typeof MutationObserver }
  ).MutationObserver;
  const observer = new Observer(reconcile);
  observer.observe(pane, { attributes: true, attributeFilter: ["view-type"] });
  observer.observe(nav, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["hidden", "disabled"],
  });
  observer.observe(doc.documentElement, {
    attributes: true,
    attributeFilter: ["data-llm-pane-view"],
  });
  reconcile();
  return {
    refresh: reconcile,
    dispose: () => {
      disposeDrop();
      observer.disconnect();
      nav
        .querySelectorAll(".llm-persistent-rail-entry")
        .forEach((node) => node.classList.remove("llm-persistent-rail-entry"));
    },
  };
}
