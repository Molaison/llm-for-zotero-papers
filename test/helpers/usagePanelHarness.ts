/**
 * Mounts the shipped Usage panel in a fake preferences window.
 *
 * The panel is imported unchanged — the same module the plugin registers — and
 * only two things around it are replaced: the chrome document (see
 * `fakePreferencesDom.ts`) and, when a test asks for it, the `t()` the copy
 * goes through. Swapping `t` needs the module to be loaded fresh, because an
 * ES module namespace cannot be assigned to, so the loader is intercepted for
 * exactly the i18n module and exactly the length of that one require.
 */

import Module from "node:module";
import path from "node:path";
import {
  createFakePreferencesWindow,
  fakeRect,
  flushAsync,
  type FakePrefElement,
  type FakePreferencesWindow,
} from "./fakePreferencesDom";
import {
  installUsageLedgerZotero,
  type UsageLedgerHarness,
} from "./usageLedgerDb";

const SRC = path.resolve(__dirname, "../../src");
const PANEL_PATH = path.join(SRC, "modules/preferences/usagePanel.ts");
const VIEW_PATH = path.join(SRC, "utils/usageView.ts");
const I18N_PATH = path.join(SRC, "utils/i18n.ts");

const requireModule = Module.createRequire(__filename);

type LoaderInternals = {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  _resolveFilename: (
    request: string,
    parent: unknown,
    isMain: boolean,
  ) => string;
};

export type UsagePanelModule = {
  registerUsagePreferencePanel: (win: unknown) => void;
  planUsageTabActivation: (input: { started: boolean; loading: boolean }) => {
    start: boolean;
    refresh: boolean;
  };
};

/**
 * Require the panel (and the view it builds its copy in) with `t()` replaced.
 *
 * The fresh copies are dropped from the cache again afterwards, so no other
 * test file can pick up a module wired to a fake translator.
 */
export function loadUsagePanelModule(
  translate?: (en: string) => string,
): UsagePanelModule {
  if (!translate) return requireModule(PANEL_PATH) as UsagePanelModule;
  const realI18n = requireModule(I18N_PATH) as Record<string, unknown>;
  const loader = Module as unknown as LoaderInternals;
  const originalLoad = loader._load;
  loader._load = function patched(
    request: string,
    parent: unknown,
    isMain: boolean,
  ) {
    let resolved = "";
    try {
      resolved = loader._resolveFilename(request, parent, isMain);
    } catch {
      resolved = "";
    }
    if (resolved === I18N_PATH) return { ...realI18n, t: translate };
    return originalLoad.call(this, request, parent, isMain);
  };
  delete requireModule.cache[PANEL_PATH];
  delete requireModule.cache[VIEW_PATH];
  try {
    return requireModule(PANEL_PATH) as UsagePanelModule;
  } finally {
    loader._load = originalLoad;
    delete requireModule.cache[PANEL_PATH];
    delete requireModule.cache[VIEW_PATH];
  }
}

/** What the reset dialog was asked to show, so a test can read its copy. */
export type CapturedDialog = {
  title: string;
  message: string;
  buttons: string[];
};

export type MountedUsagePanel = {
  ledger: UsageLedgerHarness;
  window: FakePreferencesWindow;
  root: FakePrefElement;
  panel: UsagePanelModule;
  dialogs: CapturedDialog[];
  /** Click a control inside the panel and let the repaint land. */
  click: (selector: string) => Promise<void>;
  /** Wait until the panel has painted something other than its loading line. */
  settle: () => Promise<void>;
  teardown: () => void;
};

/**
 * Install the ledger, seed it, and open the tab.
 *
 * `seed` runs against a live usage store, so a test writes its fixture with
 * the same `recordUsageEvent` the plugin uses rather than by hand.
 */
export async function mountUsagePanel(options: {
  seed?: (ledger: UsageLedgerHarness) => Promise<void>;
  translate?: (en: string) => string;
  locale?: string;
  dark?: boolean;
  /** Skip the tab click, for a test that drives activation itself. */
  activate?: boolean;
}): Promise<MountedUsagePanel> {
  const ledger = installUsageLedgerZotero();
  const dialogs: CapturedDialog[] = [];
  const previousToolkit = (globalThis as { ztoolkit?: unknown }).ztoolkit;
  (globalThis as { ztoolkit?: unknown }).ztoolkit = {
    log: () => undefined,
    Dialog: class FakeDialog {
      private data: Record<string, unknown> = {};
      private readonly record: CapturedDialog = {
        title: "",
        message: "",
        buttons: [],
      };
      addCell(
        _row: number,
        _column: number,
        cell: { properties?: { textContent?: string } },
      ) {
        this.record.message = cell.properties?.textContent || "";
        return this;
      }
      addButton(label: string, id: string) {
        this.record.buttons.push(label);
        // Nothing is deleted by a test: the confirmation is cancelled.
        this.data._lastButtonId = this.data._lastButtonId || "cancel";
        void id;
        return this;
      }
      setDialogData(data: Record<string, unknown>) {
        this.data = data;
        data.unloadLock = { promise: Promise.resolve() };
        return this;
      }
      open(title: string) {
        this.record.title = title;
        dialogs.push(this.record);
        return this;
      }
      get window() {
        return null;
      }
    },
  };
  const { initUsageStore, resetUsageStoreForTests } = requireModule(
    path.join(SRC, "utils/usageStore.ts"),
  ) as {
    initUsageStore: () => Promise<boolean>;
    resetUsageStoreForTests: () => void;
  };
  resetUsageStoreForTests();
  await initUsageStore();
  if (options.seed) await options.seed(ledger);

  const panel = loadUsagePanelModule(options.translate);
  const window = createFakePreferencesWindow({
    addonRef: "llmforzotero",
    locale: options.locale,
    dark: options.dark,
  });
  panel.registerUsagePreferencePanel(window.win);
  // The pane has a box only once its tab is showing; the panel reads this to
  // decide whether it is already visible.
  window.root.rect = fakeRect(0, 0, 640, 420);

  const settle = async () => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const painted =
        window.root.querySelector("[data-usage-card]") ||
        window.root.querySelector("[data-usage-empty]");
      if (painted) return;
      await flushAsync(2);
    }
    throw new Error(
      `the panel never painted (text: ${window.root.textContent.slice(0, 200)})`,
    );
  };

  if (options.activate !== false) {
    window.tabButton.click();
    await settle();
  }

  return {
    ledger,
    window,
    root: window.root,
    panel,
    dialogs,
    click: async (selector: string) => {
      const target = window.root.querySelector(selector);
      if (!target) throw new Error(`no such control: ${selector}`);
      target.click();
      await flushAsync(4);
    },
    settle,
    teardown: () => {
      resetUsageStoreForTests();
      ledger.close();
      (globalThis as { ztoolkit?: unknown }).ztoolkit = previousToolkit;
    },
  };
}
