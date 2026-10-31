import { readFileSync } from "node:fs";
import { assert } from "chai";
import {
  disposeStreamingMarkdown,
  finishStreamingMarkdownInto,
  renderStreamingMarkdownInto,
} from "../src/modules/contextPanel/streamingMarkdown";
import { FakeElement } from "./helpers/fakeDom";

import { MarkdownNode as StreamingElement } from "./helpers/markdownDom";

function htmlOf(element: FakeElement): string { return element.innerHTML; }

describe("streaming Markdown frame consistency", function () {
  const targets: HTMLElement[] = [];
  afterEach(function () {
    for (const target of targets.splice(0)) disposeStreamingMarkdown(target);
  });

  function fixture() {
    let handle = 0;
    let clock = [0];
    const frames = new Map<number, FrameRequestCallback>();
    const timers = new Map<number, () => void>();
    const doc = {
      createElement: (tag: string) => new StreamingElement(tag),
      querySelectorAll: () => [],
      defaultView: {
        performance: {
          now: () => (clock.length > 1 ? clock.shift()! : clock[0]),
        },
        requestAnimationFrame: (callback: FrameRequestCallback) => {
          frames.set(++handle, callback);
          return handle;
        },
        cancelAnimationFrame: (id: number) => frames.delete(id),
        setTimeout: (callback: () => void) => {
          timers.set(++handle, callback);
          return handle;
        },
        clearTimeout: (id: number) => timers.delete(id),
      },
    } as unknown as Document;
    const target = new StreamingElement("div") as unknown as HTMLElement;
    targets.push(target);
    let resized = 0;
    return {
      target,
      frames,
      timers,
      get resized() {
        return resized;
      },
      get html() {
        return htmlOf(target as unknown as FakeElement);
      },
      finish(source: string) { finishStreamingMarkdownInto(target, source, doc, () => resized++); },
      render(source: string) {
        renderStreamingMarkdownInto(target, source, doc, () => resized++);
      },
      flush(times = [0]) {
        clock = [...times];
        const callbacks = [...frames.values()];
        frames.clear();
        for (const callback of callbacks) callback(0);
      },
    };
  }

  it("never duplicates the preceding tail when the stable-block budget expires", function () {
    const view = fixture();
    view.render("Alpha");
    view.flush();
    assert.equal((view.html.match(/Alpha/g) || []).length, 1);

    view.render("Alpha\n\nBeta\n\nGamma");
    // The first stable block fits; the clock then forces the next iteration
    // to yield. This frame must replace the old Alpha tail after committing it.
    view.flush([0, 0, 9]);
    assert.equal((view.html.match(/Alpha/g) || []).length, 1);
    assert.equal((view.html.match(/Beta/g) || []).length, 1);
    assert.equal((view.html.match(/Gamma/g) || []).length, 1);
    assert.equal(view.resized, 2);
    assert.equal(view.frames.size, 1, "remaining stable work is deferred");

    view.flush();
    for (const text of ["Alpha", "Beta", "Gamma"]) {
      assert.equal((view.html.match(new RegExp(text, "g")) || []).length, 1);
    }
    assert.equal(view.frames.size, 0);
  });

  it("keeps the old rendered content until a non-prefix restart can replace it", function () {
    const view = fixture();
    view.render("Original passage");
    view.flush();
    const original = view.html;
    view.render("Original passage\n\nQueued obsolete continuation");
    view.render("Replacement passage\n\nNew continuation");
    assert.equal(view.html, original, "scheduling must not clear the viewport");
    view.flush();
    assert.include(view.html, "Replacement passage");
    assert.include(view.html, "New continuation");
    assert.notInclude(view.html, "Original passage");
    assert.notInclude(view.html, "Queued obsolete continuation");
    assert.equal(view.frames.size, 0);
  });

  it("keeps committed nodes and a complete tail across repeated slow frames and newer chunks", function () {
    const view = fixture();
    const words = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"];
    view.render(words.slice(0, 4).join("\n\n"));
    // Even a lexer that consumes the budget must allow one stable token to
    // progress; otherwise every scheduled frame would defer the same work.
    view.flush([0, 9]);
    const stableFirst = view.target.firstChild;
    assert.isOk(stableFirst);
    view.render(words.join("\n\n"));
    let remainingFrames = 12;
    while (view.frames.size && remainingFrames-- > 0) {
      view.flush([0, 9]);
      assert.strictEqual(view.target.firstChild, stableFirst);
      for (const text of words) {
        assert.equal((view.html.match(new RegExp(text, "g")) || []).length, 1);
      }
    }
    assert.equal(view.frames.size, 0, "stable promotion eventually finishes");
    assert.equal(view.timers.size, 0);
  });

  it("can cancel a queued restart without removing the last complete render", function () {
    const view = fixture();
    view.render("Visible passage");
    view.flush();
    const visible = view.html;
    view.render("Cancelled replacement");
    disposeStreamingMarkdown(view.target);
    view.flush();
    assert.equal(view.html, visible);
    assert.equal(view.frames.size, 0);
    assert.equal(view.timers.size, 0);
  });

  it("uses boxless tails and the same paragraph/whitespace rules through completion", () => {
    const view = fixture(); view.render("First $x$ paragraph\n\nSecond"); view.flush();
    assert.equal((view.target.children[view.target.children.length - 1] as HTMLElement).style.display, "contents");
    const css = readFileSync("addon/content/zoteroPane.css", "utf8");
    assert.match(css, /\.llm-assistant-answer\s*\{[^}]*white-space:\s*normal/);
    assert.notMatch(css, /\.llm-rendered-markdown p:last-child\s*\{[^}]*margin-bottom:\s*0/);
    const math = view.target.querySelector(".katex");
    view.finish("First $x$ paragraph\n\nSecond");
    assert.strictEqual(view.target.querySelector(".katex"), math);
  });

  it("renders an explicit empty restart in its scheduled frame", function () {
    const view = fixture();
    view.render("Visible passage");
    view.flush();
    view.render("");
    assert.include(view.html, "Visible passage");
    view.flush();
    assert.notInclude(view.html, "Visible passage");
    assert.equal(view.frames.size, 0);
  });
  for (const math of ["$x^2$", "$$\n\\frac{a}{b}\n$$", "\\[\n\\begin{aligned}a&=b\\\\c&=d\\end{aligned}\n\\]"]) {
    it(`retains closed formula and paragraph nodes across tail append, promotion and final: ${math}`, () => {
      const view = fixture();
      const initial = math.startsWith("$") && !math.startsWith("$$") ? `Before ${math} after` : `Before\n\n${math}\n\nAfter`;
      view.render(initial); view.flush();
      const formula = view.target.querySelector(".katex");
      assert.exists(formula);
      const tails = [initial + " more", initial + " more words", initial + " more words\n\nNext", initial + " more words\n\nNext\n\nLast"];
      for (const source of tails) {
        view.render(source); view.flush();
        assert.strictEqual(view.target.querySelector(".katex"), formula);
      }
      view.finish(tails.at(-1)!);
      assert.strictEqual(view.target.querySelector(".katex"), formula);
      assert.equal(view.frames.size, 0);
      assert.include(view.html, "Last");
    });
  }
  it("updates text in the same paragraph node and replaces genuinely changed math", () => {
    const view = fixture(); view.render("Before $x$ after"); view.flush();
    const tail = view.target.firstChild!;
    const paragraph = tail.firstChild;
    const formula = view.target.querySelector(".katex");
    view.render("Before $x$ after a longer sentence"); view.flush();
    assert.strictEqual(view.target.firstChild!.firstChild, paragraph);
    assert.strictEqual(view.target.querySelector(".katex"), formula);
    view.render("Before $y$ after"); view.flush();
    assert.notStrictEqual(view.target.querySelector(".katex"), formula);
  });
  it("renders incomplete math immediately then retains it only after its source closes", () => {
    const view = fixture(); view.render("Before $x"); view.flush();
    assert.include(view.html, "$x");
    view.render("Before $x$ after"); view.flush();
    const formula = view.target.querySelector(".katex"); assert.exists(formula);
    view.finish("Before $x$ after completed");
    assert.strictEqual(view.target.querySelector(".katex"), formula);
    assert.include(view.html, "completed");
  });

  it("finishes a queued last chunk without a stale animation frame replacing the final answer", () => {
    const view = fixture(); view.render("Before $x$ after"); view.flush();
    const formula = view.target.querySelector(".katex");
    view.render("Before $x$ after queued");
    view.finish("Before $x$ after queued and final");
    assert.equal(view.frames.size, 0);
    assert.equal(view.timers.size, 0);
    view.flush();
    assert.strictEqual(view.target.querySelector(".katex"), formula);
    assert.include(view.html, "queued and final");
  });

});
