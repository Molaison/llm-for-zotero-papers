import { assert } from "chai";
import {
  buildQuoteSourceIndex,
  classifyDisplayedQuoteSource,
  type QuoteSourceResolution,
} from "../src/services/quotes/quoteCitations";
import {
  buildQuoteTextIndex,
  findQuoteSourceSpansAllowingLayoutArtifacts,
} from "../src/services/quotes/quoteTextNormalization";

const LABEL = "(Paper, 2025)";
const PRE =
  "Prior work in this field has established several results about the cortex. ";
const POST =
  " These observations were replicated across all of the animals that we tested in this study.";

function spans(source: string, quote: string) {
  return findQuoteSourceSpansAllowingLayoutArtifacts(
    buildQuoteTextIndex(source),
    quote,
  );
}

function pageIndex(source: string) {
  return buildQuoteSourceIndex({
    sourceTexts: [
      {
        sourceText: source,
        sourceLabel: LABEL,
        sourceMatchSource: "pdf-page-text",
        pageHintIndex: 3,
        contextItemId: 5,
        itemId: 4,
        sourceFingerprint: "pdfjs:x",
        requiresPageHint: true,
      },
    ],
  });
}

/** MinerU-style page-less chunks of one attachment. */
function chunkIndex(chunks: string[]) {
  return buildQuoteSourceIndex({
    sourceTexts: chunks.map((sourceText) => ({
      sourceText,
      sourceLabel: LABEL,
      sourceMatchSource: "context-text" as const,
      contextItemId: 5,
      itemId: 4,
      sourceFingerprint: "mineru:x",
      sectionLabel: "Results",
      chunkKind: "results",
      requiresPageHint: true,
    })),
  });
}

function kindOf(result: QuoteSourceResolution): string {
  return result.kind === "matched"
    ? `matched:${result.quoteCitations[0]?.sourceMatchKind}`
    : result.kind;
}

function classify(
  quoteText: string,
  sourceIndex: ReturnType<typeof buildQuoteSourceIndex>,
) {
  return kindOf(
    classifyDisplayedQuoteSource({
      quoteText,
      sourceIndex,
      sourceEvidenceComplete: true,
    }),
  );
}

describe("quote matching false negatives", function () {
  describe("(a) a quote cut mid-sentence with an added period", function () {
    const source = `${PRE}The network uses different firing patterns to encode the stimulus in sensory cortex, and this is robust across days.${POST}`;
    const quote =
      "The network uses different firing patterns to encode the stimulus in sensory cortex.";

    it("locates the source span without the added period", function () {
      const found = spans(source, quote);
      assert.lengthOf(found, 1);
      assert.match(found[0].text, /^The network uses .* sensory cortex,?$/);
    });

    it("matches the page as a normalized span, not an exact quote", function () {
      assert.equal(
        classify(quote, pageIndex(source)),
        "matched:normalized-span",
      );
    });

    it("keeps requiring the sentence end when the quote is not cut", function () {
      const complete =
        "The network uses different firing patterns to encode the stimulus in sensory cortex, and this is robust across days.";
      assert.equal(classify(complete, pageIndex(source)), "matched:exact");
    });
  });

  describe("(b) a sentence that ends in inline math", function () {
    for (const [name, tail] of [
      ["scripted fraction", "$1 / \\lambda _ { i } ^ { 2 }$ ."],
      ["subscript", "$t _ { 1 }$ ."],
      ["parenthesized", "$( x )$ ."],
      ["percent", "$5 \\%$ ."],
    ]) {
      it(`self-matches a sentence ending in ${name}`, function () {
        const sentence = `Further, the drift amplitude along each eigenvector is proportional to ${tail}`;
        const paragraph = `Earlier sentence of the paragraph. ${sentence} The next sentence begins here.`;
        const found = spans(paragraph, sentence);
        assert.lengthOf(found, 1);
        assert.isTrue(found[0].text.endsWith("."), found[0].text);
      });
    }

    it("does not swallow the opening dollar of the next formula", function () {
      const paragraph =
        "The rate depends on the activity of neurons $x$ and the gain $g$ of the circuit.";
      const found = spans(
        paragraph,
        "The rate depends on the activity of neurons",
      );
      assert.lengthOf(found, 1);
      assert.equal(
        found[0].text,
        "The rate depends on the activity of neurons",
      );
    });
  });

  describe("(e) ligature glyphs lost in PDF extraction", function () {
    for (const [name, sourceWord, quoteWord] of [
      ["ff as !", "di!erent", "different"],
      ["ffi as a double quote", 'su"cient', "sufficient"],
      ["ffi as a space", "su cient", "sufficient"],
      ["fi as !", "!ring", "firing"],
    ]) {
      it(`matches ${quoteWord} against ${name}`, function () {
        const source = `${PRE}The network uses ${sourceWord} patterns to encode the stimulus in sensory cortex.${POST}`;
        const quote = `The network uses ${quoteWord} patterns to encode the stimulus in sensory cortex.`;
        assert.lengthOf(spans(source, quote), 1);
        assert.match(classify(quote, pageIndex(source)), /^matched:/);
      });
    }

    it("does not let a gap stand for a ligature when the letters differ", function () {
      const source = `${PRE}The network uses di!erent patterns to encode the stimulus in sensory cortex.${POST}`;
      assert.lengthOf(
        spans(
          source,
          "The network uses diverent patterns to encode the stimulus in sensory cortex.",
        ),
        0,
      );
      assert.lengthOf(
        spans(
          source,
          "The network uses difficult patterns to encode the stimulus in sensory cortex.",
        ),
        0,
      );
    });
  });

  describe("(c) mismatch is judged against the best-supporting chunk", function () {
    it("does not call a real quote absent because another chunk shares words", function () {
      const quote =
        "Stable representations are stored in groups of CA1 neurons with synchronous activity across days.";
      const index = chunkIndex([
        "Stable representations are stored in groups of CAl neurons with synchronous activity across days. Other text follows here.",
        "Neurons in groups of the dentate gyrus showed unstable representations with asynchronous activity in early sessions.",
      ]);
      assert.notEqual(classify(quote, index), "absent");
    });
  });

  describe("(d) one differing token is not proof of absence", function () {
    for (const [name, sourceSentence, quote] of [
      [
        "OCR CAl for CA1",
        "Stable representations are stored in groups of CAl neurons with synchronous activity.",
        "Stable representations are stored in groups of CA1 neurons with synchronous activity.",
      ],
      [
        "ASCII um for μm",
        "Cells within 50 μm of the electrode tip were recorded in every session of the study.",
        "Cells within 50 um of the electrode tip were recorded in every session of the study.",
      ],
      [
        "editorial [visual] insertion",
        "The network uses different firing patterns to encode the stimulus in sensory cortex.",
        "The network uses different firing patterns to encode the [visual] stimulus in sensory cortex.",
      ],
    ]) {
      it(`defers instead of flagging: ${name}`, function () {
        const source = `${PRE}${sourceSentence}${POST}`;
        assert.notEqual(classify(quote, pageIndex(source)), "absent");
        assert.notEqual(classify(quote, chunkIndex([source])), "absent");
      });
    }
  });

  describe("false-positive guard", function () {
    const paper =
      "Prior work in this field has established several results about the hippocampus. We recorded 45 neurons from each mouse over 12 consecutive imaging sessions. Drift was not observed in the CA1 population across sessions when the environment was familiar. Place cells in CA1 remapped across days when the animals explored a novel environment. Population vectors decorrelated gradually, and this decorrelation was stronger in dentate gyrus than in CA3. These observations were replicated across all of the animals that we tested in this study.";
    const indexes = {
      page: () => pageIndex(paper),
      chunks: () => chunkIndex(paper.split(/(?<=\.) /)),
    };
    const mustBeAbsent: Array<[string, string]> = [
      [
        "changed number",
        "We recorded 54 neurons from each mouse over 12 consecutive imaging sessions.",
      ],
      [
        "negation added",
        "Place cells in CA1 did not remap across days when the animals explored a novel environment.",
      ],
      [
        "paraphrase with six changed words",
        "Place cells in CA1 remapped quickly across weeks whenever the mice explored a new arena.",
      ],
      [
        "invented sentence",
        "Representational drift in CA1 is driven primarily by changes in dendritic excitability across days.",
      ],
      [
        "quote from a different paper",
        "In songbirds, the premotor nucleus HVC generates sparse sequences that are stable across many weeks of singing behavior in adult zebra finches.",
      ],
    ];
    const mustNotMatch: Array<[string, string]> = [
      [
        // 3 of 15 words changed: coverage is exactly 0.8, so by the
        // one-token rule it stays unresolved (grey), never matched.
        "paraphrase with three changed words",
        "Place cells in CA1 remapped rapidly across sessions when the animals explored a novel arena.",
      ],
      [
        "two real sentences spliced",
        "We recorded 45 neurons from each mouse, and this decorrelation was stronger in dentate gyrus than in CA3.",
      ],
      [
        "negation removed",
        "Drift was observed in the CA1 population across sessions when the environment was familiar.",
      ],
      [
        "antonym",
        "Population vectors decorrelated gradually, and this decorrelation was weaker in dentate gyrus than in CA3.",
      ],
    ];
    for (const [mode, build] of Object.entries(indexes)) {
      for (const [name, quote] of mustBeAbsent) {
        it(`flags ${name} as absent (${mode})`, function () {
          assert.equal(classify(quote, build()), "absent");
        });
      }
      for (const [name, quote] of mustNotMatch) {
        it(`never matches ${name} (${mode})`, function () {
          assert.notMatch(classify(quote, build()), /^matched/);
        });
      }
    }

    it("still matches the real sentence (control)", function () {
      assert.equal(
        classify(
          "Place cells in CA1 remapped across days when the animals explored a novel environment.",
          indexes.page(),
        ),
        "matched:exact",
      );
    });
  });

  describe("review follow-ups", function () {
    const LONG =
      "The population code remained stable across the whole recording period and shifted gradually when the animals explored the second environment in the following week of testing.";
    const longSource = `${PRE}${LONG}${POST}`;

    it("flags two or more changed words in a long sentence as absent", function () {
      const quote = LONG.replace("stable", "variable").replace(
        "gradually",
        "abruptly",
      );
      assert.equal(classify(quote, pageIndex(longSource)), "absent");
    });

    it("leaves a single changed word in a long sentence unresolved", function () {
      const quote = LONG.replace("stable", "variable");
      assert.equal(classify(quote, pageIndex(longSource)), "defer");
    });

    it("flags a changed identifier that contains a digit as absent", function () {
      const source = `${PRE}Stable representations are stored in the deep sublayer of CA1 pyramidal neurons.${POST}`;
      const quote =
        "Stable representations are stored in the deep sublayer of CA3 pyramidal neurons.";
      assert.equal(classify(quote, pageIndex(source)), "absent");
    });

    it("keeps an OCR digit confusion unresolved", function () {
      const source = `${PRE}Stable representations are stored in the deep sublayer of CAl pyramidal neurons.${POST}`;
      const quote =
        "Stable representations are stored in the deep sublayer of CA1 pyramidal neurons.";
      assert.equal(classify(quote, pageIndex(source)), "defer");
    });

    it("flags a dropped negation plus one changed word as absent", function () {
      const source = `${PRE}Silencing the input did not reduce the place field stability in every animal tested.${POST}`;
      const quote =
        "Silencing the input did reduce the place field precision in every animal tested.";
      assert.equal(classify(quote, pageIndex(source)), "absent");
    });

    it("does not read a quote mark before a word as a lost ligature", function () {
      assert.lengthOf(
        spans(
          'Neurons in the "ash" layer fired.',
          "Neurons in the flash layer fired.",
        ),
        0,
      );
      assert.lengthOf(
        spans("the 'ring' was recorded.", "the firing was recorded."),
        0,
      );
      assert.lengthOf(
        spans("the !ring was recorded.", "the firing was recorded."),
        1,
      );
    });

    it("does not take the opening dollar of the next formula after a lone dollar", function () {
      const found = spans(
        "Each mouse cost $5 per day and the neurons $x$ fired.",
        "Each mouse cost $5 per day and the neurons",
      );
      assert.lengthOf(found, 1);
      assert.equal(found[0].text, "Each mouse cost $5 per day and the neurons");
    });
  });
});
