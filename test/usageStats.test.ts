import { assert } from "chai";
import { DatabaseSync } from "node:sqlite";
import {
  UPSTREAM_GLOBAL_CONVERSATION_KEY_BASE,
  UPSTREAM_PAPER_CONVERSATION_KEY_BASE,
} from "../src/shared/conversationKeySpace";
import {
  initUsageStore,
  recordUsageEvent,
  USAGE_EVENTS_TABLE,
  resetUsageStoreForTests,
  type UsageEventInput,
} from "../src/utils/usageStore";
import {
  installUsageLedgerZotero,
  type UsageLedgerHarness,
} from "./helpers/usageLedgerDb";
import {
  loadHeaviestUsageConversations,
  loadTopUsagePapers,
  loadUsageDailyTokens,
  loadUsageEventsForExport,
  loadUsageHeatmap,
  loadUsageHistoryBounds,
  loadUsageModelBreakdown,
  loadUsageModeTotals,
  resolveUsageDateRange,
} from "../src/utils/usageStats";

const globalScope = globalThis as typeof globalThis & {
  Zotero?: Record<string, unknown>;
};
const originalZotero = globalScope.Zotero;

const LIBRARY_KEY = UPSTREAM_GLOBAL_CONVERSATION_KEY_BASE + 11;
const OTHER_LIBRARY_KEY = UPSTREAM_GLOBAL_CONVERSATION_KEY_BASE + 12;
const PAPER_KEY = UPSTREAM_PAPER_CONVERSATION_KEY_BASE + 7;
const OTHER_PAPER_KEY = UPSTREAM_PAPER_CONVERSATION_KEY_BASE + 8;

/** Local noon on a given calendar day, so a day offset never lands in the wrong day. */
function localNoon(year: number, month: number, day: number): number {
  return new Date(year, month - 1, day, 12, 0, 0).getTime();
}

const NOW = localNoon(2026, 9, 19);

function daysBefore(timestamp: number, days: number): number {
  const date = new Date(timestamp);
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() - days,
    12,
    0,
    0,
  ).getTime();
}

async function write(event: UsageEventInput): Promise<void> {
  const written = await recordUsageEvent(event);
  assert.isTrue(written, "the fixture row must be written");
}

describe("usage range filter", function () {
  it("computes local calendar bounds, inclusive of today", function () {
    assert.deepEqual(resolveUsageDateRange("last7", NOW), {
      startDate: "2026-09-13",
      endDate: "2026-09-19",
    });
    assert.deepEqual(resolveUsageDateRange("last30", NOW), {
      startDate: "2026-08-21",
      endDate: "2026-09-19",
    });
    assert.deepEqual(resolveUsageDateRange("all", NOW), {
      startDate: null,
      endDate: null,
    });
  });

  it("walks calendar days across a month boundary", function () {
    assert.deepEqual(resolveUsageDateRange("last7", localNoon(2026, 3, 3)), {
      startDate: "2026-02-25",
      endDate: "2026-03-03",
    });
  });
});

describe("usage aggregation", function () {
  let harness: UsageLedgerHarness;

  beforeEach(async function () {
    resetUsageStoreForTests();
    harness = installUsageLedgerZotero();
    await initUsageStore();
  });

  afterEach(function () {
    harness.close();
    resetUsageStoreForTests();
  });

  describe("mode totals", function () {
    it("counts a retry's tokens but not a second question", async function () {
      await write({
        mode: "library",
        conversationKey: LIBRARY_KEY,
        timestamp: NOW,
        promptTokens: 500,
        completionTokens: 100,
        totalTokens: 600,
      });
      await write({
        mode: "library",
        conversationKey: LIBRARY_KEY,
        timestamp: NOW,
        promptTokens: 520,
        completionTokens: 140,
        totalTokens: 660,
        countsAsQuestion: false,
      });

      const totals = await loadUsageModeTotals({ range: "all", now: NOW });
      assert.strictEqual(totals.library.questions, 1);
      assert.strictEqual(totals.library.promptTokens, 1020);
      assert.strictEqual(totals.library.completionTokens, 240);
      assert.strictEqual(totals.library.totalTokens, 1260);
    });

    it("reports distinct papers and conversations per mode", async function () {
      await write({
        mode: "paper",
        conversationKey: PAPER_KEY,
        paperItemID: 41,
        timestamp: NOW,
        totalTokens: 10,
      });
      await write({
        mode: "paper",
        conversationKey: PAPER_KEY,
        paperItemID: 41,
        timestamp: NOW,
        totalTokens: 10,
      });
      await write({
        mode: "paper",
        conversationKey: OTHER_PAPER_KEY,
        paperItemID: 42,
        timestamp: NOW,
        totalTokens: 10,
      });
      await write({
        mode: "library",
        conversationKey: LIBRARY_KEY,
        timestamp: NOW,
        totalTokens: 7,
      });
      await write({
        mode: "library",
        conversationKey: OTHER_LIBRARY_KEY,
        timestamp: NOW,
        totalTokens: 7,
      });

      const totals = await loadUsageModeTotals({ range: "all", now: NOW });
      assert.strictEqual(totals.paper.questions, 3);
      assert.strictEqual(totals.paper.distinctPapers, 2);
      assert.strictEqual(totals.paper.distinctConversations, 2);
      assert.strictEqual(totals.library.questions, 2);
      assert.strictEqual(
        totals.library.distinctPapers,
        0,
        "library chat is not about one paper",
      );
      assert.strictEqual(totals.library.distinctConversations, 2);
    });

    it("keeps rows outside the range out of the totals", async function () {
      await write({
        mode: "library",
        conversationKey: LIBRARY_KEY,
        timestamp: daysBefore(NOW, 10),
        totalTokens: 900,
      });
      await write({
        mode: "library",
        conversationKey: LIBRARY_KEY,
        timestamp: NOW,
        totalTokens: 5,
      });

      const week = await loadUsageModeTotals({ range: "last7", now: NOW });
      assert.strictEqual(week.library.questions, 1);
      assert.strictEqual(week.library.totalTokens, 5);
      const month = await loadUsageModeTotals({ range: "last30", now: NOW });
      assert.strictEqual(month.library.questions, 2);
      assert.strictEqual(month.library.totalTokens, 905);
    });

    it("places a late-evening turn on its own local day, not the next one", async function () {
      // 23:59:59 local on the first day of the trailing week is inside it.
      const edge = new Date(2026, 8, 13, 23, 59, 59).getTime();
      const before = new Date(2026, 8, 12, 23, 59, 59).getTime();
      await write({
        mode: "library",
        conversationKey: LIBRARY_KEY,
        timestamp: edge,
        totalTokens: 11,
      });
      await write({
        mode: "library",
        conversationKey: LIBRARY_KEY,
        timestamp: before,
        totalTokens: 22,
      });

      const totals = await loadUsageModeTotals({ range: "last7", now: NOW });
      assert.strictEqual(totals.library.questions, 1);
      assert.strictEqual(totals.library.totalTokens, 11);
    });

    it("returns zeros for both modes on an empty database", async function () {
      const totals = await loadUsageModeTotals({ range: "all", now: NOW });
      assert.deepEqual(totals.paper, {
        mode: "paper",
        questions: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        distinctPapers: 0,
        distinctConversations: 0,
      });
      assert.deepEqual(totals.library, {
        mode: "library",
        questions: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        distinctPapers: 0,
        distinctConversations: 0,
      });
    });
  });

  describe("daily token series", function () {
    it("fills every day of the window and splits paper from library", async function () {
      await write({
        mode: "paper",
        conversationKey: PAPER_KEY,
        paperItemID: 41,
        timestamp: NOW,
        totalTokens: 300,
      });
      await write({
        mode: "library",
        conversationKey: LIBRARY_KEY,
        timestamp: NOW,
        totalTokens: 120,
      });
      await write({
        mode: "library",
        conversationKey: LIBRARY_KEY,
        timestamp: daysBefore(NOW, 2),
        totalTokens: 60,
      });
      // Outside a three-day window.
      await write({
        mode: "library",
        conversationKey: LIBRARY_KEY,
        timestamp: daysBefore(NOW, 9),
        totalTokens: 9999,
      });

      const series = await loadUsageDailyTokens({ days: 3, now: NOW });
      assert.deepEqual(series, [
        {
          localDate: "2026-09-17",
          paperTokens: 0,
          libraryTokens: 60,
          totalTokens: 60,
        },
        {
          localDate: "2026-09-18",
          paperTokens: 0,
          libraryTokens: 0,
          totalTokens: 0,
        },
        {
          localDate: "2026-09-19",
          paperTokens: 300,
          libraryTokens: 120,
          totalTokens: 420,
        },
      ]);
    });

    it("counts a retry's tokens in the chart", async function () {
      await write({
        mode: "library",
        conversationKey: LIBRARY_KEY,
        timestamp: NOW,
        totalTokens: 100,
        countsAsQuestion: false,
      });
      const series = await loadUsageDailyTokens({ days: 1, now: NOW });
      assert.deepEqual(series, [
        {
          localDate: "2026-09-19",
          paperTokens: 0,
          libraryTokens: 100,
          totalTokens: 100,
        },
      ]);
    });

    it("returns a zero-filled window on an empty database", async function () {
      const series = await loadUsageDailyTokens({ days: 14, now: NOW });
      assert.lengthOf(series, 14);
      assert.strictEqual(series[0]!.localDate, "2026-09-06");
      assert.strictEqual(series[13]!.localDate, "2026-09-19");
      assert.isTrue(series.every((day) => day.totalTokens === 0));
    });
  });

  describe("heatmap", function () {
    it("counts distinct papers globally, not as a sum of daily distincts", async function () {
      // The same paper asked about on two days is ONE distinct paper.
      await write({
        mode: "paper",
        conversationKey: PAPER_KEY,
        paperItemID: 41,
        timestamp: NOW,
        totalTokens: 10,
      });
      await write({
        mode: "paper",
        conversationKey: PAPER_KEY,
        paperItemID: 41,
        timestamp: daysBefore(NOW, 1),
        totalTokens: 10,
      });
      await write({
        mode: "paper",
        conversationKey: OTHER_PAPER_KEY,
        paperItemID: 42,
        timestamp: daysBefore(NOW, 1),
        totalTokens: 10,
      });

      const heatmap = await loadUsageHeatmap({ days: 365, now: NOW });
      const byDate = new Map(heatmap.days.map((day) => [day.localDate, day]));
      assert.strictEqual(byDate.get("2026-09-19")!.distinctPapers, 1);
      assert.strictEqual(byDate.get("2026-09-18")!.distinctPapers, 2);
      assert.strictEqual(
        heatmap.distinctPapers,
        2,
        "a paper read on two days is still one paper",
      );
      assert.strictEqual(heatmap.totalQuestions, 3);
      assert.strictEqual(heatmap.activeDays, 2);
    });

    it("excludes retries from the day's question count but keeps the day active", async function () {
      await write({
        mode: "library",
        conversationKey: LIBRARY_KEY,
        timestamp: NOW,
        totalTokens: 10,
      });
      await write({
        mode: "library",
        conversationKey: LIBRARY_KEY,
        timestamp: NOW,
        totalTokens: 10,
        countsAsQuestion: false,
      });
      const heatmap = await loadUsageHeatmap({ days: 30, now: NOW });
      const today = heatmap.days.at(-1)!;
      assert.strictEqual(today.localDate, "2026-09-19");
      assert.strictEqual(today.questions, 1);
      assert.strictEqual(heatmap.totalQuestions, 1);
      assert.strictEqual(heatmap.activeDays, 1);
    });

    it("spans a full trailing year of days, zero-filled", async function () {
      const heatmap = await loadUsageHeatmap({ now: NOW });
      assert.lengthOf(heatmap.days, 365);
      assert.strictEqual(heatmap.startDate, heatmap.days[0]!.localDate);
      assert.strictEqual(heatmap.endDate, "2026-09-19");
      assert.strictEqual(heatmap.startDate, "2025-09-20");
      assert.strictEqual(heatmap.totalQuestions, 0);
      assert.strictEqual(heatmap.activeDays, 0);
      assert.strictEqual(heatmap.distinctPapers, 0);
    });

    it("carries each day's tokens and where those tokens came from", async function () {
      // The hover popover words line three from these counters, so a day's
      // tokens and their provenance must come from the SAME rows and the same
      // local_date bucketing as the cell the pointer is over.
      await write({
        mode: "paper",
        conversationKey: PAPER_KEY,
        paperItemID: 41,
        timestamp: NOW,
        promptTokens: 1000,
        completionTokens: 200,
        totalTokens: 1200,
      });
      await write({
        mode: "library",
        conversationKey: LIBRARY_KEY,
        timestamp: NOW,
        promptTokens: 4000,
        totalTokens: 4000,
        tokenSource: "history-estimate",
      });
      await write({
        mode: "library",
        conversationKey: LIBRARY_KEY,
        timestamp: daysBefore(NOW, 1),
        totalTokens: 0,
        tokenSource: "unreported",
      });

      const heatmap = await loadUsageHeatmap({ days: 30, now: NOW });
      const byDate = new Map(heatmap.days.map((day) => [day.localDate, day]));
      const today = byDate.get("2026-09-19")!;
      assert.strictEqual(today.totalTokens, 5200, "both rows' tokens");
      assert.strictEqual(today.providerRows, 1);
      assert.strictEqual(today.estimateRows, 1);
      assert.strictEqual(today.unreportedRows, 0);

      const yesterday = byDate.get("2026-09-18")!;
      assert.strictEqual(yesterday.totalTokens, 0);
      assert.strictEqual(yesterday.unreportedRows, 1);
      assert.strictEqual(yesterday.providerRows, 0);
      assert.strictEqual(yesterday.estimateRows, 0);

      const quiet = byDate.get("2026-09-17")!;
      assert.strictEqual(quiet.totalTokens, 0);
      assert.strictEqual(quiet.providerRows, 0);
      assert.strictEqual(quiet.unreportedRows, 0);
      assert.strictEqual(quiet.estimateRows, 0);
    });

    it("counts a retry's tokens in the day the popover reports", async function () {
      await write({
        mode: "library",
        conversationKey: LIBRARY_KEY,
        timestamp: NOW,
        totalTokens: 500,
      });
      await write({
        mode: "library",
        conversationKey: LIBRARY_KEY,
        timestamp: NOW,
        totalTokens: 700,
        countsAsQuestion: false,
      });
      const heatmap = await loadUsageHeatmap({ days: 7, now: NOW });
      const today = heatmap.days.at(-1)!;
      assert.strictEqual(
        today.questions,
        1,
        "a retry is not a second question",
      );
      assert.strictEqual(today.totalTokens, 1200, "but its tokens are real");
      assert.strictEqual(today.providerRows, 2);
    });

    it("ignores a day older than the window", async function () {
      await write({
        mode: "paper",
        conversationKey: PAPER_KEY,
        paperItemID: 41,
        timestamp: daysBefore(NOW, 400),
        totalTokens: 10,
      });
      const heatmap = await loadUsageHeatmap({ now: NOW });
      assert.strictEqual(heatmap.totalQuestions, 0);
      assert.strictEqual(heatmap.distinctPapers, 0);
    });
  });

  describe("model breakdown", function () {
    it("splits questions by mode and keeps the prompt/completion split", async function () {
      await write({
        mode: "paper",
        conversationKey: PAPER_KEY,
        paperItemID: 41,
        timestamp: NOW,
        model: "claude-sonnet-4-5",
        provider: "Anthropic",
        runtime: "chat",
        promptTokens: 1000,
        completionTokens: 200,
        totalTokens: 1200,
        cacheReadTokens: 400,
      });
      await write({
        mode: "library",
        conversationKey: LIBRARY_KEY,
        timestamp: NOW,
        model: "claude-sonnet-4-5",
        provider: "Anthropic",
        runtime: "chat",
        promptTokens: 500,
        completionTokens: 50,
        totalTokens: 550,
      });
      await write({
        mode: "library",
        conversationKey: LIBRARY_KEY,
        timestamp: NOW,
        model: "claude-sonnet-4-5",
        provider: "Anthropic",
        runtime: "chat",
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        countsAsQuestion: false,
      });
      await write({
        mode: "library",
        conversationKey: LIBRARY_KEY,
        timestamp: NOW,
        model: "gpt-4o",
        provider: "OpenAI",
        runtime: "chat",
        promptTokens: 100,
        completionTokens: 20,
        totalTokens: 120,
      });

      const rows = await loadUsageModelBreakdown({ range: "all", now: NOW });
      assert.deepEqual(
        rows.map((row) => row.model),
        ["claude-sonnet-4-5", "gpt-4o"],
        "the heaviest model comes first",
      );
      const claude = rows[0]!;
      assert.strictEqual(claude.provider, "Anthropic");
      assert.strictEqual(claude.paperQuestions, 1);
      assert.strictEqual(claude.libraryQuestions, 1);
      assert.strictEqual(claude.questions, 2);
      assert.strictEqual(claude.promptTokens, 1510);
      assert.strictEqual(claude.completionTokens, 255);
      assert.strictEqual(claude.totalTokens, 1765);
      assert.strictEqual(claude.cacheReadTokens, 400);
      assert.deepEqual(claude.runtimes, ["chat"]);
      assert.strictEqual(claude.unreportedTurns, 0);
      assert.strictEqual(claude.estimatedTurns, 0);
    });

    it("counts the turns whose tokens came from the history backfill", async function () {
      await write({
        mode: "library",
        conversationKey: LIBRARY_KEY,
        timestamp: NOW,
        model: "deepseek-chat",
        provider: "DeepSeek",
        runtime: "chat",
        promptTokens: 900,
        totalTokens: 900,
        tokenSource: "history-estimate",
      });
      await write({
        mode: "library",
        conversationKey: LIBRARY_KEY,
        timestamp: NOW,
        model: "deepseek-chat",
        provider: "DeepSeek",
        runtime: "chat",
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
      });

      const rows = await loadUsageModelBreakdown({ range: "all", now: NOW });
      assert.lengthOf(rows, 1);
      assert.strictEqual(rows[0]!.questions, 2);
      assert.strictEqual(rows[0]!.estimatedTurns, 1);
      assert.strictEqual(rows[0]!.unreportedTurns, 0);
    });

    it("keeps the runtimes that produced one model's tokens", async function () {
      await write({
        mode: "library",
        conversationKey: LIBRARY_KEY,
        timestamp: NOW,
        model: "gpt-5",
        provider: "OpenAI",
        runtime: "chat",
        promptTokens: 100,
        completionTokens: 10,
        totalTokens: 110,
      });
      await write({
        mode: "library",
        conversationKey: LIBRARY_KEY,
        timestamp: NOW,
        model: "gpt-5",
        provider: "OpenAI",
        runtime: "codex",
        promptTokens: 900,
        completionTokens: 90,
        totalTokens: 990,
        cacheReadTokens: 300,
      });
      const rows = await loadUsageModelBreakdown({ range: "all", now: NOW });
      assert.lengthOf(rows, 1);
      assert.deepEqual(rows[0]!.runtimes, ["chat", "codex"]);
      assert.strictEqual(rows[0]!.totalTokens, 1100);
    });

    it("returns nothing on an empty database", async function () {
      assert.deepEqual(
        await loadUsageModelBreakdown({ range: "all", now: NOW }),
        [],
      );
    });
  });

  describe("top papers", function () {
    it("ranks papers, resolves their titles, and honours the limit", async function () {
      harness.setItems(
        new Map([
          [
            41,
            {
              title: "Observer models",
              firstCreator: "Smith et al.",
              date: "2024-05-01",
            },
          ],
          [
            42,
            {
              title: "Neural models",
              firstCreator: "Chen",
              date: "2023",
            },
          ],
        ]),
      );
      await write({
        mode: "paper",
        conversationKey: PAPER_KEY,
        paperItemID: 41,
        timestamp: NOW,
        totalTokens: 100,
      });
      await write({
        mode: "paper",
        conversationKey: PAPER_KEY,
        paperItemID: 41,
        timestamp: NOW,
        totalTokens: 100,
      });
      await write({
        mode: "paper",
        conversationKey: OTHER_PAPER_KEY,
        paperItemID: 42,
        timestamp: NOW,
        totalTokens: 900,
      });
      // A library turn is not about one paper and must not appear here.
      await write({
        mode: "library",
        conversationKey: LIBRARY_KEY,
        timestamp: NOW,
        paperItemID: 41,
        totalTokens: 5000,
      });

      const papers = await loadTopUsagePapers({ range: "all", now: NOW });
      assert.deepEqual(
        papers.map((paper) => [
          paper.paperItemID,
          paper.questions,
          paper.totalTokens,
          paper.title,
          paper.inLibrary,
        ]),
        [
          [41, 2, 200, "(Smith et al., 2024)", true],
          [42, 1, 900, "(Chen, 2023)", true],
        ],
      );
      assert.lengthOf(
        await loadTopUsagePapers({ range: "all", now: NOW, limit: 1 }),
        1,
      );
    });

    it("carries the real paper title, not just its citation label", async function () {
      harness.setItems(
        new Map([
          [
            41,
            {
              title: "Attention is all you need",
              firstCreator: "Vaswani",
              date: "2017",
            },
          ],
          // A paper Zotero holds with no title at all: there is nothing to
          // show but the citation label.
          [42, { firstCreator: "Chen", date: "2023" }],
        ]),
      );
      await write({
        mode: "paper",
        conversationKey: PAPER_KEY,
        paperItemID: 41,
        timestamp: NOW,
        totalTokens: 200,
      });
      await write({
        mode: "paper",
        conversationKey: OTHER_PAPER_KEY,
        paperItemID: 42,
        timestamp: NOW,
        totalTokens: 100,
      });
      const papers = await loadTopUsagePapers({ range: "all", now: NOW });
      const byId = new Map(papers.map((paper) => [paper.paperItemID, paper]));
      assert.equal(byId.get(41)!.paperTitle, "Attention is all you need");
      assert.equal(byId.get(41)!.title, "(Vaswani, 2017)");
      assert.isNull(
        byId.get(42)!.paperTitle,
        "a paper with no title has nothing to fall forward to",
      );
      assert.equal(byId.get(42)!.title, "(Chen, 2023)");
    });

    it("reports no title for a paper that left the library", async function () {
      harness.setItems(new Map());
      await write({
        mode: "paper",
        conversationKey: PAPER_KEY,
        paperItemID: 41,
        timestamp: NOW,
        totalTokens: 100,
      });
      const papers = await loadTopUsagePapers({ range: "all", now: NOW });
      assert.isNull(papers[0]!.paperTitle);
      assert.isFalse(papers[0]!.inLibrary);
    });

    it("degrades gracefully when the Zotero item is gone", async function () {
      harness.setItems(new Map());
      await write({
        mode: "paper",
        conversationKey: PAPER_KEY,
        paperItemID: 41,
        timestamp: NOW,
        totalTokens: 100,
      });
      const papers = await loadTopUsagePapers({ range: "all", now: NOW });
      assert.lengthOf(papers, 1);
      assert.strictEqual(papers[0]!.paperItemID, 41);
      assert.isFalse(papers[0]!.inLibrary);
      assert.isNotEmpty(papers[0]!.title);
    });

    it("survives a Zotero item lookup that throws", async function () {
      (globalScope.Zotero as { Items: { get: unknown } }).Items = {
        get: () => {
          throw new Error("item lookup exploded");
        },
      };
      await write({
        mode: "paper",
        conversationKey: PAPER_KEY,
        paperItemID: 41,
        timestamp: NOW,
        totalTokens: 100,
      });
      const papers = await loadTopUsagePapers({ range: "all", now: NOW });
      assert.lengthOf(papers, 1);
      assert.isFalse(papers[0]!.inLibrary);
    });

    it("returns nothing on an empty database", async function () {
      assert.deepEqual(
        await loadTopUsagePapers({ range: "all", now: NOW }),
        [],
      );
    });
  });

  describe("heaviest conversations", function () {
    beforeEach(function () {
      harness.exec(
        `CREATE TABLE llm_for_zotero_global_conversations (
           conversation_id TEXT,
           conversation_instance_id TEXT,
           conversation_key INTEGER PRIMARY KEY,
           library_id INTEGER NOT NULL,
           created_at INTEGER NOT NULL,
           last_activity_at INTEGER,
           user_turn_count INTEGER NOT NULL DEFAULT 0,
           first_user_title TEXT,
           title TEXT,
           webchat_session INTEGER NOT NULL DEFAULT 0
         )`,
      );
    });

    it("ranks library conversations by tokens and titles them", async function () {
      harness.exec(
        `INSERT INTO llm_for_zotero_global_conversations
           (conversation_key, library_id, created_at, title, first_user_title)
         VALUES (?, 1, 0, ?, ?)`,
        [LIBRARY_KEY, "Plasticity review", null],
      );
      harness.exec(
        `INSERT INTO llm_for_zotero_global_conversations
           (conversation_key, library_id, created_at, title, first_user_title)
         VALUES (?, 1, 0, ?, ?)`,
        [OTHER_LIBRARY_KEY, "  ", "What did the 2019 cohort find?"],
      );
      await write({
        mode: "library",
        conversationKey: LIBRARY_KEY,
        timestamp: NOW,
        totalTokens: 400,
      });
      await write({
        mode: "library",
        conversationKey: LIBRARY_KEY,
        timestamp: NOW,
        totalTokens: 400,
        countsAsQuestion: false,
      });
      await write({
        mode: "library",
        conversationKey: OTHER_LIBRARY_KEY,
        timestamp: NOW,
        totalTokens: 900,
      });
      // Paper chat never appears in this list.
      await write({
        mode: "paper",
        conversationKey: PAPER_KEY,
        paperItemID: 41,
        timestamp: NOW,
        totalTokens: 99999,
      });

      const rows = await loadHeaviestUsageConversations({
        range: "all",
        now: NOW,
      });
      assert.deepEqual(
        rows.map((row) => [
          row.conversationKey,
          row.questions,
          row.totalTokens,
          row.title,
        ]),
        [
          [OTHER_LIBRARY_KEY, 1, 900, "What did the 2019 cohort find?"],
          [LIBRARY_KEY, 1, 800, "Plasticity review"],
        ],
      );
      assert.lengthOf(
        await loadHeaviestUsageConversations({
          range: "all",
          now: NOW,
          limit: 1,
        }),
        1,
      );
    });

    it("falls back to an honest label for an untitled conversation", async function () {
      harness.exec(
        `INSERT INTO llm_for_zotero_global_conversations
           (conversation_key, library_id, created_at)
         VALUES (?, 1, 0)`,
        [LIBRARY_KEY],
      );
      await write({
        mode: "library",
        conversationKey: LIBRARY_KEY,
        timestamp: NOW,
        totalTokens: 10,
      });
      const rows = await loadHeaviestUsageConversations({
        range: "all",
        now: NOW,
      });
      assert.strictEqual(rows[0]!.title, "Untitled conversation");
    });

    it("still reports a conversation whose catalog row is gone", async function () {
      await write({
        mode: "library",
        conversationKey: LIBRARY_KEY,
        timestamp: NOW,
        totalTokens: 10,
      });
      const rows = await loadHeaviestUsageConversations({
        range: "all",
        now: NOW,
      });
      assert.lengthOf(rows, 1);
      assert.strictEqual(rows[0]!.title, "Untitled conversation");
    });
  });
});

describe("usage aggregation without a usage table", function () {
  let db: DatabaseSync;

  beforeEach(function () {
    resetUsageStoreForTests();
    db = new DatabaseSync(":memory:");
    globalScope.Zotero = {
      ...(originalZotero || {}),
      Items: { get: () => false },
      debug: () => undefined,
      DB: {
        queryAsync: async (sql: string, params?: unknown[]) => {
          const head = sql.trimStart().slice(0, 8).toUpperCase();
          const stmt = db.prepare(sql);
          const bound = (params || []).map((value) =>
            value === undefined ? null : value,
          ) as never[];
          if (
            head.startsWith("SELECT") ||
            head.startsWith("PRAGMA") ||
            head.startsWith("WITH")
          ) {
            return (stmt.all(...bound) as Record<string, unknown>[]).map(
              toZoteroRow,
            );
          }
          stmt.run(...bound);
          return [];
        },
      },
    };
  });

  afterEach(function () {
    db.close();
    resetUsageStoreForTests();
    globalScope.Zotero = originalZotero;
  });

  it("returns empty results instead of throwing", async function () {
    const totals = await loadUsageModeTotals({ range: "all", now: NOW });
    assert.strictEqual(totals.paper.questions, 0);
    assert.strictEqual(totals.library.totalTokens, 0);
    assert.lengthOf(await loadUsageDailyTokens({ days: 14, now: NOW }), 14);
    const heatmap = await loadUsageHeatmap({ now: NOW });
    assert.lengthOf(heatmap.days, 365);
    assert.strictEqual(heatmap.distinctPapers, 0);
    assert.deepEqual(
      await loadUsageModelBreakdown({ range: "all", now: NOW }),
      [],
    );
    assert.deepEqual(await loadTopUsagePapers({ range: "all", now: NOW }), []);
    assert.deepEqual(
      await loadHeaviestUsageConversations({ range: "all", now: NOW }),
      [],
    );
  });
});

describe("usage aggregation without a database", function () {
  beforeEach(function () {
    resetUsageStoreForTests();
    globalScope.Zotero = { ...(originalZotero || {}), debug: () => undefined };
  });

  afterEach(function () {
    resetUsageStoreForTests();
    globalScope.Zotero = originalZotero;
  });

  it("returns empty results instead of throwing", async function () {
    const totals = await loadUsageModeTotals({ range: "all", now: NOW });
    assert.strictEqual(totals.library.questions, 0);
    assert.deepEqual(await loadTopUsagePapers({ range: "all", now: NOW }), []);
  });
});

describe("model breakdown filtered by chat mode", function () {
  let harness: UsageLedgerHarness;

  beforeEach(async function () {
    resetUsageStoreForTests();
    harness = installUsageLedgerZotero();
    await initUsageStore();
  });

  afterEach(function () {
    harness.close();
    resetUsageStoreForTests();
  });

  it("splits one model's tokens between the two chat modes", async function () {
    await write({
      mode: "paper",
      conversationKey: PAPER_KEY,
      paperItemID: 11,
      timestamp: NOW,
      model: "gpt-5",
      provider: "openai",
      promptTokens: 300,
      completionTokens: 100,
      totalTokens: 400,
    });
    await write({
      mode: "library",
      conversationKey: LIBRARY_KEY,
      timestamp: NOW,
      model: "gpt-5",
      provider: "openai",
      promptTokens: 60,
      completionTokens: 40,
      totalTokens: 100,
    });

    const combined = await loadUsageModelBreakdown({ range: "all", now: NOW });
    assert.lengthOf(combined, 1);
    assert.equal(combined[0]!.totalTokens, 500);

    const paperOnly = await loadUsageModelBreakdown({
      range: "all",
      now: NOW,
      mode: "paper",
    });
    assert.lengthOf(paperOnly, 1);
    assert.equal(paperOnly[0]!.totalTokens, 400);
    assert.equal(paperOnly[0]!.paperQuestions, 1);
    assert.equal(paperOnly[0]!.libraryQuestions, 0);

    const libraryOnly = await loadUsageModelBreakdown({
      range: "all",
      now: NOW,
      mode: "library",
    });
    assert.lengthOf(libraryOnly, 1);
    assert.equal(libraryOnly[0]!.totalTokens, 100);
    assert.equal(libraryOnly[0]!.libraryQuestions, 1);
  });

  it("still honours the date range while filtering by mode", async function () {
    await write({
      mode: "paper",
      conversationKey: PAPER_KEY,
      paperItemID: 11,
      timestamp: daysBefore(NOW, 40),
      model: "gpt-5",
      totalTokens: 400,
    });
    assert.deepEqual(
      await loadUsageModelBreakdown({
        range: "last7",
        now: NOW,
        mode: "paper",
      }),
      [],
    );
  });
});

describe("usage history bounds and export rows", function () {
  let harness: UsageLedgerHarness;

  beforeEach(async function () {
    resetUsageStoreForTests();
    harness = installUsageLedgerZotero();
    await initUsageStore();
  });

  afterEach(function () {
    harness.close();
    resetUsageStoreForTests();
  });

  it("reports no history before anything is recorded", async function () {
    assert.deepEqual(await loadUsageHistoryBounds(), {
      firstDate: null,
      lastDate: null,
      events: 0,
    });
  });

  it("reports the first and last recorded local day and the row count", async function () {
    await write({
      mode: "library",
      conversationKey: LIBRARY_KEY,
      timestamp: daysBefore(NOW, 40),
      totalTokens: 10,
    });
    await write({
      mode: "paper",
      conversationKey: PAPER_KEY,
      paperItemID: 11,
      timestamp: NOW,
      totalTokens: 20,
    });
    assert.deepEqual(await loadUsageHistoryBounds(), {
      firstDate: "2026-08-10",
      lastDate: "2026-09-19",
      events: 2,
    });
  });

  it("exports every stored column for the chosen range, oldest first", async function () {
    await write({
      mode: "library",
      conversationKey: LIBRARY_KEY,
      timestamp: daysBefore(NOW, 40),
      model: "old-model",
      totalTokens: 10,
    });
    await write({
      mode: "paper",
      conversationKey: PAPER_KEY,
      paperItemID: 11,
      libraryID: 1,
      timestamp: daysBefore(NOW, 2),
      model: "gpt-5",
      provider: "openai",
      runtime: "chat",
      promptTokens: 100,
      completionTokens: 40,
      totalTokens: 140,
      cacheReadTokens: 10,
    });
    const all = await loadUsageEventsForExport({ range: "all", now: NOW });
    assert.deepEqual(
      all.map((row) => row.model),
      ["old-model", "gpt-5"],
    );
    const recent = await loadUsageEventsForExport({ range: "last7", now: NOW });
    assert.lengthOf(recent, 1);
    assert.deepEqual(
      {
        localDate: recent[0]!.localDate,
        mode: recent[0]!.mode,
        model: recent[0]!.model,
        provider: recent[0]!.provider,
        runtime: recent[0]!.runtime,
        paperItemID: recent[0]!.paperItemID,
        promptTokens: recent[0]!.promptTokens,
        completionTokens: recent[0]!.completionTokens,
        totalTokens: recent[0]!.totalTokens,
        cacheReadTokens: recent[0]!.cacheReadTokens,
        countsAsQuestion: recent[0]!.countsAsQuestion,
      },
      {
        localDate: "2026-09-17",
        mode: "paper",
        model: "gpt-5",
        provider: "openai",
        runtime: "chat",
        paperItemID: 11,
        promptTokens: 100,
        completionTokens: 40,
        totalTokens: 140,
        cacheReadTokens: 10,
        countsAsQuestion: true,
      },
    );
  });

  it("returns nothing rather than throwing when the ledger has no table", async function () {
    harness.exec(`DROP TABLE ${USAGE_EVENTS_TABLE}`);
    assert.deepEqual(
      await loadUsageEventsForExport({ range: "all", now: NOW }),
      [],
    );
    assert.deepEqual(await loadUsageHistoryBounds(), {
      firstDate: null,
      lastDate: null,
      events: 0,
    });
  });
});
