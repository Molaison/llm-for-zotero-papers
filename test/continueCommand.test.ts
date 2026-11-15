import { assert } from "chai";
import { isExplicitContinueCommand } from "../src/agent/continuation/continueCommand";

describe("explicit continue commands", function () {
  it("accepts the whole message as a continue command in either language", function () {
    for (const text of [
      "continue",
      "resume",
      "go on",
      "keep going",
      "proceed",
      "continue the plan",
      "resume the plan",
      "继续",
      "继续执行",
      "繼續",
      "繼續執行",
    ]) {
      assert.isTrue(isExplicitContinueCommand(text), text);
    }
  });

  it("ignores case, surrounding space and trailing punctuation", function () {
    for (const text of [
      "Continue",
      "  RESUME  ",
      "Go on.",
      "keep going!",
      "Proceed...",
      "continue?",
      "Continue the plan.",
      "继续。",
      "繼續！",
      "继续执行？",
      "Keep going …",
    ]) {
      assert.isTrue(isExplicitContinueCommand(text), text);
    }
  });

  it("treats any longer or different message as a new request", function () {
    for (const text of [
      "",
      "   ",
      "continue with a different question about X",
      "Please continue",
      "Can you continue?",
      "continued",
      "don't continue",
      "continue writing the summary",
      "resume the plan later",
      "What does the plan continue with?",
      "继续写",
      "请继续",
    ]) {
      assert.isFalse(isExplicitContinueCommand(text), JSON.stringify(text));
    }
  });
});
