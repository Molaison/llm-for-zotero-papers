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
    assert.equal(labels.get("C1"), "Summaries");
    assert.equal(labels.get("C2"), "Summaries", "its first use wins");
    assert.equal(labels.get("C3"), "Open questions");
    assert.isFalse(labels.has("C9"));
    // The document's first H1 is its title, whatever the title field says.
    const other = citationSectionLabels(
      "# Drift: a review\n\nOpening [[cite:A]].\n\n## Body\n\nMore [[cite:B]].",
      "Another title",
    );
    assert.isFalse(other.has("A"));
    assert.equal(other.get("B"), "Body");
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
});
