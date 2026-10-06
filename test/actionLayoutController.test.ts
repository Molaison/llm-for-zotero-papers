import { assert } from "chai";
import { createActionLayoutController } from "../src/modules/contextPanel/setupHandlers/controllers/actionLayoutController";

function layoutFixture(initialWidth: number, connected = true) {
  let width = initialWidth;
  let geometryReads = 0;
  let styleReads = 0;
  const pendingFrames: FrameRequestCallback[] = [];
  function element(label = "") {
    const classes = new Set<string>();
    return {
      isConnected: connected,
      dataset: {} as Record<string, string>,
      textContent: label,
      title: "",
      parentElement: null,
      scrollWidth: 20,
      get clientWidth() {
        geometryReads++;
        return width;
      },
      getBoundingClientRect: () => ({ width }),
      classList: {
        toggle(name: string, enabled: boolean) {
          if (enabled) classes.add(name);
          else classes.delete(name);
        },
        contains: (name: string) => classes.has(name),
      },
    };
  }
  const body = {
    isConnected: connected,
    getBoundingClientRect: () => ({ width }),
    ownerDocument: {
      createElement: () => ({ getContext: () => null }),
      defaultView: {
        requestAnimationFrame(callback: FrameRequestCallback) {
          pendingFrames.push(callback);
          return pendingFrames.length;
        },
        getComputedStyle() {
          styleReads++;
          return { getPropertyValue: () => "0" };
        },
      },
    },
  };
  const panelRoot = element();
  const modelBtn = element();
  modelBtn.dataset.modelLabel = "Example model";
  const reasoningBtn = element();
  reasoningBtn.dataset.reasoningLabel = "High";
  const sendBtn = element("Send");
  const cancelBtn = element("Cancel");
  const controller = createActionLayoutController({
    body,
    panelRoot,
    actionsRow: element(),
    actionsLeft: element(),
    modelBtn,
    modelSlot: null,
    reasoningBtn,
    reasoningSlot: null,
    uploadBtn: null,
    selectTextBtn: null,
    screenshotBtn: null,
    sendBtn,
    cancelBtn,
  } as unknown as Parameters<typeof createActionLayoutController>[0]);
  return {
    controller,
    panelRoot,
    modelBtn,
    reasoningBtn,
    sendBtn,
    cancelBtn,
    pendingFrames,
    setWidth: (nextWidth: number) => (width = nextWidth),
    get geometryReads() {
      return geometryReads;
    },
    get styleReads() {
      return styleReads;
    },
    advanceFrames(count: number) {
      for (let frame = 0; frame < count; frame++) {
        const callbacks = pendingFrames.splice(0);
        for (const callback of callbacks) callback(frame * 16);
      }
    },
  };
}

describe("action layout lifetime", function () {
  it("leaves a zero-width panel idle until a real layout request", function () {
    const fixture = layoutFixture(0);
    fixture.controller.applyResponsiveActionButtonsLayout();
    const readsAfterRequest = fixture.geometryReads;
    fixture.advanceFrames(120);
    assert.equal(fixture.geometryReads, readsAfterRequest);
    assert.lengthOf(fixture.pendingFrames, 0);
    assert.equal(fixture.styleReads, 0);
  });

  for (const width of [0, 600]) {
    it(`does no layout on a disconnected panel with cached width ${width}`, function () {
      const fixture = layoutFixture(width, false);
      fixture.controller.applyResponsiveActionButtonsLayout();
      fixture.advanceFrames(120);
      assert.equal(fixture.geometryReads, 0);
      assert.equal(fixture.styleReads, 0);
      assert.lengthOf(fixture.pendingFrames, 0);
    });
  }

  it("restores labels on reveal and responds to later width and model changes", function () {
    const fixture = layoutFixture(0);
    const layout = fixture.controller.applyResponsiveActionButtonsLayout;
    layout();
    fixture.setWidth(600);
    layout();
    assert.equal(fixture.modelBtn.textContent, "Example model");
    assert.equal(fixture.reasoningBtn.textContent, "High");
    assert.equal(fixture.sendBtn.textContent, "");
    assert.equal(fixture.cancelBtn.textContent, "");
    assert.equal(fixture.sendBtn.title, "Send");
    assert.equal(fixture.cancelBtn.title, "Cancel");
    assert.equal(fixture.panelRoot.dataset.llmActionLayoutMode, "full");

    fixture.setWidth(40);
    layout();
    assert.equal(fixture.modelBtn.textContent, "");
    assert.equal(fixture.sendBtn.textContent, "");
    assert.equal(fixture.cancelBtn.textContent, "");

    fixture.setWidth(0);
    layout();
    fixture.modelBtn.dataset.modelLabel = "New model";
    fixture.setWidth(600);
    layout();
    assert.equal(fixture.modelBtn.textContent, "New model");
    assert.equal(fixture.panelRoot.dataset.llmActionLayoutMode, "full");
    assert.lengthOf(fixture.pendingFrames, 0);
  });
});
