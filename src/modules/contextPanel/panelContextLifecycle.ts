export type PanelContextLifecycleDecisionParams = {
  needsFullRender: boolean;
  storedItemKey?: string;
  newItemKey: string;
  currentKind?: string;
  currentRawContextItemKey?: string;
  rawContextItemKey: string;
  currentContextOwnerItemKey?: string;
  newContextOwnerItemKey: string;
  currentContextSourceStateKey?: string;
  newContextSourceStateKey: string;
};

function isSamePaperConversation(
  params: PanelContextLifecycleDecisionParams,
): boolean {
  return (
    !params.needsFullRender &&
    params.storedItemKey === params.newItemKey &&
    params.currentKind === "paper"
  );
}

export function hasPanelContextOwnerChanged(
  params: PanelContextLifecycleDecisionParams,
): boolean {
  if (!isSamePaperConversation(params)) return false;
  return Boolean(
    params.currentContextOwnerItemKey &&
    params.newContextOwnerItemKey &&
    params.currentContextOwnerItemKey !== params.newContextOwnerItemKey,
  );
}

export function shouldRefreshContextSourceWithoutPanelRebuild(
  params: PanelContextLifecycleDecisionParams,
): boolean {
  if (!isSamePaperConversation(params)) return false;
  if (hasPanelContextOwnerChanged(params)) return false;
  return (
    (params.currentRawContextItemKey || "") !== params.rawContextItemKey ||
    (params.currentContextSourceStateKey || "") !==
      params.newContextSourceStateKey
  );
}
