import { assert } from "chai";
import {
  buildQuoteCitation,
  finalizeAssistantQuoteCitations,
} from "../src/services/quotes/quoteCitations";

describe("quote finalization diagnostics", function () {
  const citation = buildQuoteCitation({
    id: "Q_known1",
    quoteText:
      "Place cells in CA1 remapped across days when the animals explored a novel environment.",
    citationLabel: "(Example et al., 2024)",
    sourceMatchKind: "exact",
    sourceMatchSource: "context-text",
    contextItemId: 12,
    itemId: 11,
  })!;

  it("reports paragraph citation ids that finalization removes", function () {
    const finalized = finalizeAssistantQuoteCitations({
      markdown:
        "Place fields changed over days. [[cite:Q_known1, Q_missing2; not-an-id]]",
      quoteCitations: [citation],
    });
    assert.include(finalized.markdown, "[[cite:Q_known1]]");
    assert.notInclude(finalized.markdown, "Q_missing2");
    assert.sameMembers(finalized.droppedParagraphCitationIds || [], [
      "Q_missing2",
      "not-an-id",
    ]);
  });

  it("omits the diagnostic when every paragraph citation is kept", function () {
    const finalized = finalizeAssistantQuoteCitations({
      markdown: "Place fields changed over days. [[cite:Q_known1]]",
      quoteCitations: [citation],
    });
    assert.notProperty(finalized, "droppedParagraphCitationIds");
  });
});
