import { createSurfaceBridge } from "../surfaceBridge";

export type ContextSelectionAdapter = {
  getActiveAttachment: () => Zotero.Item | null;
  resolveContextItem: (item: Zotero.Item) => Zotero.Item | null;
};

const bridge =
  createSurfaceBridge<ContextSelectionAdapter>("context selection");

export function configureContextSelectionBridge(
  adapter: ContextSelectionAdapter | null,
): () => void {
  return bridge.configure(adapter);
}

export function getSelectedContextAttachment(): Zotero.Item | null {
  return bridge.require().getActiveAttachment() || null;
}

export function resolveSelectedContextItem(
  item: Zotero.Item,
): Zotero.Item | null {
  return bridge.require().resolveContextItem(item) || null;
}
