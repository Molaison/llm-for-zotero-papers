import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "chai";
import { afterEach, describe, it } from "mocha";
import {
  createReasoningPanelForTests,
  disposeMountedAssistantViewForTests,
  renderReasoningPartForTests,
} from "../src/modules/contextPanel/chat";
import { disposeStreamingMarkdown } from "../src/modules/contextPanel/streamingMarkdown";
import type { Message } from "../src/modules/contextPanel/types";
import { FakeElement } from "./helpers/fakeDom";

const here = dirname(fileURLToPath(import.meta.url));

class StreamingElement extends FakeElement {
  get isConnected() {
    return true;
  }

  replaceWith(...elements: StreamingElement[]) {
    const parent = this.parentElement;
    if (!parent) return;
    for (const element of elements) parent.insertBefore(element, this);
    parent.removeChild(this);
  }
}

function htmlOf(element: FakeElement): string {
  return element.innerHTML + element.children.map(htmlOf).join("");
}

function textOf(element: FakeElement): string {
  return htmlOf(element).replace(/<[^>]*>/g, "");
}

function message(patch: Partial<Message> = {}): Message {
  return {
    role: "assistant",
    text: "",
    timestamp: 1,
    ...patch,
  } as Message;
}

describe("streamed thinking text", function () {
  const texts: HTMLElement[] = [];
  afterEach(function () {
    for (const text of texts.splice(0)) disposeStreamingMarkdown(text);
  });

  function fixture() {
    let handle = 0;
    const frames = new Map<number, FrameRequestCallback>();
    const doc = {
      createElement: (tag: string) => new StreamingElement(tag),
      querySelectorAll: () => [],
      defaultView: {
        performance: { now: () => 0 },
        requestAnimationFrame: (callback: FrameRequestCallback) => {
          frames.set(++handle, callback);
          return handle;
        },
        cancelAnimationFrame: (id: number) => frames.delete(id),
        setTimeout: (callback: () => void) => {
          frames.set(++handle, callback as FrameRequestCallback);
          return handle;
        },
        clearTimeout: (id: number) => frames.delete(id),
      },
    } as unknown as Document;
    let resized = 0;
    const panel = createReasoningPanelForTests(doc, message(), (fn) => fn());
    return {
      doc,
      frames,
      panel,
      get resized() {
        return resized;
      },
      onResize: () => {
        resized++;
      },
      flush() {
        const callbacks = [...frames.values()];
        frames.clear();
        for (const callback of callbacks) callback(0);
      },
      track(part: "summary" | "details") {
        const text = panel.text[part]!;
        texts.push(text);
        return text;
      },
    };
  }

  const bodyOf = (panel: { bodyWrap: HTMLElement }) =>
    panel.bodyWrap as unknown as FakeElement;

  it("builds the thinking panel and follows reasoningOpen", function () {
    const f = fixture();
    const closed = createReasoningPanelForTests(
      f.doc,
      message({ reasoningOpen: false }),
      (fn) => fn(),
    );
    const open = createReasoningPanelForTests(
      f.doc,
      message({ reasoningOpen: true }),
      (fn) => fn(),
    );
    assert.isFalse(closed.panel.open);
    assert.isTrue(open.panel.open);
    const el = open.panel as unknown as FakeElement;
    assert.isTrue(el.classList.contains("llm-agent-reasoning"));
    assert.equal(el.children[0].tagName, "summary");
    assert.isTrue(
      el.children[0].classList.contains("llm-agent-reasoning-summary"),
    );
    assert.equal(el.children[0].textContent, "Thinking");
    assert.strictEqual(el.children[1], open.bodyWrap as unknown as FakeElement);
    assert.isTrue(
      el.children[1].classList.contains("llm-agent-reasoning-body"),
    );
    assert.deepEqual(open.text, {});
  });

  it("streams chunks into the same text element", function () {
    const f = fixture();
    const msg = message({ reasoningSummary: "First **chunk**" });
    renderReasoningPartForTests(f.panel, "summary", msg, f.doc, f.onResize);
    const text = f.track("summary");
    f.flush();
    for (const chunk of [" and more", " plus a tail.\n\nSecond paragraph"]) {
      msg.reasoningSummary += chunk;
      renderReasoningPartForTests(f.panel, "summary", msg, f.doc, f.onResize);
      assert.strictEqual(f.panel.text.summary, text);
      f.flush();
    }
    assert.strictEqual(f.panel.text.summary, text);
    assert.equal(bodyOf(f.panel).children.length, 1);
    assert.include(
      textOf(text as unknown as FakeElement).replace(/\s+/g, ""),
      "Firstchunkandmoreplusatail.Secondparagraph",
    );
    assert.isAbove(f.resized, 0);
  });

  it("places the summary block before an existing details block", function () {
    const f = fixture();
    const msg = message({ reasoningDetails: "Details body" });
    renderReasoningPartForTests(f.panel, "details", msg, f.doc, f.onResize);
    f.track("details");
    msg.reasoningSummary = "Summary body";
    renderReasoningPartForTests(f.panel, "summary", msg, f.doc, f.onResize);
    f.track("summary");
    const blocks = bodyOf(f.panel).children;
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].children[0].textContent, "Summary");
    assert.equal(blocks[1].children[0].textContent, "Details");
    assert.strictEqual(
      blocks[0].children[1],
      f.panel.text.summary as unknown as FakeElement,
    );
    assert.strictEqual(
      blocks[1].children[1],
      f.panel.text.details as unknown as FakeElement,
    );
  });

  it("renders synchronously without a streaming resize callback", function () {
    const f = fixture();
    const msg = message({ reasoningSummary: "Final **summary**" });
    renderReasoningPartForTests(f.panel, "summary", msg, f.doc);
    assert.equal(f.frames.size, 0);
    const text = f.panel.text.summary as unknown as FakeElement;
    assert.include(textOf(text), "Final");
    assert.include(htmlOf(text), "summary");
  });

  it("writes nothing after the view is disposed", function () {
    const f = fixture();
    const msg = message({ reasoningSummary: "Pending thinking" });
    renderReasoningPartForTests(f.panel, "summary", msg, f.doc, f.onResize);
    const text = f.track("summary") as unknown as FakeElement;
    assert.isAbove(f.frames.size, 0);
    disposeMountedAssistantViewForTests({
      bubble: new StreamingElement("div") as unknown as HTMLElement,
      reasoning: f.panel,
    } as never);
    assert.equal(f.frames.size, 0);
    f.flush();
    assert.equal(text.children.length, 0);
    assert.equal(htmlOf(text), "");
    assert.equal(f.resized, 0);
  });

  it("keeps the fast path from bailing on growing thinking text", function () {
    // Guards updateMountedAssistantViews, which needs the full Zotero panel
    // (covered by the live chatRenderingReuse workflow test).
    const source = readFileSync(
      resolve(here, "../src/modules/contextPanel/chat.ts"),
      "utf8",
    );
    const from = source.indexOf("function updateMountedAssistantViews(");
    const to = source.indexOf("export type RefreshChatOptions", from);
    assert.isAbove(from, 0);
    assert.isAbove(to, from);
    const fastPath = source.slice(from, to);
    assert.notInclude(
      fastPath,
      "message.reasoningSummary !== view.reasoningSummary",
    );
    assert.notInclude(
      fastPath,
      "message.reasoningDetails !== view.reasoningDetails",
    );
  });
});
