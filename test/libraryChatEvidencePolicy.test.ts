import { assert } from "chai";
import {
  chunkKindFromSectionLabel,
  compareEvidenceCandidatesForQuestion,
  compareEvidenceCandidatesForSections,
  isBodyEvidenceSection,
  isFrontMatterSection,
  queryHasExplicitSectionPreference,
  scoreSectionPreference,
  wantedSectionKinds,
} from "../src/shared/libraryChatEvidencePolicy";
import type {
  PaperContextCandidate,
  PdfChunkKind,
} from "../src/services/paperContent/types";

function candidate(input: {
  chunkIndex: number;
  sectionLabel: string;
  evidenceScore: number;
  chunkKind?: PdfChunkKind;
}): PaperContextCandidate {
  return {
    paperKey: "1:2",
    itemId: 1,
    contextItemId: 2,
    title: "Policy Paper",
    chunkIndex: input.chunkIndex,
    chunkText: `${input.sectionLabel}\nEvidence text`,
    sectionLabel: input.sectionLabel,
    chunkKind: input.chunkKind ?? chunkKindFromSectionLabel(input.sectionLabel),
    estimatedTokens: 8,
    bm25Score: input.evidenceScore,
    embeddingScore: 0,
    hybridScore: input.evidenceScore,
    evidenceScore: input.evidenceScore,
  };
}

describe("libraryChatEvidencePolicy", function () {
  it("classifies front matter and body evidence consistently", function () {
    assert.isTrue(isFrontMatterSection("Abstract"));
    assert.isTrue(isFrontMatterSection("Highlights"));
    assert.isFalse(isFrontMatterSection("Results"));

    assert.isFalse(isBodyEvidenceSection("Abstract", "abstract"));
    assert.isFalse(isBodyEvidenceSection("References", "references"));
    assert.isTrue(isBodyEvidenceSection("Methods", "methods"));
    assert.isTrue(isBodyEvidenceSection("Results", "unknown"));
  });

  it("scores section preferences from the user question", function () {
    assert.equal(scoreSectionPreference("Compare the methods", "Methods"), 2);
    assert.equal(
      scoreSectionPreference("Compare the methods", "Results"),
      0.25,
    );
    assert.equal(
      scoreSectionPreference("What are the findings?", "Results"),
      2,
    );
    assert.equal(
      scoreSectionPreference("What are the limitations?", "Discussion"),
      2,
    );
    assert.isTrue(queryHasExplicitSectionPreference("Compare the methods"));
    assert.isFalse(
      queryHasExplicitSectionPreference("Give me a broad synthesis"),
    );
  });

  it("orders candidates by section preference before base relevance", function () {
    const rows = [
      candidate({ chunkIndex: 1, sectionLabel: "Results", evidenceScore: 0.9 }),
      candidate({ chunkIndex: 2, sectionLabel: "Methods", evidenceScore: 0.2 }),
    ];

    rows.sort(
      compareEvidenceCandidatesForQuestion(
        "Compare the methods",
        (row) => row.evidenceScore,
      ),
    );

    assert.equal(rows[0].sectionLabel, "Methods");
  });

  it("keeps English cue scoring as it was, except that a Limitations heading now counts as limitations", function () {
    const labels = [
      "Methods",
      "2.1 Experimental design",
      "Results",
      "Results and Discussion",
      "Discussion",
      "Limitations",
      "Introduction",
      "Abstract",
      "Conclusions",
      "",
    ];
    const grid: Array<[question: string, scores: number[], cued: boolean]> = [
      [
        "Compare the methods",
        [2, 2, 0.25, 0.25, 0.25, 0.25, 0.25, 0, 0.25, 0],
        true,
      ],
      [
        "What are the findings?",
        [0.25, 0.25, 2, 2, 2, 0.25, 0.25, 0, 0.25, 0],
        true,
      ],
      // Before, the plural heading missed /\blimitation\b/ and scored 0.25.
      [
        "What are the limitations?",
        [0.25, 0.25, 0.25, 2, 2, 2, 0.25, 0, 0.25, 0],
        true,
      ],
      [
        "How was the experimental setup chosen, and what were the results?",
        [2, 2, 2, 2, 2, 0.25, 0.25, 0, 0.25, 0],
        true,
      ],
      [
        "Give me a broad synthesis",
        [0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0, 0.25, 0],
        false,
      ],
    ];
    for (const [question, scores, cued] of grid) {
      assert.deepEqual(
        labels.map((label) => scoreSectionPreference(question, label)),
        scores,
        question,
      );
      assert.equal(queryHasExplicitSectionPreference(question), cued, question);
    }
  });

  describe("sections named in any language", function () {
    const question = "这些论文用了什么方法？";
    /** Two equally relevant chunks; the introduction comes first in the paper. */
    const rows = () => [
      candidate({
        chunkIndex: 1,
        sectionLabel: "Introduction",
        evidenceScore: 0.5,
      }),
      candidate({ chunkIndex: 2, sectionLabel: "Methods", evidenceScore: 0.5 }),
    ];
    const ranked = (kinds: ReturnType<typeof wantedSectionKinds>) =>
      rows()
        .sort(
          compareEvidenceCandidatesForSections(
            kinds,
            (row) => row.evidenceScore,
          ),
        )
        .map((row) => row.sectionLabel);

    it("ranks the sections the caller names first", function () {
      const kinds = wantedSectionKinds({ question, sections: ["methods"] });
      assert.deepEqual(kinds, ["methods"]);
      assert.deepEqual(ranked(kinds), ["Methods", "Introduction"]);
    });

    it("reads the cue from English query variants when the question carries none", function () {
      const kinds = wantedSectionKinds({
        question,
        queryVariants: ["methods used"],
      });
      assert.deepEqual(kinds, ["methods"]);
      assert.deepEqual(ranked(kinds), ["Methods", "Introduction"]);
    });

    it("keeps the base order when neither the question nor its variants name a section", function () {
      const kinds = wantedSectionKinds({
        question,
        queryVariants: ["survey of these papers"],
      });
      assert.deepEqual(kinds, []);
      assert.deepEqual(ranked(kinds), ["Introduction", "Methods"]);
    });

    it("leaves an English cue question as it was, and lets named sections replace its cue", function () {
      assert.deepEqual(
        wantedSectionKinds({ question: "Compare the methods" }),
        ["methods"],
      );
      assert.deepEqual(
        wantedSectionKinds({
          question: "Compare the methods",
          queryVariants: ["results"],
        }),
        ["methods"],
        "the question's own cue decides before its variants",
      );
      assert.deepEqual(
        wantedSectionKinds({
          question: "Compare the methods",
          sections: ["results", "results"],
        }),
        ["results"],
      );
    });

    it("finds limitations in discussion-like sections and captions by their chunk kind", function () {
      const sorted = (
        kinds: ReturnType<typeof wantedSectionKinds>,
        entries: PaperContextCandidate[],
      ) =>
        entries
          .sort(compareEvidenceCandidatesForSections(kinds))
          .map((row) => `${row.sectionLabel}/${row.chunkKind}`);
      assert.deepEqual(
        sorted(
          ["limitations"],
          [
            candidate({
              chunkIndex: 1,
              sectionLabel: "Introduction",
              evidenceScore: 0,
            }),
            candidate({
              chunkIndex: 2,
              sectionLabel: "Limitations",
              evidenceScore: 0,
            }),
            candidate({
              chunkIndex: 3,
              sectionLabel: "General Discussion",
              evidenceScore: 0,
            }),
          ],
        ),
        [
          "Limitations/body",
          "General Discussion/discussion",
          "Introduction/body",
        ],
      );
      assert.deepEqual(
        sorted(
          ["figure-caption"],
          [
            candidate({
              chunkIndex: 1,
              sectionLabel: "Results",
              evidenceScore: 0,
            }),
            candidate({
              chunkIndex: 2,
              sectionLabel: "Results",
              evidenceScore: 0,
              chunkKind: "figure-caption",
            }),
          ],
        ),
        ["Results/figure-caption", "Results/results"],
      );
    });
  });
});
