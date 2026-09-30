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
  answer: (
    queries: string[],
    scopeAttachmentIds: number[],
  ) => Partial<LibraryTextIndexSearchResult>,
  leading: (
    attachmentId: number,
    k: number,
  ) => ReturnType<typeof hit>[] = () => [],
): LibraryTextIndexFacade & {
  calls: string[][];
  scopes: number[][];
  leadingCalls: Array<[number, number]>;
} {
  const calls: string[][] = [];
  const scopes: number[][] = [];
  const leadingCalls: Array<[number, number]> = [];
  return {
    calls,
    scopes,
    leadingCalls,
    isEnabled: () => true,
    async leadingChunks(attachmentId, k) {
      leadingCalls.push([attachmentId, k]);
      return leading(attachmentId, k);
    },
    async search(params) {
      calls.push(params.queries);
      scopes.push(params.scopeAttachmentIds);
      return {
        chunks: [],
        papers: [],
        coverage: fullCoverage(params.scopeAttachmentIds.length),
        queryTerms: ["method"],
        timings: {},
        ...answer(params.queries, params.scopeAttachmentIds),
      };
    },
  };
}

describe("library retrieve, index first (v2 rules)", function () {
  it("serves evidence from the index at full coverage, still runs the first quicksearch pass, and never loads paper text for indexed papers", async function () {
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
    assert.isAbove(
      rig.quicksearchCalls(),
      0,
      "the first quicksearch pass always runs (notes, annotations, second PDFs)",
    );
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

  it("runs probe reformulations against the index when the first pass is weak, without quicksearch rescans", async function () {
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
    assert.isAbove(rig.quicksearchCalls(), 0, "the first pass ran");
    assert.notInclude(
      rig.quicksearchQueries(),
      "scripted procedure",
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

  it("never searches a paper the user removed from the task scope", async function () {
    const index = fakeIndex(() => ({}));
    const rig = createRetrieveServiceRig({
      papers: 3,
      collectionIds: [44],
      textIndex: index,
    });
    await rig.service.retrieve({
      query: "method",
      depth: "evidence",
      request: {
        conversationKey: 1,
        mode: "agent",
        userText: "What methods do these papers use?",
        libraryID: 1,
        selectedCollectionContexts: [
          {
            collectionId: 44,
            name: "Methods",
            libraryID: 1,
            excludedItemIds: [20],
          },
        ],
      },
    });
    assert.isNotEmpty(index.scopes);
    for (const scope of index.scopes) {
      assert.notInclude(scope, 21, "the removed paper's PDF is not searched");
    }
    assert.sameMembers(index.scopes[0], [11, 31]);
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

  it("an indexed paper the index did not rank still gets its leading body chunks as evidence", async function () {
    const index = fakeIndex(
      () => ({ chunks: [], papers: [] }),
      (attachmentId, k) =>
        Array.from({ length: Math.min(k, 2) }, (_, i) => ({
          ...hit(
            attachmentId,
            attachmentId - 1,
            i + 2,
            i + 1,
            `Body passage ${i} of ${attachmentId}.`,
          ),
          bm25Score: 0,
          hybridScore: 0,
          evidenceScore: 0,
          matchedTerms: [],
        })),
    );
    const rig = createRetrieveServiceRig({ papers: 2, textIndex: index });
    const result = await rig.service.retrieve({
      query: "overall conclusions across these papers",
      intent: "summarize",
      depth: "evidence",
    });
    assert.deepEqual(
      [...new Set(result.snippets.map((s) => s.itemId))].sort(),
      ["10", "20"],
    );
    assert.isTrue(result.snippets.every((s) => s.matchMethod === "bm25"));
    assert.isTrue(
      result.snippets.every(
        (s) =>
          s.whyMatched ===
          "Leading passage of an indexed paper (no direct match)",
      ),
      "a zero-score leading chunk never claims a BM25 match",
    );
    assert.equal(rig.ensurePaperContextCalls(), 0);
    assert.equal(result.answerContract.indexedTextCoverage, "complete");
    assert.sameMembers(
      index.leadingCalls.map(([attachmentId]) => attachmentId),
      [11, 21],
    );
  });

  it("searches the index with triage's per-paper query for that paper", async function () {
    const index = fakeIndex((queries) =>
      queries.includes("method")
        ? { chunks: [hit(21, 20, 0, 1, "p")], papers: [paper(21, 20, 9, 1)] }
        : queries.includes("grid cell firing")
          ? { chunks: [hit(31, 30, 4, 1, "Grid cells fire.")], papers: [] }
          : { chunks: [], papers: [] },
    );
    const rig = createRetrieveServiceRig({
      papers: 3,
      textIndex: index,
      unmatchedMetadata: true,
      modelConfigured: true,
      triageResult: {
        selectedItemIds: ["30"],
        perPaperQueries: { "30": "grid cell firing" },
      },
    });
    const result = await rig.service.retrieve({
      query: "method",
      depth: "evidence",
    });
    assert.equal(rig.triageCalls(), 1);
    const i = index.calls.findIndex((q) => q.includes("grid cell firing"));
    assert.isAtLeast(i, 0, "the per-paper query reached the index");
    assert.deepEqual(index.calls[i], ["grid cell firing"]);
    assert.deepEqual(index.scopes[i], [31]);
    const paper30 = result.snippets.filter((s) => s.itemId === "30");
    assert.deepEqual(
      paper30.map((s) => s.chunkIndex),
      [4],
    );
  });

  it("windows an index snippet around the matched term deep in its chunk", async function () {
    const filler = (n: number) =>
      "Background sentence about other things. ".repeat(n);
    const head = filler(40).slice(0, 1400);
    const planted = "Place cells in the hippocampus remap after training.";
    const text = (head + planted + " " + filler(20)).slice(0, 2000);
    const termAt = text.indexOf("hippocampus");
    assert.isAtLeast(termAt, 1300);
    const deepHit = {
      ...hit(11, 10, 5, 1, text),
      matchedTerms: ["hippocampus"],
    };
    const index = fakeIndex(() => ({
      chunks: [deepHit],
      papers: [paper(11, 10, 9, 1)],
    }));
    const rig = createRetrieveServiceRig({ papers: 1, textIndex: index });
    const result = await rig.service.retrieve({
      query: "hippocampus remapping",
      depth: "evidence",
    });
    const snippet = result.snippets.find(
      (s) => s.itemId === "10" && s.chunkIndex === 5,
    );
    assert.isOk(snippet);
    assert.include(snippet!.snippet, planted);
    // snippetTextAround: 360 characters either side plus the term and ellipses.
    assert.isAtMost(
      snippet!.snippet.length,
      360 * 2 + "hippocampus".length + 6,
    );
    assert.equal(snippet!.matchMethod, "bm25");
  });

  it("falls back to the query's tokens when a hit carries no matched terms, and to the chunk head when none occur", async function () {
    const text = `${"Unrelated opening words. ".repeat(60)}The entorhinal grid fires here. ${"Tail words. ".repeat(20)}`;
    const noTerms = {
      ...hit(11, 10, 2, 1, text),
      matchedTerms: [] as string[],
    };
    const headOnly = {
      ...hit(21, 20, 3, 2, `${"Plain words only. ".repeat(80)}`),
      matchedTerms: [] as string[],
    };
    const index = fakeIndex(() => ({
      chunks: [noTerms, headOnly],
      papers: [paper(11, 10, 9, 1), paper(21, 20, 8, 2)],
    }));
    const rig = createRetrieveServiceRig({ papers: 2, textIndex: index });
    const result = await rig.service.retrieve({
      query: "entorhinal grid",
      depth: "evidence",
    });
    const windowed = result.snippets.find((s) => s.itemId === "10");
    assert.include(windowed!.snippet, "The entorhinal grid fires here.");
    const head = result.snippets.find((s) => s.itemId === "20");
    assert.match(head!.snippet, /^Plain words only\./);
    assert.isAtMost(head!.snippet.length, 900);
  });
  it("still shortlists a paper that only quicksearch matches (e.g. in a child note) at full coverage", async function () {
    const index = fakeIndex(() => ({
      chunks: [hit(11, 10, 1, 1, "The method is scripted.")],
      papers: [paper(11, 10, 9, 1)],
    }));
    const rig = createRetrieveServiceRig({
      papers: 3,
      textIndex: index,
      unmatchedMetadata: true,
      quicksearchItemIds: () => [30],
    });
    const result = await rig.service.retrieve({
      query: "method",
      depth: "evidence",
    });
    assert.isAbove(rig.quicksearchCalls(), 0);
    const ids = result.candidates.map((c) => c.itemId);
    assert.include(ids, "30", "the note-only match reaches the shortlist");
    assert.include(
      result.candidates.find((c) => c.itemId === "30")!.whyMatched,
      "quicksearch",
    );
  });

  it("asks the index for every paper in scope for a comprehensive intent and reports every match (all 350 of 3,000)", async function () {
    const maxPapersAsked: number[] = [];
    const matching = (scope: number[]) => scope.slice(0, 350);
    const index = fakeIndex((_queries, scope) => {
      const all = matching(scope);
      const limit = maxPapersAsked[maxPapersAsked.length - 1];
      const papers = all
        .slice(0, limit)
        .map((attachmentId, i) =>
          paper(attachmentId, attachmentId - 1, 9 - i * 0.001, i + 1),
        );
      return { papers, totalMatchingPapers: all.length };
    });
    const search = index.search.bind(index);
    index.search = async (params) => {
      maxPapersAsked.push(params.maxPapers);
      return search(params);
    };
    const rig = createRetrieveServiceRig({ papers: 3000, textIndex: index });
    const result = await rig.service.retrieve({
      query: "method",
      intent: "enumerate",
      depth: "evidence",
    });
    assert.equal(maxPapersAsked[0], 3000, "mirrors quicksearch's scan limit");
    assert.equal(result.resourcePool.queryCoverage.indexedTextMatched, 350);
    assert.equal(result.answerContract.indexedTextCoverage, "complete");
  });

  it("reports partial coverage and the true match count when the index cut its matches (200 of 350 returned)", async function () {
    const index = fakeIndex((_queries, scope) => ({
      papers: scope
        .slice(0, 200)
        .map((attachmentId, i) =>
          paper(attachmentId, attachmentId - 1, 9 - i * 0.001, i + 1),
        ),
      totalMatchingPapers: 350,
    }));
    const rig = createRetrieveServiceRig({ papers: 3000, textIndex: index });
    const result = await rig.service.retrieve({
      query: "method",
      depth: "evidence",
    });
    assert.equal(result.resourcePool.queryCoverage.indexedTextMatched, 350);
    assert.equal(result.answerContract.indexedTextCoverage, "partial");
  });

  it("never caps direct reads of unindexed papers in verify mode", async function () {
    const index = fakeIndex((_queries, scope) => ({
      coverage: {
        scopeAttachments: scope.length,
        indexed: 0,
        unindexed: [...scope],
        failed: [],
        stale: [],
      },
    }));
    const rig = createRetrieveServiceRig({ papers: 12, textIndex: index });
    const result = await rig.service.retrieve({
      query: "method",
      depth: "verify",
      requireExact: true,
      maxFullTextPapers: 12,
    });
    assert.equal(
      rig.ensurePaperContextCalls(),
      12,
      "verify scans every shortlisted paper, indexed or not",
    );
    assert.notEqual(result.answerContract.indexedTextCoverage, "none");
  });

  it("orders merged pass hits by score before taking a paper's snippet slots", async function () {
    const index = fakeIndex((queries) =>
      queries.includes("scripted procedure")
        ? {
            chunks: [
              {
                ...hit(11, 10, 5, 1, "A scripted procedure was followed."),
                bm25Score: 9,
                hybridScore: 9,
              },
            ],
            papers: [paper(11, 10, 9, 1)],
          }
        : {
            chunks: [
              {
                ...hit(11, 10, 1, 1, "Weak mention of it."),
                bm25Score: 1,
                hybridScore: 1,
              },
            ],
            papers: [paper(11, 10, 1, 1)],
          },
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
      perPaperTopK: 1,
    });
    assert.deepEqual(
      result.snippets.filter((s) => s.itemId === "10").map((s) => s.chunkIndex),
      [5],
      "the better round-2 hit wins the paper's single slot",
    );
  });
});
