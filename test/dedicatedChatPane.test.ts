import { assert } from "chai";
import { readFileSync } from "node:fs";
import { installDedicatedChatPane } from "../src/modules/contextPanel/dedicatedChatPane";

function harness() {
  const attributes = new Map<string, string>();
  const listeners = new Map<string, EventListener>();
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  let refreshCount = 0;
  let notify: ((event: string) => void) | undefined;
  let subscribed = false;
  const root = {
    getAttribute: (key: string) => attributes.get(key),
    setAttribute: (key: string, value: string) => attributes.set(key, value),
    removeAttribute: (key: string) => attributes.delete(key),
  };
  const doc = {
    querySelectorAll: () => [],
    defaultView: {
      Zotero_Tabs: { selectedID: "zotero-pane" },
      setTimeout(callback: () => void) {
        timers.set(++nextTimer, callback);
        return nextTimer;
      },
      clearTimeout: (id: number) => timers.delete(id),
    },
    getElementById: () => null,
    querySelector: () => ({
      querySelector: () => ({
        _forceRenderAll: async () => {
          refreshCount++;
        },
      }),
    }),
    documentElement: root,
    addEventListener: (name: string, listener: EventListener) =>
      listeners.set(name, listener),
    removeEventListener: (name: string) => listeners.delete(name),
  } as unknown as Document;
  const dispose = installDedicatedChatPane(doc, {
    registerObserver(observer) {
      notify = observer.notify;
      subscribed = true;
      return "test";
    },
    unregisterObserver() {
      subscribed = false;
    },
  });
  const nav = {
    _collapsed: true,
    container: {
      getPane: (id: string) => ({
        classList: { contains: () => id === "plugin-namespaced-chat" },
      }),
    },
  };
  return {
    nav,
    attributes,
    listeners,
    dispose,
    notify: (event: string) => notify?.(event),
    refreshCount: () => refreshCount,
    subscribed: () => subscribed,
    pendingTimers: () => timers.size,
    flush() {
      const pending = [...timers.values()];
      timers.clear();
      for (const callback of pending) callback();
    },
    click(
      pane: string,
      options: { button?: number; nav?: boolean; disabled?: boolean } = {},
    ) {
      const target = {
        getAttribute: () => pane,
        hasAttribute: (name: string) =>
          name === "disabled" && Boolean(options.disabled),
        closest: (selector: string) =>
          selector === "item-pane-sidenav"
            ? options.nav === false
              ? null
              : nav
            : selector === "#llm-dedicated-chat-close"
              ? null
              : target,
      };
      let stopped = false;
      listeners.get("click")?.({
        target,
        button: options.button || 0,
        preventDefault() {},
        stopImmediatePropagation() {
          stopped = true;
        },
      } as unknown as Event);
      // Native navigation expands the pane unless capture intercepted the click.
      if (!stopped && options.nav !== false && !options.button)
        nav._collapsed = false;
    },
    /** Click the chat header's × inside a native item-details host. */
    closeChat() {
      const host = { sidenav: nav };
      const button = {
        closest: (selector: string) =>
          selector === "item-details" ? host : button,
      };
      let stopped = false;
      listeners.get("click")?.({
        target: {
          closest: (selector: string) =>
            selector === "#llm-dedicated-chat-close" ? button : null,
        },
        button: 0,
        preventDefault() {},
        stopImmediatePropagation() {
          stopped = true;
        },
      } as unknown as Event);
      return stopped;
    },
  };
}

describe("dedicated chat pane navigation", function () {
  const globals = globalThis as any;
  let originalZotero: any;

  beforeEach(function () {
    originalZotero = globals.Zotero;
    globals.Zotero = { Prefs: { get: () => "independent" } };
  });

  afterEach(function () {
    globals.Zotero = originalZotero;
  });

  it("starts with stacked native navigation without a saved preference", function () {
    globals.Zotero.Prefs.get = () => undefined;
    const h = harness();
    assert.equal(h.attributes.get("data-llm-sidebar-layout"), "stacked");
    assert.equal(h.attributes.get("data-llm-pane-view"), "stacked");
    h.click("plugin-namespaced-chat");
    assert.equal(h.attributes.get("data-llm-pane-view"), "stacked");
    assert.isFalse(h.nav._collapsed);
    h.dispose();
  });

  it("toggles chat open, closed, and open again through its icon", function () {
    const h = harness();
    assert.equal(h.attributes.get("data-llm-pane-view"), "details");
    h.click("plugin-namespaced-chat");
    assert.equal(h.attributes.get("data-llm-pane-view"), "chat");
    assert.isFalse(h.nav._collapsed);
    h.click("plugin-namespaced-chat");
    assert.isTrue(h.nav._collapsed);
    h.click("plugin-namespaced-chat");
    assert.isFalse(h.nav._collapsed);
    assert.equal(h.attributes.get("data-llm-pane-view"), "chat");
  });

  it("leaves the pane closed when a disabled rail tab is activated", function () {
    const h = harness();
    h.click("plugin-namespaced-chat", { disabled: true });
    assert.equal(h.attributes.get("data-llm-pane-view"), "details");
    assert.isTrue(h.nav._collapsed);
    assert.equal(h.pendingTimers(), 0);
  });

  it("reopens chat after the native pane toggle collapsed it", function () {
    const h = harness();
    h.click("plugin-namespaced-chat");
    h.nav._collapsed = true;
    h.click("plugin-namespaced-chat");
    assert.isFalse(h.nav._collapsed);
    assert.equal(h.attributes.get("data-llm-pane-view"), "chat");
  });

  it("preserves native navigation in the stacked layout", function () {
    const h = harness();
    h.attributes.set("data-llm-sidebar-layout", "stacked");
    h.attributes.set("data-llm-pane-view", "stacked");
    h.click("plugin-namespaced-chat");
    h.click("plugin-namespaced-chat");
    assert.isFalse(h.nav._collapsed);
    assert.equal(h.attributes.get("data-llm-pane-view"), "stacked");
  });

  it("returns to details or reader notes through their native icons", function () {
    const h = harness();
    for (const pane of ["info", "abstract", "context-notes"]) {
      h.click("plugin-namespaced-chat");
      h.click(pane);
      assert.equal(h.attributes.get("data-llm-pane-view"), "details");
    }
  });

  it("ignores context clicks and similarly marked content outside navigation", function () {
    const h = harness();
    h.click("plugin-namespaced-chat", { button: 2 });
    h.click("plugin-namespaced-chat", { nav: false });
    assert.equal(h.attributes.get("data-llm-pane-view"), "details");
  });

  it("removes presentation and listeners when the window closes", function () {
    const h = harness();
    h.click("plugin-namespaced-chat");
    h.dispose();
    h.dispose();
    assert.isFalse(h.attributes.has("data-llm-pane-view"));
    assert.equal(h.listeners.size, 0);
    assert.isFalse(h.subscribed());
    assert.equal(h.pendingTimers(), 0);
  });

  it("rechecks the native conversation on tab selection only while chat is active", function () {
    const h = harness();
    h.notify("select");
    h.flush();
    assert.equal(h.refreshCount(), 0);
    h.click("plugin-namespaced-chat");
    h.flush();
    assert.equal(h.refreshCount(), 1);
    h.notify("select");
    h.notify("select");
    assert.equal(h.refreshCount(), 1, "wait for native deck selection");
    h.flush();
    assert.equal(h.refreshCount(), 2, "coalesce rapid tab changes");
    h.click("info");
    h.notify("select");
    h.flush();
    assert.equal(h.refreshCount(), 2);
  });

  it("closes the Independent chat from its header × exactly like the rail icon", function () {
    const h = harness();
    h.click("plugin-namespaced-chat");
    assert.equal(h.attributes.get("data-llm-pane-view"), "chat");
    assert.isFalse(h.nav._collapsed);
    assert.isTrue(h.closeChat(), "the click is handled");
    assert.equal(h.attributes.get("data-llm-pane-view"), "details");
    assert.isTrue(h.nav._collapsed, "the native pane collapses");
    h.click("plugin-namespaced-chat");
    assert.equal(h.attributes.get("data-llm-pane-view"), "chat");
    assert.isFalse(h.nav._collapsed, "the rail icon reopens it");
    h.dispose();
  });

  it("leaves the stacked layout alone when a header × is clicked", function () {
    const h = harness();
    h.attributes.set("data-llm-sidebar-layout", "stacked");
    h.attributes.set("data-llm-pane-view", "stacked");
    h.nav._collapsed = false;
    assert.isFalse(h.closeChat());
    assert.equal(h.attributes.get("data-llm-pane-view"), "stacked");
    assert.isFalse(h.nav._collapsed);
    h.dispose();
  });

  it("builds the × only for native chat sections, shown only in Independent", function () {
    const buildUi = readFileSync("src/modules/contextPanel/buildUI.ts", "utf8");
    assert.match(
      buildUi,
      /if \(body\.closest\("\.llm-dedicated-chat-pane"\)\) \{[\s\S]*?"llm-btn-icon llm-dedicated-chat-close"[\s\S]*?title: t\("Close chat"\)[\s\S]*?setAttribute\("aria-label", t\("Close chat"\)\)[\s\S]*?toggleRow\.append\(closeBtn\)/,
    );
    const css = readFileSync("addon/content/zoteroPane.css", "utf8");
    assert.match(
      css,
      /:root\[data-llm-sidebar-layout="independent"\]\s+\.llm-dedicated-chat-pane\s+\.llm-header-toggle-row \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) auto minmax\(0, 1fr\);/,
      "symmetric side tracks keep the toggle centered",
    );
    assert.match(
      css,
      /:root:not\(\[data-llm-sidebar-layout="independent"\]\)\s+\.llm-dedicated-chat-pane\s+\.llm-dedicated-chat-close \{\s*display: none;/,
      "hidden outside Independent",
    );
    assert.match(
      css,
      /\.llm-dedicated-chat-pane \.llm-dedicated-chat-close \{[\s\S]*?width: 28px;[\s\S]*?height: 28px;/,
    );
    assert.include(css, 'mask-image: url("icons/action-close.svg")');
  });
});
