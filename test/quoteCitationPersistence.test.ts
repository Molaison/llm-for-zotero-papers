import { assert } from "chai";
import {
  buildQuoteCitation,
  extractQuoteCitationsFromToolContent,
  mergeQuoteCitations,
  normalizeQuoteCitations,
  replaceQuoteCitationPlaceholdersForMarkdown,
} from "../src/services/quotes/quoteCitations";
import type { QuoteCitation } from "../src/shared/types";

const SHORT_ANCHOR = "Electrophysiological characterization: interneurons.";

function mintShortPaperReadAnchor(): QuoteCitation {
  // paper_read mints chunk anchors with allowShortQuoteText: true.
  const citation = buildQuoteCitation({
    quoteText: SHORT_ANCHOR,
    sourceMatchText: SHORT_ANCHOR,
    sourceMatchKind: "exact",
    sourceMatchSource: "context-text",
    citationLabel: "(Smith, 2020)",
    contextItemId: 5,
    itemId: 1,
    allowShortQuoteText: true,
  });
  assert.isDefined(citation);
  return citation!;
}

describe("quote citation persistence", function () {
  it("keeps a short paper_read anchor through merge and reload", function () {
    const citation = mintShortPaperReadAnchor();
    const merged = mergeQuoteCitations([citation]);
    assert.deepEqual(
      merged.map((entry) => entry.id),
      [citation.id],
    );
    const reloaded = normalizeQuoteCitations(
      JSON.parse(JSON.stringify(merged)),
    );
    assert.deepEqual(
      reloaded.map((entry) => entry.id),
      [citation.id],
    );
  });

  it("keeps a short paper_read anchor extracted from tool content", function () {
    const citation = mintShortPaperReadAnchor();
    const extracted = extractQuoteCitationsFromToolContent(
      JSON.stringify({ quoteCitations: [citation] }),
    );
    assert.deepEqual(
      extracted.map((entry) => entry.id),
      [citation.id],
    );
  });

  it("keeps stored citations that a later eligibility rule would reject", function () {
    // A stored row written before a filter change: it has an id, a label and
    // text, but today's worthiness rules reject its text.
    const stored = {
      id: "Q_stored1",
      quoteText:
        "# Addresses 1 Department of Engineering, University of Cambridge, Cambridge CB21PZ, United Kingdom",
      citationLabel: "(Smith, 2020)",
      sourceMatchKind: "exact",
      sourceMatchSource: "context-text",
      contextItemId: 5,
    };
    const reloaded = normalizeQuoteCitations([stored]);
    assert.deepEqual(
      reloaded.map((entry) => entry.id),
      ["Q_stored1"],
    );
    assert.deepEqual(
      mergeQuoteCitations(reloaded).map((entry) => entry.id),
      ["Q_stored1"],
    );
    assert.include(
      replaceQuoteCitationPlaceholdersForMarkdown(
        "> Addresses [[quote:Q_stored1]]",
        reloaded,
        { resolved: "preserve", unresolved: "omit" },
      ),
      "[[quote:Q_stored1]]",
    );
  });

  it("still applies every filter to tool content that is not a stored citation", function () {
    // Tool output is the boundary: a citation-shaped object there may come
    // from text a model wrote, so the full worthiness filter applies.
    const affiliation = {
      id: "Q_fabricated1",
      quoteText:
        "Department of Neuroscience, University of Example, 1 Institute Road, Boston, MA 02115",
      citationLabel: "(Smith, 2020)",
      allowShortQuoteText: true,
    };
    assert.lengthOf(extractQuoteCitationsFromToolContent(affiliation), 0);
    assert.lengthOf(
      extractQuoteCitationsFromToolContent({ quoteCitations: [affiliation] }),
      0,
    );
  });

  it("still filters stored entries that carry no match provenance", function () {
    const stored = {
      id: "Q_noprov1",
      quoteText:
        "Full article and list of author affiliations: https://doi.org/10.1126/science.adw7707",
      citationLabel: "(Liu et al., 2026)",
      contextItemId: 22,
    };
    assert.lengthOf(normalizeQuoteCitations([stored]), 0);
    assert.lengthOf(mergeQuoteCitations([stored as QuoteCitation]), 0);
  });

  it("still drops stored entries without an id, label or text", function () {
    assert.lengthOf(
      normalizeQuoteCitations([
        {
          quoteText:
            "Department of Neuroscience, University of Example, Boston, MA 02115",
          citationLabel: "(Smith, 2020)",
        },
        {
          id: "Q_nolabel1",
          quoteText: "Some stored quote text that is long enough.",
        },
        { id: "Q_notext1", quoteText: "", citationLabel: "(Smith, 2020)" },
      ]),
      0,
    );
  });
});
