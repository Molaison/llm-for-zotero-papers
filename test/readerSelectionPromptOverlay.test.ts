import { assert } from "chai";
import { afterEach, describe, it } from "mocha";
import {
  closeAllReaderSelectionPromptOverlays,
  closeReaderSelectionPromptOverlay,
  countOpenReaderSelectionPromptOverlays,
  openReaderSelectionPromptForChip,
  openReaderSelectionPromptOverlay,
} from "../src/modules/contextPanel/selectionPrompt/readerSelectionPromptOverlay";

type Listener = (e: any) => void;
function makeFakeDoc(
  viewport = { innerWidth: 800, innerHeight: 600 },
  options: { deferTimers?: boolean } = {},
) {
  const listeners = new Map<string, Listener[]>();
  const timers: Array<() => void> = [];
  const makeEl = (tag: string) => {
    const el: any = {
      tagName: tag.toUpperCase(),
      style: (() => {
        // Parses cssText so assertions on .position/.left/.top work.
        const st: any = {};
        Object.defineProperty(st, "cssText", {
          set(v: string) {
            for (const pair of v.split(";")) {
              const i = pair.indexOf(":");
              if (i > 0)
                st[
                  pair
                    .slice(0, i)
                    .trim()
                    .replace(/-([a-z])/g, (_m, c) => c.toUpperCase())
                ] = pair.slice(i + 1).trim();
            }
          },
        });
        return st;
      })(),
      children: [] as any[],
      parentNode: null as any,
      attributes: {} as Record<string, string>,
      value: "",
      focused: false,
      _listeners: new Map<string, Listener[]>(),
      isConnected: false,
      setAttribute(k: string, v: string) {
        this.attributes[k] = v;
      },
      getAttribute(k: string) {
        return k in this.attributes ? this.attributes[k] : null;
      },
      append(...nodes: any[]) {
        for (const n of nodes) {
          n.parentNode = this;
          n.isConnected = true;
          this.children.push(n);
        }
      },
      appendChild(n: any) {
        this.append(n);
        return n;
      },
      remove() {
        if (this.parentNode) {
          this.parentNode.children = this.parentNode.children.filter(
            (c: any) => c !== this,
          );
          this.parentNode = null;
          this.isConnected = false;
        }
      },
      contains(n: any): boolean {
        if (n === this) return true;
        return this.children.some((c: any) => c.contains(n));
      },
      addEventListener(t: string, fn: Listener) {
        const a = this._listeners.get(t) || [];
        a.push(fn);
        this._listeners.set(t, a);
      },
      removeEventListener(t: string, fn: Listener) {
        this._listeners.set(
          t,
          (this._listeners.get(t) || []).filter((f: Listener) => f !== fn),
        );
      },
      listenerCount(t: string) {
        return (this._listeners.get(t) || []).length;
      },
      dispatch(t: string, e: any = {}) {
        const ev = {
          type: t,
          target: this,
          defaultPrevented: false,
          propagationStopped: false,
          preventDefault() {
            this.defaultPrevented = true;
          },
          stopPropagation() {
            this.propagationStopped = true;
          },
          ...e,
        };
        // Bubbles up the parent chain like a DOM event.
        for (let node: any = this; node; node = node.parentNode) {
          for (const fn of [...(node._listeners.get(t) || [])]) fn(ev);
          if (ev.propagationStopped) break;
        }
        return ev;
      },
      focus() {
        this.focused = true;
      },
      getBoundingClientRect() {
        return {
          width: 320,
          height: 80,
          left: 0,
          top: 0,
          right: 320,
          bottom: 80,
        };
      },
      // Supports `tag`, `[attr]`, and `[attr="value"]`.
      querySelector(sel: string) {
        const attr = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(sel);
        const matches = (n: any) =>
          attr
            ? attr[2] === undefined
              ? attr[1] in n.attributes
              : n.attributes[attr[1]] === attr[2]
            : n.tagName === sel.toUpperCase();
        const walk = (n: any): any => {
          if (matches(n)) return n;
          for (const c of n.children) {
            const r = walk(c);
            if (r) return r;
          }
          return null;
        };
        return walk(this);
      },
    };
    el.textContent = "";
    return el;
  };
  const body = makeEl("body");
  const doc: any = {
    execCommands: [] as unknown[][],
    execCommand(...args: unknown[]) {
      this.execCommands.push(args);
      return true;
    },
    body,
    documentElement: makeEl("html"),
    defaultView: {
      innerWidth: viewport.innerWidth,
      innerHeight: viewport.innerHeight,
      setTimeout(this: unknown, fn: () => void) {
        // Gecko chrome throws on an unbound window.setTimeout call.
        if (this !== doc.defaultView) throw new Error("unbound setTimeout");
        if (options.deferTimers) timers.push(fn);
        else fn();
        return 0;
      },
      clearTimeout: () => {},
    },
    createElementNS: (_ns: string, tag: string) => makeEl(tag),
    addEventListener(t: string, fn: Listener) {
      const a = listeners.get(t) || [];
      a.push(fn);
      listeners.set(t, a);
    },
    removeEventListener(t: string, fn: Listener) {
      listeners.set(
        t,
        (listeners.get(t) || []).filter((f) => f !== fn),
      );
    },
    dispatch(t: string, e: any) {
      for (const fn of [...(listeners.get(t) || [])])
        fn({ type: t, preventDefault() {}, stopPropagation() {}, ...e });
    },
    listenerCount: (t: string) => (listeners.get(t) || []).length,
    iframes: [] as any[],
    querySelectorAll(sel: string) {
      return sel === "iframe" ? this.iframes : [];
    },
    runTimers: () => {
      while (timers.length) timers.shift()!();
    },
  };
  return doc;
}
const labels = {
  placeholder: "Ask…",
  hint: "Enter to add",
  submit: "Add",
  selectedTextLabel: "Selected text",
};
const selectedText = "The quoted passage.";
const editorOf = (doc: any) =>
  doc.body.querySelector('[data-llm-reader-selection-prompt-editor="true"]');
const anchor = { left: 100, top: 200, right: 180, bottom: 230 };

describe("openReaderSelectionPromptOverlay", function () {
  // The overlay registry is module-wide; do not leak overlays across tests.
  afterEach(() => closeAllReaderSelectionPromptOverlays());

  it("mounts a fixed overlay below the anchor and focuses the editor", function () {
    const doc = makeFakeDoc();
    const h = openReaderSelectionPromptOverlay({
      doc,
      anchor,
      labels,
      selectedText,
      onSubmit: () => {},
      onClose: () => {},
    });
    assert.strictEqual(h.root.parentNode, doc.body);
    assert.equal(h.root.style.position, "fixed");
    assert.equal(h.root.style.left, "100px");
    assert.equal(h.root.style.top, "236px"); // bottom + 6
    assert.equal(
      (h.root as any).attributes["data-llm-reader-selection-prompt"],
      "true",
    );
    const ta = editorOf(doc);
    assert.isTrue(ta.focused);
    // Zotero's reader KeyboardManager treats only <input type=text> and
    // contenteditable="true" as text boxes; a <textarea> gets its shortcuts.
    assert.equal(ta.attributes.contenteditable, "true");
    assert.equal(ta.attributes.role, "textbox");
    assert.equal(ta.attributes["aria-multiline"], "true");
    assert.equal(ta.attributes["aria-placeholder"], "Ask…");
    const placeholder = doc.body.querySelector(
      '[data-llm-reader-selection-prompt-placeholder="true"]',
    );
    assert.equal(placeholder.textContent, "Ask…");
    assert.notEqual(placeholder.style.display, "none");
  });

  it("renders the hint as a small footnote in the label color", function () {
    const doc = makeFakeDoc();
    const h = openReaderSelectionPromptOverlay({
      doc,
      anchor,
      labels,
      selectedText,
      onSubmit: () => {},
      onClose: () => {},
    });
    const hint = (h.root as any).children[(h.root as any).children.length - 1];
    assert.equal(hint.textContent, "Enter to add");
    assert.equal(hint.style.fontSize, "10px");
    assert.equal(hint.style.lineHeight, "1.25");
    // Light theme label color, the same as the "Selected text" label.
    assert.equal(hint.style.color, "#7a7a7a");
    assert.isUndefined(hint.style.opacity);
  });

  it("hides the placeholder while the editor has text", function () {
    const doc = makeFakeDoc();
    openReaderSelectionPromptOverlay({
      doc,
      anchor,
      labels,
      selectedText,
      onSubmit: () => {},
      onClose: () => {},
    });
    const ta = editorOf(doc);
    const placeholder = doc.body.querySelector(
      '[data-llm-reader-selection-prompt-placeholder="true"]',
    );
    ta.textContent = "x";
    ta.dispatch("input");
    assert.equal(placeholder.style.display, "none");
    ta.textContent = "";
    ta.dispatch("input");
    assert.notEqual(placeholder.style.display, "none");
  });

  it("pastes clipboard content as plain text", function () {
    const doc = makeFakeDoc();
    openReaderSelectionPromptOverlay({
      doc,
      anchor,
      labels,
      selectedText,
      onSubmit: () => {},
      onClose: () => {},
    });
    const ev = editorOf(doc).dispatch("paste", {
      clipboardData: {
        getData: (type: string) => (type === "text/plain" ? "plain" : ""),
      },
    });
    assert.isTrue(ev.defaultPrevented);
    assert.deepEqual(doc.execCommands, [["insertText", false, "plain"]]);
  });

  it("appends pasted text when the document refuses insertText", function () {
    const doc = makeFakeDoc();
    doc.execCommand = () => false;
    openReaderSelectionPromptOverlay({
      doc,
      anchor,
      labels,
      selectedText,
      onSubmit: () => {},
      onClose: () => {},
    });
    const ta = editorOf(doc);
    ta.textContent = "a ";
    ta.dispatch("paste", {
      clipboardData: { getData: () => "b" },
    });
    assert.equal(ta.textContent, "a b");
  });

  it("flips above the anchor when there is no room below and clamps to the right edge", function () {
    const doc = makeFakeDoc({ innerWidth: 400, innerHeight: 300 });
    const h = openReaderSelectionPromptOverlay({
      doc,
      anchor: { left: 300, top: 260, right: 380, bottom: 290 },
      labels,
      selectedText,
      onSubmit: () => {},
      onClose: () => {},
    });
    assert.equal(h.root.style.top, `${260 - 6 - 80}px`);
    assert.equal(h.root.style.left, `${400 - 8 - 320}px`);
  });

  it("Enter submits trimmed text then closes once", function () {
    const doc = makeFakeDoc();
    const submitted: string[] = [];
    let closed = 0;
    const h = openReaderSelectionPromptOverlay({
      doc,
      anchor,
      labels,
      selectedText,
      onSubmit: (t) => submitted.push(t),
      onClose: () => {
        closed++;
      },
    });
    const ta = editorOf(doc);
    ta.textContent = "  why?  ";
    const ev = ta.dispatch("keydown", {
      key: "Enter",
      shiftKey: false,
      isComposing: false,
      keyCode: 13,
    });
    assert.deepEqual(submitted, ["why?"]);
    assert.isTrue(ev.defaultPrevented);
    assert.isTrue(ev.propagationStopped);
    assert.isFalse(h.root.isConnected);
    assert.equal(closed, 1);
    h.close();
    assert.equal(closed, 1);
  });

  it("a true onSubmit result closes and a false one keeps the box open", function () {
    for (const [accept, connected] of [
      [true, false],
      [false, true],
    ] as const) {
      const doc = makeFakeDoc();
      let closed = 0;
      const h = openReaderSelectionPromptOverlay({
        doc,
        anchor,
        labels,
        selectedText,
        onSubmit: () => accept,
        onClose: () => {
          closed++;
        },
      });
      const ta = editorOf(doc);
      ta.textContent = "hi";
      ta.dispatch("keydown", {
        key: "Enter",
        shiftKey: false,
        isComposing: false,
        keyCode: 13,
      });
      assert.equal(h.root.isConnected, connected);
      assert.equal(closed, accept ? 1 : 0);
    }
  });

  it("close finishes the registry cleanup and onClose when a nested document throws", function () {
    closeAllReaderSelectionPromptOverlays();
    const doc = makeFakeDoc();
    const viewDoc = makeFakeDoc();
    viewDoc.removeEventListener = () => {
      throw new Error("can't access dead object");
    };
    doc.iframes.push({ contentDocument: viewDoc });
    let closed = 0;
    const h = openReaderSelectionPromptOverlay({
      doc,
      anchor,
      labels,
      selectedText,
      onSubmit: () => true,
      onClose: () => {
        closed++;
      },
    });
    assert.equal(countOpenReaderSelectionPromptOverlays(), 1);
    h.close();
    assert.isFalse(h.root.isConnected);
    assert.equal(countOpenReaderSelectionPromptOverlays(), 0);
    assert.equal(closed, 1);
  });

  it("empty Enter and Escape close without submitting", function () {
    for (const key of ["Enter", "Escape"]) {
      const doc = makeFakeDoc();
      const submitted: string[] = [];
      let closed = 0;
      openReaderSelectionPromptOverlay({
        doc,
        anchor,
        labels,
        selectedText,
        onSubmit: (t) => submitted.push(t),
        onClose: () => {
          closed++;
        },
      });
      editorOf(doc).dispatch("keydown", {
        key,
        shiftKey: false,
        isComposing: false,
        keyCode: 0,
      });
      assert.deepEqual(submitted, []);
      assert.equal(closed, 1);
    }
  });

  it("Shift+Enter and IME Enter neither submit nor close but stop propagation", function () {
    const doc = makeFakeDoc();
    let closed = 0;
    openReaderSelectionPromptOverlay({
      doc,
      anchor,
      labels,
      selectedText,
      onSubmit: () => assert.fail("no submit"),
      onClose: () => {
        closed++;
      },
    });
    const ta = editorOf(doc);
    const a = ta.dispatch("keydown", {
      key: "Enter",
      shiftKey: true,
      isComposing: false,
      keyCode: 13,
    });
    const b = ta.dispatch("keydown", {
      key: "Enter",
      shiftKey: false,
      isComposing: true,
      keyCode: 229,
    });
    assert.isFalse(a.defaultPrevented);
    assert.isTrue(a.propagationStopped);
    assert.isFalse(b.defaultPrevented);
    assert.isTrue(b.propagationStopped);
    assert.equal(closed, 0);
  });

  it("keeps ordinary typing keys from bubbling past the box", function () {
    const doc = makeFakeDoc();
    let closed = 0;
    openReaderSelectionPromptOverlay({
      doc,
      anchor,
      labels,
      selectedText,
      onSubmit: () => assert.fail("no submit"),
      onClose: () => {
        closed++;
      },
    });
    const ta = editorOf(doc);
    for (const type of ["keydown", "keyup", "keypress"]) {
      const ev = ta.dispatch(type, {
        key: "a",
        shiftKey: false,
        isComposing: false,
        keyCode: 65,
      });
      assert.isTrue(ev.propagationStopped, type);
      assert.isFalse(ev.defaultPrevented, type);
    }
    assert.equal(closed, 0);
  });

  it("outside pointerdown closes, inside pointerdown does not", function () {
    const doc = makeFakeDoc();
    let closed = 0;
    const h = openReaderSelectionPromptOverlay({
      doc,
      anchor,
      labels,
      selectedText,
      onSubmit: () => {},
      onClose: () => {
        closed++;
      },
    });
    doc.dispatch("pointerdown", { target: editorOf(doc) });
    assert.equal(closed, 0);
    doc.dispatch("pointerdown", { target: doc.body });
    assert.equal(closed, 1);
    assert.isFalse(h.root.isConnected);
    assert.equal(doc.listenerCount("pointerdown"), 0);
  });

  it("Escape and Enter work with focus on the Add button", function () {
    for (const [key, expectSubmit] of [
      ["Escape", false],
      ["Enter", true],
    ] as const) {
      const doc = makeFakeDoc();
      const submitted: string[] = [];
      let closed = 0;
      const h = openReaderSelectionPromptOverlay({
        doc,
        anchor,
        labels,
        selectedText,
        onSubmit: (t) => submitted.push(t),
        onClose: () => {
          closed++;
        },
      });
      editorOf(doc).textContent = "typed";
      const ev = doc.body.querySelector("button").dispatch("keydown", {
        key,
        shiftKey: false,
        isComposing: false,
        keyCode: 0,
      });
      assert.isTrue(ev.defaultPrevented, key);
      assert.isTrue(ev.propagationStopped, key);
      assert.deepEqual(submitted, expectSubmit ? ["typed"] : [], key);
      assert.equal(closed, 1, key);
      assert.isFalse(h.root.isConnected, key);
    }
  });

  it("outside pointerdown in a nested view iframe closes, and close detaches it", function () {
    const doc = makeFakeDoc();
    const viewDoc = makeFakeDoc();
    const innerDoc = makeFakeDoc();
    viewDoc.iframes.push({ contentDocument: innerDoc });
    doc.iframes.push(
      { contentDocument: viewDoc },
      {
        get contentDocument() {
          throw new Error("cross-origin");
        },
      },
      { contentDocument: null },
    );
    let closed = 0;
    const h = openReaderSelectionPromptOverlay({
      doc,
      anchor,
      labels,
      selectedText,
      onSubmit: () => {},
      onClose: () => {
        closed++;
      },
    });
    assert.equal(viewDoc.listenerCount("pointerdown"), 1);
    assert.equal(innerDoc.listenerCount("pointerdown"), 1);
    viewDoc.dispatch("pointerdown", { target: viewDoc.body });
    assert.equal(closed, 1);
    assert.isFalse(h.root.isConnected);
    for (const d of [doc, viewDoc, innerDoc]) {
      assert.equal(d.listenerCount("pointerdown"), 0);
    }
  });

  it("the Add button submits the typed text", function () {
    const doc = makeFakeDoc();
    const submitted: string[] = [];
    let closed = 0;
    const h = openReaderSelectionPromptOverlay({
      doc,
      anchor,
      labels,
      selectedText,
      onSubmit: (t) => submitted.push(t),
      onClose: () => {
        closed++;
      },
    });
    editorOf(doc).textContent = "summarize";
    const button = doc.body.querySelector("button");
    assert.equal(button.textContent, "Add");
    const ev = button.dispatch("click");
    assert.isTrue(ev.defaultPrevented);
    assert.deepEqual(submitted, ["summarize"]);
    assert.equal(closed, 1);
    assert.isFalse(h.root.isConnected);
  });

  it("close removes every listener it added", function () {
    const doc = makeFakeDoc();
    const h = openReaderSelectionPromptOverlay({
      doc,
      anchor,
      labels,
      selectedText,
      onSubmit: () => {},
      onClose: () => {},
    });
    const ta = editorOf(doc);
    const button = doc.body.querySelector("button");
    h.close();
    assert.equal(doc.listenerCount("pointerdown"), 0);
    for (const type of ["keydown", "keyup", "keypress"]) {
      assert.equal(ta.listenerCount(type), 0, type);
      assert.equal((h.root as any).listenerCount(type), 0, type);
    }
    assert.equal(button.listenerCount("click"), 0);
  });

  it("does not focus the editor when closed before the deferred focus runs", function () {
    const doc = makeFakeDoc(undefined, { deferTimers: true });
    const h = openReaderSelectionPromptOverlay({
      doc,
      anchor,
      labels,
      selectedText,
      onSubmit: () => {},
      onClose: () => {},
    });
    const ta = editorOf(doc);
    assert.isFalse(ta.focused);
    h.close();
    doc.runTimers();
    assert.isFalse(ta.focused);
  });

  it("opening a second overlay on the same document closes the first", function () {
    const doc = makeFakeDoc();
    let firstClosed = 0;
    const first = openReaderSelectionPromptOverlay({
      doc,
      anchor,
      labels,
      selectedText,
      onSubmit: () => {},
      onClose: () => {
        firstClosed++;
      },
    });
    const second = openReaderSelectionPromptOverlay({
      doc,
      anchor,
      labels,
      selectedText,
      onSubmit: () => {},
      onClose: () => {},
    });
    assert.equal(firstClosed, 1);
    assert.isFalse(first.root.isConnected);
    assert.isTrue(second.root.isConnected);
    assert.equal(doc.body.children.length, 1);
  });
});

describe("closeReaderSelectionPromptOverlay", function () {
  it("closes the overlay open on the document and is safe when none is open", function () {
    const doc = makeFakeDoc();
    closeReaderSelectionPromptOverlay(doc);
    let closed = 0;
    const h = openReaderSelectionPromptOverlay({
      doc,
      anchor,
      labels,
      selectedText,
      onSubmit: () => {},
      onClose: () => {
        closed++;
      },
    });
    closeReaderSelectionPromptOverlay(doc);
    assert.equal(closed, 1);
    assert.isFalse(h.root.isConnected);
    closeReaderSelectionPromptOverlay(doc);
    assert.equal(closed, 1);
  });
});

describe("closeAllReaderSelectionPromptOverlays", function () {
  it("closes the overlays open on every document and empties the registry", function () {
    closeAllReaderSelectionPromptOverlays();
    const docs = [makeFakeDoc(), makeFakeDoc()];
    let closed = 0;
    const handles = docs.map((doc) =>
      openReaderSelectionPromptOverlay({
        doc,
        anchor,
        labels,
        selectedText,
        onSubmit: () => {},
        onClose: () => {
          closed++;
        },
      }),
    );
    assert.equal(countOpenReaderSelectionPromptOverlays(), 2);
    closeAllReaderSelectionPromptOverlays();
    assert.equal(closed, 2);
    for (const [i, h] of handles.entries()) {
      assert.isFalse(h.root.isConnected, String(i));
      assert.equal(docs[i].listenerCount("pointerdown"), 0, String(i));
    }
    assert.equal(countOpenReaderSelectionPromptOverlays(), 0);
    closeAllReaderSelectionPromptOverlays();
    assert.equal(closed, 2);
  });

  it("forgets overlays whose reader document was torn down", function () {
    closeAllReaderSelectionPromptOverlays();
    const deadDoc = makeFakeDoc();
    let deadClosed = 0;
    openReaderSelectionPromptOverlay({
      doc: deadDoc,
      anchor,
      labels,
      selectedText,
      onSubmit: () => {},
      onClose: () => {
        deadClosed++;
      },
    });
    // The reader tab closed: its document lost its window.
    deadDoc.defaultView = null;
    openReaderSelectionPromptOverlay({
      doc: makeFakeDoc(),
      anchor,
      labels,
      selectedText,
      onSubmit: () => {},
      onClose: () => {},
    });
    assert.equal(countOpenReaderSelectionPromptOverlays(), 1);
    assert.equal(deadClosed, 1);
  });

  it("forgets an overlay that closed on its own", function () {
    closeAllReaderSelectionPromptOverlays();
    const h = openReaderSelectionPromptOverlay({
      doc: makeFakeDoc(),
      anchor,
      labels,
      selectedText,
      onSubmit: () => {},
      onClose: () => {},
    });
    h.close();
    assert.equal(countOpenReaderSelectionPromptOverlays(), 0);
  });
});

describe("openReaderSelectionPromptForChip", function () {
  afterEach(() => closeAllReaderSelectionPromptOverlays());

  const pressEnter = (doc: any, text: string) => {
    const ta = editorOf(doc);
    ta.textContent = text;
    ta.dispatch("keydown", {
      key: "Enter",
      shiftKey: false,
      isComposing: false,
      keyCode: 13,
    });
  };
  const quoteLabelOf = (doc: any) =>
    doc.body.querySelector(
      '[data-llm-reader-selection-prompt-quote-label="true"]',
    );
  const quoteOf = (doc: any) =>
    doc.body.querySelector('[data-llm-reader-selection-prompt-quote="true"]');

  it("opens after an add or a duplicate add and shows the selected text above the editor", function () {
    for (const outcome of ["added", "duplicate"] as const) {
      const doc = makeFakeDoc();
      const overlay = openReaderSelectionPromptForChip({
        doc,
        anchor,
        outcome,
        selectedText,
        labels,
        attach: () => true,
      });
      assert.isNotNull(overlay, outcome);
      assert.isTrue(overlay!.root.isConnected, outcome);
      assert.equal(quoteOf(doc).textContent, selectedText, outcome);
      // Label and quote share one tight section above the editor row.
      const children = overlay!.root.children;
      assert.strictEqual(children[0].children[0], quoteLabelOf(doc), outcome);
      assert.equal(quoteLabelOf(doc).textContent, "Selected text", outcome);
      assert.strictEqual(children[0].children[1], quoteOf(doc), outcome);
      assert.isTrue(children[1].contains(editorOf(doc)), outcome);
      assert.equal(doc.body.querySelector("button").textContent, "Add");
    }
  });

  it("styles the quote as a clamped, dimmed block without a box", function () {
    for (const [dark, color] of [
      [false, "#5b5b5b"],
      [true, "#b3b3b3"],
    ] as const) {
      const doc = makeFakeDoc();
      doc.defaultView.matchMedia = () => ({ matches: dark });
      openReaderSelectionPromptForChip({
        doc,
        anchor,
        outcome: "added",
        selectedText,
        labels,
        attach: () => true,
      });
      const labelStyle = quoteLabelOf(doc).style;
      assert.equal(
        labelStyle.color,
        dark ? "#8f8f8f" : "#7a7a7a",
        String(dark),
      );
      assert.equal(labelStyle.fontSize, "11px");
      const style = quoteOf(doc).style;
      assert.equal(style.color, color, String(dark));
      assert.isUndefined(style.background);
      assert.isUndefined(style.borderRadius);
      assert.isUndefined(style.padding);
      assert.equal(style.fontSize, "12px");
      assert.equal(style.display, "-webkit-box");
      assert.equal(style.WebkitLineClamp, "4");
      assert.equal(style.WebkitBoxOrient, "vertical");
      assert.equal(style.overflow, "hidden");
      assert.equal(style.whiteSpace, "pre-wrap");
      assert.isUndefined(style.borderLeft);
    }
  });

  it("Enter attaches the trimmed text and closes when the chip took it", function () {
    const doc = makeFakeDoc();
    const attached: string[] = [];
    const overlay = openReaderSelectionPromptForChip({
      doc,
      anchor,
      outcome: "added",
      selectedText,
      labels,
      attach: (text) => {
        attached.push(text);
        return true;
      },
    });
    pressEnter(doc, "  what does this mean?  ");
    assert.deepEqual(attached, ["what does this mean?"]);
    assert.isFalse(overlay!.root.isConnected);
  });

  it("keeps the box open with the chip-gone notice when no chip took the text", function () {
    const doc = makeFakeDoc();
    const overlay = openReaderSelectionPromptForChip({
      doc,
      anchor,
      outcome: "duplicate",
      selectedText,
      labels: {
        ...labels,
        chipGone: "Selected text is no longer in the context",
      },
      attach: () => false,
    });
    pressEnter(doc, "explain");
    assert.isTrue(overlay!.root.isConnected);
    assert.equal(editorOf(doc).textContent, "explain");
    const hintEl = overlay!.root.children[overlay!.root.children.length - 1];
    assert.equal(
      hintEl.textContent,
      "Selected text is no longer in the context",
    );
  });

  it("empty Enter closes without attaching", function () {
    const doc = makeFakeDoc();
    const overlay = openReaderSelectionPromptForChip({
      doc,
      anchor,
      outcome: "added",
      selectedText,
      labels,
      attach: () => assert.fail("no attach"),
    });
    pressEnter(doc, "   ");
    assert.isFalse(overlay!.root.isConnected);
  });

  it("prefills the chip's existing question with the caret at the end", function () {
    const doc = makeFakeDoc();
    const ranges: any[] = [];
    doc.createRange = () => {
      const range: any = {
        node: null,
        collapsedToStart: null,
        selectNodeContents(node: any) {
          range.node = node;
        },
        collapse(toStart: boolean) {
          range.collapsedToStart = toStart;
        },
      };
      return range;
    };
    doc.defaultView.getSelection = () => ({
      removeAllRanges() {
        ranges.length = 0;
      },
      addRange(range: any) {
        ranges.push(range);
      },
    });
    const attached: string[] = [];
    const overlay = openReaderSelectionPromptForChip({
      doc,
      anchor,
      outcome: "duplicate",
      selectedText,
      existingQuestion: "Old question?",
      labels,
      attach: (text) => {
        attached.push(text);
        return true;
      },
    });
    const editor = editorOf(doc);
    assert.equal(editor.textContent, "Old question?");
    assert.isTrue(editor.focused);
    const placeholder = doc.body.querySelector(
      '[data-llm-reader-selection-prompt-placeholder="true"]',
    );
    assert.equal(placeholder.style.display, "none");
    assert.lengthOf(ranges, 1);
    assert.strictEqual(ranges[0].node, editor);
    assert.isFalse(ranges[0].collapsedToStart);

    // Enter replaces the question with the edited text.
    pressEnter(doc, "New question?");
    assert.deepEqual(attached, ["New question?"]);
    assert.isFalse(overlay!.root.isConnected);
  });

  it("empty Enter on a prefilled box closes and leaves the question alone", function () {
    const doc = makeFakeDoc();
    const overlay = openReaderSelectionPromptForChip({
      doc,
      anchor,
      outcome: "duplicate",
      selectedText,
      existingQuestion: "Old question?",
      labels,
      attach: () => assert.fail("no attach"),
    });
    pressEnter(doc, "  ");
    assert.isFalse(overlay!.root.isConnected);
  });

  it("opens empty when the chip has no question", function () {
    const doc = makeFakeDoc();
    openReaderSelectionPromptForChip({
      doc,
      anchor,
      outcome: "duplicate",
      selectedText,
      existingQuestion: "",
      labels,
      attach: () => true,
    });
    assert.equal(editorOf(doc).textContent, "");
    const placeholder = doc.body.querySelector(
      '[data-llm-reader-selection-prompt-placeholder="true"]',
    );
    assert.notEqual(placeholder.style.display, "none");
  });

  it("does not open when the add failed, had no result, or has no text", function () {
    for (const [label, outcome, text] of [
      ["not-added", "not-added", selectedText],
      ["no-selection", "no-selection", selectedText],
      ["invalid-target", "invalid-target", selectedText],
      ["null", null, selectedText],
      ["empty text", "added", "  "],
    ] as const) {
      const doc = makeFakeDoc();
      const overlay = openReaderSelectionPromptForChip({
        doc,
        anchor,
        outcome,
        selectedText: text,
        labels,
        attach: () => true,
      });
      assert.isNull(overlay, label);
      assert.equal(doc.body.children.length, 0, label);
      assert.equal(doc.listenerCount("pointerdown"), 0, label);
    }
  });
});
