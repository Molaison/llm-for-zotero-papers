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
