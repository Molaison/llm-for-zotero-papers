import { assert } from "chai";
import type { PaperContextRef } from "../src/modules/contextPanel/types";
import type {
  PaperContextCandidate,
  PdfChunkMeta,
  PdfContext,
} from "../src/services/paperContent/types";
import {
  buildEvidenceCacheKey,
  RetrievalService,
} from "../src/agent/services/retrievalService";

describe("RetrievalService", function () {
  it("keeps evidence-mode ordering instead of re-sorting by raw hybrid score", async function () {
    const paper: PaperContextRef = {
      itemId: 1,
      contextItemId: 11,
      title: "TEM",
      firstCreator: "Muller",
      year: "2020",
    };
    const pdfContext = {
      title: "Mock Paper",
      chunks: [],
      chunkMeta: [],
      chunkStats: [],
      docFreq: {},
      avgChunkLength: 0,
      fullLength: 0,
    } as PdfContext;
    const abstractCandidate: PaperContextCandidate = {
      paperKey: "1:11",
      itemId: 1,
      contextItemId: 11,
      title: "TEM",
      firstCreator: "Muller",
      year: "2020",
      chunkIndex: 0,
      chunkText:
        "Abstract\nThe paper introduces the Tolman-Eichenbaum Machine and shows it generalizes structural maps across tasks.",
      chunkKind: "abstract",
      sourceStart: 100,
      sourceEnd: 310,
      sourceFingerprint: "fnv1a32-test",
      pageStart: 5,
      pageEnd: 5,
      estimatedTokens: 18,
      bm25Score: 0.2,
      embeddingScore: 0,
      hybridScore: 0.2,
      evidenceScore: 1.1,
    };
    const captionCandidate: PaperContextCandidate = {
      paperKey: "1:11",
      itemId: 1,
      contextItemId: 11,
      title: "TEM",
      firstCreator: "Muller",
      year: "2020",
      chunkIndex: 1,
      chunkText:
        "Figure S7. The main contribution finding generalizes structural maps across tasks and environments.",
      chunkKind: "figure-caption",
      estimatedTokens: 14,
      bm25Score: 0.9,
      embeddingScore: 0,
      hybridScore: 0.9,
      evidenceScore: -0.2,
    };
    const retrieval = new RetrievalService(
      {
        ensurePaperContext: async () => pdfContext,
      } as any,
      async (_paperContext, _pdfContext, _question, _apiOverrides, options) => {
        assert.equal(options?.mode, "evidence");
        assert.equal(options?.topK, 2);
        return [captionCandidate, abstractCandidate];
      },
    );

    const results = await retrieval.retrieveEvidence({
      papers: [paper],
      question:
        "Summarize the paper in one sentence with the main contribution and finding.",
      topK: 2,
      perPaperTopK: 2,
    });

    assert.lengthOf(results, 2);
    assert.equal(results[0].chunkIndex, 0);
    assert.equal(results[0].chunkKind, "abstract");
    assert.equal(results[0].score, abstractCandidate.evidenceScore);
    assert.equal(results[0].sourceStart, 100);
    assert.equal(results[0].sourceEnd, 310);
    assert.equal(results[0].sourceFingerprint, "fnv1a32-test");
    assert.equal(results[0].pageStart, 5);
    assert.equal(results[0].pageEnd, 5);
    assert.equal(results[1].chunkIndex, 1);
    assert.equal(results[1].chunkKind, "figure-caption");
    assert.equal(results[1].score, captionCandidate.evidenceScore);
    assert.isAbove(results[0].score, results[1].score);
  });

  it("names a passage's section with the section enclosing it", async function () {
    const paper: PaperContextRef = {
      itemId: 1,
      contextItemId: 11,
      title: "Drift paper",
    };
    const passage: PaperContextCandidate = {
      paperKey: "1:11",
      itemId: 1,
      contextItemId: 11,
      title: "Drift paper",
      chunkIndex: 6,
      chunkText: "Traces were deconvolved before decoding.",
      sectionLabel: "Data analysis",
      enclosingSection: "Materials and methods",
      chunkKind: "body",
      estimatedTokens: 8,
      bm25Score: 1,
      embeddingScore: 0,
      hybridScore: 1,
      evidenceScore: 1,
    };
    const retrieval = new RetrievalService(
      {
        ensurePaperContext: async () =>
          ({
            title: "Drift paper",
            chunks: [],
            chunkMeta: [],
            chunkStats: [],
            docFreq: {},
            avgChunkLength: 0,
            fullLength: 0,
          }) as PdfContext,
      } as any,
      async () => [passage],
    );
    const results = await retrieval.retrieveEvidence({
      papers: [paper],
      question: "How were the traces analysed?",
      topK: 1,
      perPaperTopK: 1,
    });
    assert.equal(
      results[0].sectionLabel,
      "Materials and methods › Data analysis",
    );
  });

  it("passes query variants through the shared paper retrieval query plan", async function () {
    const paper: PaperContextRef = {
      itemId: 2,
      contextItemId: 22,
      title: "Variant Paper",
      firstCreator: "Chen",
      year: "2026",
    };
    const pdfContext = {
      title: "Mock Paper",
      chunks: [],
      chunkMeta: [],
      chunkStats: [],
      docFreq: {},
      avgChunkLength: 0,
      fullLength: 0,
    } as PdfContext;
    const retrieval = new RetrievalService(
      {
        ensurePaperContext: async () => pdfContext,
      } as any,
      async (_paperContext, _pdfContext, _question, _apiOverrides, options) => {
        assert.include(options?.queryPlan?.variants || [], "calcium imaging");
        assert.include(options?.queryPlan?.lexicalTerms || [], "calcium");
        assert.include(
          options?.queryPlan?.semanticQuery || "",
          "calcium imaging",
        );
        return [
          {
            paperKey: "2:22",
            itemId: 2,
            contextItemId: 22,
            title: "Variant Paper",
            chunkIndex: 0,
            chunkText: "The paper uses calcium imaging.",
            estimatedTokens: 8,
            bm25Score: 1,
            embeddingScore: 0,
            hybridScore: 1,
            evidenceScore: 1,
            matchedQueryVariant: "calcium imaging",
            matchedQueryVariants: ["calcium imaging"],
          },
        ];
      },
    );

    const results = await retrieval.retrieveEvidence({
      papers: [paper],
      question: "钙成像",
      queryVariants: ["calcium imaging"],
      topK: 1,
      perPaperTopK: 1,
    });

    assert.lengthOf(results, 1);
    assert.equal(results[0].text, "The paper uses calcium imaging.");
  });
  it("breaks a cross-paper score tie by the fused hybrid score", async function () {
    const papers: PaperContextRef[] = [
      {
        itemId: 1,
        contextItemId: 11,
        title: "Weak match",
        firstCreator: "Adams",
        year: "2021",
      },
      {
        itemId: 2,
        contextItemId: 22,
        title: "Strong match",
        firstCreator: "Baker",
        year: "2022",
      },
    ];
    const pdfContext = {
      title: "Mock Paper",
      chunks: [],
      chunkMeta: [],
      chunkStats: [],
      docFreq: {},
      avgChunkLength: 0,
      fullLength: 0,
    } as PdfContext;
    // Every paper's rank-1 chunk scores 1/61 in evidence mode, so the sort
    // used to fall through to the chunk index and rank the weakest paper's
    // early chunk first.
    const tiedScore = 1 / 61;
    const retrieval = new RetrievalService(
      {
        ensurePaperContext: async () => pdfContext,
      } as any,
      async (paperContext) => {
        const strong = paperContext.itemId === 2;
        return [
          {
            paperKey: `${paperContext.itemId}:${paperContext.contextItemId}`,
            itemId: paperContext.itemId,
            contextItemId: paperContext.contextItemId,
            title: paperContext.title || "",
            chunkIndex: strong ? 7 : 2,
            chunkText: strong
              ? "Place fields remained stable across the whole recording block."
              : "The apparatus is described in an earlier report.",
            estimatedTokens: 12,
            bm25Score: strong ? 4.2 : 0.4,
            embeddingScore: 0,
            hybridScore: strong ? 0.0161 : 0.0129,
            evidenceScore: tiedScore,
          } as PaperContextCandidate,
        ];
      },
    );

    const results = await retrieval.retrieveEvidence({
      papers,
      question: "how stable are place fields across days",
      topK: 2,
      perPaperTopK: 1,
    });

    assert.lengthOf(results, 2);
    assert.equal(results[0].chunkIndex, 7);
    assert.equal(results[0].paperContext.itemId, 2);
    assert.equal(results[1].paperContext.itemId, 1);
  });
});

describe("evidence cache key", function () {
  const paper: PaperContextRef = {
    itemId: 3,
    contextItemId: 33,
    title: "Long Paper",
    firstCreator: "Nguyen",
    year: "2026",
  };
  const PARAGRAPH =
    "The adaptive front tracking scheme moves every boundary vertex by one " +
    "explicit Euler step of the extended velocity field. ";

  /** A paper of unknown provenance: no chunk carries a sourceFingerprint. */
  function buildLongSource(chunks: string[]): PdfContext {
    return {
      title: "Long Paper",
      chunks,
      chunkMeta: chunks.map((text, chunkIndex) => ({
        chunkIndex,
        text,
        normalizedText: text.toLowerCase(),
        chunkKind: "body",
      })) as PdfChunkMeta[],
      chunkStats: [],
      docFreq: {},
      avgChunkLength: 0,
      fullLength: chunks.join("\n").length,
    } as PdfContext;
  }

  function keyFor(source: PdfContext): string {
    return buildEvidenceCacheKey({
      paper,
      queryKey: JSON.stringify(["how is the front velocity computed"]),
      perPaperTopK: 8,
      sectionIds: [],
      source,
      embeddingKey: "off",
    });
  }

  const chunks = Array.from(
    { length: 200 },
    (_, index) => `${index}. ${PARAGRAPH.repeat(10)}`,
  );

  it("stays bounded for a 200 kB paper with no chunk fingerprints", function () {
    const source = buildLongSource(chunks);
    assert.isAbove(
      source.chunks.join("\n").length,
      200_000,
      "the fixture is a 200 kB paper",
    );
    assert.isTrue(
      source.chunkMeta.every((meta) => !meta.sourceFingerprint),
      "the fixture has no chunk provenance",
    );
    assert.isBelow(keyFor(source).length, 512);
  });

  it("gives identical sources the same key and a changed chunk a new one", function () {
    assert.equal(
      keyFor(buildLongSource(chunks)),
      keyFor(buildLongSource([...chunks])),
      "the same text reuses the same evidence",
    );
    const edited = [...chunks];
    edited[7] = `${edited[7]} The mobility is frozen at the previous level.`;
    assert.notEqual(
      keyFor(buildLongSource(edited)),
      keyFor(buildLongSource(chunks)),
      "a re-parsed paper never reuses stale evidence",
    );
  });

  it("separates two sources whose chunk boundaries moved", function () {
    // Re-chunking can move a boundary across a line break and leave the
    // concatenated text unchanged; the evidence still comes from other chunks.
    const before = ["The scheme moves\nevery vertex.", "The mesh is rebuilt."];
    const after = ["The scheme moves", "every vertex.\nThe mesh is rebuilt."];
    assert.equal(
      before.join("\n"),
      after.join("\n"),
      "the fixture keeps the concatenated text identical",
    );
    assert.notEqual(
      keyFor(buildLongSource(before)),
      keyFor(buildLongSource(after)),
      "a moved chunk boundary is a different source",
    );
  });

  it("keys a source that carries no chunks instead of throwing", function () {
    assert.doesNotThrow(() => keyFor({} as PdfContext));
  });
});
