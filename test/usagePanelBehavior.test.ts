import { assert } from "chai";
import {
  UPSTREAM_GLOBAL_CONVERSATION_KEY_BASE,
  UPSTREAM_PAPER_CONVERSATION_KEY_BASE,
} from "../src/shared/conversationKeySpace";
import { recordUsageEvent } from "../src/utils/usageStore";
import { formatUsageFullDateLabel } from "../src/utils/usageView";
import {
  collectOwnText,
  fakeRect,
  flushAsync,
  type FakePrefElement,
} from "./helpers/fakePreferencesDom";
import {
  loadUsagePanelModule,
  mountUsagePanel,
  type MountedUsagePanel,
} from "./helpers/usagePanelHarness";

/**
 * WHY THIS EXISTS: two things the panel got wrong in the same place.
 *
 * The snapshot was cached for the whole life of the preferences window, so a
 * question asked with the window open never appeared until the window was
 * closed and reopened — the tab quietly showed stale numbers. And each heatmap
 * cell carried an SVG `<title>`, the browser's slow native tooltip, which
 * could not say how many tokens a day cost or admit that a day's tokens were
 * an estimate.
 */

const PAPER_KEY = UPSTREAM_PAPER_CONVERSATION_KEY_BASE + 5150;
const LIBRARY_KEY = UPSTREAM_GLOBAL_CONVERSATION_KEY_BASE + 5151;

function localDay(offset: number): number {
  const now = new Date();
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - offset,
    12,
  ).getTime();
}

async function seedLedger(): Promise<void> {
  for (let offset = 0; offset < 10; offset += 1) {
    assert.isTrue(
      await recordUsageEvent({
        mode: "paper",
        conversationKey: PAPER_KEY,
        paperItemID: 7701,
        timestamp: localDay(offset),
        model: "gpt-4o",
        provider: "openai",
        runtime: "chat",
        promptTokens: 1200,
        completionTokens: 300,
        totalTokens: 1500,
      }),
      "the fixture row must be written",
    );
  }
}

/** The number in the Paper chat card, which is a question count. */
function paperQuestions(root: FakePrefElement): string {
  const card = root.querySelector('[data-usage-card="Paper chat"]');
  return collectOwnText(card!)[1] || "";
}

function usageReads(reads: readonly string[]): number {
  return reads.filter((sql) => sql.includes("llm_for_zotero_usage_events"))
    .length;
}

/** Poll until `check` holds, so a query in flight is waited for, not guessed. */
async function until(check: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (check()) return;
    await flushAsync(2);
  }
  throw new Error(`never happened: ${what}`);
}

describe("usage tab activation", function () {
  it("loads lazily the first time and re-queries every time after", function () {
    const { planUsageTabActivation } = loadUsagePanelModule();
    assert.deepEqual(
      planUsageTabActivation({ started: false, loading: false }),
      {
        start: true,
        refresh: false,
      },
    );
    assert.deepEqual(
      planUsageTabActivation({ started: true, loading: false }),
      {
        start: false,
        refresh: true,
      },
    );
    // A load already in flight is by definition current; a second one would
    // only race it.
    assert.deepEqual(planUsageTabActivation({ started: true, loading: true }), {
      start: false,
      refresh: false,
    });
    // The first activation must not also refresh: there is nothing to throw
    // away, and a refresh there would double the opening query.
    assert.isFalse(
      planUsageTabActivation({ started: false, loading: true }).refresh,
    );
  });

  describe("driving the real panel", function () {
    let mounted: MountedUsagePanel | null = null;

    beforeEach(async function () {
      mounted = await mountUsagePanel({ seed: async () => seedLedger() });
    });

    afterEach(function () {
      mounted?.teardown();
      mounted = null;
    });

    it("shows a question asked while the preferences window was open", async function () {
      assert.equal(paperQuestions(mounted!.root), "10");
      assert.isTrue(
        await recordUsageEvent({
          mode: "paper",
          conversationKey: PAPER_KEY,
          paperItemID: 7701,
          timestamp: localDay(0),
          model: "gpt-4o",
          provider: "openai",
          runtime: "chat",
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
        }),
        "the new turn must be recorded",
      );
      // Until the user comes back to the tab, the pane keeps last visit's
      // answer; it does not poll the database.
      assert.equal(paperQuestions(mounted!.root), "10");

      mounted!.window.tabButton.click();
      await until(
        () => paperQuestions(mounted!.root) === "11",
        "the re-activated tab shows the new question",
      );
    });

    it("re-queries even when the user clicks the tab they are already on", async function () {
      const before = usageReads(mounted!.ledger.reads);
      mounted!.window.tabButton.click();
      await until(
        () => usageReads(mounted!.ledger.reads) > before,
        "a repeat click re-reads the ledger",
      );
    });

    it("keeps the range and sub-tab controls instant within one visit", async function () {
      await mounted!.click('[data-usage-range="last7"]');
      await until(
        () => Boolean(mounted!.root.querySelector("[data-usage-card]")),
        "the narrowed range paints",
      );
      const afterFirstLoad = usageReads(mounted!.ledger.reads);
      await mounted!.click('[data-usage-range="last30"]');
      await mounted!.click('[data-usage-subtab="paper"]');
      await mounted!.click('[data-usage-subtab="library"]');
      await mounted!.click('[data-usage-subtab="overview"]');
      await mounted!.click('[data-usage-metric="papers"]');
      assert.equal(
        usageReads(mounted!.ledger.reads),
        afterFirstLoad,
        "a cached range and the sub-tabs must repaint without a query",
      );
      assert.isOk(
        mounted!.root.querySelector("[data-usage-heatmap]"),
        "and they must still paint",
      );
    });
  });

  it("says it is loading, never that nothing was ever recorded", async function () {
    const mounted = await mountUsagePanel({
      seed: async () => seedLedger(),
      activate: false,
    });
    try {
      mounted.window.tabButton.click();
      // The very first paint, before any query has answered.
      const firstPaint = mounted.root.textContent;
      assert.include(firstPaint, "Loading usage…");
      assert.notInclude(
        firstPaint,
        "No usage recorded yet",
        "an unanswered ledger is not an empty ledger",
      );
      await mounted.settle();
      // The same must hold on a re-activation, which drops the cache.
      mounted.window.tabButton.click();
      assert.notInclude(mounted.root.textContent, "No usage recorded yet");
    } finally {
      mounted.teardown();
    }
  });
});

describe("usage reset confirmation", function () {
  it("keeps its old wording when nothing was reconstructed", async function () {
    const mounted = await mountUsagePanel({
      locale: "en-US",
      seed: async () => seedLedger(),
    });
    try {
      await mounted.click('[data-usage-action="reset"]');
      await until(
        () => mounted.dialogs.length > 0,
        "the reset button confirms first",
      );
      const message = mounted.dialogs[0]!.message;
      assert.include(message, "recorded usage rows from your local database");
      assert.notInclude(message, "reconstructed");
    } finally {
      mounted.teardown();
    }
  });

  it("warns that reconstructed history will not come back, counting it fresh", async function () {
    const mounted = await mountUsagePanel({
      locale: "en-US",
      seed: async () => seedLedger(),
    });
    try {
      // Written AFTER the tab cached its snapshot: the warning has to count
      // the ledger, not the numbers already on screen.
      for (let index = 0; index < 4; index += 1) {
        assert.isTrue(
          await recordUsageEvent({
            mode: "library",
            conversationKey: LIBRARY_KEY,
            timestamp: localDay(40 + index),
            model: "deepseek-chat",
            provider: "DeepSeek",
            runtime: "chat",
            promptTokens: 4200,
            totalTokens: 4200,
            tokenSource: "history-estimate",
          }),
        );
      }
      await mounted.click('[data-usage-action="reset"]');
      await until(
        () => mounted.dialogs.length > 0,
        "the reset button confirms first",
      );
      assert.include(
        mounted.dialogs[0]!.message,
        "This includes the 4 turns reconstructed from your earlier" +
          " conversations; they will not be rebuilt.",
      );
    } finally {
      mounted.teardown();
    }
  });
});

describe("usage heatmap hover popover", function () {
  let mounted: MountedUsagePanel | null = null;

  beforeEach(async function () {
    mounted = await mountUsagePanel({
      locale: "en-US",
      seed: async () => {
        await seedLedger();
        assert.isTrue(
          await recordUsageEvent({
            mode: "library",
            conversationKey: LIBRARY_KEY,
            timestamp: localDay(3),
            model: "deepseek-chat",
            provider: "DeepSeek",
            runtime: "chat",
            promptTokens: 4200,
            totalTokens: 4200,
            tokenSource: "history-estimate",
          }),
        );
      },
    });
  });

  afterEach(function () {
    mounted?.teardown();
    mounted = null;
  });

  function popover(): FakePrefElement {
    const node = mounted!.root.querySelector("[data-usage-popover]");
    assert.isOk(node, "the panel builds one hover card for the grid");
    node!.rect = fakeRect(0, 0, 140, 50);
    return node!;
  }

  function cellFor(offset: number): FakePrefElement {
    const date = new Date(localDay(offset));
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    const cell = mounted!.root.querySelector(
      `[data-usage-heatmap-cell="${key}"]`,
    );
    assert.isOk(cell, `the grid should hold a cell for ${key}`);
    return cell!;
  }

  function expectedDate(offset: number): string {
    const date = new Date(localDay(offset));
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    return formatUsageFullDateLabel(key, "en-US");
  }

  it("replaces the native tooltip rather than adding a second one", function () {
    const titles = mounted!.root.querySelectorAll("title");
    assert.lengthOf(
      titles,
      0,
      "an SVG <title> would give the user two tooltips for one cell",
    );
    assert.include(
      popover().getAttribute("style") || "",
      "pointer-events: none",
      "a card that took the pointer would stop the cells seeing it",
    );
  });

  it("appears on hover and names the day it is over", function () {
    const card = popover();
    assert.equal(card.style.display, "none", "hidden until hovered");
    cellFor(1).dispatch("mouseenter", { clientX: 100, clientY: 80 });
    assert.equal(card.style.display, "block");
    const lines = collectOwnText(card);
    assert.equal(lines[0], expectedDate(1));
    assert.equal(lines[1], "1 question");
    assert.equal(lines[2], "1.5k tokens");
  });

  it("follows the pointer from cell to cell", function () {
    const card = popover();
    cellFor(1).dispatch("mouseenter", { clientX: 100, clientY: 80 });
    const firstLeft = card.style.left;
    cellFor(3).dispatch("mousemove", { clientX: 160, clientY: 80 });
    assert.equal(collectOwnText(card)[0], expectedDate(3));
    assert.notEqual(
      card.style.left,
      firstLeft,
      "the card moved with the pointer",
    );
    // Day 3 also carries the backfilled turn, so its tokens are an estimate.
    assert.include(collectOwnText(card)[2]!, "· estimate");
  });

  it("hides again when the pointer leaves the grid", function () {
    const card = popover();
    cellFor(1).dispatch("mouseenter", { clientX: 100, clientY: 80 });
    assert.equal(card.style.display, "block");
    mounted!.root
      .querySelector("[data-usage-heatmap]")!
      .dispatch("mouseleave", {});
    assert.equal(card.style.display, "none");
  });

  it("flips to the other side of the pointer at the panel's edge", function () {
    const card = popover();
    // The panel root is 640 × 420 in this window.
    cellFor(1).dispatch("mouseenter", { clientX: 630, clientY: 410 });
    assert.equal(card.style.left, `${630 - 12 - 140}px`);
    assert.equal(card.style.top, `${410 - 12 - 50}px`);
  });

  it("says a quiet day has no activity rather than zero tokens", function () {
    const card = popover();
    // The fixture stops ten days back; the day before it has no rows at all.
    cellFor(11).dispatch("mouseenter", { clientX: 40, clientY: 60 });
    const lines = collectOwnText(card);
    assert.deepEqual(lines, [expectedDate(11), "No activity"]);
  });
});
