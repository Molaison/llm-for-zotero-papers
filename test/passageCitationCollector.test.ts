import { assert } from "chai";
import { PassageCitationCollector } from "../src/agent/context/passageCitationCollector";
import { reanchorQuoteCitationsToClaims } from "../src/services/quotes/claimAnchoring";

/** What library_retrieve delivers: the window the model reads around the
 * exact match, and the head of the same chunk, which is a different region. */
const SNIPPET = [
  "Decoder accuracy fell from 80% to 62% by day 10 in the fixed-decoder condition.",
  "The retrained decoder held at 81% across the same sessions.",
].join(" ");
const SURROUNDING_TEXT = [
  "Methods. We recorded 200 tracked neurons in visual cortex from 10 adult mice",
  "over 10 daily sessions. Imaging used a two-photon microscope at 30 Hz.",
].join(" ");

describe("PassageCitationCollector", function () {
  it("maps paper_read passages and library snippets to their citation ids", function () {
    const collector = new PassageCitationCollector();
    collector.collect({
      groups: [
        {
          passages: [
            {
              text: "Passage one text long enough to matter here.",
              quoteCitationIds: ["q1"],
            },
            { text: "Passage two text.", quoteCitationId: "q2" },
          ],
        },
      ],
      quoteCitations: [
        {
          id: "q1",
          quoteText: "Passage one text long enough to matter here.",
          citationLabel: "A 2020",
        },
        { id: "q2", quoteText: "Passage two text.", citationLabel: "A 2020" },
      ],
    });
    collector.collect({
      snippets: [
        {
          snippet: SNIPPET,
          surroundingText: SURROUNDING_TEXT,
          quoteCitationId: "q3",
        },
      ],
      quoteCitations: [
        {
          id: "q3",
          quoteText:
            "The retrained decoder held at 81% across the same sessions.",
          citationLabel: "(Orion et al., 2025)",
        },
      ],
    });
    assert.equal(
      collector.passageTextByCitationId.get("q1"),
      "Passage one text long enough to matter here.",
    );
    assert.equal(
      collector.passageTextByCitationId.get("q2"),
      "Passage two text.",
    );
    const libraryPassage = collector.passageTextByCitationId.get("q3") || "";
    assert.include(
      libraryPassage,
      SNIPPET,
      "the window the model actually read must be in the passage",
    );
    assert.include(
      libraryPassage,
      SURROUNDING_TEXT,
      "the rest of the chunk stays available as context",
    );
    assert.deepEqual(
      collector.quoteCitations.map((c) => c.id),
      ["q1", "q2", "q3"],
    );
  });

  it("lets a claim re-anchor to the snippet sentence the model read", function () {
    const collector = new PassageCitationCollector();
    collector.collect({
      snippets: [
        {
          snippet: SNIPPET,
          surroundingText: SURROUNDING_TEXT,
          quoteCitationId: "q3",
        },
      ],
      quoteCitations: [
        {
          id: "q3",
          quoteText:
            "The retrained decoder held at 81% across the same sessions.",
          citationLabel: "(Orion et al., 2025)",
        },
      ],
    });

    const { quoteCitations } = reanchorQuoteCitationsToClaims({
      text: "Accuracy fell from 80% to 62% by day 10 in the fixed-decoder condition [[quote:q3]].",
      quoteCitations: collector.quoteCitations,
      passageTextByCitationId: collector.passageTextByCitationId,
    });

    assert.equal(
      quoteCitations[0].quoteText,
      "Decoder accuracy fell from 80% to 62% by day 10 in the fixed-decoder condition.",
    );
    assert.equal(quoteCitations[0].anchorMatch, "claim");
  });
});
