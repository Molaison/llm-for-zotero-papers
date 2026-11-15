import { assert } from "chai";
import {
  UPSTREAM_GLOBAL_CONVERSATION_KEY_BASE,
  UPSTREAM_PAPER_CONVERSATION_KEY_BASE,
} from "../src/shared/conversationKeySpace";
import { initI18n, t } from "../src/utils/i18n";
import { recordUsageEvent } from "../src/utils/usageStore";
import { formatUsageFullDateLabel } from "../src/utils/usageView";
import { collectOwnText } from "./helpers/fakePreferencesDom";
import {
  mountUsagePanel,
  type MountedUsagePanel,
} from "./helpers/usagePanelHarness";

/**
 * WHY THIS EXISTS: every other preferences tab speaks the user's language and
 * the Usage tab shipped speaking only English. A missed string is invisible in
 * an English build, so this test renders the real panel with a `t()` that TAGS
 * whatever it is given and then reads every word the panel put on screen: a
 * word that is not tagged must be a number, a date, or the user's own data.
 *
 * It also checks the other half of the contract — that each key the panel asks
 * for actually has a Chinese translation — because an untranslated key is a
 * string that silently stays English for a Chinese user.
 */

const TAG_OPEN = "«";
const TAG_CLOSE = "»";

const PAPER_KEY = UPSTREAM_PAPER_CONVERSATION_KEY_BASE + 4242;
const LIBRARY_KEY = UPSTREAM_GLOBAL_CONVERSATION_KEY_BASE + 4243;
const IN_LIBRARY_PAPER = 8801;
const GONE_PAPER = 8802;

/** The fixture's own words: a title, a model and a provider are not copy. */
const DATA_WORDS = new Set([
  "Attention Is All You Need",
  "gpt-4o",
  "openai",
  "deepseek-chat",
  "DeepSeek",
]);

const MODEL_LABELS = new Set(["Attention et al. 2017"]);

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
  for (let offset = 0; offset < 12; offset += 1) {
    assert.isTrue(
      await recordUsageEvent({
        mode: "paper",
        conversationKey: PAPER_KEY,
        paperItemID: offset % 4 === 0 ? GONE_PAPER : IN_LIBRARY_PAPER,
        timestamp: localDay(offset),
        model: "gpt-4o",
        provider: "openai",
        runtime: "chat",
        promptTokens: 1500 + offset * 10,
        completionTokens: 300,
        totalTokens: 1800 + offset * 10,
      }),
      "the paper fixture row must be written",
    );
    assert.isTrue(
      await recordUsageEvent({
        mode: "library",
        conversationKey: LIBRARY_KEY,
        timestamp: localDay(offset),
        model: "gpt-4o",
        provider: "openai",
        runtime: "chat",
        promptTokens: 900,
        completionTokens: 200,
        totalTokens: 1100,
      }),
      "the library fixture row must be written",
    );
  }
  // One turn whose provider never reported usage, and one rebuilt from chat
  // history: both put copy of their own on the pane.
  assert.isTrue(
    await recordUsageEvent({
      mode: "library",
      conversationKey: LIBRARY_KEY,
      timestamp: localDay(1),
      model: "deepseek-chat",
      provider: "DeepSeek",
      runtime: "chat",
      tokenSource: "unreported",
    }),
  );
  assert.isTrue(
    await recordUsageEvent({
      mode: "library",
      conversationKey: LIBRARY_KEY,
      timestamp: localDay(2),
      model: "deepseek-chat",
      provider: "DeepSeek",
      runtime: "chat",
      promptTokens: 4200,
      totalTokens: 4200,
      tokenSource: "history-estimate",
    }),
  );
}

/**
 * Output of the view's own formatters, which is not copy and is not
 * translated: counts and token totals, the em dash that stands for "unknown",
 * axis dates like `18 Sep`, three-letter month and weekday labels, and the one
 * spelled-out date the popover shows in the window's locale.
 */
function isFormattingOutput(text: string): boolean {
  if (/^[\d.,]+[kM]?$/.test(text)) return true;
  // The model table's "paper / library" question split is two counts.
  if (/^[\d.,]+ \/ [\d.,]+$/.test(text)) return true;
  if (text === "—") return true;
  if (/^\d{1,2} [A-Z][a-z]{2}$/.test(text)) return true;
  if (/^[A-Z][a-z]{2}$/.test(text)) return true;
  return false;
}

function isUserData(text: string): boolean {
  if (DATA_WORDS.has(text)) return true;
  if (MODEL_LABELS.has(text)) return true;
  // The shared paper-label helper builds a citation identity out of the same
  // fixture metadata; it is the user's data, reshaped.
  return text.includes("Attention");
}

describe("usage panel copy", function () {
  let mounted: MountedUsagePanel | null = null;
  const keysAsked: string[] = [];
  let fullDates: Set<string>;

  beforeEach(async function () {
    keysAsked.length = 0;
    mounted = await mountUsagePanel({
      locale: "en-US",
      seed: async (ledger) => {
        ledger.setItems(
          new Map([
            [
              IN_LIBRARY_PAPER,
              {
                title: "Attention Is All You Need",
                firstCreator: "Attention",
                date: "2017-06-12",
              },
            ],
          ]),
        );
        await seedLedger();
      },
      translate: (en: string) => {
        keysAsked.push(en);
        return `${TAG_OPEN}${en}${TAG_CLOSE}`;
      },
    });
    fullDates = new Set(
      Array.from({ length: 400 }, (_, offset) => {
        const date = new Date(localDay(offset));
        const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
        return formatUsageFullDateLabel(key, "en-US");
      }),
    );
  });

  afterEach(function () {
    mounted?.teardown();
    mounted = null;
  });

  /** Every word on the pane that is neither a number, a date, nor user data. */
  function untranslated(): string[] {
    return collectOwnText(mounted!.root).filter(
      (text) =>
        !text.includes(TAG_OPEN) &&
        !isFormattingOutput(text) &&
        !isUserData(text) &&
        !fullDates.has(text),
    );
  }

  it("routes every word of the Overview through t()", async function () {
    const tagged = collectOwnText(mounted!.root).filter((text) =>
      text.includes(TAG_OPEN),
    );
    assert.isAtLeast(
      tagged.length,
      15,
      "the Overview is mostly copy; a test that finds none is not looking",
    );
    assert.deepEqual(untranslated(), []);
    // The cards, sections and controls keep their English names in the DOM so
    // the rest of the plugin can still find them.
    assert.deepEqual(
      mounted!.root
        .querySelectorAll("[data-usage-card]")
        .map((card) => card.getAttribute("data-usage-card")),
      ["Paper chat", "Library chat", "Tokens"],
    );
    assert.includeMembers(
      mounted!.root
        .querySelectorAll("[data-usage-section]")
        .map((node) => node.getAttribute("data-usage-section")),
      ["Activity", "Tokens per day", "Models"],
    );
  });

  it("routes the paper and library sub-tabs through t()", async function () {
    await mounted!.click('[data-usage-subtab="paper"]');
    assert.deepEqual(untranslated(), [], "paper sub-tab");
    await mounted!.click('[data-usage-subtab="library"]');
    assert.deepEqual(untranslated(), [], "library sub-tab");
    await mounted!.click('[data-usage-subtab="overview"]');
  });

  it("routes the heatmap hover card through t(), date excepted", async function () {
    const cell = mounted!.root.querySelectorAll(
      "[data-usage-heatmap-cell]",
    )[3]!;
    cell.dispatch("mouseenter", { clientX: 120, clientY: 90 });
    const popover = mounted!.root.querySelector("[data-usage-popover]")!;
    const lines = collectOwnText(popover);
    assert.isAtLeast(lines.length, 2, "the card says something");
    assert.isTrue(
      fullDates.has(lines[0]!),
      `the first line is the formatted date, got ${lines[0]}`,
    );
    for (const line of lines.slice(1)) {
      assert.include(line, TAG_OPEN, `hover line not translated: ${line}`);
    }
  });

  it("routes an empty range and the export status through t()", async function () {
    await mounted!.click('[data-usage-range="last7"]');
    await mounted!.click('[data-usage-action="export"]');
    const status = collectOwnText(mounted!.root).filter(
      (text) =>
        text.includes("export") ||
        text.includes("Export") ||
        text.includes(TAG_OPEN),
    );
    assert.isAtLeast(status.length, 1);
    assert.deepEqual(untranslated(), []);
  });

  it("routes the destructive confirmation through t()", async function () {
    await mounted!.click('[data-usage-action="reset"]');
    const dialog = mounted!.dialogs[0];
    assert.isOk(dialog, "the reset button must confirm before deleting");
    assert.include(dialog!.title, TAG_OPEN, "the dialog title");
    for (const line of dialog!.message.split("\n\n")) {
      if (!line.trim()) continue;
      assert.include(line, TAG_OPEN, `dialog paragraph: ${line}`);
    }
    for (const button of dialog!.buttons) {
      assert.include(button, TAG_OPEN, `dialog button: ${button}`);
    }
  });

  it("has a Chinese translation for every key the tab asks for", async function () {
    // Walk the whole tab first: a key is only asked for once something that
    // uses it has been painted.
    await mounted!.click('[data-usage-subtab="paper"]');
    await mounted!.click('[data-usage-subtab="library"]');
    await mounted!.click('[data-usage-subtab="overview"]');
    await mounted!.click('[data-usage-metric="papers"]');
    await mounted!.click('[data-usage-range="last7"]');
    // The reset confirmation is copy too, and its reconstructed-history
    // warning only exists because the fixture holds a backfilled turn.
    await mounted!.click('[data-usage-action="reset"]');
    const previousLocale = (globalThis as { Zotero?: Record<string, unknown> })
      .Zotero;
    (globalThis as { Zotero?: Record<string, unknown> }).Zotero = {
      ...(previousLocale || {}),
      Prefs: { get: () => "zh-CN" },
    };
    initI18n();
    try {
      const missing = [...new Set(keysAsked)].filter((key) => t(key) === key);
      assert.deepEqual(
        missing,
        [],
        "these Usage keys would stay English for a Chinese user",
      );
      assert.isAtLeast(
        new Set(keysAsked).size,
        25,
        "the panel asks for its whole vocabulary, not a handful of strings",
      );
      const singularWarning =
        "This includes the {count} turn reconstructed from your earlier" +
        " conversations; it will not be rebuilt.";
      assert.include(
        keysAsked,
        singularWarning,
        "the reset confirmation must have been walked too",
      );
      // The fixture can only reach the singular of the reset warning; the
      // plural is what a real reconstructed history would show.
      const pluralWarning =
        "This includes the {count} turns reconstructed from your earlier" +
        " conversations; they will not be rebuilt.";
      assert.notEqual(
        t(pluralWarning),
        pluralWarning,
        "the plural reset warning would stay English for a Chinese user",
      );
    } finally {
      (globalThis as { Zotero?: Record<string, unknown> }).Zotero =
        previousLocale;
      initI18n();
    }
  });
});

describe("usage panel copy without a ledger", function () {
  it("explains the empty tab in the user's language", async function () {
    const mounted = await mountUsagePanel({
      translate: (en: string) => `${TAG_OPEN}${en}${TAG_CLOSE}`,
    });
    try {
      assert.isOk(
        mounted.root.querySelector('[data-usage-empty="none"]'),
        "an empty ledger explains itself",
      );
      for (const text of collectOwnText(mounted.root)) {
        assert.include(
          text,
          TAG_OPEN,
          `untranslated empty-state copy: ${text}`,
        );
      }
    } finally {
      mounted.teardown();
    }
  });
});
