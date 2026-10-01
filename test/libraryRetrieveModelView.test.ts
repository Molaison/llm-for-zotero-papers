import { assert } from "chai";
import { buildLibraryRetrieveModelView } from "../src/agent/services/libraryRetrieveModelView";
import type {
  LibraryRetrieveIntent,
  LibraryRetrievePaperMatch,
  LibraryRetrievePaperMatchStatus,
  LibraryRetrieveResult,
  LibraryRetrieveSnippet,
} from "../src/agent/services/libraryRetrieveService";
import { DEEP_SYNTHESIS_MAX_PAPERS } from "../src/shared/libraryChatReadStrategy";

type PaperSpec = {
  status: LibraryRetrievePaperMatchStatus;
  passages: number;
  /** Every passage is the paper's leading passage: nothing in it matched. */
  lead?: boolean;
};

const ROOMY = 1_000_000;

/** A full library_retrieve result over `specs`, ranked as the service ranks. */
function fullResult(
  intent: LibraryRetrieveIntent,
  specs: PaperSpec[],
  options: { strategy?: string; quotes?: boolean } = {},
): LibraryRetrieveResult {
  const paperMatches: LibraryRetrievePaperMatch[] = specs.map((spec, i) => ({
    itemId: String(i + 1),
    title: `Paper ${i + 1} on drift`,
    matchStatus: spec.status,
    basis: spec.lead ? [] : ["chunk_text", "indexed_text"],
    returnedSnippetCount: spec.passages,
    confidence: spec.status === "strong" ? "high" : "low",
    whyMatched: "library index: 4 matching passage(s)",
  }));
  const snippets: LibraryRetrieveSnippet[] = specs.flatMap((spec, i) =>
    Array.from({ length: spec.passages }, (_, k) => ({
      snippetId: `lr_${i + 1}_${100 + i + 1}_${k}_bm25`,
      itemId: String(i + 1),
      contextItemId: String(100 + i + 1),
      chunkIndex: k,
      title: `Paper ${i + 1} on drift`,
      citationLabel: `Author${i + 1}, 2020`,
      sourceLabel: `(Author${i + 1}, 2020)`,
      sourceKind: "mineru" as const,
      matchMethod: (intent === "verify" ? "exact" : "bm25") as never,
      sectionLabel: "Results",
      chunkKind: "results" as const,
      snippet: `Passage ${k} of paper ${i + 1}: drift ${"words ".repeat(60)}`,
      surroundingText: `Chunk ${k} of paper ${i + 1}. ${"context ".repeat(140)}`,
      score: 100 - i - k / 10,
      whyMatched: spec.lead
        ? "Leading passage of an indexed paper (no direct match)"
        : "Library index BM25 ranked this passage highly",
      ...(spec.lead ? { leadingPassage: true as const } : {}),
      ...(options.quotes ? { quoteCitationId: `Q_${i + 1}_${k}` } : {}),
    })),
  );
  return {
    queryPlan: {
      originalQuery: "drift",
      variants: [],
      effectiveQueries: ["drift"],
      lexicalTerms: ["drift"],
      semanticQuery: "drift",
      variantLimitHit: false,
      notes: [],
      readIntent: "targeted",
      references: [],
      quoteAnchorPolicy: "none",
    } as never,
    resourcePool: {
      type: "collection",
      name: "Corpus",
      scope: { collectionIds: [6] },
      totalItems: specs.length,
      states: {
        available: specs.length,
        metadataLoaded: specs.length,
        textAvailable: specs.length,
        textIndexed: specs.length,
        unsupported: 0,
      },
      queryCoverage: {} as never,
    },
    intent,
    depth: "evidence",
    methodsUsed: ["metadata", "fts"],
    candidates: specs.map((_, i) => ({
      itemId: String(i + 1),
      title: `Paper ${i + 1} on drift`,
      resourceState: ["available", "text_indexed"],
      queryState: ["shortlisted"],
      score: 10 - i / 100,
      whyMatched: "library index: 4 matching passage(s)",
    })),
    paperMatches,
    frontier: {
      needsSnippetExpansion: [],
      needsCloseRead: [],
      suggestedNextQueries: [],
      stopReason: "budget_limit",
    },
    answerContract: {
      resolvedStrategy: options.strategy || "evidence_overview",
      answerStyle: "enumeration",
      strategyReason: "test",
      papersPlanned: specs.length,
      papersBodyRead: specs.filter((spec) => spec.passages).length,
      papersMetadataOnly: 0,
      unreadableReasons: specs.map((_, i) => `${i + 1}: no snippet returned`),
      stopReason: "budget_limit",
      coverageFrontier: specs.map((_, i) => `${i + 1}: needs close reading`),
      metadataCoverage: "complete",
      indexedTextCoverage: "complete",
      snippetCoverage: "sampled",
      safeClaims: ["Can enumerate lexical/indexed-text matches."],
      unsafeClaims: [],
    } as never,
    coverageReceipt: { text: "Reading receipt" } as never,
    evidenceLedgerText: `Paper coverage ledger:\n${"- Paper\n".repeat(specs.length)}`,
    synthesisDigest: [
      "Paper synthesis digest:",
      ...specs.map((_, i) => `- Paper ${i + 1}: (Author${i + 1}, 2020)`),
    ].join("\n"),
    snippets,
    ...(options.quotes
      ? {
          quoteCitations: snippets.map((snippet) => ({
            id: snippet.quoteCitationId!,
            quoteText: snippet.snippet,
          })) as never,
        }
      : {}),
    warnings: [],
  };
}

function view(
  result: LibraryRetrieveResult,
  input: Record<string, number> = {},
  roomTokens = ROOMY,
) {
  const built = buildLibraryRetrieveModelView({ input, result, roomTokens });
  assert.isNotNull(built);
  return built! as {
    content: Record<string, any>;
    stored: Record<string, any>;
  };
}

const ids = (rows: Array<{ itemId: string }>) => rows.map((row) => row.itemId);
const size = (value: unknown) => JSON.stringify(value).length;

describe("library_retrieve model view", function () {
  it("verify: shows the best-matching papers' exact passages and counts the papers that matched only lexically", function () {
    const result = fullResult(
      "verify",
      [
        { status: "strong", passages: 2 },
        { status: "strong", passages: 1 },
        ...Array.from({ length: 30 }, () => ({
          status: "mentions_only" as const,
          passages: 0,
        })),
      ],
      { quotes: true },
    );
    const { content } = view(result);
    assert.deepEqual(ids(content.paperMatches), ["1", "2"]);
    assert.deepEqual(
      content.paperMatches[0],
      {
        itemId: "1",
        title: "Paper 1 on drift",
        matchStatus: "strong",
        returnedSnippetCount: 2,
      },
      "a ledger row carries the paper's id, title, status and passage count",
    );
    assert.deepEqual(
      content.snippets.map((s: LibraryRetrieveSnippet) => s.snippetId),
      ["lr_1_101_0_bm25", "lr_1_101_1_bm25", "lr_2_102_0_bm25"],
    );
    assert.deepEqual(
      Object.keys(content.snippets[0]).sort(),
      [
        "citationLabel",
        "contextItemId",
        "itemId",
        "quoteCitationId",
        "sectionLabel",
        "snippet",
        "snippetId",
      ],
      "a passage keeps what the answer cites and quotes; the chunk text, scores and match diagnostics stay behind the handle",
    );
    assert.deepEqual(
      content.quoteCitations.map((citation: { id: string }) => citation.id),
      ["Q_1_0", "Q_1_1", "Q_2_0"],
    );
    assert.deepEqual(content.omitted, {
      paperMatches: 30,
      candidates: 32,
      synthesisDigest: 32,
    });
    for (const key of [
      "candidates",
      "queryPlan",
      "synthesisDigest",
      "evidenceLedgerText",
      "coverageReceipt",
    ]) {
      assert.notProperty(content, key, `${key} stays behind the handle`);
    }
    assert.notProperty(content.answerContract, "unreadableReasons");
    assert.notProperty(content.answerContract, "coverageFrontier");
    assert.equal(content.answerContract.indexedTextCoverage, "complete");
    assert.isBelow(size(content), size(result) / 4);
  });

  it("enumerate: lists every matching paper by id and title, each with its best passage, and counts unmatched leads", function () {
    const result = fullResult("enumerate", [
      ...Array.from({ length: 40 }, () => ({
        status: "strong" as const,
        passages: 3,
      })),
      ...Array.from({ length: 60 }, () => ({
        status: "mentions_only" as const,
        passages: 0,
      })),
      ...Array.from({ length: 10 }, () => ({
        status: "not_enough_evidence" as const,
        passages: 3,
        lead: true,
      })),
    ]);
    const { content } = view(result);
    assert.lengthOf(content.paperMatches, 100, "every matching paper");
    assert.isTrue(
      content.paperMatches.every(
        (row: LibraryRetrievePaperMatch) =>
          row.itemId && row.title.startsWith("Paper "),
      ),
    );
    assert.notInclude(
      ids(content.paperMatches),
      "101",
      "a pool-fallback lead is not a matching paper",
    );
    assert.lengthOf(content.snippets, 40, "one passage per paper");
    assert.deepEqual(
      ids(content.snippets),
      Array.from({ length: 40 }, (_, i) => String(i + 1)),
    );
    assert.deepEqual(content.omitted, {
      paperMatches: 10,
      snippets: 110,
      candidates: 110,
      synthesisDigest: 110,
    });
  });

  it("summarize: reads the top papers in depth and counts the rest", function () {
    const result = fullResult(
      "summarize",
      Array.from({ length: 60 }, () => ({
        status: "strong" as const,
        passages: 3,
      })),
    );
    const { content } = view(result);
    assert.deepEqual(
      ids(content.paperMatches),
      Array.from({ length: DEEP_SYNTHESIS_MAX_PAPERS }, (_, i) =>
        String(i + 1),
      ),
    );
    assert.lengthOf(content.snippets, DEEP_SYNTHESIS_MAX_PAPERS * 3);
    assert.deepEqual(content.omitted, {
      paperMatches: 60 - DEEP_SYNTHESIS_MAX_PAPERS,
      snippets: (60 - DEEP_SYNTHESIS_MAX_PAPERS) * 3,
      candidates: 60,
      synthesisDigest: 60,
    });
  });

  it("reads a bounded synthesis's unmatched planned papers, but never a fallback's unmatched leads", function () {
    const papers: PaperSpec[] = [
      { status: "strong", passages: 2 },
      { status: "not_enough_evidence", passages: 2, lead: true },
    ];
    const bounded = view(
      fullResult("summarize", papers, { strategy: "deep_synthesis" }),
    ).content;
    assert.deepEqual(ids(bounded.paperMatches), ["1", "2"]);
    assert.isTrue(
      bounded.snippets
        .filter((s: LibraryRetrieveSnippet) => s.itemId === "2")
        .every((s: LibraryRetrieveSnippet) => s.leadingPassage === true),
      "a leading passage says so",
    );
    const fallback = view(fullResult("summarize", papers)).content;
    assert.deepEqual(ids(fallback.paperMatches), ["1"]);
    assert.deepEqual(ids(fallback.snippets), ["1", "1"]);
  });

  it("follows the caller's own per-paper and paper budgets", function () {
    const result = fullResult(
      "enumerate",
      Array.from({ length: 6 }, () => ({
        status: "strong" as const,
        passages: 3,
      })),
    );
    assert.lengthOf(view(result, { perPaperTopK: 2 }).content.snippets, 12);
    const summarize = fullResult(
      "summarize",
      Array.from({ length: 6 }, () => ({
        status: "strong" as const,
        passages: 3,
      })),
    );
    assert.deepEqual(
      ids(view(summarize, { maxSnippetPapers: 2 }).content.paperMatches),
      ["1", "2"],
    );
  });

  it("fits a small model's room: the best passages and papers stay, the rest are counted", function () {
    const result = fullResult(
      "enumerate",
      Array.from({ length: 50 }, () => ({
        status: "strong" as const,
        passages: 3,
      })),
    );
    const roomy = view(result).content;
    const tight = view(result, {}, 2_000).content;
    assert.isBelow(tight.snippets.length, roomy.snippets.length);
    assert.isAtLeast(tight.snippets.length, 1);
    assert.equal(tight.snippets[0].snippetId, roomy.snippets[0].snippetId);
    assert.deepEqual(
      ids(tight.snippets),
      ids(roomy.snippets).slice(0, tight.snippets.length),
      "passages leave from the lowest-ranked paper up",
    );
    assert.isAtMost(Math.ceil(size(tight) / 4), 2_000 + 200);
    assert.equal(
      tight.omitted.snippets,
      150 - tight.snippets.length,
      "every passage left out is counted",
    );
    assert.equal(
      tight.omitted.paperMatches || 0,
      50 - tight.paperMatches.length,
    );
    for (const passage of tight.snippets) {
      assert.include(
        ids(tight.paperMatches),
        passage.itemId,
        "a passage's paper stays in the ledger",
      );
    }
  });

  it("stores every row with the rows it shows first, so the omitted rows start at the number shown", function () {
    const result = fullResult(
      "enumerate",
      Array.from({ length: 8 }, () => ({
        status: "strong" as const,
        passages: 3,
      })),
    );
    const { content, stored } = view(result);
    assert.lengthOf(stored.snippets, result.snippets.length);
    assert.sameMembers(
      stored.snippets.map((s: LibraryRetrieveSnippet) => s.snippetId),
      result.snippets.map((s) => s.snippetId),
    );
    assert.deepEqual(
      stored.snippets
        .slice(0, content.snippets.length)
        .map((s: LibraryRetrieveSnippet) => s.snippetId),
      content.snippets.map((s: LibraryRetrieveSnippet) => s.snippetId),
    );
    assert.deepEqual(
      stored.snippets[0],
      result.snippets[0],
      "a stored row is the whole row",
    );
    assert.deepEqual(stored.candidates, result.candidates);
    assert.equal(stored.synthesisDigest, result.synthesisDigest);
    assert.deepEqual(
      ids(stored.paperMatches).slice(0, content.paperMatches.length),
      ids(content.paperMatches),
    );
    // A verify ledger skips a paper the snippet budget never reached, so
    // its rows are not the full ledger's first rows until stored that way.
    const verify = view(
      fullResult("verify", [
        { status: "strong", passages: 0 },
        { status: "possible", passages: 1 },
      ]),
    );
    assert.deepEqual(ids(verify.content.paperMatches), ["2"]);
    assert.deepEqual(ids(verify.stored.paperMatches), ["2", "1"]);
  });
});
