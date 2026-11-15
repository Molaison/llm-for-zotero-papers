import { assert } from "chai";
import {
  collectAssistantOutputTexts,
  estimateTokensFromText,
  estimateTokensFromTexts,
} from "../src/utils/usageTokenEstimate";

describe("usage token estimate", function () {
  it("returns zero for empty or whitespace-only text", function () {
    assert.strictEqual(estimateTokensFromText(""), 0);
    assert.strictEqual(estimateTokensFromText("   \n\t  "), 0);
    assert.strictEqual(
      estimateTokensFromText(undefined as unknown as string),
      0,
    );
    assert.strictEqual(estimateTokensFromText(null as unknown as string), 0);
  });

  it("counts English prose at roughly one token per four characters", function () {
    // 40 characters, no CJK: 40 / 4 = 10.
    const text = "The quick brown fox jumps over the lazy.";
    assert.strictEqual(text.length, 40);
    assert.strictEqual(estimateTokensFromText(text), 10);
  });

  it("counts CJK characters at roughly one token each", function () {
    // Eight Han characters and no other characters.
    const text = "神经科学研究方法";
    assert.strictEqual(estimateTokensFromText(text), 8);
    // Hiragana, katakana and hangul are counted the same way.
    assert.strictEqual(estimateTokensFromText("ひらがな"), 4);
    assert.strictEqual(estimateTokensFromText("カタカナ"), 4);
    assert.strictEqual(estimateTokensFromText("한국어"), 3);
  });

  it("adds both buckets for mixed-script text", function () {
    // 5 Han characters + 12 other characters ("RNA-seq data") => 5 + 3.
    const text = "转录组分析RNA-seq data";
    assert.strictEqual(estimateTokensFromText(text), 5 + 3);
  });

  it("counts code by characters, like any other non-CJK text", function () {
    const code = "const total = rows.reduce((sum, r) => sum + r.n, 0);";
    assert.strictEqual(code.length, 52);
    assert.strictEqual(estimateTokensFromText(code), 13);
  });

  it("counts an astral character once, not twice", function () {
    // An emoji is one code point stored as two UTF-16 units; counting units
    // would double it. 12 other characters => 3 tokens.
    const text = "ok 🎉 done ab";
    assert.strictEqual(text.length, 13);
    assert.strictEqual(estimateTokensFromText(text), 3);
  });

  it("never reports zero tokens for text that has content", function () {
    assert.strictEqual(estimateTokensFromText("a"), 1);
    assert.strictEqual(estimateTokensFromText("ok"), 1);
  });

  it("sums a turn's messages instead of estimating them as one blob", function () {
    assert.strictEqual(estimateTokensFromTexts([]), 0);
    assert.strictEqual(
      estimateTokensFromTexts(["神经科学", "abcdefgh"]),
      4 + 2,
    );
    // Non-string and blank entries contribute nothing.
    assert.strictEqual(
      estimateTokensFromTexts([
        "神经科学",
        "   ",
        null as unknown as string,
        undefined as unknown as string,
      ]),
      4,
    );
  });
});

describe("assistant output parts", function () {
  it("counts the answer text on its own when there is no reasoning", function () {
    assert.deepStrictEqual(collectAssistantOutputTexts({ text: "answer" }), [
      "answer",
    ]);
    assert.deepStrictEqual(collectAssistantOutputTexts({}), []);
  });

  it("counts hidden reasoning as output, because the provider billed it", function () {
    const parts = collectAssistantOutputTexts({
      text: "a".repeat(40),
      reasoningSummary: "b".repeat(40),
      reasoningDetails: "c".repeat(80),
    });
    assert.deepStrictEqual(parts, [
      "a".repeat(40),
      "b".repeat(40),
      "c".repeat(80),
    ]);
    // Summed per generation: 10 + 10 + 20, never estimated over a join.
    assert.strictEqual(estimateTokensFromTexts(parts), 40);
  });

  it("ignores a reasoning field that is empty or blank", function () {
    assert.deepStrictEqual(
      collectAssistantOutputTexts({
        text: "answer",
        reasoningSummary: "   ",
        reasoningDetails: null,
      }),
      ["answer"],
    );
    assert.deepStrictEqual(
      collectAssistantOutputTexts({
        text: "",
        reasoningSummary: undefined,
        reasoningDetails: "thinking",
      }),
      ["thinking"],
    );
  });

  it("counts a summary repeated inside the details only once", function () {
    const summary = "Considering the two candidate explanations.";
    const details = `Preamble. ${summary} Then the rest of the trace.`;
    assert.deepStrictEqual(
      collectAssistantOutputTexts({
        text: "answer",
        reasoningSummary: summary,
        reasoningDetails: details,
      }),
      ["answer", details],
    );
  });

  it("treats identical summary and details as one generation", function () {
    assert.deepStrictEqual(
      collectAssistantOutputTexts({
        text: "answer",
        reasoningSummary: "thinking about it",
        reasoningDetails: "thinking about it",
      }),
      ["answer", "thinking about it"],
    );
  });

  it("keeps the longer field when the details are a fragment of the summary", function () {
    const summary = "Step one. Step two. Step three.";
    assert.deepStrictEqual(
      collectAssistantOutputTexts({
        reasoningSummary: summary,
        reasoningDetails: "Step two.",
      }),
      [summary],
    );
  });

  it("ignores whitespace differences when deciding a field is a repeat", function () {
    const summary = "weighing   the\n evidence";
    const details = `intro weighing the evidence outro`;
    assert.deepStrictEqual(
      collectAssistantOutputTexts({
        reasoningSummary: summary,
        reasoningDetails: details,
      }),
      [details],
    );
  });

  it("never drops a field that merely shares words with the other", function () {
    const parts = collectAssistantOutputTexts({
      reasoningSummary: "weighing the evidence",
      reasoningDetails: "the evidence is weak, so weighing matters",
    });
    assert.lengthOf(parts, 2);
  });
});
