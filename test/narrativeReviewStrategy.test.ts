import { assert } from "chai";
import {
  resolveAdaptiveReadingBudget,
  resolvePlannedReadingPapers,
} from "../src/agent/context/readingBudget";
import { resolveResearchPolicy } from "../src/agent/context/researchPolicy";
import { bindCitationEvidenceRefs } from "../src/agent/documents/citationService";

const policy = resolveResearchPolicy("plan_research");

describe("narrative literature-review strategy", function () {
  it("derives adaptive full-scope reading from the frozen corpus instead of a count in the prompt", function () {
    const adaptive = {
      reviewMode: "narrative" as const,
      readingStrategy: "adaptive" as const,
      requiredEvidenceDepth: "body" as const,
      estimatedDeepReadPapers: 0,
    };
    assert.equal(resolvePlannedReadingPapers(adaptive, 7), 7);
    assert.equal(resolvePlannedReadingPapers(adaptive, 55), 55);
    assert.equal(
      resolvePlannedReadingPapers(
        {
          ...adaptive,
          readingStrategy: "selected",
          estimatedDeepReadPapers: 6,
        },
        55,
      ),
      6,
    );
  });
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
