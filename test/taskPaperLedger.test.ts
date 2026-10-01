import { assert } from "chai";
import fs from "node:fs";
import path from "node:path";
import {
  TASK_PAPER_LEDGER_TOOL_NAMES,
  TASK_PAPER_MAX_CITATIONS_PER_TURN,
  TASK_PAPER_MAX_PAPERS,
  TASK_PAPER_MAX_READS_PER_TURN,
  applyFinalCitations,
  applyTaskPaperLedgerDelta,
  createTaskPaperLedger,
  deriveTaskPaperLedgerDelta,
  type TaskPaperLedgerDelta,
} from "../src/agent/context/taskPaperLedger";
import { createTrustedReadObservations } from "../src/agent/context/readObservation";
import type { QuoteCitation } from "../src/shared/types";

function derive(
  toolName: string,
  input: unknown,
  content: unknown,
  extra: Partial<Parameters<typeof deriveTaskPaperLedgerDelta>[0]> = {},
): TaskPaperLedgerDelta {
  const delta = deriveTaskPaperLedgerDelta({
    toolName,
    callId: extra.callId || "call-1",
    input,
    content,
    libraryID: 1,
    ...extra,
  });
  assert.isNotNull(delta, `${toolName} should derive a delta`);
  return delta!;
}

function paperState(delta: TaskPaperLedgerDelta, key: string) {
  return delta.papers.find((paper) => paper.key === key)?.state;
}

function readsFor(delta: TaskPaperLedgerDelta, key: string) {
  return delta.reads.filter((read) => read.key === key);
}

/** A library_retrieve payload shaped like LibraryRetrieveService.retrieve. */
function libraryRetrieveFixture() {
  return {
    resourcePool: { type: "collection", scope: { libraryID: 3 } },
    candidates: [
      {
        itemId: "101",
        title: "Place cell drift",
        year: "2021",
        creators: ["Smith"],
        resourceState: ["available", "metadata_loaded", "text_indexed"],
        queryState: ["matched_bm25", "shortlisted"],
        score: 3,
        whyMatched: "title and abstract mention representational drift",
      },
      {
        itemId: "102",
        title: "Learning rules",
        resourceState: ["available", "metadata_loaded", "unsupported"],
        queryState: ["matched_metadata"],
        score: 1,
        whyMatched: "tag match",
      },
      {
        itemId: "103",
        title: "Abstract only",
        resourceState: ["available", "metadata_loaded"],
        queryState: ["matched_bm25"],
        score: 1,
        whyMatched: "abstract",
      },
      {
        itemId: "104",
        title: "Mineru paper",
        resourceState: ["available", "text_available"],
        queryState: ["matched_bm25", "content_loaded", "snippet_returned"],
        score: 2,
        whyMatched: "body",
      },
    ],
    paperMatches: [
      {
        itemId: "101",
        title: "Place cell drift",
        matchStatus: "strong",
        basis: ["chunk_text"],
        returnedSnippetCount: 1,
        confidence: "high",
        whyMatched: "body",
      },
      {
        itemId: "105",
        title: "Only a paper match",
        matchStatus: "weak",
        basis: ["metadata"],
        returnedSnippetCount: 0,
        confidence: "low",
        whyMatched: "venue",
      },
    ],
    snippets: [
      {
        snippetId: "s1",
        itemId: "101",
        contextItemId: "201",
        title: "Place cell drift",
        sourceKind: "pdf_text",
        matchMethod: "bm25",
        sectionLabel: "Methods §2.3",
        snippet: "Cells drifted over weeks.",
        score: 2,
        whyMatched: "bm25 hit",
      },
      {
        snippetId: "s2",
        itemId: "103",
        title: "Abstract only",
        sourceKind: "abstract",
        matchMethod: "bm25",
        snippet: "We study drift.",
        score: 1,
        whyMatched: "abstract",
      },
      {
        snippetId: "s3",
        itemId: "104",
        contextItemId: "204",
        title: "Mineru paper",
        sourceKind: "mineru",
        matchMethod: "exact",
        snippet: "Exact drift phrase.",
        score: 1,
        whyMatched: "exact",
      },
      {
        snippetId: "s4",
        itemId: "106",
        title: "No text",
        sourceKind: "pdf_text",
        matchMethod: "bm25",
        snippet: "   ",
        score: 0,
        whyMatched: "",
      },
    ],
    warnings: [],
  };
}

describe("taskPaperLedger", function () {
  describe("deriveTaskPaperLedgerDelta", function () {
    it("maps library_retrieve rows to matched, skimmed and read", function () {
      const delta = derive(
        "library_retrieve",
        { query: "drift" },
        libraryRetrieveFixture(),
        { runId: "run-1", turnIndex: 2 },
      );
      assert.equal(delta.callId, "call-1");
      assert.equal(delta.runId, "run-1");
      assert.equal(delta.turnIndex, 2);
      // The retrieval's own scope library wins over the call's fallback.
      assert.equal(paperState(delta, "3:101"), "read");
      assert.equal(paperState(delta, "3:102"), "matched");
      assert.equal(paperState(delta, "3:103"), "skimmed");
      assert.equal(paperState(delta, "3:104"), "read");
      assert.equal(paperState(delta, "3:105"), "matched");
      assert.isUndefined(
        paperState(delta, "3:106"),
        "a snippet row with no text is not a read",
      );

      const p101 = delta.papers.find((paper) => paper.key === "3:101")!;
      assert.include(p101, {
        itemId: 101,
        libraryID: 3,
        contextItemId: 201,
        title: "Place cell drift",
        year: "2021",
        creator: "Smith",
        // The body snippet names its extraction, more specific than the index.
        text: "pdf_text",
      });
      assert.equal(
        delta.papers.find((paper) => paper.key === "3:104")!.text,
        "mineru",
      );
      assert.equal(
        delta.papers.find((paper) => paper.key === "3:102")!.text,
        "none",
      );

      const reads101 = readsFor(delta, "3:101");
      assert.deepEqual(
        reads101.map((read) => [read.granularity, read.method, read.label]),
        [
          ["metadata", "bm25", undefined],
          ["section", "bm25", "Methods §2.3"],
        ],
        "a paperMatch for a known candidate adds no second metadata read",
      );
      assert.equal(reads101[1].snippet, "Cells drifted over weeks.");
      assert.equal(reads101[1].whyMatched, "bm25 hit");
      assert.equal(reads101[1].runId, "run-1");
      assert.equal(reads101[1].turnIndex, 2);
      assert.deepEqual(
        readsFor(delta, "3:103").map((read) => read.granularity),
        ["metadata", "abstract"],
      );
      assert.deepEqual(
        readsFor(delta, "3:104").map((read) => read.granularity),
        ["metadata", "passage"],
      );
      assert.deepEqual(
        readsFor(delta, "3:105").map((read) => read.method),
        ["metadata"],
      );
    });

    it("maps paper_read overview by backend and coverage", function () {
      const delta = derive(
        "paper_read",
        { mode: "overview" },
        {
          mode: "overview",
          results: [
            {
              backend: "mineru",
              text: "Full MinerU text",
              coverage: "complete",
              paperContext: { itemId: 10, contextItemId: 20, title: "A" },
            },
            {
              backend: "raw_pdf_text",
              text: "Opening pages",
              coverage: "capacity_sampled",
              paperContext: { itemId: 11, contextItemId: 21, title: "B" },
            },
            {
              backend: "zotero_metadata",
              sourceKind: "zotero_metadata",
              text: "Title: C\nAbstract: An abstract about drift.",
              paperContext: { itemId: 12, contextItemId: 22 },
            },
            {
              backend: "zotero_metadata",
              sourceKind: "zotero_metadata",
              text: "Title: D",
              paperContext: { itemId: 13, contextItemId: 23 },
            },
            {
              backend: "mineru",
              ok: false,
              warning: "missing",
              paperContext: { itemId: 14, contextItemId: 24 },
            },
          ],
        },
      );
      assert.equal(paperState(delta, "1:10"), "read");
      assert.equal(readsFor(delta, "1:10")[0].granularity, "full");
      assert.equal(
        delta.papers.find((paper) => paper.key === "1:10")!.text,
        "mineru",
      );
      assert.equal(paperState(delta, "1:11"), "skimmed");
      assert.equal(readsFor(delta, "1:11")[0].granularity, "passage");
      assert.equal(
        delta.papers.find((paper) => paper.key === "1:11")!.text,
        "pdf_text",
      );
      assert.equal(paperState(delta, "1:12"), "skimmed");
      assert.equal(readsFor(delta, "1:12")[0].granularity, "abstract");
      assert.equal(
        readsFor(delta, "1:12")[0].snippet,
        "An abstract about drift.",
      );
      assert.equal(paperState(delta, "1:13"), "matched");
      assert.isUndefined(paperState(delta, "1:14"));
    });

    it("maps paper_read targeted passages to sections, passages and pages", function () {
      const paperContext = { itemId: 10, contextItemId: 20, title: "A" };
      const delta = derive(
        "paper_read",
        { mode: "targeted", query: "drift" },
        {
          mode: "targeted",
          results: [],
          papers: [
            {
              paperContext,
              status: "matched",
              passages: [
                { text: "In Methods we ...", sectionLabel: "Methods" },
                { text: "An unlabelled passage", chunkIndex: 4 },
                {
                  text: "Page text",
                  chunkKind: "page",
                  sectionLabel: "Page 5",
                  pageIndex: 4,
                },
              ],
            },
            {
              paperContext: { itemId: 11, contextItemId: 21 },
              status: "no_matches",
              passages: [],
            },
          ],
        },
      );
      assert.equal(paperState(delta, "1:10"), "read");
      assert.deepEqual(
        readsFor(delta, "1:10").map((read) => [read.granularity, read.label]),
        [
          ["section", "Methods"],
          ["passage", undefined],
          ["page", "Page 5"],
        ],
      );
      assert.isUndefined(
        paperState(delta, "1:11"),
        "a paper with no passages was not read",
      );
    });

    it("maps paper_read outline to skimmed, full and figures to read", function () {
      const outline = derive(
        "paper_read",
        { mode: "outline" },
        {
          mode: "outline",
          papers: [
            {
              paperContext: { itemId: 10, contextItemId: 20 },
              outline: {
                sections: [{ title: "Intro" }, { title: "Methods" }],
              },
            },
            {
              paperContext: { itemId: 11, contextItemId: 21 },
              outline: { sections: [] },
            },
          ],
        },
      );
      assert.equal(paperState(outline, "1:10"), "skimmed");
      assert.deepEqual(readsFor(outline, "1:10")[0], {
        key: "1:10",
        callId: "call-1",
        toolName: "paper_read",
        granularity: "outline",
        method: "outline",
        label: "Intro · Methods",
      });
      assert.isUndefined(paperState(outline, "1:11"));

      const full = derive(
        "paper_read",
        { mode: "full" },
        {
          mode: "full",
          papers: [
            {
              paperContext: { itemId: 10, contextItemId: 20 },
              processedChunks: 30,
              totalChunks: 32,
            },
            {
              paperContext: { itemId: 11, contextItemId: 21 },
              processedChunks: 0,
              totalChunks: 10,
            },
          ],
        },
      );
      assert.equal(readsFor(full, "1:10")[0].granularity, "full");
      assert.equal(readsFor(full, "1:10")[0].label, "30/32 chunks");
      assert.isUndefined(paperState(full, "1:11"));

      const figures = derive(
        "paper_read",
        { mode: "figures" },
        {
          mode: "figures",
          status: "ok",
          figures: [
            {
              label: "Figure 2",
              caption: "Drift over days",
              cropPath: "/tmp/fig2.png",
              pageIndex: 3,
              paperContext: { itemId: 10, contextItemId: 20 },
            },
            {
              label: "Figure 3",
              paperContext: { itemId: 11, contextItemId: 21 },
            },
          ],
        },
      );
      assert.deepEqual(
        readsFor(figures, "1:10").map((read) => [
          read.granularity,
          read.label,
          read.snippet,
        ]),
        [["figure", "Figure 2 · p. 4", "Drift over days"]],
      );
      assert.isUndefined(
        paperState(figures, "1:11"),
        "a figure without a crop was not seen",
      );
    });

    it("maps catalog search rows to matched metadata reads", function () {
      const delta = derive(
        "library_search",
        { entity: "items", mode: "search", text: "drift" },
        {
          results: [
            { itemId: 10, title: "A", firstCreator: "Smith", year: 2020 },
            { collectionId: 5, name: "Not a paper" },
          ],
        },
      );
      assert.deepEqual(delta.papers, [
        {
          key: "1:10",
          libraryID: 1,
          itemId: 10,
          title: "A",
          year: "2020",
          creator: "Smith",
          state: "matched",
        },
      ]);
      assert.equal(delta.reads[0].method, "search");
    });

    it("resolves attachment-only rows through the host resolver, else skips them", function () {
      const content = {
        attachmentId: 20,
        title: "notes.md",
        textContent: "Attachment body",
      };
      const input = { target: { contextItemId: 20 } };
      assert.isNull(
        deriveTaskPaperLedgerDelta({
          toolName: "read_attachment",
          callId: "c",
          input,
          content,
          libraryID: 1,
        }),
      );
      const delta = derive("read_attachment", input, content, {
        resolvePaper: (ref) =>
          ref.contextItemId === 20 ? { itemId: 10, libraryID: 2 } : null,
      });
      assert.equal(paperState(delta, "2:10"), "read");
      assert.equal(delta.papers[0].contextItemId, 20);
      assert.equal(readsFor(delta, "2:10")[0].granularity, "full");
    });

    it("records rendered pages from paper_read visual mode", function () {
      const delta = derive(
        "paper_read",
        { target: { itemId: 10 }, mode: "visual", pages: [3, 4] },
        {
          target: { itemId: 10, contextItemId: 20, title: "A" },
          pageCount: 2,
          results: [
            { pageIndex: 2, pageLabel: "3" },
            { pageIndex: 3, pageLabel: "4" },
          ],
        },
      );
      assert.deepEqual(
        readsFor(delta, "1:10").map((read) => [read.granularity, read.label]),
        [["page", "p. 3, p. 4"]],
      );
    });

    it("returns null for unknown tools and empty payloads", function () {
      assert.isNull(
        deriveTaskPaperLedgerDelta({
          toolName: "web_read",
          callId: "c",
          input: {},
          content: { results: [{ itemId: 10, text: "x" }] },
          libraryID: 1,
        }),
      );
      assert.isNull(
        deriveTaskPaperLedgerDelta({
          toolName: "paper_read",
          callId: "c",
          input: { mode: "full", target: { itemId: 10 } },
          content: {},
          libraryID: 1,
        }),
      );
    });

    it("caps reads per paper and clips snippet and whyMatched", function () {
      const snippets = Array.from({ length: 20 }, (_, index) => ({
        itemId: "10",
        sourceKind: "pdf_text",
        matchMethod: "bm25",
        sectionLabel: `Section ${index}`,
        snippet: `${"x".repeat(400)} ${index}`,
        whyMatched: "w".repeat(300),
      }));
      const delta = derive(
        "library_retrieve",
        { query: "q" },
        {
          snippets,
        },
      );
      const reads = readsFor(delta, "1:10");
      assert.lengthOf(reads, TASK_PAPER_MAX_READS_PER_TURN);
      assert.equal(delta.droppedReads, 20 - TASK_PAPER_MAX_READS_PER_TURN);
      assert.isAtMost(reads[0].snippet!.length, 280);
      assert.isTrue(reads[0].snippet!.endsWith("…"));
      assert.isAtMost(reads[0].whyMatched!.length, 120);
    });
  });

  describe("applyTaskPaperLedgerDelta", function () {
    it("is idempotent by run and call, and keeps states monotone", function () {
      const ledger = createTaskPaperLedger();
      const read = derive(
        "library_retrieve",
        { query: "q" },
        libraryRetrieveFixture(),
        {
          runId: "run-1",
        },
      );
      applyTaskPaperLedgerDelta(ledger, read, 1);
      const snapshot = JSON.stringify(ledger);
      applyTaskPaperLedgerDelta(ledger, read, 1);
      assert.equal(JSON.stringify(ledger), snapshot, "replay is a no-op");

      const weaker = derive(
        "library_search",
        { mode: "search" },
        { results: [{ itemId: 101, libraryID: 3, title: "Place cell drift" }] },
        { runId: "run-1", callId: "call-2" },
      );
      applyTaskPaperLedgerDelta(ledger, weaker, 1);
      const entry = ledger.papers["3:101"];
      assert.equal(entry.state, "read", "a weaker read never lowers state");
      assert.equal(entry.turns[1].state, "read");
      assert.lengthOf(entry.turns[1].reads, 3);

      // The same call id in another run (MCP request ids restart) applies.
      const otherRun = { ...weaker, runId: "run-2" };
      applyTaskPaperLedgerDelta(ledger, otherRun, 2);
      assert.equal(entry.latestTurn, 2);
      assert.equal(entry.turns[2].state, "matched");
      assert.equal(entry.state, "read");
      assert.deepEqual(ledger.order.slice(0, 2), ["3:101", "3:102"]);
      assert.equal(entry.text, "pdf_text");
      assert.deepEqual(entry.contextItemIds, [201]);
    });

    it("caps reads per paper per turn across calls", function () {
      const ledger = createTaskPaperLedger();
      for (let call = 0; call < 5; call += 1) {
        applyTaskPaperLedgerDelta(
          ledger,
          derive(
            "paper_read",
            { mode: "targeted" },
            {
              papers: [
                {
                  paperContext: { itemId: 10, contextItemId: 20 },
                  passages: [1, 2, 3, 4].map((index) => ({
                    text: `call ${call} passage ${index}`,
                  })),
                },
              ],
            },
            { callId: `call-${call}` },
          ),
          1,
        );
      }
      const turn = ledger.papers["1:10"].turns[1];
      assert.lengthOf(turn.reads, TASK_PAPER_MAX_READS_PER_TURN);
      assert.equal(turn.droppedReads, 20 - TASK_PAPER_MAX_READS_PER_TURN);
      assert.isTrue(turn.reads.every((read) => read.turnIndex === 1));
    });

    it("caps papers per conversation", function () {
      const ledger = createTaskPaperLedger();
      const results = Array.from(
        { length: TASK_PAPER_MAX_PAPERS + 3 },
        (_, index) => ({ itemId: index + 1 }),
      );
      applyTaskPaperLedgerDelta(
        ledger,
        {
          version: 1,
          callId: "big",
          toolName: "library_search",
          papers: results.map((row) => ({
            key: `1:${row.itemId}`,
            libraryID: 1,
            itemId: row.itemId,
            state: "matched" as const,
          })),
          reads: [],
        },
        1,
      );
      assert.lengthOf(ledger.order, TASK_PAPER_MAX_PAPERS);
      assert.equal(ledger.droppedPapers, 3);
    });
  });

  describe("applyFinalCitations", function () {
    function citation(
      id: string,
      fields: Partial<QuoteCitation> = {},
    ): QuoteCitation {
      return {
        id,
        quoteText: `quote ${id} ${"q".repeat(200)}`,
        citationLabel: "Smith 2021",
        itemId: 101,
        contextItemId: 201,
        sourceSectionLabel: "Results",
        pageHintLabel: "7",
        ...fields,
      };
    }

    it("marks cited papers, caps per turn, and replays idempotently", function () {
      const ledger = createTaskPaperLedger();
      applyTaskPaperLedgerDelta(
        ledger,
        derive("library_retrieve", { query: "q" }, libraryRetrieveFixture()),
        1,
      );
      const citations = [
        ...Array.from({ length: 10 }, (_, index) => citation(`c${index}`)),
        citation("c0"),
        citation("ctx-only", { itemId: undefined, contextItemId: 204 }),
        citation("unknown", { itemId: undefined, contextItemId: 999 }),
      ];
      applyFinalCitations(ledger, citations, 1);
      const cited = ledger.papers["3:101"];
      assert.equal(cited.state, "cited");
      assert.equal(cited.turns[1].state, "cited");
      assert.lengthOf(
        cited.turns[1].citations,
        TASK_PAPER_MAX_CITATIONS_PER_TURN,
      );
      assert.equal(cited.turns[1].droppedCitations, 2);
      assert.isAtMost(cited.turns[1].citations[0].quote!.length, 160);
      assert.include(cited.turns[1].citations[0], {
        citationId: "c0",
        turnIndex: 1,
        label: "Smith 2021",
        sectionLabel: "Results",
        pageLabel: "7",
      });
      assert.equal(ledger.papers["3:104"].state, "cited");
      const snapshot = JSON.stringify(ledger);
      applyFinalCitations(ledger, citations, 1);
      assert.equal(JSON.stringify(ledger), snapshot);
    });

    it("creates an entry for a cited paper that no read recorded", function () {
      const ledger = createTaskPaperLedger();
      applyFinalCitations(ledger, [citation("c1", { itemId: 55 })], 3, 1);
      assert.equal(ledger.papers["1:55"].state, "cited");
      assert.equal(ledger.papers["1:55"].latestTurn, 3);
    });

    it("re-applying a question's citations replaces them and recomputes state", function () {
      const ledger = createTaskPaperLedger();
      applyTaskPaperLedgerDelta(
        ledger,
        {
          version: 1,
          callId: "r1",
          toolName: "library_retrieve",
          papers: [
            { key: "1:7", libraryID: 1, itemId: 7, state: "read" },
            { key: "1:8", libraryID: 1, itemId: 8, state: "skimmed" },
          ],
          reads: [],
        },
        2,
      );
      applyFinalCitations(
        ledger,
        [citation("a", { itemId: 7 }), citation("b", { itemId: 8 })],
        2,
        1,
      );
      assert.equal(ledger.papers["1:7"].state, "cited");
      assert.equal(ledger.papers["1:8"].state, "cited");
      // The final answer dropped citation "b": paper 8 falls back to the
      // highest state its reads earned, in the turn and overall.
      applyFinalCitations(ledger, [citation("a", { itemId: 7 })], 2, 1);
      assert.equal(ledger.papers["1:7"].state, "cited");
      assert.equal(ledger.papers["1:8"].turns[2].state, "skimmed");
      assert.lengthOf(ledger.papers["1:8"].turns[2].citations, 0);
      assert.equal(ledger.papers["1:8"].state, "skimmed");
      // A citation of the same paper in another question is untouched.
      applyFinalCitations(ledger, [citation("c", { itemId: 8 })], 1, 1);
      applyFinalCitations(ledger, [], 2, 1);
      assert.equal(ledger.papers["1:8"].turns[1].state, "cited");
      assert.equal(ledger.papers["1:8"].state, "cited");
      assert.equal(ledger.papers["1:7"].state, "read");
      // A paper only a dropped citation created falls back to listed.
      applyFinalCitations(ledger, [citation("d", { itemId: 9 })], 3, 1);
      applyFinalCitations(ledger, [], 3, 1);
      assert.equal(ledger.papers["1:9"].state, "listed");
      assert.equal(ledger.papers["1:9"].turns[3].state, "listed");
    });
  });

  describe("alignment with readObservation", function () {
    const priorZotero = (globalThis as { Zotero?: unknown }).Zotero;
    const items = new Map<number, Record<string, unknown>>([
      [10, { id: 10, key: "AAAA1111", libraryID: 1 }],
      [20, { id: 20, key: "PDFP1111", libraryID: 1, parentID: 10 }],
    ]);

    before(function () {
      (globalThis as { Zotero?: unknown }).Zotero = {
        Items: { get: (itemId: number) => items.get(itemId) || null },
      };
    });

    after(function () {
      (globalThis as { Zotero?: unknown }).Zotero = priorZotero;
    });

    function discoveredToolNames(): string[] {
      const names = new Set<string>();
      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.name.endsWith(".ts")) {
            const source = fs.readFileSync(full, "utf8");
            for (const match of source.matchAll(/name: "([a-z_]+)"/g)) {
              names.add(match[1]);
            }
          }
        }
      };
      walk(path.join(__dirname, "../src/agent/tools"));
      return [...names];
    }

    const row = {
      itemId: 10,
      contextItemId: 20,
      paperContext: { itemId: 10, contextItemId: 20 },
      text: "Body text",
      content: "Body text",
      snippet: "A snippet",
      abstract: "An abstract",
      metadata: { title: "T", abstract: "An abstract" },
      sourceKind: "pdf_text",
      cropPath: "/tmp/fig.png",
      backend: "mineru",
      coverage: "complete",
      pages: [{ pageIndex: 0 }],
      passages: [{ text: "Passage" }],
      processedChunks: 3,
      totalChunks: 3,
    };
    const fixtures: Array<{ input: Record<string, unknown>; result: unknown }> =
      [
        {
          input: {},
          result: {
            results: [row],
            papers: [row],
            candidates: [row],
            paperMatches: [row],
            snippets: [row],
            figures: [row],
          },
        },
        {
          input: { target: { itemId: 10 } },
          result: {
            text: "Body text",
            content: "Body text",
            abstract: "An abstract",
            pages: [{ pageIndex: 0 }],
            images: [{}],
          },
        },
        { input: { itemId: 10 }, result: { snippets: [row] } },
      ];
    const modes = [
      undefined,
      "overview",
      "outline",
      "targeted",
      "full",
      "figures",
      "visual",
      "capture",
    ];

    it("records every read readObservation attests", async function () {
      const names = discoveredToolNames();
      assert.include(names, "paper_read");
      const attested = new Set<string>();
      for (const toolName of names) {
        for (const fixture of fixtures) {
          for (const mode of modes) {
            const input = mode ? { ...fixture.input, mode } : fixture.input;
            const observations = await createTrustedReadObservations({
              toolName,
              callId: "align",
              input,
              result: fixture.result,
            });
            if (!observations.length) continue;
            attested.add(toolName);
            const delta = deriveTaskPaperLedgerDelta({
              toolName,
              callId: "align",
              input,
              content: fixture.result,
              libraryID: 1,
            });
            assert.isNotNull(
              delta,
              `readObservation attests ${toolName} (mode ${mode}) but the task ledger records nothing`,
            );
            const observed = new Set(
              observations.map((entry) => entry.itemKey),
            );
            assert.isTrue(
              observed.has("AAAA1111") &&
                delta!.papers.some((paper) => paper.itemId === 10),
              `${toolName} (mode ${mode}) must record the attested paper`,
            );
          }
        }
      }
      for (const toolName of attested) {
        assert.isTrue(
          TASK_PAPER_LEDGER_TOOL_NAMES.has(toolName),
          `${toolName} is attested but not in TASK_PAPER_LEDGER_TOOL_NAMES`,
        );
      }
      assert.includeMembers(
        [...attested],
        [
          "library_retrieve",
          "paper_read",
          "library_search",
          "library_read",
          "read_attachment",
        ],
      );
    });
  });
});
