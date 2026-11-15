import { assert } from "chai";
import {
  addSelectedTextContext,
  appendSelectedTextContextForItem,
  appendSelectedTextContextForItemDetailed,
  findSelectedTextContextIndexForItem,
  getSelectedTextContextEntries,
  getSelectedTextContextQueryForItem,
  setSelectedTextContextEntries,
  stripSelectedTextQuestionsForItem,
  updateSelectedTextContextLocationForItem,
  updateSelectedTextContextQueryForItem,
} from "../src/modules/contextPanel/contextResolution";
import { retainPinnedTextState } from "../src/modules/contextPanel/contexts/textContextState";
import { togglePinnedSelectedText } from "../src/modules/contextPanel/setupHandlers/controllers/pinnedContextController";

type FakeStatus = { textContent: string; className: string };

function fakeBody(): { body: Element; status: FakeStatus } {
  const status: FakeStatus = { textContent: "", className: "" };
  const body = {
    querySelector: (selector: string) =>
      selector === "#llm-status" ? status : null,
  } as unknown as Element;
  return { body, status };
}

describe("selected text chip questions", function () {
  const conversationKey = 929292;
  const paperContext = { itemId: 70, contextItemId: 77, title: "Paper" };

  beforeEach(function () {
    setSelectedTextContextEntries(conversationKey, []);
  });

  afterEach(function () {
    setSelectedTextContextEntries(conversationKey, []);
  });

  describe("append outcomes", function () {
    it("reports added, duplicate, and full separately", function () {
      assert.equal(
        appendSelectedTextContextForItemDetailed(
          conversationKey,
          "first quote",
          "pdf",
          paperContext,
          { contextItemId: 77, pageIndex: 1 },
        ),
        "added",
      );
      assert.equal(
        appendSelectedTextContextForItemDetailed(
          conversationKey,
          "first   quote",
          "pdf",
          paperContext,
          { contextItemId: 77, pageIndex: 1 },
        ),
        "duplicate",
      );
      for (let index = 2; index <= 5; index++) {
        appendSelectedTextContextForItem(
          conversationKey,
          `quote ${index}`,
          "pdf",
          paperContext,
          { contextItemId: 77, pageIndex: index },
        );
      }
      assert.equal(
        appendSelectedTextContextForItemDetailed(
          conversationKey,
          "sixth quote",
          "pdf",
          paperContext,
          { contextItemId: 77, pageIndex: 6 },
        ),
        "full",
      );
      assert.equal(
        appendSelectedTextContextForItemDetailed(
          conversationKey,
          "first quote",
          "pdf",
          paperContext,
          { contextItemId: 77, pageIndex: 1 },
        ),
        "duplicate",
        "an existing chip is a duplicate even when the list is full",
      );
      assert.lengthOf(getSelectedTextContextEntries(conversationKey), 5);
    });

    it("adds the same text from a different page as a second chip", function () {
      appendSelectedTextContextForItem(
        conversationKey,
        "repeated phrase",
        "pdf",
        paperContext,
        { contextItemId: 77, pageIndex: 2 },
      );

      assert.equal(
        appendSelectedTextContextForItemDetailed(
          conversationKey,
          "repeated phrase",
          "pdf",
          paperContext,
          { contextItemId: 77, pageIndex: 4 },
        ),
        "added",
      );
      assert.deepEqual(
        getSelectedTextContextEntries(conversationKey).map(
          (entry) => entry.pageIndex,
        ),
        [2, 4],
      );
    });

    it("keeps the boolean wrapper for existing callers", function () {
      assert.isTrue(
        appendSelectedTextContextForItem(conversationKey, "quote", "model"),
      );
      assert.isFalse(
        appendSelectedTextContextForItem(conversationKey, "quote", "model"),
      );
    });

    it("shows a distinct status for a duplicate and keeps the limit status for a full list", function () {
      const panel = fakeBody();
      appendSelectedTextContextForItem(conversationKey, "model quote", "model");

      assert.equal(
        addSelectedTextContext(panel.body, conversationKey, "model quote", {
          source: "model",
        }),
        "duplicate",
      );
      assert.equal(panel.status.textContent, "Selected text already included");
      assert.include(panel.status.className, "llm-status-ready");

      for (let index = 2; index <= 5; index++) {
        appendSelectedTextContextForItem(
          conversationKey,
          `model quote ${index}`,
          "model",
        );
      }
      assert.equal(
        addSelectedTextContext(panel.body, conversationKey, "another quote", {
          source: "model",
        }),
        "full",
      );
      assert.equal(panel.status.textContent, "Text Context up to 5");
      assert.include(panel.status.className, "llm-status-error");
    });
  });

  describe("stripSelectedTextQuestionsForItem", function () {
    it("drops every question and keeps the chips", function () {
      appendSelectedTextContextForItem(
        conversationKey,
        "first",
        "pdf",
        paperContext,
        { contextItemId: 77, pageIndex: 1 },
      );
      appendSelectedTextContextForItem(conversationKey, "second", "model");
      updateSelectedTextContextQueryForItem(
        conversationKey,
        "first",
        "pdf",
        paperContext,
        "Q1",
      );
      updateSelectedTextContextQueryForItem(
        conversationKey,
        "second",
        "model",
        null,
        "Q2",
      );

      assert.isTrue(stripSelectedTextQuestionsForItem(conversationKey));
      const entries = getSelectedTextContextEntries(conversationKey);
      assert.deepEqual(
        entries.map((entry) => entry.text),
        ["first", "second"],
      );
      for (const entry of entries) assert.notProperty(entry, "userQuery");
      assert.isFalse(stripSelectedTextQuestionsForItem(conversationKey));
    });
  });

  describe("getSelectedTextContextQueryForItem", function () {
    it("reads the question of the chip that holds the text", function () {
      appendSelectedTextContextForItem(
        conversationKey,
        "quoted claim",
        "pdf",
        paperContext,
        { contextItemId: 77, pageIndex: 3 },
      );
      appendSelectedTextContextForItem(conversationKey, "model words", "model");
      updateSelectedTextContextQueryForItem(
        conversationKey,
        "quoted claim",
        "pdf",
        paperContext,
        "Line one\nline two",
        77,
        3,
      );

      assert.equal(
        getSelectedTextContextQueryForItem(
          conversationKey,
          "quoted   claim",
          "pdf",
          paperContext,
          77,
          3,
        ),
        "Line one\nline two",
      );
      // A chip without a question, and no chip at all, read as "".
      assert.equal(
        getSelectedTextContextQueryForItem(
          conversationKey,
          "model words",
          "model",
          null,
        ),
        "",
      );
      assert.equal(
        getSelectedTextContextQueryForItem(
          conversationKey,
          "missing",
          "pdf",
          paperContext,
        ),
        "",
      );
    });
  });

  describe("updateSelectedTextContextQueryForItem", function () {
    it("sets, updates, and clears a chip's question", function () {
      appendSelectedTextContextForItem(
        conversationKey,
        "quoted claim",
        "pdf",
        paperContext,
        { contextItemId: 77, pageIndex: 3 },
      );

      assert.isTrue(
        updateSelectedTextContextQueryForItem(
          conversationKey,
          "quoted claim",
          "pdf",
          paperContext,
          "  Is this   right? ",
        ),
      );
      assert.equal(
        getSelectedTextContextEntries(conversationKey)[0]?.userQuery,
        "Is this right?",
      );

      assert.isTrue(
        updateSelectedTextContextQueryForItem(
          conversationKey,
          "quoted claim",
          "pdf",
          paperContext,
          "What is the evidence?",
        ),
      );
      assert.equal(
        getSelectedTextContextEntries(conversationKey)[0]?.userQuery,
        "What is the evidence?",
      );

      assert.isTrue(
        updateSelectedTextContextQueryForItem(
          conversationKey,
          "quoted claim",
          "pdf",
          paperContext,
          "   ",
        ),
      );
      const [cleared] = getSelectedTextContextEntries(conversationKey);
      assert.notProperty(cleared, "userQuery");
      assert.equal(cleared?.pageIndex, 3);
    });

    it("finds the chip whose page index arrived after the add", function () {
      appendSelectedTextContextForItem(
        conversationKey,
        "late located text",
        "pdf",
        paperContext,
        { contextItemId: 77 },
      );
      updateSelectedTextContextLocationForItem(
        conversationKey,
        "late located text",
        "pdf",
        paperContext,
        { contextItemId: 77, pageIndex: 9, pageLabel: "10" },
      );

      assert.equal(
        findSelectedTextContextIndexForItem(
          conversationKey,
          "late located text",
          "pdf",
          paperContext,
        ),
        0,
      );
      assert.isTrue(
        updateSelectedTextContextQueryForItem(
          conversationKey,
          "late located text",
          "pdf",
          paperContext,
          "Explain the method.",
        ),
      );
      assert.deepInclude(getSelectedTextContextEntries(conversationKey)[0], {
        pageIndex: 9,
        pageLabel: "10",
        userQuery: "Explain the method.",
      });
    });

    it("attaches to the chip on the given page when the text repeats", function () {
      appendSelectedTextContextForItem(
        conversationKey,
        "repeated text",
        "pdf",
        paperContext,
        { contextItemId: 77, pageIndex: 3 },
      );
      appendSelectedTextContextForItem(
        conversationKey,
        "repeated text",
        "pdf",
        paperContext,
        { contextItemId: 77, pageIndex: 5 },
      );

      assert.isTrue(
        updateSelectedTextContextQueryForItem(
          conversationKey,
          "repeated text",
          "pdf",
          paperContext,
          "Page five question",
          77,
          5,
        ),
      );
      const entries = getSelectedTextContextEntries(conversationKey);
      assert.notProperty(entries[0], "userQuery");
      assert.equal(entries[1]?.userQuery, "Page five question");
    });

    it("prefers a chip without a page over a chip on another page", function () {
      appendSelectedTextContextForItem(
        conversationKey,
        "repeated text",
        "pdf",
        paperContext,
        { contextItemId: 77, pageIndex: 3 },
      );
      appendSelectedTextContextForItem(
        conversationKey,
        "repeated text",
        "pdf",
        paperContext,
      );

      assert.equal(
        findSelectedTextContextIndexForItem(
          conversationKey,
          "repeated text",
          "pdf",
          paperContext,
          77,
          5,
        ),
        1,
      );
      updateSelectedTextContextLocationForItem(
        conversationKey,
        "repeated text",
        "pdf",
        paperContext,
        { contextItemId: 77, pageIndex: 5 },
      );
      assert.equal(
        findSelectedTextContextIndexForItem(
          conversationKey,
          "repeated text",
          "pdf",
          paperContext,
          77,
          5,
        ),
        1,
      );
    });

    it("falls back to the first match without a page index", function () {
      appendSelectedTextContextForItem(
        conversationKey,
        "repeated text",
        "pdf",
        paperContext,
        { contextItemId: 77, pageIndex: 3 },
      );
      appendSelectedTextContextForItem(
        conversationKey,
        "repeated text",
        "pdf",
        paperContext,
        { contextItemId: 77, pageIndex: 5 },
      );

      assert.equal(
        findSelectedTextContextIndexForItem(
          conversationKey,
          "repeated text",
          "pdf",
          paperContext,
        ),
        0,
      );
      assert.equal(
        findSelectedTextContextIndexForItem(
          conversationKey,
          "repeated text",
          "pdf",
          paperContext,
          77,
          9,
        ),
        0,
      );
    });

    it("targets the matching chip among several", function () {
      appendSelectedTextContextForItem(conversationKey, "first", "model");
      appendSelectedTextContextForItem(conversationKey, "second", "model");

      assert.equal(
        findSelectedTextContextIndexForItem(
          conversationKey,
          "second",
          "model",
          null,
        ),
        1,
      );
      assert.isTrue(
        updateSelectedTextContextQueryForItem(
          conversationKey,
          "second",
          "model",
          null,
          "Why?",
        ),
      );
      const entries = getSelectedTextContextEntries(conversationKey);
      assert.notProperty(entries[0], "userQuery");
      assert.equal(entries[1]?.userQuery, "Why?");
    });

    it("does nothing when no chip matches", function () {
      appendSelectedTextContextForItem(
        conversationKey,
        "existing text",
        "pdf",
        paperContext,
        { contextItemId: 77 },
      );
      const before = getSelectedTextContextEntries(conversationKey);

      assert.isFalse(
        updateSelectedTextContextQueryForItem(
          conversationKey,
          "missing text",
          "pdf",
          paperContext,
          "Question",
        ),
      );
      assert.isFalse(
        updateSelectedTextContextQueryForItem(
          conversationKey,
          "existing text",
          "model",
          paperContext,
          "Question",
        ),
        "a different source is a different chip",
      );
      assert.isFalse(
        updateSelectedTextContextQueryForItem(
          conversationKey,
          "existing text",
          "pdf",
          { itemId: 80, contextItemId: 88, title: "Other paper" },
          "Question",
        ),
        "a different paper is a different chip",
      );
      assert.isFalse(
        updateSelectedTextContextQueryForItem(
          conversationKey,
          "existing text",
          "pdf",
          paperContext,
          "Question",
          99,
        ),
        "a different attachment is a different chip",
      );
      assert.equal(
        findSelectedTextContextIndexForItem(
          conversationKey,
          "missing text",
          "pdf",
          paperContext,
        ),
        -1,
      );
      assert.deepEqual(getSelectedTextContextEntries(conversationKey), before);
    });
  });

  it("drops the question of a pinned chip after a send but keeps its text", function () {
    const pins = new Map<number, Set<string>>();
    appendSelectedTextContextForItem(conversationKey, "pinned quote", "model");
    updateSelectedTextContextQueryForItem(
      conversationKey,
      "pinned quote",
      "model",
      null,
      "Pinned question",
    );
    togglePinnedSelectedText(
      pins,
      conversationKey,
      getSelectedTextContextEntries(conversationKey)[0]!,
    );

    retainPinnedTextState(pins, conversationKey);

    const entries = getSelectedTextContextEntries(conversationKey);
    assert.lengthOf(entries, 1);
    assert.equal(entries[0]?.text, "pinned quote");
    assert.notProperty(entries[0], "userQuery");
  });
});
