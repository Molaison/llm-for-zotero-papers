import { assert } from "chai";
import {
  buildPaperDigest,
  collectPaperEvidence,
  readStoredPaperDigests,
  renderPaperDigests,
} from "../src/agent/context/paperDigests";
import type { AgentModelMessage } from "../src/agent/types";
import { estimateTextTokens } from "../src/utils/modelInputCap";

/**
 * The per-paper results of a long job: what its reads returned for each
 * paper, kept with the paper's id, its anchors and a handle to the full
 * result, within the paper's share of the input budget.
 */

function toolMessage(
  name: string,
  callId: string,
  content: unknown,
): AgentModelMessage {
  return {
    role: "tool",
    name,
    tool_call_id: callId,
    content: JSON.stringify(content),
  };
}

const paper = (itemId: number, title = `Paper ${itemId}`) => ({
  itemId,
  contextItemId: itemId + 1000,
  libraryID: 1,
  title,
});

const targetedRead = toolMessage("paper_read", "read-1", {
  mode: "targeted",
  results: [],
  papers: [
    {
      paperContext: paper(11, "Place cells drift"),
      passages: [
        {
          text: "Place fields drifted across days.",
          sectionLabel: "Results",
          pageLabel: "4",
        },
        { text: "We imaged CA1 for 30 days.", sectionLabel: "Methods" },
      ],
    },
    {
      paperContext: paper(12),
      passages: [{ text: "Synapses turn over.", sectionLabel: "Discussion" }],
    },
  ],
  quoteCitations: [
    {
      id: "Q11a",
      quoteText: "Place fields drifted across days.",
      citationLabel: "(Smith, 2021)",
      itemId: 11,
    },
    {
      id: "Q12a",
      quoteText: "Synapses turn over.",
      citationLabel: "(Lee, 2020)",
      itemId: 12,
    },
  ],
});

const overviewRead = toolMessage("paper_read", "read-2", {
  mode: "overview",
  results: [
    {
      backend: "mineru",
      coverage: "capacity_sampled",
      text: "Representational drift is gradual.",
      paperContext: paper(13),
    },
    {
      backend: "zotero_metadata",
      sourceKind: "zotero_metadata",
      coverage: "metadata_only",
      text: "Title: A paper without a PDF",
      paperContext: paper(14, "A paper without a PDF"),
    },
  ],
});

const retrieval = toolMessage("library_retrieve", "retrieve-1", {
  snippets: [
    {
      itemId: 15,
      title: "Drift scales with experience",
      sourceKind: "pdf_text",
      sectionLabel: "Introduction",
      snippet: "Experience, not time, drives drift.",
      quoteCitationId: "Q15a",
    },
  ],
  quoteCitations: [
    {
      id: "Q15a",
      quoteText: "Experience, not time, drives drift.",
      citationLabel: "(Kim, 2022)",
      itemId: 15,
    },
  ],
});

const declaration = toolMessage("task_update", "task-1", {
  parts: [{ taskId: "read-all", status: "pending", done: 0, total: 5 }],
});

describe("paper digests", function () {
  it("[digest paging repair] keeps both ends of an oversized excerpt without claiming a verbatim quote", function () {
    const conclusion = "The final conclusion is that the effect reverses.";
    const original =
      "Opening observation. " +
      "Intermediate observations. ".repeat(800) +
      conclusion;
    const digest = buildPaperDigest(
      41,
      {
        excerpts: [
          { text: original, section: "Results", page: "9", quoteId: "Q41" },
          { text: "Additional exact evidence." },
        ],
        noText: false,
        calls: [],
      },
      ["trh_original"],
      180,
    );
    assert.include(digest.excerpts[0].text, "Opening observation.");
    assert.include(digest.excerpts[0].text, conclusion);
    assert.match(digest.excerpts[0].text, /omitted/i);
    assert.notProperty(digest.excerpts[0], "quoteId");
    assert.equal(digest.omitted, 1);
    assert.isAtMost(estimateTextTokens(JSON.stringify(digest)), 180);
    const rendered = renderPaperDigests([digest]);
    assert.include(rendered, "non-verbatim");
    assert.notInclude(rendered, '"Opening observation.');
    assert.notInclude(rendered, "anchor Q41");
    assert.deepEqual(readStoredPaperDigests([digest]), [digest]);
  });

  it("[digest paging repair] does not claim legacy omitted evidence was recovered when projecting it again", function () {
    const [legacy] = readStoredPaperDigests([
      {
        itemId: 42,
        excerpts: [{ text: "Legacy visible result." }],
        omitted: 7,
        handles: ["trh_legacy"],
      },
    ]);
    const projected = buildPaperDigest(
      legacy.itemId,
      { ...legacy, noText: false, calls: [] },
      legacy.handles,
      100,
    );
    assert.equal(projected.omitted, 7);
    assert.include(
      renderPaperDigests([projected]),
      "7 more excerpts in the handle",
    );
    assert.isAtMost(estimateTextTokens(JSON.stringify(projected)), 100);
  });

  it("collects full-read summaries before exact evidence with the parent paper identity and real anchors", function () {
    const summary = "Repeated observations support gradual drift.";
    const full = toolMessage("paper_read", "read-full", {
      mode: "full",
      papers: [
        {
          paperContext: paper(31, "Full-read paper"),
          exactEvidence: [
            {
              itemId: 999,
              title: "Not the parent",
              text: "Fields changed across days.",
              sectionLabel: "Results",
              pageLabel: "7",
              quoteCitationId: "Q31a",
            },
            {
              text: "We followed the same cells.",
              sectionLabel: "Methods",
              pageIndex: 0,
            },
          ],
          digests: [
            {
              batchIndex: 0,
              chunkIndexes: [0, 1],
              digest: summary,
              itemId: 999,
              title: "Not the parent",
              quoteCitationId: "not-a-summary-anchor",
            },
            { batchIndex: 0, chunkIndexes: [0, 1], digest: summary },
          ],
        },
      ],
      quoteCitations: [
        { id: "not-a-quote", itemId: 31, quoteText: summary },
        {
          id: "Q31b",
          itemId: 31,
          quoteText: "We followed the same cells.",
        },
      ],
    });
    const evidence = collectPaperEvidence([full, full]);
    assert.sameMembers([...evidence.keys()], [31]);
    assert.deepEqual(evidence.get(31), {
      title: "Full-read paper",
      excerpts: [
        {
          text: summary,
          section: "Model summary (not a verbatim quote)",
        },
        {
          text: "Fields changed across days.",
          section: "Results",
          page: "7",
          quoteId: "Q31a",
        },
        {
          text: "We followed the same cells.",
          section: "Methods",
          page: "1",
          quoteId: "Q31b",
        },
      ],
      noText: false,
      calls: [{ name: "paper_read", callId: "read-full" }],
    });
    const stored = buildPaperDigest(31, evidence.get(31)!, ["trh_full"], 2_000);
    const rendered = renderPaperDigests([stored]);
    assert.include(rendered, "Model summary (not a verbatim quote)");
    assert.notInclude(rendered, "not-a-quote");
    assert.notInclude(rendered, "not-a-summary-anchor");
    assert.include(rendered, "Results, p. 7");
    assert.include(rendered, "anchor Q31a");
    assert.deepEqual(readStoredPaperDigests([stored]), [stored]);
  });

  it("keeps the full-read summary when long exact evidence exceeds the digest share", function () {
    const summary = "The paper reports a stable population despite cell drift.";
    const full = toolMessage("paper_read", "full-budget", {
      mode: "full",
      papers: [
        {
          paperContext: paper(32),
          exactEvidence: [{ text: "Long exact body. ".repeat(2_000) }],
          digests: [{ batchIndex: 0, chunkIndexes: [0], digest: summary }],
        },
      ],
    });
    const digest = buildPaperDigest(
      32,
      collectPaperEvidence([full]).get(32)!,
      ["trh_full_body"],
      160,
    );
    assert.deepEqual(digest.excerpts, [
      { text: summary, section: "Model summary (not a verbatim quote)" },
    ]);
    assert.equal(digest.omitted, 1);
    assert.deepEqual(digest.handles, ["trh_full_body"]);
    assert.isAtMost(estimateTextTokens(JSON.stringify(digest)), 160);
  });

  it("ignores empty or malformed full-read records and preserves legacy passages and no-text reports", function () {
    const mixed = toolMessage("paper_read", "full-mixed", {
      mode: "full",
      papers: [
        {
          paperContext: paper(33),
          status: "partial",
          digests: [null, {}, { digest: 7 }, { digest: " " }],
          exactEvidence: [null, {}, { text: 7 }, { text: " " }],
          passages: [{ text: "Legacy passage.", sectionLabel: "Results" }],
        },
        {
          paperContext: paper(34),
          status: "unreadable",
          digests: [{ error: "digest unavailable" }],
          exactEvidence: [],
        },
      ],
      results: [{ paperContext: paper(35), backend: "zotero_metadata" }],
    });
    const evidence = collectPaperEvidence([mixed]);
    assert.deepEqual(evidence.get(33)!.excerpts, [
      { text: "Legacy passage.", section: "Results" },
    ]);
    assert.deepEqual(evidence.get(34), {
      title: "Paper 34",
      excerpts: [],
      noText: false,
      calls: [{ name: "paper_read", callId: "full-mixed" }],
    });
    assert.isTrue(evidence.get(35)!.noText);
  });

  it("collects each paper's excerpts and anchors from the reads that returned them", function () {
    const evidence = collectPaperEvidence([
      declaration,
      targetedRead,
      overviewRead,
      retrieval,
    ]);
    assert.sameMembers([...evidence.keys()], [11, 12, 13, 14, 15]);
    assert.deepEqual(evidence.get(11), {
      title: "Place cells drift",
      excerpts: [
        {
          text: "Place fields drifted across days.",
          section: "Results",
          page: "4",
          quoteId: "Q11a",
        },
        { text: "We imaged CA1 for 30 days.", section: "Methods" },
      ],
      noText: false,
      calls: [{ name: "paper_read", callId: "read-1" }],
    });
    assert.deepEqual(evidence.get(13)!.excerpts, [
      { text: "Representational drift is gradual." },
    ]);
    assert.isTrue(evidence.get(14)!.noText);
    assert.deepEqual(evidence.get(14)!.excerpts, []);
    assert.deepEqual(evidence.get(15)!.excerpts, [
      {
        text: "Experience, not time, drives drift.",
        section: "Introduction",
        quoteId: "Q15a",
      },
    ]);
  });

  it("keeps a paper's id, title and handles, and as many excerpts as its share holds", function () {
    const long = toolMessage("paper_read", "read-3", {
      mode: "targeted",
      papers: [
        {
          paperContext: paper(21, "A long paper"),
          passages: Array.from({ length: 40 }, (_, index) => ({
            text: `Passage ${index} ${"about drift ".repeat(30)}`,
            sectionLabel: `Section ${index}`,
          })),
        },
      ],
    });
    const evidence = collectPaperEvidence([long]).get(21)!;
    const digest = buildPaperDigest(21, evidence, ["trh_long"], 300);
    assert.equal(digest.itemId, 21);
    assert.equal(digest.title, "A long paper");
    assert.deepEqual(digest.handles, ["trh_long"]);
    assert.isAbove(digest.excerpts.length, 0);
    assert.isBelow(digest.excerpts.length, 40);
    assert.equal(digest.omitted, 40 - digest.excerpts.length);
    assert.isAtMost(estimateTextTokens(JSON.stringify(digest)), 300);
    assert.equal(digest.excerpts[0].section, "Section 0", "in reading order");

    const tiny = buildPaperDigest(21, evidence, ["trh_long"], 1);
    assert.deepEqual(tiny.excerpts, [], "a share too small keeps the identity");
    assert.equal(tiny.omitted, 40);
    assert.deepEqual(tiny.handles, ["trh_long"]);
  });

  it("renders every paper's results with its id, anchors and handle", function () {
    const evidence = collectPaperEvidence([targetedRead, overviewRead]);
    const text = renderPaperDigests([
      buildPaperDigest(11, evidence.get(11)!, ["trh_a"], 2_000),
      buildPaperDigest(14, evidence.get(14)!, ["trh_b"], 2_000),
    ]);
    assert.include(text, "itemId=11");
    assert.include(text, "Place cells drift");
    assert.include(text, "Results");
    assert.include(text, "anchor Q11a");
    assert.include(text, "trh_a");
    assert.include(text, "itemId=14");
    assert.include(text, "no readable text");
  });

  it("reads back the digests a job recorded, and nothing that is not one", function () {
    const evidence = collectPaperEvidence([targetedRead, overviewRead]);
    const digests = [
      buildPaperDigest(11, evidence.get(11)!, ["trh_a"], 2_000),
      buildPaperDigest(14, evidence.get(14)!, ["trh_b"], 2_000),
    ];
    const stored = JSON.parse(JSON.stringify({ digests }));
    assert.deepEqual(readStoredPaperDigests(stored.digests), digests);
    assert.deepEqual(readStoredPaperDigests(undefined), []);
    assert.deepEqual(
      readStoredPaperDigests([
        { itemId: "x", excerpts: [], handles: [] },
        { itemId: 5, excerpts: "no", handles: [] },
        { itemId: 6, excerpts: [{ text: 7 }], handles: [] },
        null,
      ]),
      [{ itemId: 6, excerpts: [], handles: [] }],
      "a malformed entry is left out, a malformed excerpt dropped",
    );
  });
});
