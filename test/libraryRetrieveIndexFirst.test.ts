import { assert } from "chai";
import { createRetrieveServiceRig } from "./helpers/libraryRetrieveRig";
import type {
  LibraryTextIndexFacade,
  LibraryTextIndexSearchResult,
} from "../src/services/libraryTextIndex";

function hit(
  attachmentId: number,
  parentItemId: number,
  chunkIndex: number,
  rank: number,
  text: string,
  sectionLabel = "Results",
) {
  return {
    attachmentId,
    parentItemId,
    chunkIndex,
    text,
    title: `Paper ${parentItemId}`,
    sourceType: "mineru",
    meta: { sectionLabel, chunkKind: "results" as const },
    bm25Score: 10 - rank,
    hybridScore: 10 - rank,
    rank,
    evidenceScore: 1 / (60 + rank),
    matchedTerms: ["method"],
  };
}
function paper(
  attachmentId: number,
  parentItemId: number,
  score: number,
  rank: number,
) {
  return {
    attachmentId,
    parentItemId,
    score,
    matchingChunks: 1,
    bestChunkIndex: 0,
    rank,
  };
}
const fullCoverage = (n: number) => ({
  scopeAttachments: n,
  indexed: n,
  unindexed: [],
  failed: [],
  stale: [],
});

/** A fake index whose answer depends on the queries it is asked. */
function fakeIndex(
  answer: (queries: string[]) => Partial<LibraryTextIndexSearchResult>,
): LibraryTextIndexFacade & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    isEnabled: () => true,
    async search(params) {
      calls.push(params.queries);
      return {
        chunks: [],
        papers: [],
        coverage: fullCoverage(params.scopeAttachmentIds.length),
        queryTerms: ["method"],
        timings: {},
        ...answer(params.queries),
      };
    },
  };
}

describe("library retrieve, index first (v2 rules)", function () {
  it("serves evidence from the index, skips quicksearch probes at full coverage, and never loads paper text for indexed papers", async function () {
    // rig papers: itemIds 10,20,30 with attachments 11,21,31
    const index = fakeIndex(() => ({
      chunks: [
        hit(11, 10, 3, 1, "The method is scripted."),
        hit(21, 20, 0, 2, "Abstract text.", "Abstract"),
      ],
      papers: [paper(11, 10, 9, 1), paper(21, 20, 8, 2)],
    }));
    const rig = createRetrieveServiceRig({ papers: 3, textIndex: index });
    const result = await rig.service.retrieve({
      query: "method",
      depth: "evidence",
    });
    assert.equal(rig.quicksearchCalls(), 0);
    assert.equal(rig.ensurePaperContextCalls(), 0);
    assert.lengthOf(index.calls, 1);
    assert.deepEqual(
      result.snippets.map((s) => [s.itemId, s.chunkIndex, s.matchMethod]),
      [
        ["10", 3, "bm25"],
        ["20", 0, "bm25"],
      ],
    );
    assert.equal(result.answerContract.indexedTextCoverage, "complete");
    assert.equal(result.resourcePool.queryCoverage.indexedTextScanned, 3);
    assert.isEmpty(
      result.warnings.filter((w) =>
        /not yet in the library text index/.test(w),
      ),
    );
  });

  it("runs probe reformulations against the index when the first pass is weak, without quicksearch", async function () {
    const index = fakeIndex((queries) =>
      queries.includes("scripted procedure")
        ? {
            chunks: [hit(31, 30, 1, 1, "A scripted procedure was followed.")],
            papers: [paper(31, 30, 7, 1)],
          }
        : { chunks: [], papers: [] },
    );
    const rig = createRetrieveServiceRig({
      papers: 3,
      textIndex: index,
      reformulations: [["scripted procedure"]],
      unmatchedMetadata: true,
    });
    const result = await rig.service.retrieve({
      query: "method",
      depth: "evidence",
    });
    assert.equal(
      rig.reformulationCalls(),
      2,
      "round 2 asks again because one match is still weak, gets no variants and stops",
    );
    assert.equal(
      rig.quicksearchCalls(),
      0,
      "variants go to the index, not to Zotero quicksearch",
    );
    assert.deepEqual(index.calls, [["method"], ["scripted procedure"]]);
    assert.equal(result.candidates[0].itemId, "30");
    assert.deepEqual(
      result.snippets.map((s) => s.itemId),
      ["30"],
    );
  });

  it("keeps triage on its existing trigger when the index returns far more matches than read slots", async function () {
    const index = fakeIndex(() => ({
      papers: Array.from({ length: 9 }, (_, i) =>
        paper(11 + 10 * i, 10 + 10 * i, 9 - i * 0.5, i + 1),
      ),
      chunks: Array.from({ length: 9 }, (_, i) =>
        hit(11 + 10 * i, 10 + 10 * i, 0, i + 1, `passage ${i}`),
      ),
    }));
    const rig = createRetrieveServiceRig({
      papers: 9,
      textIndex: index,
      modelConfigured: true,
    });
    await rig.service.retrieve({
      query: "method",
      depth: "evidence",
      maxFullTextPapers: 2,
    });
    assert.equal(
      rig.triageCalls(),
      1,
      "9 matches > 2 × 2 read slots triggers triage exactly as before",
    );
  });

  it("does not triage when the index match count is within the read budget", async function () {
    const index = fakeIndex(() => ({
      papers: [paper(11, 10, 9, 1)],
      chunks: [hit(11, 10, 0, 1, "p")],
    }));
    const rig = createRetrieveServiceRig({
      papers: 3,
      textIndex: index,
      modelConfigured: true,
    });
    await rig.service.retrieve({ query: "method", depth: "evidence" });
    assert.equal(rig.triageCalls(), 0);
  });

  it("reads at most five unindexed papers directly and reports the rest as unread, naming failures", async function () {
    const index = fakeIndex(() => ({
      coverage: {
        scopeAttachments: 9,
        indexed: 1,
        unindexed: [21, 31, 41, 51, 61, 71, 81, 91],
        failed: [91],
        stale: [],
      },
    }));
    const rig = createRetrieveServiceRig({ papers: 9, textIndex: index });
    const result = await rig.service.retrieve({
      query: "method",
      depth: "evidence",
    });
    assert.isAbove(
      rig.quicksearchCalls(),
      0,
      "below the coverage threshold the lexical path still runs",
    );
    assert.equal(rig.ensurePaperContextCalls(), 5);
    assert.equal(result.answerContract.indexedTextCoverage, "partial");
    assert.match(
      result.warnings.join("\n"),
      /8 paper\(s\) in scope are not yet in the library text index, 1 could not be indexed; 5 were read directly, 3 were not read\./,
    );
  });

  it("uses the index only to order the shortlist in verify mode", async function () {
    const index = fakeIndex(() => ({
      chunks: [hit(21, 20, 2, 1, "exact phrase here")],
      papers: [paper(21, 20, 9, 1)],
    }));
    const rig = createRetrieveServiceRig({ papers: 3, textIndex: index });
    const result = await rig.service.retrieve({
      query: "exact phrase here",
      depth: "verify",
      requireExact: true,
    });
    assert.equal(
      result.candidates[0].itemId,
      "20",
      "index-ranked paper leads the shortlist",
    );
    assert.isAbove(
      rig.ensurePaperContextCalls(),
      0,
      "verify still scans whole documents",
    );
  });

  it("falls back to today's path when the index is disabled or unavailable", async function () {
    const rig = createRetrieveServiceRig({
      papers: 2,
      textIndex: { isEnabled: () => true, search: async () => null },
    });
    await rig.service.retrieve({ query: "method", depth: "evidence" });
    assert.isAbove(rig.quicksearchCalls(), 0);
    assert.equal(rig.ensurePaperContextCalls(), 2);
  });

  it("gives index-served snippets the same offset and page convention as the direct path for the same chunk", async function () {
    // Without "exact", the direct path's snippet for this chunk is its BM25
    // passage (an exact hit would otherwise claim the chunk first).
    const methods = ["metadata", "abstract", "fts"] as const;
    const direct = createRetrieveServiceRig({ papers: 1 });
    const directResult = await direct.service.retrieve({
      query: "method",
      depth: "evidence",
      methods: [...methods],
    });
    const directSnippet = directResult.snippets.find(
      (s) =>
        s.itemId === "10" && s.chunkIndex === 1 && s.matchMethod === "bm25",
    );
    assert.isOk(directSnippet, "the direct path returns chunk 1 of paper 10");
    const indexedHit = hit(11, 10, 1, 1, "Chunk 1 explains the method.");
    indexedHit.meta = {
      ...indexedHit.meta,
      sourceStart: 120,
      sourceEnd: 480,
      pageStart: 3,
    } as typeof indexedHit.meta;
    const index = fakeIndex(() => ({
      chunks: [indexedHit],
      papers: [paper(11, 10, 9, 1)],
    }));
    const indexed = createRetrieveServiceRig({ papers: 1, textIndex: index });
    const indexResult = await indexed.service.retrieve({
      query: "method",
      depth: "evidence",
      methods: [...methods],
    });
    const indexSnippet = indexResult.snippets.find(
      (s) =>
        s.itemId === "10" && s.chunkIndex === 1 && s.matchMethod === "bm25",
    );
    assert.isOk(indexSnippet, "the index path returns chunk 1 of paper 10");
    assert.equal(indexed.ensurePaperContextCalls(), 0);
    const convention = (s: typeof indexSnippet) => ({
      charStart: s!.charStart,
      charEnd: s!.charEnd,
      pageLabel: s!.pageLabel,
      contextItemId: s!.contextItemId,
    });
    assert.deepEqual(convention(indexSnippet), convention(directSnippet));
  });
});
