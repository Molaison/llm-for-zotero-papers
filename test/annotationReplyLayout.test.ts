import { assert } from "chai";
import { readFileSync } from "node:fs";
import { installAnnotationReplyLayout } from "../src/modules/contextPanel/setupHandlers/controllers/annotationReplyController";

function harness() {
  const props = new Map<string, string>();
  const attrs = new Map<string, string>();
  let resize: () => void = () => {};
  let frame: (() => void) | undefined;
  let observed = 0;
  const panel = {
    style: { setProperty: (k: string, v: string) => props.set(k, v), removeProperty: (k: string) => props.delete(k) },
    setAttribute: (k: string, v: string) => attrs.set(k, v),
    removeAttribute: (k: string) => attrs.delete(k),
    getBoundingClientRect: () => ({ top: 143.8 }),
  };
  const viewport = Object.assign(new EventTarget(), {
    getBoundingClientRect: () => ({ top: 113.8, bottom: 1151.2 }),
  });
  const win = Object.assign(new EventTarget(), {
    innerHeight: 1151,
    ResizeObserver: class {
      constructor(callback: () => void) { resize = callback; }
      observe() { observed++; }
      disconnect() { observed = 0; }
    },
    requestAnimationFrame: (callback: () => void) => { frame = callback; return 1; },
    cancelAnimationFrame: () => { frame = undefined; },
  });
  const root = Object.assign(new EventTarget(), {
    open: false, isConnected: true,
    ownerDocument: { defaultView: win },
    closest: (selector: string) => selector === ".llm-panel" ? panel : viewport,
  });
  const dispose = installAnnotationReplyLayout(root as unknown as HTMLDetailsElement);
  const toggle = (open: boolean) => { root.open = open; root.dispatchEvent(new Event("toggle")); };
  return { props, attrs, root, win, toggle, dispose, observed: () => observed,
    resize: () => resize(), flush: () => { const cb = frame; frame = undefined; cb?.(); } };
}

describe("single reading workspace native viewport contract", () => {
  it("uses the measured native viewport, not auto-height main or the 360px preview cap", () => {
    const h = harness();
    h.toggle(true);
    assert.equal(h.props.get("--llm-workspace-height"), "999px");
    assert.equal(h.attrs.get("data-reading-workspace"), "true");
    assert.equal(h.observed(), 2);
    h.win.innerHeight = 900;
    h.win.dispatchEvent(new Event("resize")); h.flush();
    assert.equal(h.props.get("--llm-workspace-height"), "748px");
    h.win.innerHeight = 1400;
    h.resize(); h.flush();
    assert.equal(h.props.get("--llm-workspace-height"), "999px");
    h.dispose();
  });

  it("keeps the viewport budget when returning to reading and cancels it on disposal", () => {
    const h = harness();
    h.toggle(true); h.resize(); h.toggle(false); h.flush();
    assert.equal(h.props.get("--llm-workspace-height"), "999px");
    assert.equal(h.observed(), 2);
    h.toggle(true); h.resize(); h.dispose(); h.flush();
    h.toggle(true);
    assert.equal(h.props.size, 0); assert.equal(h.attrs.size, 0);
    assert.equal(h.observed(), 0);
  });
  it("overrides native fixed button height only inside the content-sized research drawer", () => {
    const css = readFileSync("addon/content/zoteroPane.css", "utf8");
    const rule = /\.llm-annotation-drawer button\s*\{([^}]+)\}/.exec(css)?.[1];
    assert.isString(rule);
    assert.match(rule!, /height:\s*auto\s*;/);
    assert.match(rule!, /box-sizing:\s*border-box\s*;/);
    assert.notMatch(rule!, /!important/);
  });

});
