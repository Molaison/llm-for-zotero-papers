import { assert } from "chai";
import {
  measureGrounding,
  measureSupport,
  splitSentencesForEval,
} from "./helpers/qaSupportMetrics";

describe("qaSupportMetrics", function () {
  it("splits prose into sentences and keeps CJK terminators", function () {
    const parts = splitSentencesForEval(
      "The decoder fell to 62%. Accuracy stayed at 85%! 恢复到81%。Fig. 1 shows it.",
    ).map((s) => s.text);
    assert.deepEqual(parts, [
      "The decoder fell to 62%.",
      "Accuracy stayed at 85%!",
      "恢复到81%。",
      "Fig. 1 shows it.",
    ]);
  });

  it("scores a token by overlap between its claim sentence and its quote", function () {
    const answer =
      "The fixed decoder declined from 80% to 62% by day 10 [[quote:q1]]. Behavior stayed stable [[quote:q2]].";
    const result = measureSupport(answer, [
      {
        id: "q1",
        quoteText:
          "The fixed day-1 decoder declined from 80% to 62% accuracy by day 10.",
      },
      {
        id: "q2",
        quoteText:
          "We recorded 200 tracked neurons in visual cortex from 10 adult mice.",
        anchorMatch: "passage",
      },
    ]);
    assert.equal(result.tokens.length, 2);
    assert.isAbove(result.tokens[0].overlap, 0.6);
    assert.isBelow(result.tokens[1].overlap, 0.2);
    assert.equal(result.lowOverlapTokens, 1);
    assert.equal(result.anchorMatchPassage, 1);
    assert.equal(result.anchorMatchClaim, 0);
    assert.equal(result.tokens[1].claimSentence, "Behavior stayed stable.");
  });

  it("counts substantive sentences and those carrying a known token", function () {
    const answer = [
      "# Heading",
      "Median accuracy was 84% on day 1 and 85% on day 10 [[quote:q1]].",
      "> quoted line that is excluded",
      "This second sentence has no anchor but is long enough to count.",
      "Short.",
    ].join("\n");
    assert.deepEqual(measureGrounding(answer, new Set(["q1"])), {
      sentences: 2,
      cited: 1,
    });
    assert.isNull(measureGrounding("Nothing here.", new Set()));
  });

  it("ends a sentence before a closing quotation mark", function () {
    const answer =
      'The authors write that accuracy fell by day 10." [[quote:q1]] A later sentence about mice.';
    assert.deepEqual(
      splitSentencesForEval(answer).map((s) => s.text),
      [
        'The authors write that accuracy fell by day 10."',
        "[[quote:q1]] A later sentence about mice.",
      ],
    );
    const result = measureSupport(answer, [
      { id: "q1", quoteText: "Accuracy fell by day 10 in the fixed decoder." },
    ]);
    assert.equal(result.tokens.length, 1);
    assert.equal(
      result.tokens[0].claimSentence,
      'The authors write that accuracy fell by day 10."',
    );
  });

  it("keeps a closing bracket with the sentence it ends", function () {
    const result = measureSupport(
      "Values were (84% and 85%). [[quote:q2]] Next.",
      [{ id: "q2", quoteText: "Median accuracy values were 84% and 85%." }],
    );
    assert.equal(result.tokens.length, 1);
    assert.equal(result.tokens[0].claimSentence, "Values were (84% and 85%).");
  });

  it("ends a sentence when a quote token follows it directly", function () {
    const withClosingMark = measureSupport(
      'The count dropped to day 10."[[quote:q1]] Next sentence about mice.',
      [{ id: "q1", quoteText: "The count dropped to day 10." }],
    );
    assert.equal(withClosingMark.tokens.length, 1);
    assert.equal(
      withClosingMark.tokens[0].claimSentence,
      'The count dropped to day 10."',
    );
    assert.equal(withClosingMark.tokens[0].overlap, 1);

    const bare = measureSupport("Accuracy stayed at 85%.[[quote:q2]] Next.", [
      { id: "q2", quoteText: "Accuracy stayed at 85%." },
    ]);
    assert.equal(bare.tokens.length, 1);
    assert.equal(bare.tokens[0].claimSentence, "Accuracy stayed at 85%.");
  });

  it("ends a sentence on a standalone No.", function () {
    assert.deepEqual(
      splitSentencesForEval("No. The decoder fell to 62%.").map((s) => s.text),
      ["No.", "The decoder fell to 62%."],
    );
  });

  it("binds a token written after the terminal punctuation to that sentence", function () {
    const result = measureSupport(
      "The fixed decoder declined from 80% to 62% by day 10. [[quote:q1]] Behavior stayed stable.",
      [
        {
          id: "q1",
          quoteText:
            "The fixed day-1 decoder declined from 80% to 62% accuracy by day 10.",
        },
      ],
    );
    assert.equal(result.tokens.length, 1);
    assert.equal(
      result.tokens[0].claimSentence,
      "The fixed decoder declined from 80% to 62% by day 10.",
    );
    assert.isAbove(result.tokens[0].overlap, 0.6);
  });

  it("binds a token alone on its own line to the preceding sentence", function () {
    const result = measureSupport(
      "Opening explanation with several words in it here.\n\n[[quote:q2]]",
      [
        {
          id: "q2",
          quoteText: "Opening explanation with several words in it here.",
        },
      ],
    );
    assert.equal(result.tokens.length, 1);
    assert.equal(
      result.tokens[0].claimSentence,
      "Opening explanation with several words in it here.",
    );
    assert.isAbove(result.tokens[0].overlap, 0.9);
  });

  it("credits the sentence a trailing token follows", function () {
    assert.deepEqual(
      measureGrounding(
        "Median accuracy was 84% on day 1 and 85% on day 10. [[quote:q1]]",
        new Set(["q1"]),
      ),
      { sentences: 1, cited: 1 },
    );
  });

  describe("blockquote claims", function () {
    const quote =
      "The fixed day-1 decoder declined from 80% to 62% accuracy by day 10.";
    const citations = [{ id: "q1", quoteText: quote }];
    const claimOf = (answer: string) => {
      const result = measureSupport(answer, citations);
      assert.equal(result.tokens.length, 1, "exactly one scored token");
      return result.tokens[0];
    };

    it("scores a token inside a blockquote against that block", function () {
      const token = claimOf(`The paper states:\n\n> ${quote} [[quote:q1]]`);
      assert.equal(token.claimSentence, quote);
      assert.equal(token.overlap, 1);
    });

    it("binds a lead-in sentence ending in a colon to the block below it", function () {
      const token = claimOf(`The paper states: [[quote:q1]]\n\n> ${quote}`);
      assert.equal(token.claimSentence, quote);
      assert.equal(token.overlap, 1);
    });

    it("binds a token after a block to that block", function () {
      const token = claimOf(`The paper states:\n\n> ${quote}\n\n[[quote:q1]]`);
      assert.equal(token.claimSentence, quote);
      assert.equal(token.overlap, 1);
    });

    it("treats a citation label under a block as claiming the block", function () {
      const bare = claimOf(`> ${quote}\n\n(Orion, 2025) [[quote:q1]]`);
      assert.equal(bare.claimSentence, quote);
      assert.equal(bare.overlap, 1);
      const labelled = claimOf(
        `> ${quote}\n\nSource: (Orion, 2025) [[quote:q1]]`,
      );
      assert.equal(labelled.claimSentence, quote);
      assert.equal(labelled.overlap, 1);
    });

    it("keeps a three-token sentence under a block as its own claim", function () {
      const token = claimOf(
        `> ${quote}\n\nAccuracy stayed stable [[quote:q1]].`,
      );
      assert.equal(token.claimSentence, "Accuracy stayed stable.");
    });

    it("keeps a real sentence under a block as its own claim", function () {
      const token = claimOf(
        `> ${quote}\n\nThe animals nevertheless kept their accuracy across sessions [[quote:q1]].`,
      );
      assert.equal(
        token.claimSentence,
        "The animals nevertheless kept their accuracy across sessions.",
      );
    });

    it("keeps the lead-in sentence when no block follows", function () {
      const token = claimOf(
        "The paper states: [[quote:q1]]\n\nA normal sentence follows here.",
      );
      assert.equal(token.claimSentence, "The paper states:");
    });

    it("still excludes blockquotes from the grounding sentence count", function () {
      const answer = `The paper states this clearly enough to count here: [[quote:q1]]\n\n> ${quote}`;
      assert.deepEqual(measureGrounding(answer, new Set(["q1"])), {
        sentences: 1,
        cited: 1,
      });
    });
  });

  it("excludes fenced code and table rows from the sentence count", function () {
    const answer = [
      "```",
      "const value = compute(alpha, beta, gamma, delta, epsilon, zeta);",
      "```",
      "| column one | column two | column three | column four | column five |",
      "This prose sentence is long enough to be counted on its own [[quote:q1]].",
    ].join("\n");
    assert.deepEqual(measureGrounding(answer, new Set(["q1"])), {
      sentences: 1,
      cited: 1,
    });
  });
});
