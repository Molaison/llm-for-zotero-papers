import { assert } from "chai";
import { installLibraryPaperDrop } from "../src/modules/contextPanel/libraryPaperDrop";
import {
  clearContextSurfaceActionTargetsForTests,
  registerContextSurfaceActionTarget,
} from "../src/modules/contextPanel/zoteroItemContextMenu";

function harness() {
  const listeners = new Map<string, EventListener>();
  let library = true;
  let rendered = 0;
  let releaseRender: (() => void) | undefined;
  const received: number[][] = [];
  const active = new Set<string>();
  const body = { isConnected: true } as Element;
  const section = {
    isConnected: true,
    contains: (node: unknown) => node === body,
    querySelectorAll: () => [
      {
        classList: {
          toggle: (_name: string, value: boolean) =>
            value ? active.add("drop") : active.delete("drop"),
        },
      },
    ],
    _forceRenderAll: () => {
      rendered++;
      return new Promise<void>((resolve) => {
        releaseRender = resolve;
      });
    },
  } as unknown as Element & { _forceRenderAll: () => Promise<void> };
  const pane = {
    addEventListener: (name: string, listener: EventListener) =>
      listeners.set(name, listener),
    removeEventListener: (name: string) => listeners.delete(name),
  } as unknown as Element;
  registerContextSurfaceActionTarget(body, {
    surfaceKind: "embedded",
    prepareItemsAsDefaultContextTarget: async () => true,
    addItemsAsDefaultContext: async (items) => {
      received.push(items.map((item) => item.id));
      return { changed: true };
    },
  });
  const dispose = installLibraryPaperDrop(pane, {
    getSection: () => section,
    isLibraryTab: () => library,
  });
  return {
    received,
    active,
    dispose,
    rendered: () => rendered,
    listeners,
    leaveLibrary: () => {
      library = false;
    },
    finishRender: async () => {
      releaseRender?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    fire(type: string, data = "1,2", inside = true, types = ["zotero/item"]) {
      let stopped = false;
      const event = {
        target: { closest: () => (inside ? section : null) },
        dataTransfer: { types, getData: () => data, dropEffect: "none" },
        preventDefault() {},
        stopPropagation() {},
        stopImmediatePropagation() {
          stopped = true;
        },
      } as unknown as Event;
      listeners.get(type)?.(event);
      return stopped;
    },
  };
}

describe("library sidebar paper drop", function () {
  const globals = globalThis as any;
  let originalZotero: any;
  beforeEach(function () {
    originalZotero = globals.Zotero;
    const items = [1, 2].map((id) => ({ id, isRegularItem: () => true }));
    globals.Zotero = {
      Items: { get: (id: number) => items.find((item) => item.id === id) },
    };
  });
  afterEach(function () {
    clearContextSurfaceActionTargetsForTests();
    globals.Zotero = originalZotero;
  });

  it("clears drag feedback and renders once before accepting a multi-paper drop", async function () {
    const h = harness();
    h.fire("dragenter");
    assert.isTrue(h.active.has("drop"));
    assert.isTrue(h.fire("drop"));
    assert.isFalse(h.active.has("drop"));
    h.fire("drop");
    assert.equal(
      h.rendered(),
      1,
      "a pending drop cannot create a duplicate chat",
    );
    assert.isEmpty(h.received);
    await h.finishRender();
    assert.deepEqual(h.received, [[1, 2]]);
    h.dispose();
    assert.equal(h.listeners.size, 0);
  });

  it("preserves single-item and file handling and ignores drops outside the chat", function () {
    const h = harness();
    for (const data of ["1", "1,1", "invalid", "999,1"])
      assert.isFalse(h.fire("drop", data));
    assert.isFalse(h.fire("drop", "1,2", false));
    assert.isFalse(h.fire("drop", "1,2", true, ["Files"]));
    assert.equal(h.rendered(), 0);
    h.dispose();
  });

  it("abandons a drop when its library tab is left or its window is disposed", async function () {
    for (const dispose of [false, true]) {
      const h = harness();
      h.fire("drop");
      if (dispose) h.dispose();
      else h.leaveLibrary();
      await h.finishRender();
      assert.isEmpty(h.received);
      h.dispose();
    }
  });
});
