import { assert } from "chai";
import { decodePlanContract } from "../src/agent/plans/contracts";
import {
  resolveAdaptiveReadingBudget,
  resolvePlannedReadingPapers,
} from "../src/agent/context/readingBudget";
import { resolveResearchPolicy } from "../src/agent/context/researchPolicy";
import { bindCitationEvidenceRefs } from "../src/agent/documents/citationService";
import { canonicalizePlanResearchEvidenceDepth } from "../src/agent/plans/coordinator";

const policy = resolveResearchPolicy("plan_research");

describe("narrative literature-review strategy", function () {
  it("accepts a narrative review without systematic-review eligibility criteria or a fixed paper quota", function () {
    const contract = decodePlanContract({
      investigation: {
        question: "How can behavior remain stable while representations drift?",
        subquestions: [
          { id: "mechanisms", question: "Which mechanisms are proposed?" },
        ],
        criteria: [],
        reviewMode: "narrative",
        readingStrategy: "adaptive",
        scope: { libraryID: 1, kind: "items", itemKeys: ["AAAA1111"] },
        requiredEvidenceDepth: "body",
        estimatedDeepReadPapers: 0,
        approvedLargeCorpus: false,
      },
      deliverable: { kind: "answer" },
      researchPolicy: policy,
    });

    assert.equal(contract.investigation?.reviewMode, "narrative");
    assert.equal(contract.investigation?.readingStrategy, "adaptive");
    assert.deepEqual(contract.investigation?.criteria, []);
    assert.equal(contract.investigation?.estimatedDeepReadPapers, 0);
  });

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

  it("treats adaptive reading as a body-evidence promise even with a zero quota", function () {
    const contract = canonicalizePlanResearchEvidenceDepth(
      decodePlanContract({
        investigation: {
          question: "What does this corpus show?",
          subquestions: [{ id: "q1", question: "What is the main answer?" }],
          criteria: [],
          reviewMode: "narrative",
          readingStrategy: "adaptive",
          scope: { libraryID: 1, kind: "items", itemKeys: ["AAAA1111"] },
          requiredEvidenceDepth: "abstract",
          estimatedDeepReadPapers: 0,
          approvedLargeCorpus: false,
        },
        deliverable: { kind: "answer" },
        researchPolicy: policy,
      }),
    );

    assert.equal(contract.investigation?.requiredEvidenceDepth, "body");
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

  it("offers the research execution protocol only inside an approved Plan", async function () {
    const { createResearchUpdateTool } =
      await import("../src/agent/tools/plan/researchUpdate");
    const tool = createResearchUpdateTool({} as never);
    const ordinary = {} as never;
    const approved = { planContext: { phase: "executing" } } as never;
    assert.isFalse(tool.isAvailable!(ordinary));
    assert.isFalse(tool.guidance!.matches(ordinary));
    assert.isTrue(tool.isAvailable!(approved));
    assert.isTrue(tool.guidance!.matches(approved));
    assert.include(
      tool.guidance!.instruction,
      "The literature-review skill owns the investigation loop",
    );
  });

  it("names the finalize outcome in the research_update guidance", async function () {
    const { createResearchUpdateTool } =
      await import("../src/agent/tools/plan/researchUpdate");
    const tool = createResearchUpdateTool({} as never);
    assert.include(
      tool.guidance?.instruction ?? "",
      "finalize {outcome:'complete'|'partial'|'failed'}",
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
