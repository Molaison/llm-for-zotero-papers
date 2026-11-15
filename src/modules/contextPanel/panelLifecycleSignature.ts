export type PanelLifecycleSignature = {
  conversationKey: string;
  rawContextItemId: string;
  contextItemId: string;
  conversationSystem: string;
  conversationKind: string;
  shortcutMode: string;
};

const COMPLETED_PANEL_LIFECYCLE_SIGNATURE_KEY =
  "__llmCompletedPanelLifecycleSignature";

export function serializePanelLifecycleSignature(
  signature: PanelLifecycleSignature,
): string {
  return JSON.stringify([
    signature.conversationKey,
    signature.rawContextItemId,
    signature.contextItemId,
    signature.conversationSystem,
    signature.conversationKind,
    signature.shortcutMode,
  ]);
}

export function getCompletedPanelLifecycleSignature(host: unknown): string {
  const value = (host as Record<string, unknown> | null)?.[
    COMPLETED_PANEL_LIFECYCLE_SIGNATURE_KEY
  ];
  return typeof value === "string" ? value : "";
}

export function markCompletedPanelLifecycleSignature(
  host: unknown,
  signature: PanelLifecycleSignature,
): string {
  const serialized = serializePanelLifecycleSignature(signature);
  (host as Record<string, unknown>)[COMPLETED_PANEL_LIFECYCLE_SIGNATURE_KEY] =
    serialized;
  return serialized;
}

export function clearCompletedPanelLifecycleSignature(host: unknown): void {
  delete (host as Record<string, unknown>)[
    COMPLETED_PANEL_LIFECYCLE_SIGNATURE_KEY
  ];
}

export function hasCompletedPanelLifecycleSignature(
  host: unknown,
  signature: PanelLifecycleSignature,
  opts: { conversationLoaded: boolean },
): boolean {
  return (
    opts.conversationLoaded &&
    getCompletedPanelLifecycleSignature(host) ===
      serializePanelLifecycleSignature(signature)
  );
}
