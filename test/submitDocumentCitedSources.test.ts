import { assert } from "chai";
import {
  citationSectionLabels,
  documentCitedSources,
} from "../src/agent/tools/control/submitDocument";

const MARKDOWN = [
  "# A review of drift",
  "",
  "Drift is everywhere [[cite:C0]].",
  "",
  "## Summaries",
  "",
  "Smith measured it [[cite:C1]]; others agree [[cite:C2]].",
  "",
  "## Discussion",
  "",
  "### Open questions",
  "",
  "It is unresolved [[cite:C2]] [[cite:C3]].",
].join("\n");

describe("submit_document cited sources", function () {
  it("labels each citation by the heading before its first use, never the title", function () {
    const labels = citationSectionLabels(MARKDOWN, "A review of drift");
    assert.isFalse(labels.has("C0"), "text under the title has no section");
    assert.deepEqual(labels.get("C1"), ["Summaries"]);
    assert.deepEqual(
      labels.get("C2"),
      ["Summaries", "Open questions"],
      "every section it is used in, in order",
    );
    assert.deepEqual(labels.get("C3"), ["Open questions"]);
    assert.isFalse(labels.has("C9"));
    // The document's first H1 is its title, whatever the title field says.
    const other = citationSectionLabels(
      "# Drift: a review\n\nOpening [[cite:A]].\n\n## Body\n\nMore [[cite:B]].",
      "Another title",
    );
    assert.isFalse(other.has("A"));
    assert.deepEqual(other.get("B"), ["Body"]);
  });

  it("lists every source of every cited cluster, with the item id when known", function () {
    const source = (itemKey: string) => ({
      libraryID: 1,
      itemKey,
      evidenceRefs: [],
    });
    const sources = documentCitedSources({
      markdown: MARKDOWN,
      title: "A review of drift",
      clusters: [
        { citationId: "C1", sources: [source("AAAA1111")] },
        { citationId: "C3", sources: [source("BBBB2222"), source("CCCC3333")] },
        { citationId: "UNUSED", sources: [source("DDDD4444")] },
      ],
      itemOf: (_libraryID, itemKey) =>
        itemKey === "AAAA1111"
          ? {
              itemId: 11,
              title: "Drift in the cortex",
              firstCreator: "Smith",
              year: "2021",
            }
          : undefined,
    });
    assert.deepEqual(sources, [
      {
        citationId: "C1",
        libraryID: 1,
        itemKey: "AAAA1111",
        itemId: 11,
        title: "Drift in the cortex",
        firstCreator: "Smith",
        year: "2021",
        sectionLabel: "Summaries",
      },
      {
        citationId: "C3",
        libraryID: 1,
        itemKey: "BBBB2222",
        sectionLabel: "Open questions",
      },
      {
        citationId: "C3",
        libraryID: 1,
        itemKey: "CCCC3333",
        sectionLabel: "Open questions",
      },
    ]);
  });

  it("keeps a heading after a fence that holds the other fence marker", function () {
    const labels = citationSectionLabels(
      "# Review\n\n```\n~~~\n## Not a heading [[cite:C0]]\n```\n\n## Results\n\nA [[cite:C1]].\n\n~~~md\n```\n~~~\n\n## Discussion\n\nB [[cite:C2]].",
      "Review",
    );
    assert.isFalse(labels.has("C0"), "a fenced token is not a use");
    assert.deepEqual(labels.get("C1"), ["Results"]);
    assert.deepEqual(labels.get("C2"), ["Discussion"]);
  });

  it("reads setext headings as headings", function () {
    const labels = citationSectionLabels(
      "Review\n======\n\nOpening [[cite:C0]].\n\nResults\n-------\n\nA [[cite:C1]].\n\nDiscussion\n==========\n\nB [[cite:C2]].",
      "Review",
    );
    assert.isFalse(labels.has("C0"), "the first H1 is the title");
    assert.deepEqual(labels.get("C1"), ["Results"]);
    assert.deepEqual(labels.get("C2"), ["Discussion"]);
    // A dashed line under nothing is a thematic break, not a heading.
    const rule = citationSectionLabels(
      "# Review\n\n## Results\n\n---\n\nA [[cite:C1]].",
      "Review",
    );
    assert.deepEqual(rule.get("C1"), ["Results"]);
  });

  it("lists every section of a reused citation on its source", function () {
    const [entry] = documentCitedSources({
      markdown:
        "# Review\n\n## Intro\n\nA [[cite:C1]].\n\n## Discussion\n\nB [[cite:C1]].",
      title: "Review",
      clusters: [
        {
          citationId: "C1",
          sources: [{ libraryID: 1, itemKey: "AAAA1111", evidenceRefs: [] }],
        },
      ],
    });
    assert.equal(entry.sectionLabel, "Intro");
    assert.deepEqual(entry.sectionLabels, ["Intro", "Discussion"]);
  });

  it("counts the citations quote repairs add or reuse, and papers cited only by a verified quote", function () {
    const source = (itemKey: string) => ({
      libraryID: 1,
      itemKey,
      evidenceRefs: [],
    });
    const quote = (quoteId: string, itemKey: string) => ({
      quoteId,
      text: `Text of ${quoteId}.`,
      libraryID: 1,
      itemKey,
      attachmentItemKey: `PDF-${itemKey}`,
      evidenceRefs: [],
    });
    const sources = documentCitedSources({
      // The draft as submitted: Q1 and Q2 could not be verified, Q3 was.
      markdown: [
        "# Review",
        "",
        "## Results",
        "",
        "[[quote:Q1]]",
        "",
        "## Discussion",
        "",
        "B [[cite:C1]]. They note [[quote:Q2]].",
        "",
        "## Evidence",
        "",
        "[[quote:Q3]]",
        "",
        "And [[cite:C1,C2]].",
      ].join("\n"),
      title: "Review",
      // The finalized document's clusters: cite-Q1 was added for Q1, C1 was
      // reused for Q2, and C2 came from splitting the comma-joined token.
      clusters: [
        { citationId: "C1", sources: [source("AAAA1111")] },
        { citationId: "C2", sources: [source("DDDD4444")] },
        { citationId: "cite-Q1", sources: [source("BBBB2222")] },
      ],
      quotes: [
        quote("Q1", "BBBB2222"),
        quote("Q2", "AAAA1111"),
        quote("Q3", "CCCC3333"),
      ],
      verifiedQuotes: [{ quoteId: "Q3", libraryID: 1, itemKey: "CCCC3333" }],
    });
    assert.deepEqual(
      sources.map((entry) => [
        entry.citationId,
        entry.itemKey,
        entry.sectionLabels || [entry.sectionLabel],
      ]),
      [
        ["C1", "AAAA1111", ["Discussion", "Evidence"]],
        ["C2", "DDDD4444", ["Evidence"]],
        ["cite-Q1", "BBBB2222", ["Results"]],
        ["Q3", "CCCC3333", ["Evidence"]],
      ],
    );
  });
});
