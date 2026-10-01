import { assert } from "chai";
import { resolveAdaptiveReadingBudget } from "../src/agent/context/readingBudget";
import { bindCitationEvidenceRefs } from "../src/agent/documents/citationService";

describe("narrative literature-review strategy", function () {
  it("sizes reading depth from remaining model capacity and never from small, medium, or large corpus labels", function () {
    const smallWindow = resolveAdaptiveReadingBudget({
      contextWindowTokens: 128_000,
      usedContextTokens: 20_000,
      outputReserveTokens: 16_000,
      paperCount: 30,
    });
    const largeWindow = resolveAdaptiveReadingBudget({
      contextWindowTokens: 1_000_000,
      usedContextTokens: 20_000,
      outputReserveTokens: 100_000,
      paperCount: 30,
    });
    const morePapers = resolveAdaptiveReadingBudget({
      contextWindowTokens: 1_000_000,
      usedContextTokens: 20_000,
      outputReserveTokens: 100_000,
      paperCount: 60,
    });

    assert.isAbove(largeWindow.tokensPerPaper, smallWindow.tokensPerPaper);
    assert.isBelow(morePapers.tokensPerPaper, largeWindow.tokensPerPaper);
    assert.isAtMost(
      largeWindow.allocatedReadingTokens,
      largeWindow.remainingInputTokens,
    );
    assert.equal(
      largeWindow.maxCharactersPerPaper,
      largeWindow.tokensPerPaper * 4,
    );
  });
  it("gives a paper read while a long job's page is open no more than its page share", function () {
    const open = {
      contextWindowTokens: 128_000,
      usedContextTokens: 20_000,
      outputReserveTokens: 16_000,
    };
    const alone = resolveAdaptiveReadingBudget({ ...open, paperCount: 1 });
    const paged = resolveAdaptiveReadingBudget({
      ...open,
      paperCount: 1,
      maxTokensPerPaper: 6_000,
    });
    assert.isAbove(alone.tokensPerPaper, 6_000);
    assert.equal(paged.tokensPerPaper, 6_000);
    assert.equal(paged.maxCharactersPerPaper, 24_000);
    const shared = resolveAdaptiveReadingBudget({
      ...open,
      paperCount: 30,
      maxTokensPerPaper: 6_000,
    });
    assert.isBelow(
      shared.tokensPerPaper,
      6_000,
      "a smaller capacity share still wins",
    );
  });
  it("binds durable evidence to citations by paper identity without model-visible IDs", function () {
    const clusters = bindCitationEvidenceRefs(
      [
        {
          citationId: "claim-1",
          sources: [{ libraryID: 1, itemKey: "AAAA1111", evidenceRefs: [] }],
        },
      ],
      [
        {
          version: 2,
          evidenceRef: "opaque:research:evidence:1",
          observationId: "observation-1",
          libraryID: 1,
          itemKey: "AAAA1111",
          sourceKind: "body",
        },
      ],
    );

    assert.deepEqual(clusters[0].sources[0].evidenceRefs, [
      "opaque:research:evidence:1",
    ]);
  });
});
