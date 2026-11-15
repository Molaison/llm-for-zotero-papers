import { assert } from "chai";
import {
  applySelectedTextPreview,
  setSelectedTextContextEntries,
} from "../src/modules/contextPanel/contextResolution";
import { appendSelectedTextSections } from "../src/modules/contextPanel/selectedTextPreviewSections";
import { FakeElement, collectFakeText, fakeDocument } from "./helpers/fakeDom";

/** A panel body whose id lookups find the selected-text preview list only. */
function fakePanelBody(): { body: Element; list: FakeElement } {
  const list = new FakeElement("div");
  const body = new FakeElement("div") as FakeElement & {
    ownerDocument: Document;
  };
  body.ownerDocument = fakeDocument;
  body.querySelector = (selector: string) =>
    selector === "#llm-selected-context-list" ? list : null;
  return { body: body as unknown as Element, list };
}

describe("selected-text chip preview sections", function () {
  const conversationKey = 818181;

  afterEach(function () {
    setSelectedTextContextEntries(conversationKey, []);
  });

  it("shows only the selected text and no question section without a question", function () {
    setSelectedTextContextEntries(conversationKey, [
      { text: "The cell divides.", source: "model" },
    ]);
    const { body, list } = fakePanelBody();
    applySelectedTextPreview(body, conversationKey);

    const expanded = list.findByClass("llm-selected-context-expanded");
    assert.deepEqual(
      (expanded?.findAllByClass("llm-selected-context-label") || []).map(
        (node) => node.textContent,
      ),
      ["Selected text"],
    );
    assert.isNull(expanded?.findByClass("llm-context-label"));
    const text = expanded?.findByClass("llm-selected-context-text");
    assert.equal(text?.textContent, "The cell divides.");
    assert.equal(text?.className, "llm-selected-context-text");
    assert.isNull(expanded?.findByClass("llm-selected-context-quote"));
    assert.isNull(expanded?.findByClass("llm-selected-context-question"));
    assert.isNull(expanded?.findByClass("llm-agent-output-divider"));
  });

  it("adds a divider and the question when the chip carries one", function () {
    setSelectedTextContextEntries(conversationKey, [
      {
        text: "The cell divides.",
        source: "model",
        userQuery: "Why does it divide?",
      },
    ]);
    const { body, list } = fakePanelBody();
    applySelectedTextPreview(body, conversationKey);

    const expanded = list.findByClass("llm-selected-context-expanded");
    assert.deepEqual(
      (expanded?.findAllByClass("llm-selected-context-label") || []).map(
        (node) => node.textContent,
      ),
      ["Selected text", "Your question"],
    );
    // Each label travels with its text in one section; the divider sits
    // between the two sections.
    const order = (expanded?.children || []).map((child) => child.className);
    assert.deepEqual(order.slice(0, 3), [
      "llm-selected-context-section",
      "llm-agent-output-divider",
      "llm-selected-context-section",
    ]);
    const sections =
      expanded?.findAllByClass("llm-selected-context-section") || [];
    assert.deepEqual(
      sections.map((section) =>
        (section.children || []).map((child) => child.className),
      ),
      [
        ["llm-selected-context-label", "llm-selected-context-text"],
        ["llm-selected-context-label", "llm-selected-context-question"],
      ],
    );
    const textIndex = 0;
    const dividerIndex = 1;
    const questionIndex = 2;
    assert.isAbove(dividerIndex, textIndex);
    assert.isAbove(questionIndex, dividerIndex);
    const question = expanded?.findByClass("llm-selected-context-question");
    assert.equal(question?.textContent, "Why does it divide?");
    assert.equal(question?.className, "llm-selected-context-question");
    assert.isNull(expanded?.findByClass("llm-selected-context-quote"));
    // The chip text lookup never lands on the question.
    assert.equal(
      expanded?.findAllByClass("llm-selected-context-text").length,
      1,
    );
  });

  it("builds the same sections for a sent message's expanded chip", function () {
    const container = new FakeElement("div");
    appendSelectedTextSections(
      fakeDocument,
      container as unknown as Element,
      "Paper A\n\nThe cell divides.",
      "Why does it divide?",
    );
    assert.lengthOf(container.findAllByClass("llm-selected-context-label"), 2);
    assert.isNull(container.findByClass("llm-context-label"));
    assert.lengthOf(container.findAllByClass("llm-agent-output-divider"), 1);
    assert.equal(
      container.findByClass("llm-selected-context-text")?.textContent,
      "Paper A\n\nThe cell divides.",
    );
    assert.equal(
      container.findByClass("llm-selected-context-question")?.textContent,
      "Why does it divide?",
    );
    assert.include(collectFakeText(container), "Why does it divide?");
  });

  it("puts a leading node and the label text on one row of the first label", function () {
    const container = new FakeElement("div");
    const icon = new FakeElement("span");
    icon.className = "llm-user-selected-text-icon";
    const textBlock = appendSelectedTextSections(
      fakeDocument,
      container as unknown as Element,
      "The cell divides.",
      "Why does it divide?",
      { leading: icon as unknown as Node },
    );
    const labels = container.findAllByClass("llm-selected-context-label");
    assert.lengthOf(labels, 2);
    const [selectedLabel, questionLabel] = labels;
    assert.isTrue(
      selectedLabel.classList.contains("llm-selected-context-label-row"),
    );
    assert.deepEqual(
      selectedLabel.children.map((child) => child.className),
      ["llm-user-selected-text-icon", "llm-selected-context-label-text"],
    );
    assert.strictEqual(selectedLabel.children[0], icon);
    assert.equal(selectedLabel.children[1].textContent, "Selected text");
    // Only the first label gains the leading node.
    assert.isFalse(
      questionLabel.classList.contains("llm-selected-context-label-row"),
    );
    assert.equal(questionLabel.textContent, "Your question");
    assert.lengthOf(questionLabel.children, 0);
    // The returned block is still the selected text.
    assert.equal(textBlock.className, "llm-selected-context-text");
    assert.equal(
      (textBlock as unknown as FakeElement).textContent,
      "The cell divides.",
    );
  });

  it("keeps a plain first label without a leading node", function () {
    const container = new FakeElement("div");
    appendSelectedTextSections(
      fakeDocument,
      container as unknown as Element,
      "The cell divides.",
      "Why does it divide?",
    );
    const [selectedLabel] = container.findAllByClass(
      "llm-selected-context-label",
    );
    assert.equal(selectedLabel.textContent, "Selected text");
    assert.lengthOf(selectedLabel.children, 0);
    assert.isFalse(
      selectedLabel.classList.contains("llm-selected-context-label-row"),
    );
  });

  it("omits the question section for a blank question", function () {
    const container = new FakeElement("div");
    appendSelectedTextSections(
      fakeDocument,
      container as unknown as Element,
      "The cell divides.",
      "   ",
    );
    assert.lengthOf(container.findAllByClass("llm-selected-context-label"), 1);
    assert.isNull(container.findByClass("llm-agent-output-divider"));
    assert.isNull(container.findByClass("llm-selected-context-question"));
  });
});
