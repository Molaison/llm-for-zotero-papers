import { appLogger } from "../../core/logging";
export type ZoteroTabsState = {
  selectedID?: string | number;
  selectedType?: string;
  _tabs?: Array<{ id?: string | number; type?: string; data?: any }>;
};

/**
 * Last selected Zotero tab observed from a stable Tabs snapshot.
 *
 * Zotero can temporarily hide Tabs while a selection transition is in
 * progress. Keeping this small amount of integration state outside the panel
 * lets runtime services restore the user's tab without depending on UI code.
 */
let lastKnownSelectedTabId: string | number | null = null;

export function getLastKnownSelectedTabId(): string | number | null {
  return lastKnownSelectedTabId;
}

export function refreshLastKnownSelectedTabId(): string | number | null {
  const tabs = getZoteroTabsState();
  const selectedTabId = tabs?.selectedID;
  if (selectedTabId === undefined || selectedTabId === null) return null;
  lastKnownSelectedTabId = selectedTabId;
  return selectedTabId;
}

export function getActiveReaderForSelectedTab(): any | null {
  const selectedTabId = refreshLastKnownSelectedTabId();
  if (selectedTabId === null) return null;
  return (
    (
      Zotero as unknown as {
        Reader?: { getByTabID?: (id: string | number) => any };
      }
    ).Reader?.getByTabID?.(selectedTabId) || null
  );
}

export function getAllOpenReaders(): any[] {
  const readers = (
    Zotero as unknown as {
      Reader?: { _readers?: unknown[] };
    }
  ).Reader?._readers;
  return Array.isArray(readers) ? readers.filter(Boolean) : [];
}

function isTabsState(value: unknown): value is ZoteroTabsState {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return (
    "selectedID" in obj || "selectedType" in obj || Array.isArray(obj._tabs)
  );
}

function getZoteroTabsStateWithSource(): {
  tabs: ZoteroTabsState | null;
  source: string;
} {
  const candidates: Array<{ source: string; value: unknown }> = [];
  const push = (source: string, value: unknown) => {
    candidates.push({ source, value });
  };

  push(
    "local.Zotero.Tabs",
    (Zotero as unknown as { Tabs?: ZoteroTabsState }).Tabs,
  );

  let mainWindow: any = null;
  try {
    mainWindow = Zotero.getMainWindow?.() || null;
  } catch (_error) {
    void _error;
  }
  if (mainWindow) {
    push("mainWindow.Zotero.Tabs", mainWindow.Zotero?.Tabs);
    push("mainWindow.Zotero_Tabs", mainWindow.Zotero_Tabs);
    push("mainWindow.Tabs", mainWindow.Tabs);
  }

  let activePaneWindow: any = null;
  try {
    const activePane = Zotero.getActiveZoteroPane?.() as
      | { document?: Document }
      | null
      | undefined;
    activePaneWindow = activePane?.document?.defaultView || null;
  } catch (_error) {
    void _error;
  }
  if (activePaneWindow) {
    push("activePaneWindow.Zotero.Tabs", activePaneWindow.Zotero?.Tabs);
    push("activePaneWindow.Zotero_Tabs", activePaneWindow.Zotero_Tabs);
  }

  let anyMainWindow: any = null;
  try {
    const windows = Zotero.getMainWindows?.() || [];
    anyMainWindow = windows[0] || null;
  } catch (_error) {
    void _error;
  }
  if (anyMainWindow) {
    push("mainWindows[0].Zotero.Tabs", anyMainWindow.Zotero?.Tabs);
    push("mainWindows[0].Zotero_Tabs", anyMainWindow.Zotero_Tabs);
  }

  try {
    const wmRecent = (Services as any).wm?.getMostRecentWindow?.(
      "navigator:browser",
    ) as any;
    push("wm:navigator:browser.Zotero.Tabs", wmRecent?.Zotero?.Tabs);
    push("wm:navigator:browser.Zotero_Tabs", wmRecent?.Zotero_Tabs);
  } catch (_error) {
    void _error;
  }
  try {
    const wmAny = (Services as any).wm?.getMostRecentWindow?.("") as any;
    push("wm:any.Zotero.Tabs", wmAny?.Zotero?.Tabs);
    push("wm:any.Zotero_Tabs", wmAny?.Zotero_Tabs);
  } catch (_error) {
    void _error;
  }

  const globalAny = globalThis as any;
  push("globalThis.Zotero_Tabs", globalAny.Zotero_Tabs);
  push("globalThis.window.Zotero_Tabs", globalAny.window?.Zotero_Tabs);

  for (const candidate of candidates) {
    if (isTabsState(candidate.value)) {
      return { tabs: candidate.value, source: candidate.source };
    }
  }
  return { tabs: null, source: "none" };
}

export function getZoteroTabsState(): ZoteroTabsState | null {
  return getZoteroTabsStateWithSource().tabs;
}

export function selectZoteroTab(tabId: string | number): boolean {
  const { tabs, source } = getZoteroTabsStateWithSource();
  if (!tabs) return false;
  const tabsAny = tabs as unknown as {
    select?: (id: string | number) => void;
  };
  if (typeof tabsAny.select === "function") {
    try {
      tabsAny.select(tabId);
      appLogger.debug(
        `[LLM] selectZoteroTab: selected "${tabId}" via ${source}`,
      );
      return true;
    } catch (err) {
      appLogger.warn(
        `[LLM] selectZoteroTab: error selecting "${tabId}" via ${source} — ${err}`,
      );
    }
  }
  return false;
}
