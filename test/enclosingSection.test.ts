import { assert } from "chai";
import {
  buildMarkdownPdfContext,
  headingSequenceMarkdown,
  restoreTestGlobals,
  snapshotTestGlobals,
  type TestGlobalSnapshot,
} from "./helpers/retrievalCorpus";
import {
  buildChunkMetadata,
  buildPaperRetrievalCandidates,
} from "../src/services/paperContent/pdfContext";
import { pdfTextCache } from "../src/services/paperContent/contextCache";
import {
  admitsAsBodyEvidence,
  compareEvidenceCandidatesForSections,
  isInSectionKinds,
} from "../src/shared/libraryChatEvidencePolicy";
import type { PdfContext } from "../src/services/paperContent/types";

/** Heading sequences as MinerU flattens them in the live suite's papers. */
const RATZON_LIKE = [
  "Representational drift as a result of implicit regularization",
  "Introduction",
  "Results",
  "Spontaneous sparsification in a predictive coding network",
  "Discussion",
  "Code availability",
  "Materials and methods",
  "Predictive coding task",
  "Data analysis",
  "Acknowledgements",
  "Funding",
  "References",
];
/** No Results heading: result subsections follow the introduction. */
const RULE_LIKE = [
  "Stable task information from an unstable neural population",
  "Introduction",
  "PPC representations facilitate a linear readout",
  "Representational drift is systematic and degrades a fixed readout",
  "Discussion",
  "Materials and methods",
  "Data acquisition",
  "Quantification and statistical analysis",
  "Data and code availability",
  "Acknowledgements",
  "References",
];
/** Preprint line numbers fused onto the headings, references before thanks. */
const DEVALLE_LIKE = [
  "1 Network mechanisms underlying representational drift in area CA1",
  "61 Results",
  "93 Statistical Model",
  "216 Experimental data shows signatures of network mechanisms",
  "Methods",
  "Data analysis",
  "461 Place fields",
  "609 References",
  "738 Acknowledgements",
];

function sections(ctx: PdfContext) {
  return ctx.chunkMeta.map((meta) => [
    meta.sectionLabel,
    meta.enclosingSection,
  ]);
}

describe("enclosing standard section", function () {
  let globals: TestGlobalSnapshot;
  before(function () {
    globals = snapshotTestGlobals();
  });
  after(function () {
    restoreTestGlobals(globals);
  });
  afterEach(function () {
    pdfTextCache.clear();
  });

  it("carries Methods and Results to their subsections, stops at back matter, and keeps each subsection's own title", async function () {
    const ctx = await buildMarkdownPdfContext(
      headingSequenceMarkdown(RATZON_LIKE),
      801,
    );
    assert.deepEqual(sections(ctx), [
      [RATZON_LIKE[0], undefined],
      ["Introduction", "Introduction"],
      ["Results", "Results"],
      ["Spontaneous sparsification in a predictive coding network", "Results"],
      ["Discussion", "Discussion"],
      ["Code availability", undefined],
      ["Materials and methods", "Materials and methods"],
      ["Predictive coding task", "Materials and methods"],
      ["Data analysis", "Materials and methods"],
      ["Acknowledgements", undefined],
      ["Funding", undefined],
      ["References", undefined],
    ]);
    assert.deepEqual(
      ctx.chunkMeta.map((meta) => meta.chunkKind),
      [
        "body",
        "introduction",
        "results",
        "body",
        "discussion",
        "body",
        "methods",
        "body",
        "body",
        "body",
        "body",
        "references",
      ],
      "each chunk keeps its own kind; references stay references",
    );
  });

  it("leaves text after the introduction unlabelled when no Results heading claims it", async function () {
    const ctx = await buildMarkdownPdfContext(
      headingSequenceMarkdown(RULE_LIKE),
      802,
    );
    assert.deepEqual(sections(ctx), [
      [RULE_LIKE[0], undefined],
      ["Introduction", "Introduction"],
      ["PPC representations facilitate a linear readout", undefined],
      [
        "Representational drift is systematic and degrades a fixed readout",
        undefined,
      ],
      ["Discussion", "Discussion"],
      ["Materials and methods", "Materials and methods"],
      ["Data acquisition", "Materials and methods"],
      ["Quantification and statistical analysis", "Materials and methods"],
      ["Data and code availability", undefined],
      ["Acknowledgements", undefined],
      ["References", undefined],
    ]);
  });

  it("carries a numbered Results heading across its subsections and never past references", async function () {
    const ctx = await buildMarkdownPdfContext(
      headingSequenceMarkdown(DEVALLE_LIKE),
      803,
    );
    assert.deepEqual(sections(ctx), [
      [DEVALLE_LIKE[0], undefined],
      ["61 Results", "61 Results"],
      ["93 Statistical Model", "61 Results"],
      [
        "216 Experimental data shows signatures of network mechanisms",
        "61 Results",
      ],
      ["Methods", "Methods"],
      ["Data analysis", "Methods"],
      ["461 Place fields", "Methods"],
      ["609 References", undefined],
      ["738 Acknowledgements", undefined],
    ]);
  });

  it("places a repeated running header where it occurs, so it inherits the section it interrupts", async function () {
    // Longer than the 100-character probe that locates a chunk in the text.
    const header =
      "1 Network mechanisms underlying representational drift in area CA1 of the hippocampus, as running header";
    const ctx = await buildMarkdownPdfContext(
      headingSequenceMarkdown([
        header,
        "61 Results",
        header,
        "Methods",
      ]).replace(/Passage \d+ under/g, "Passage under"),
      806,
    );
    assert.deepEqual(sections(ctx), [
      [header, undefined],
      ["61 Results", "61 Results"],
      [header, "61 Results"],
      ["Methods", "Methods"],
    ]);
    const starts = ctx.chunkMeta.map((meta) => meta.sourceStart ?? -1);
    assert.deepEqual(
      [...starts].sort((a, b) => a - b),
      starts,
      "chunks are located in document order",
    );
  });

  it("ends inheritance at a sibling heading when the markdown nests its headings", async function () {
    const markdown = `${[
      "# Drift in a nested paper",
      "## 1 Introduction",
      "## 2 Results",
      "### 2.1 Drift readout",
      "## 3 Model extensions",
      "## 4 Methods",
      "### 4.1 Data analysis",
      "## References",
    ]
      .map(
        (heading, index) =>
          `${heading}\n\nPassage ${index} under this heading reports its part of the work in plain words.`,
      )
      .join("\n\n")}\n`;
    const ctx = await buildMarkdownPdfContext(markdown, 805);
    assert.deepEqual(sections(ctx), [
      ["Drift in a nested paper", undefined],
      ["1 Introduction", "1 Introduction"],
      ["2 Results", "2 Results"],
      ["2.1 Drift readout", "2 Results"],
      ["3 Model extensions", undefined],
      ["4 Methods", "4 Methods"],
      ["4.1 Data analysis", "4 Methods"],
      ["References", undefined],
    ]);
  });

  it("counts a Data analysis subsection under Methods as methods, not results", async function () {
    const ctx = await buildMarkdownPdfContext(
      headingSequenceMarkdown(RULE_LIKE, {
        "Quantification and statistical analysis":
          "Calcium traces were deconvolved before quorvex decoding.",
        Introduction: "Drift reshapes quorvex readouts over days.",
      }),
      804,
    );
    const analysis = ctx.chunkMeta[7];
    const inKinds = (kinds: Parameters<typeof isInSectionKinds>[0]) =>
      isInSectionKinds(
        kinds,
        analysis.sectionLabel,
        analysis.chunkKind,
        analysis.enclosingSection,
      );
    assert.isTrue(inKinds(["methods"]));
    assert.isFalse(inKinds(["results"]));
    assert.isTrue(
      isInSectionKinds(["results"], analysis.sectionLabel, analysis.chunkKind),
      "the subsection title alone reads as results: the fallback",
    );

    const candidates = await buildPaperRetrievalCandidates(
      { itemId: 1, contextItemId: 804, title: "Rule-like paper" },
      ctx,
      "quorvex",
      { topK: 10, mode: "evidence" },
    );
    const byLabel = (label: string) =>
      candidates.find((candidate) => candidate.sectionLabel === label)!;
    assert.equal(
      byLabel("Quantification and statistical analysis").enclosingSection,
      "Materials and methods",
      "candidates carry the enclosing section into ranking",
    );
    const ranked = [
      byLabel("Introduction"),
      byLabel("Quantification and statistical analysis"),
    ].sort(compareEvidenceCandidatesForSections(["methods"]));
    assert.deepEqual(
      ranked.map((candidate) => candidate.sectionLabel),
      ["Quantification and statistical analysis", "Introduction"],
    );
  });

  it("stops a PDF-text section at back matter, which takes its own heading, and never lets references inherit", function () {
    const words =
      "describes the work in enough plain words to stand as a passage.";
    const meta = buildChunkMetadata(
      [
        `Introduction\nThe introduction ${words}`,
        `The introduction continues and ${words}`,
        `Methods\nThe methods section ${words}`,
        `Data analysis followed the methods and ${words}`,
        `Acknowledgements\nWe thank the funders who ${words}`,
        `More thanks to colleagues who ${words}`,
        "References\n1. Smith J (2020) A paper. Journal 1:1.\n2. Doe A (2021) Another paper. Journal 2:2.\n3. Roe B (2019) A third paper. Journal 3:3.",
      ],
      "zotero-fulltext-cache",
    );
    assert.deepEqual(
      meta.map((entry) => [
        entry.sectionLabel,
        entry.enclosingSection,
        entry.chunkKind,
      ]),
      [
        ["Introduction", "Introduction", "introduction"],
        ["Introduction", "Introduction", "introduction"],
        ["Methods", "Methods", "methods"],
        ["Methods", "Methods", "methods"],
        ["Acknowledgements", undefined, "body"],
        ["Acknowledgements", undefined, "body"],
        ["References", undefined, "references"],
      ],
    );
    assert.isFalse(
      admitsAsBodyEvidence(
        ["methods"],
        meta[6].sectionLabel,
        meta[6].chunkKind,
        meta[6].enclosingSection,
      ),
      "a reference list never competes for evidence slots",
    );
  });
});
