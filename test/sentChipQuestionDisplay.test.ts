import { assert } from "chai";
import { describe, it } from "mocha";
import {
  getInlineEditPrefillText,
  getMessageSelectedTextExpandedIndices,
  isMessageTextDerivedFromChipQuestions,
  toggleSelectedTextExpandedIndex,
} from "../src/modules/contextPanel/chat";
import type { Message } from "../src/modules/contextPanel/types";
import type { SelectedTextContext } from "../src/shared/types";

function chip(text: string, userQuery?: string): SelectedTextContext {
  return { text, source: "pdf", ...(userQuery ? { userQuery } : {}) };
}

function userMessage(
  text: string,
  contexts?: SelectedTextContext[],
  extra: Partial<Message> = {},
): Message {
  return {
    role: "user",
    text,
    timestamp: 1,
    selectedTextContexts: contexts,
    ...extra,
  };
}

describe("isMessageTextDerivedFromChipQuestions", function () {
  it("is true when the text equals the joined chip questions", function () {
    const message = userMessage("Why A?\n\nWhy B?", [
      chip("Alpha", "Why A?"),
      chip("Beta", "Why B?"),
    ]);
    assert.isTrue(isMessageTextDerivedFromChipQuestions(message));
  });

  it("is false when the composer text was sent", function () {
    const message = userMessage("Compare these", [
      chip("Alpha", "Why A?"),
      chip("Beta", "Why B?"),
    ]);
    assert.isFalse(isMessageTextDerivedFromChipQuestions(message));
  });

  it("is false without contexts or without chip questions", function () {
    assert.isFalse(isMessageTextDerivedFromChipQuestions(userMessage("Hi")));
    assert.isFalse(isMessageTextDerivedFromChipQuestions(userMessage("", [])));
    assert.isFalse(
      isMessageTextDerivedFromChipQuestions(userMessage("", [chip("Alpha")])),
    );
  });

  it("ignores whitespace and newline differences", function () {
    const message = userMessage("  Why A?\nWhy   B?\n", [
      chip("Alpha", "Why A?"),
      chip("Beta", "Why B?"),
    ]);
    assert.isTrue(isMessageTextDerivedFromChipQuestions(message));
  });
});

// For a chip with a question, "expanded" means its always-shown card shows
// the full selection instead of the three-line clamp. For a chip without a
// question, it still means the bar's card is open.
describe("getMessageSelectedTextExpandedIndices", function () {
  it("unclamps every question chip only when asked to (openQuestionChips)", function () {
    const message = userMessage("q", []);
    assert.deepEqual(
      getMessageSelectedTextExpandedIndices(message, [true, false, true], {
        openQuestionChips: true,
      }),
      [0, 2],
    );
  });

  it("keeps every question chip clamped by default, as the sent turn renders it", function () {
    const message = userMessage("q", []);
    assert.deepEqual(
      getMessageSelectedTextExpandedIndices(message, [true, false, true]),
      [],
    );
    assert.deepEqual(
      getMessageSelectedTextExpandedIndices(message, [true, false, true], {
        openQuestionChips: false,
      }),
      [],
    );
  });

  it("keeps the earlier single expanded chip for older turns", function () {
    const message = userMessage("q", [], { selectedTextExpandedIndex: 1 });
    assert.deepEqual(
      getMessageSelectedTextExpandedIndices(message, [true, false]),
      [1],
    );
    const legacy = userMessage("q", [], { selectedTextExpanded: true });
    assert.deepEqual(
      getMessageSelectedTextExpandedIndices(legacy, [false, false]),
      [0],
    );
  });

  it("uses the stored choice once the user toggled a chip", function () {
    const message = userMessage("q", [], {
      selectedTextExpandedIndices: [1, 5],
    });
    assert.deepEqual(
      getMessageSelectedTextExpandedIndices(message, [true, false]),
      [1],
    );
    const collapsed = userMessage("q", [], { selectedTextExpandedIndices: [] });
    assert.deepEqual(
      getMessageSelectedTextExpandedIndices(collapsed, [true, true]),
      [],
    );
  });
});

describe("toggleSelectedTextExpandedIndex", function () {
  it("clamps an unclamped question chip and unclamps one beside the others", function () {
    assert.deepEqual(
      toggleSelectedTextExpandedIndex([0, 2], 0, [true, false, true]),
      [2],
    );
    assert.deepEqual(
      toggleSelectedTextExpandedIndex([2], 0, [true, false, true]),
      [0, 2],
    );
  });

  it("keeps one plain chip open at a time, as before", function () {
    assert.deepEqual(
      toggleSelectedTextExpandedIndex([0, 1], 2, [true, false, false]),
      [0, 2],
    );
    assert.deepEqual(
      toggleSelectedTextExpandedIndex([1], 1, [false, false]),
      [],
    );
  });
});

describe("getInlineEditPrefillText", function () {
  it("starts empty when the text is only the chip questions", function () {
    const message = userMessage("Alpha", [chip("sel", "Alpha")]);
    assert.equal(getInlineEditPrefillText(message), "");
  });

  it("keeps the typed text otherwise", function () {
    const message = userMessage("My own words", [chip("sel", "Alpha")]);
    assert.equal(getInlineEditPrefillText(message), "My own words");
    assert.equal(getInlineEditPrefillText(userMessage("Hi")), "Hi");
  });
});
