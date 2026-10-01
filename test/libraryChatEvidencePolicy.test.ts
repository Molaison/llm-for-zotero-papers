import { assert } from "chai";
import {
  chunkKindFromSectionLabel,
  compareEvidenceCandidatesForSections,
  isBodyEvidenceSection,
  isFrontMatterSection,
  isInSectionKinds,
  renderSectionLabel,
  sectionLabelParts,
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

  it("orders candidates by section preference before base relevance", function () {
    const rows = [
      candidate({ chunkIndex: 1, sectionLabel: "Results", evidenceScore: 0.9 }),
      candidate({ chunkIndex: 2, sectionLabel: "Methods", evidenceScore: 0.2 }),
    ];

    rows.sort(
      compareEvidenceCandidatesForSections(
        wantedSectionKinds({ question: "Compare the methods" }),
        (row) => row.evidenceScore,
      ),
    );

    assert.equal(rows[0].sectionLabel, "Methods");
  });

  it("ranks sections by a question's English cue words: wanted sections, then labelled body, then front matter", function () {
    // Equally relevant chunks in paper order, so only section preference
    // moves them.
    const labels = [
      "Abstract",
      "Introduction",
      "Methods",
      "2.1 Experimental design",
      "4 Experiments",
      "Results",
      "Results and Discussion",
      "Discussion",
      "Limitations",
      "Conclusions",
      "",
    ];
    const ranked = (question: string) =>
      labels
        .map((sectionLabel, chunkIndex) =>
          candidate({ chunkIndex, sectionLabel, evidenceScore: 0.5 }),
        )
        .sort(
          compareEvidenceCandidatesForSections(
            wantedSectionKinds({ question }),
            (row) => row.evidenceScore,
          ),
        )
        .map((row) => row.sectionLabel);
    const unwanted = (...wanted: string[]) =>
      labels.filter(
        (label) => label && label !== "Abstract" && !wanted.includes(label),
      );
    const grid: Array<[question: string, kinds: string[], wanted: string[]]> = [
      // "4 Experiments" joins methods and results: the plural missed
      // /\bexperiment\b/ before.
      [
        "Compare the methods",
        ["methods"],
        ["Methods", "2.1 Experimental design", "4 Experiments"],
      ],
      [
        "What are the findings?",
        ["results"],
        ["4 Experiments", "Results", "Results and Discussion", "Discussion"],
      ],
      [
        "What are the limitations?",
        ["limitations"],
        ["Results and Discussion", "Discussion", "Limitations"],
      ],
      [
        "How was the experimental setup chosen, and what were the results?",
        ["methods", "results"],
        [
          "Methods",
          "2.1 Experimental design",
          "4 Experiments",
          "Results",
          "Results and Discussion",
          "Discussion",
        ],
      ],
      ["Give me a broad synthesis", [], []],
    ];
    for (const [question, kinds, wanted] of grid) {
      assert.deepEqual(wantedSectionKinds({ question }), kinds, question);
      assert.deepEqual(
        ranked(question),
        [...wanted, ...unwanted(...wanted), "Abstract", ""],
        question,
      );
    }
  });

  it("renders a chunk's section as one label: the enclosing section, then its own title when that differs", function () {
    assert.equal(
      renderSectionLabel("Data analysis", "Materials and methods"),
      "Materials and methods › Data analysis",
    );
    assert.equal(renderSectionLabel("Methods", "Methods"), "Methods");
    assert.equal(renderSectionLabel("2. Methods:", "Methods"), "Methods");
    assert.equal(renderSectionLabel(undefined, "Results"), "Results");
    assert.equal(renderSectionLabel("Data analysis"), "Data analysis");
    assert.isUndefined(renderSectionLabel(undefined, undefined));
    // A paper's own title is no section: a running header inside Results
    // reads as Results, and the title chunk as nothing.
    const title = "Network mechanisms underlying drift in area CA1";
    assert.equal(
      renderSectionLabel(
        "1 Network mechanisms underlying drift in area CA1",
        "61 Results",
        title,
      ),
      "61 Results",
    );
    assert.isUndefined(renderSectionLabel(title, undefined, title));
    assert.deepEqual(
      sectionLabelParts("Materials and methods › Data analysis"),
      {
        enclosingSection: "Materials and methods",
        sectionLabel: "Data analysis",
      },
    );
    assert.deepEqual(sectionLabelParts("Methods"), { sectionLabel: "Methods" });
    assert.deepEqual(sectionLabelParts(undefined), {});
  });

  it("never reads a paper's title chunk as a section", function () {
    const title =
      "Representational drift as a result of implicit regularization";
    assert.isTrue(
      isInSectionKinds(["results"], title, "body"),
      "the title alone reads as results",
    );
    assert.isFalse(
      isInSectionKinds(["results"], title, "body", undefined, title),
    );
    assert.isFalse(
      isInSectionKinds(
        ["results"],
        "1 Representational drift as a result of implicit regularization",
        "body",
        undefined,
        title,
      ),
      "line numbers and punctuation do not hide the title",
    );
    const rows = [
      {
        ...candidate({
          chunkIndex: 0,
          sectionLabel: title,
          evidenceScore: 0.9,
        }),
        title,
      },
      {
        ...candidate({
          chunkIndex: 5,
          sectionLabel: "Results",
          evidenceScore: 0.1,
        }),
        title,
      },
    ];
    rows.sort(
      compareEvidenceCandidatesForSections(
        ["results"],
        (row) => row.evidenceScore,
      ),
    );
    assert.equal(rows[0].sectionLabel, "Results");
  });

  it("maps a section label to one chunk kind, whole words only", function () {
    const table: Array<[label: string, kind: string]> = [
      ["Abstract", "abstract"],
      ["Introduction", "introduction"],
      ["1 Background", "introduction"],
      ["Related Work", "introduction"],
      ["Literature review", "introduction"],
      ["Materials and methods", "methods"],
      ["Methodological considerations", "methods"],
      ["Experimental design", "methods"],
      ["Results", "results"],
      ["4 Experiments", "results"],
      ["Statistical analysis", "results"],
      ["Results and Discussion", "results"],
      ["General Discussion", "discussion"],
      ["Conclusions", "conclusion"],
      ["Concluding remarks", "conclusion"],
      ["References", "references"],
      ["Acknowledgements", "body"],
      // Not results any more: "experiment" counts only as a whole word.
      ["Experimental data", "body"],
      ["", "unknown"],
    ];
    assert.deepEqual(
      table.map(([label]) => [label, chunkKindFromSectionLabel(label)]),
      table,
    );
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
          "Introduction/introduction",
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
