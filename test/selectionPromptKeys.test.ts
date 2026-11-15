import { assert } from "chai";
import { describe, it } from "mocha";
import { classifySelectionPromptKey } from "../src/modules/contextPanel/selectionPrompt/selectionPromptKeys";

const key = (overrides: Partial<KeyboardEvent>) =>
  ({
    key: "",
    shiftKey: false,
    isComposing: false,
    keyCode: 0,
    repeat: false,
    ...overrides,
  }) as KeyboardEvent;

describe("classifySelectionPromptKey", function () {
  it("Enter submits", () =>
    assert.equal(classifySelectionPromptKey(key({ key: "Enter" })), "submit"));
  it("Shift+Enter inserts a newline", () =>
    assert.equal(
      classifySelectionPromptKey(key({ key: "Enter", shiftKey: true })),
      "newline",
    ));
  it("Enter during IME composition is ignored", () =>
    assert.equal(
      classifySelectionPromptKey(key({ key: "Enter", isComposing: true })),
      "other",
    ));
  it("Enter with keyCode 229 (IME) is ignored", () =>
    assert.equal(
      classifySelectionPromptKey(key({ key: "Enter", keyCode: 229 })),
      "other",
    ));
  it("Escape closes", () =>
    assert.equal(classifySelectionPromptKey(key({ key: "Escape" })), "close"));
  it("Escape during IME composition is ignored", () =>
    assert.equal(
      classifySelectionPromptKey(key({ key: "Escape", isComposing: true })),
      "other",
    ));
  it("Escape with keyCode 229 (IME) is ignored", () =>
    assert.equal(
      classifySelectionPromptKey(key({ key: "Escape", keyCode: 229 })),
      "other",
    ));
  it("auto-repeated Enter and Escape are ignored", () => {
    assert.equal(
      classifySelectionPromptKey(key({ key: "Enter", repeat: true })),
      "other",
    );
    assert.equal(
      classifySelectionPromptKey(key({ key: "Escape", repeat: true })),
      "other",
    );
  });
  it("other keys pass through", () =>
    assert.equal(classifySelectionPromptKey(key({ key: "a" })), "other"));
});
