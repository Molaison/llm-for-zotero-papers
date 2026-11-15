import { dispatchZoteroItemsToSidebar } from "./zoteroItemContextMenu";
import {
  isZoteroItemDragEvent,
  parseZoteroItemDragData,
} from "./setupHandlers/controllers/fileIntakeController";
import { appLogger } from "../../core/logging";

type ChatDropTarget = Element & { _forceRenderAll: () => Promise<void> };

/** Accept multi-paper library drops anywhere inside the native chat section. */
export function installLibraryPaperDrop(
  pane: Element,
  {
    getSection,
    isLibraryTab,
  }: {
    getSection: () => ChatDropTarget | null;
    isLibraryTab: () => boolean;
  },
): () => void {
  let disposed = false;
  let dropPending = false;
  const setDropActive = (active: boolean) => {
    getSection()
      ?.querySelectorAll(".llm-input-section, .llm-input")
      .forEach((node) =>
        node.classList.toggle("llm-input-drop-active", active),
      );
  };
  const acceptsDrop = (event: DragEvent) =>
    isLibraryTab() &&
    isZoteroItemDragEvent(event) &&
    Boolean(
      (event.target as Element | null)?.closest?.(".llm-dedicated-chat-pane"),
    );
  const onDragOver = (event: Event) => {
    const drag = event as DragEvent;
    if (!acceptsDrop(drag)) return;
    drag.preventDefault();
    drag.stopPropagation();
    if (drag.dataTransfer) drag.dataTransfer.dropEffect = "copy";
    setDropActive(true);
  };
  const onDragLeave = (event: Event) => {
    if (!acceptsDrop(event as DragEvent)) return;
    event.stopPropagation();
    if (
      !getSection()?.contains((event as DragEvent).relatedTarget as Node | null)
    )
      setDropActive(false);
  };
  const onDrop = (event: Event) => {
    const drag = event as DragEvent;
    if (!acceptsDrop(drag)) return;
    setDropActive(false);
    const items = parseZoteroItemDragData(
      drag.dataTransfer?.getData("zotero/item"),
    )
      .map((id) => Zotero.Items.get(id))
      .filter((item): item is Zotero.Item => Boolean(item));
    const papers = new Set(
      items
        .map((item) => (item.isRegularItem?.() ? item.id : item.parentID))
        .filter((id) => id && Zotero.Items.get(id)?.isRegularItem?.()),
    );
    // Single-item and file drops retain the composer's existing behavior.
    if (papers.size < 2) return;
    drag.preventDefault();
    drag.stopImmediatePropagation();
    const target = getSection();
    if (dropPending || !target) return;
    dropPending = true;
    void (async () => {
      try {
        await target._forceRenderAll();
        if (!disposed && isLibraryTab() && target.isConnected) {
          await dispatchZoteroItemsToSidebar(target, items);
        }
      } catch (error) {
        appLogger.warn(`LLM: sidebar context drop failed: ${String(error)}`);
      } finally {
        dropPending = false;
      }
    })();
  };
  pane.addEventListener("dragenter", onDragOver, true);
  pane.addEventListener("dragover", onDragOver, true);
  pane.addEventListener("dragleave", onDragLeave, true);
  pane.addEventListener("drop", onDrop, true);
  return () => {
    disposed = true;
    setDropActive(false);
    pane.removeEventListener("dragenter", onDragOver, true);
    pane.removeEventListener("dragover", onDragOver, true);
    pane.removeEventListener("dragleave", onDragLeave, true);
    pane.removeEventListener("drop", onDrop, true);
  };
}
