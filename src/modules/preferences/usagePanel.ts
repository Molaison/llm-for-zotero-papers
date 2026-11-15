/**
 * The Usage tab of the preferences window.
 *
 * Zotero's preferences window is a Gecko/XUL chrome document with no network
 * access and no bundler reach, so there is no chart library here and there
 * cannot be one: the activity heatmap and the daily token chart are inline SVG
 * built node by node. The geometry and every user-visible string come from
 * `src/utils/usageView.ts`, which is pure and unit-tested; this file only turns
 * those numbers into elements and wires the controls.
 *
 * Three rules shape the data flow:
 *
 *   - Opening preferences must not wait on the ledger. The panel renders
 *     nothing until its tab is first opened, and then loads asynchronously.
 *   - Switching sub-tabs or the heatmap metric must not re-query. Each range is
 *     loaded once and cached WITHIN one visit to the tab; the range control, an
 *     explicit reset, and coming back to the tab invalidate it.
 *   - The panel never shows a number it cannot justify. An empty ledger gets an
 *     explanation instead of empty charts, and a turn whose provider never
 *     reported its tokens gets an em dash and a reason instead of a zero.
 *
 * The panel reports tokens only. There is no cost estimate anywhere in it.
 *
 * Every string here goes through `t()`, like the rest of the preferences
 * window. The `data-usage-*` attributes keep the English names regardless: they
 * are how the panel is addressed, not what the user reads.
 */

import { config } from "../../../package.json";
import { appLogger } from "../../core/logging";
import { registerAddonDialog } from "../../utils/dialogRegistry";
import { el } from "../../utils/domHelpers";
import { t } from "../../utils/i18n";
import {
  MISSING_PAPER_LABEL,
  UNTITLED_CONVERSATION_LABEL,
  loadHeaviestUsageConversations,
  loadTopUsagePapers,
  loadUsageDailyTokens,
  loadUsageEventsForExport,
  loadUsageHeatmap,
  loadUsageHistoryBounds,
  loadUsageModeTotals,
  loadUsageModelBreakdown,
  type UsageConversationUsage,
  type UsageDailyTokens,
  type UsageHeatmap,
  type UsageHeatmapDay,
  type UsageModeTotals,
  type UsageModelUsage,
  type UsagePaperUsage,
  type UsageRangeKey,
} from "../../utils/usageStats";
import {
  clearAllUsageEvents,
  countHistoryEstimateUsageEvents,
} from "../../utils/usageStore";
import {
  USAGE_CHART_BAR_RADIUS,
  USAGE_CHART_HEIGHT,
  USAGE_HEATMAP_CELL_GAP,
  USAGE_HEATMAP_CELL_RADIUS,
  USAGE_HEATMAP_CELL_SIZE,
  USAGE_HEATMAP_EMPTY_LEVEL,
  USAGE_HEATMAP_ROWS,
  buildUsageHeatmapGrid,
  buildUsageTokenChartModel,
  describeUsageEstimateNote,
  describeUsageHeatmapPopover,
  describeUsageHeatmapSummary,
  describeUsageModelSource,
  describeUsageResetConfirmation,
  describeUsageTokensCard,
  formatUsageCount,
  formatUsageTokens,
  placeUsagePopover,
  resolveUsageEmptyState,
  resolveUsageHeatmapDays,
  resolveUsagePalette,
  roundedTopRectPath,
  serializeUsageEventsCsv,
  usageCsvFileName,
  usageText,
  type UsageChartModel,
  type UsageColorScheme,
  type UsageHeatmapGridModel,
  type UsageHeatmapMetric,
  type UsagePalette,
} from "../../utils/usageView";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Columns the mature heatmap is sized for; the panel's own width follows it. */
const HEATMAP_FULL_COLUMNS = 53;
/** Room for the Mon/Wed/Fri labels to the left of the grid. */
const HEATMAP_LABEL_GUTTER = 22;
/** Room for the month labels above the grid. */
const HEATMAP_MONTH_GUTTER = 12;

const HEATMAP_COLUMN_PITCH = USAGE_HEATMAP_CELL_SIZE + USAGE_HEATMAP_CELL_GAP;
const SURFACE_WIDTH =
  HEATMAP_LABEL_GUTTER +
  HEATMAP_FULL_COLUMNS * HEATMAP_COLUMN_PITCH -
  USAGE_HEATMAP_CELL_GAP;

/** Rows in "Papers you asked about most" and "Heaviest conversations". */
const DETAIL_LIST_LIMIT = 8;
/** Rows in the model table. */
const MODEL_TABLE_LIMIT = 8;

const SUBTLE_SURFACE = "var(--llm-usage-subtle)";
const TEXT_PRIMARY = "var(--fill-primary, inherit)";
const TEXT_SECONDARY = "var(--fill-secondary, #888)";
const HAIRLINE = "0.5px solid var(--llm-pref-stroke)";

type UsageSubTab = "overview" | "paper" | "library";

/**
 * The control segments, built per render rather than once at module load: the
 * labels go through `t()` and the user can be reading a different language
 * than the one this module was first evaluated in.
 *
 * The `id` is the segment's stable English name and is what lands in the
 * `data-usage-*` attributes; only the label is translated.
 */
function subTabSegments(): ReadonlyArray<{ id: UsageSubTab; label: string }> {
  return [
    { id: "overview", label: t("Overview") },
    { id: "paper", label: t("Paper chat") },
    { id: "library", label: t("Library chat") },
  ];
}

function rangeSegments(): ReadonlyArray<{ id: UsageRangeKey; label: string }> {
  return [
    { id: "last7", label: t("7d") },
    { id: "last30", label: t("30d") },
    { id: "all", label: t("All") },
  ];
}

function metricSegments(): ReadonlyArray<{
  id: UsageHeatmapMetric;
  label: string;
}> {
  return [
    { id: "questions", label: t("Questions") },
    { id: "papers", label: t("Papers") },
  ];
}

/**
 * "Nothing in this range", as a whole sentence per range.
 *
 * Whole sentences, not a phrase glued into a template: a translator needs the
 * sentence to reorder it, and "yet" cannot be translated on its own.
 */
const RANGE_EMPTY_COPY: Record<UsageRangeKey, string> = {
  last7:
    "No questions in the last 7 days. Pick a wider range to see your history.",
  last30:
    "No questions in the last 30 days. Pick a wider range to see your history.",
  all: "No questions yet. Pick a wider range to see your history.",
};

/** Everything one range's worth of the panel needs, loaded once. */
type UsageSnapshot = {
  range: UsageRangeKey;
  totals: UsageModeTotals;
  heatmap: UsageHeatmap;
  daily: UsageDailyTokens[];
  models: UsageModelUsage[];
  /** Per-scope model rows, for the unreported-turn tallies the cards show. */
  paperModels: UsageModelUsage[];
  libraryModels: UsageModelUsage[];
  papers: UsagePaperUsage[];
  conversations: UsageConversationUsage[];
};

type PanelState = {
  doc: Document;
  root: HTMLElement;
  /** The window's own locale, for the popover's spelled-out date. */
  locale: string | undefined;
  /** The hover card over the heatmap; rebuilt with each render. */
  popover: HTMLElement | null;
  subTab: UsageSubTab;
  range: UsageRangeKey;
  metric: UsageHeatmapMetric;
  /** Rows on file across all time; drives the never-used state and the reset copy. */
  totalEvents: number;
  snapshots: Map<UsageRangeKey, UsageSnapshot>;
  loading: Promise<void> | null;
  started: boolean;
  /** False until the first load has answered; keeps the never-used state honest. */
  loadedOnce: boolean;
};

/**
 * Which colour scheme the preferences window is painted in.
 *
 * The data colours are fixed hexes, not theme variables, so the panel has to
 * know the scheme to pick the right set: a near-white heatmap stop on a dark
 * pane makes the quietest day the brightest cell on the grid.
 */
function resolveColorScheme(doc: Document): UsageColorScheme {
  try {
    const media = doc.defaultView?.matchMedia?.("(prefers-color-scheme: dark)");
    return media?.matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

function log(message: string, error?: unknown): void {
  appLogger.warn(`LLM: ${message}`, error);
}

// ── element helpers ─────────────────────────────────────────────────

function svgEl<K extends keyof SVGElementTagNameMap>(
  doc: Document,
  tag: K,
  attributes: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const node = doc.createElementNS(SVG_NS, tag) as SVGElementTagNameMap[K];
  for (const [name, value] of Object.entries(attributes)) {
    node.setAttribute(name, String(value));
  }
  return node;
}

function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function row(doc: Document, style: string): HTMLDivElement {
  return el(doc, "div", style);
}

function sectionHeading(doc: Document, text: string): HTMLDivElement {
  return el(
    doc,
    "div",
    `font-size: 12px; font-weight: 500; color: ${TEXT_PRIMARY};`,
    text,
  );
}

function mutedLine(doc: Document, text: string): HTMLDivElement {
  return el(doc, "div", `font-size: 11px; color: ${TEXT_SECONDARY};`, text);
}

function colorDot(doc: Document, color: string): HTMLSpanElement {
  return el(
    doc,
    "span",
    `width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto;` +
      ` background: ${color};`,
  );
}

/**
 * The bordered pill group both the sub-tabs and the range control use.
 * `onPick` fires for a segment that is not already active.
 */
function segmentedControl<T extends string>(
  doc: Document,
  options: {
    name: string;
    segments: ReadonlyArray<{ id: T; label: string }>;
    active: T;
    onPick: (id: T) => void;
  },
): HTMLDivElement {
  const group = el(
    doc,
    "div",
    `display: inline-flex; align-items: stretch; border: ${HAIRLINE};` +
      ` border-radius: 6px; overflow: hidden;`,
  );
  group.setAttribute("role", "tablist");
  group.setAttribute("data-usage-control", options.name);
  options.segments.forEach((segment, index) => {
    const active = segment.id === options.active;
    const button = el(
      doc,
      "button",
      `padding: 4px 10px; font-size: 11px; line-height: 1.4; cursor: pointer;` +
        ` border: none; ${index ? `border-left: ${HAIRLINE};` : ""}` +
        ` background: ${active ? SUBTLE_SURFACE : "transparent"};` +
        ` color: ${active ? "FieldText" : TEXT_SECONDARY};` +
        ` font-weight: ${active ? 500 : 400};`,
      segment.label,
    ) as HTMLButtonElement;
    button.type = "button";
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", active ? "true" : "false");
    button.setAttribute(`data-usage-${options.name}`, segment.id);
    button.addEventListener("click", () => {
      if (segment.id === options.active) return;
      options.onPick(segment.id);
    });
    group.appendChild(button);
  });
  return group;
}

type MetricCardInput = {
  label: string;
  value: string;
  sub: string;
  dotColor?: string;
};

/**
 * One metric card: subtle fill, no border, and no edge stripe ever — a card is
 * identified by its label plus a small colour dot.
 */
function metricCard(doc: Document, input: MetricCardInput): HTMLDivElement {
  const card = el(
    doc,
    "div",
    `background: ${SUBTLE_SURFACE}; border-radius: 6px; padding: 8px 10px;` +
      ` display: flex; flex-direction: column; gap: 2px; min-width: 0;`,
  );
  // The attribute keeps the card's stable English name; only what the user
  // reads is translated.
  card.setAttribute("data-usage-card", input.label);
  const label = el(
    doc,
    "div",
    `display: flex; align-items: center; gap: 5px; font-size: 11px;` +
      ` color: ${TEXT_SECONDARY};`,
  );
  if (input.dotColor) label.appendChild(colorDot(doc, input.dotColor));
  label.appendChild(el(doc, "span", "", t(input.label)));
  card.appendChild(label);
  card.appendChild(
    el(
      doc,
      "div",
      `font-size: 19px; font-weight: 500; line-height: 1.3; color: ${TEXT_PRIMARY};`,
      input.value,
    ),
  );
  card.appendChild(mutedLine(doc, input.sub));
  return card;
}

function metricCardRow(
  doc: Document,
  cards: MetricCardInput[],
): HTMLDivElement {
  const grid = el(
    doc,
    "div",
    "display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px;",
  );
  for (const card of cards) grid.appendChild(metricCard(doc, card));
  return grid;
}

/** The 110px track with its 5px filled bar, used by both detail lists. */
function progressTrack(
  doc: Document,
  fraction: number,
  color: string,
): HTMLDivElement {
  const track = el(
    doc,
    "div",
    `width: 110px; flex: 0 0 110px; height: 5px; border-radius: 3px;` +
      ` background: ${SUBTLE_SURFACE}; overflow: hidden;`,
  );
  const filled = Math.max(0, Math.min(1, fraction));
  track.appendChild(
    el(
      doc,
      "div",
      `width: ${(filled * 100).toFixed(2)}%; height: 100%; border-radius: 3px;` +
        ` background: ${color};`,
    ),
  );
  return track;
}

function detailRow(
  doc: Document,
  input: {
    title: string;
    sub: string;
    fraction: number;
    color: string;
    value: string;
  },
): HTMLDivElement {
  const line = el(
    doc,
    "div",
    "display: flex; align-items: center; gap: 10px; padding: 3px 0;",
  );
  line.setAttribute("data-usage-row", "detail");
  const text = el(doc, "div", "flex: 1; min-width: 0;");
  text.appendChild(
    el(
      doc,
      "div",
      `font-size: 12px; color: ${TEXT_PRIMARY}; overflow: hidden;` +
        ` text-overflow: ellipsis; white-space: nowrap;`,
      input.title,
    ),
  );
  text.appendChild(mutedLine(doc, input.sub));
  line.appendChild(text);
  line.appendChild(progressTrack(doc, input.fraction, input.color));
  line.appendChild(
    el(
      doc,
      "div",
      `width: 48px; flex: 0 0 48px; text-align: right; font-size: 11px;` +
        ` color: ${TEXT_SECONDARY};`,
      input.value,
    ),
  );
  return line;
}

// ── charts ──────────────────────────────────────────────────────────

/**
 * The hover card the heatmap shows instead of a native tooltip.
 *
 * It is one absolutely positioned element reused by every cell — creating one
 * per cell would put a thousand nodes in the pane — and it never takes the
 * pointer, so moving across the grid keeps producing cell events.
 */
function createHeatmapPopover(doc: Document): HTMLElement {
  const popover = el(
    doc,
    "div",
    `position: absolute; left: 0; top: 0; display: none; z-index: 10;` +
      ` pointer-events: none; padding: 6px 8px; border-radius: 6px;` +
      ` background: var(--llm-pref-surface); border: ${HAIRLINE};` +
      ` max-width: 220px;`,
  );
  popover.setAttribute("data-usage-popover", "true");
  popover.setAttribute("role", "tooltip");
  return popover;
}

/** Fill the popover with one day's lines and park it beside the pointer. */
function showHeatmapPopover(
  state: PanelState,
  day: UsageHeatmapDay,
  clientX: number,
  clientY: number,
): void {
  const popover = state.popover;
  if (!popover) return;
  const { doc } = state;
  clear(popover);
  const lines = describeUsageHeatmapPopover(day, state.metric, {
    locale: state.locale,
  });
  lines.forEach((line, index) => {
    popover.appendChild(
      el(
        doc,
        "div",
        `font-size: 11px; line-height: 1.45; white-space: nowrap;` +
          ` color: ${index === 0 ? TEXT_PRIMARY : TEXT_SECONDARY};`,
        line,
      ),
    );
  });
  // Shown before it is measured: a display:none element has no box, and the
  // flip decision needs the card's real width and height. It is measured from
  // the panel's top-left corner, because an absolutely positioned box left
  // near the right edge is shrink-to-fit against the space that remains there
  // — measuring it in place would report a narrow, wrapped card and flip on a
  // width the card will not have once it is moved.
  popover.style.display = "block";
  popover.style.left = "0px";
  popover.style.top = "0px";
  const rootRect = state.root.getBoundingClientRect();
  const cardRect = popover.getBoundingClientRect();
  const placed = placeUsagePopover({
    pointerX: clientX - rootRect.left,
    pointerY: clientY - rootRect.top,
    popoverWidth: cardRect.width,
    popoverHeight: cardRect.height,
    containerWidth: rootRect.width,
    containerHeight: rootRect.height,
  });
  popover.style.left = `${placed.left}px`;
  popover.style.top = `${placed.top}px`;
}

function hideHeatmapPopover(state: PanelState): void {
  if (state.popover) state.popover.style.display = "none";
}

/**
 * The activity heatmap: weeks across, weekdays down, one hover card for all.
 *
 * The cells carry no SVG `<title>`: Gecko's native tooltip is slow to appear
 * and cannot say what the popover says, and having both would show the user
 * two tooltips for the same cell. Plain `mouseenter`/`mousemove` listeners on
 * the `<rect>` elements drive the card instead, and it is hidden when the
 * pointer leaves the grid.
 */
function renderHeatmap(
  doc: Document,
  state: PanelState,
  days: ReadonlyMap<string, UsageHeatmapDay>,
  grid: UsageHeatmapGridModel,
  palette: UsagePalette,
): SVGSVGElement {
  const width =
    HEATMAP_LABEL_GUTTER +
    Math.max(1, grid.columns) * HEATMAP_COLUMN_PITCH -
    USAGE_HEATMAP_CELL_GAP;
  const height =
    HEATMAP_MONTH_GUTTER +
    USAGE_HEATMAP_ROWS * HEATMAP_COLUMN_PITCH -
    USAGE_HEATMAP_CELL_GAP;
  const svg = svgEl(doc, "svg", {
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
    "data-usage-heatmap": "true",
  });
  svg.setAttribute("style", "display: block; overflow: visible;");
  for (const label of grid.weekdayLabels) {
    const text = svgEl(doc, "text", {
      x: HEATMAP_LABEL_GUTTER - 5,
      y: HEATMAP_MONTH_GUTTER + label.row * HEATMAP_COLUMN_PITCH + 7,
      "font-size": 8,
      "text-anchor": "end",
    });
    text.style.fill = TEXT_SECONDARY;
    text.textContent = label.label;
    svg.appendChild(text);
  }
  for (const label of grid.monthLabels) {
    const text = svgEl(doc, "text", {
      x: HEATMAP_LABEL_GUTTER + label.column * HEATMAP_COLUMN_PITCH,
      y: 8,
      "font-size": 8,
    });
    text.style.fill = TEXT_SECONDARY;
    text.textContent = label.label;
    svg.appendChild(text);
  }
  for (const cell of grid.cells) {
    const rect = svgEl(doc, "rect", {
      x: HEATMAP_LABEL_GUTTER + cell.column * HEATMAP_COLUMN_PITCH,
      y: HEATMAP_MONTH_GUTTER + cell.row * HEATMAP_COLUMN_PITCH,
      width: USAGE_HEATMAP_CELL_SIZE,
      height: USAGE_HEATMAP_CELL_SIZE,
      rx: USAGE_HEATMAP_CELL_RADIUS,
      "data-usage-heatmap-cell": cell.localDate,
    });
    // The empty-day fill is the PALETTE's, not the shared subtle surface: on a
    // dark pane that surface is lighter than the darkest ramp stop, which
    // makes "no activity" read brighter than "a little activity".
    rect.style.fill =
      cell.level === USAGE_HEATMAP_EMPTY_LEVEL
        ? palette.emptyCell
        : palette.ramp[cell.level - 1]!;
    const day = days.get(cell.localDate);
    if (day) {
      const point = (event: MouseEvent) => {
        showHeatmapPopover(state, day, event.clientX, event.clientY);
      };
      rect.addEventListener("mouseenter", point);
      rect.addEventListener("mousemove", point);
    }
    svg.appendChild(rect);
  }
  // Leaving one cell for the next must not flicker the card, so the grid, not
  // the cell, owns the hide.
  svg.addEventListener("mouseleave", () => hideHeatmapPopover(state));
  return svg;
}

/** Less / six swatches / More, right-aligned under the heatmap. */
function renderHeatmapLegend(
  doc: Document,
  palette: UsagePalette,
): HTMLDivElement {
  const legend = el(
    doc,
    "div",
    `display: flex; align-items: center; justify-content: flex-end; gap: 4px;` +
      ` font-size: 11px; color: ${TEXT_SECONDARY};`,
  );
  legend.appendChild(el(doc, "span", "", t("Less")));
  for (const color of [palette.emptyCell, ...palette.ramp]) {
    legend.appendChild(
      el(
        doc,
        "span",
        `width: ${USAGE_HEATMAP_CELL_SIZE}px; height: ${USAGE_HEATMAP_CELL_SIZE}px;` +
          ` border-radius: ${USAGE_HEATMAP_CELL_RADIUS}px; background: ${color};`,
      ),
    );
  }
  legend.appendChild(el(doc, "span", "", t("More")));
  return legend;
}

/** The stacked daily token chart: axes, grid lines and one path per segment. */
function renderTokenChart(
  doc: Document,
  model: UsageChartModel,
): SVGSVGElement {
  const svg = svgEl(doc, "svg", {
    width: model.width,
    height: model.height,
    viewBox: `0 0 ${model.width} ${model.height}`,
    "data-usage-chart": "true",
  });
  svg.setAttribute("style", "display: block; overflow: visible;");
  for (const tick of model.yTicks) {
    const line = svgEl(doc, "line", {
      x1: model.plot.x,
      x2: model.plot.x + model.plot.width,
      y1: tick.y,
      y2: tick.y,
      "stroke-width": 0.5,
    });
    line.style.stroke = "var(--llm-pref-stroke)";
    svg.appendChild(line);
    const text = svgEl(doc, "text", {
      x: model.plot.x - 6,
      y: tick.y + 3,
      "font-size": 8,
      "text-anchor": "end",
    });
    text.style.fill = TEXT_SECONDARY;
    text.textContent = tick.label;
    svg.appendChild(text);
  }
  for (const bar of model.bars) {
    for (const segment of bar.segments) {
      const path = svgEl(doc, "path", {
        d: segment.roundTop
          ? roundedTopRectPath(
              bar.x,
              segment.y,
              bar.width,
              segment.height,
              USAGE_CHART_BAR_RADIUS,
            )
          : roundedTopRectPath(bar.x, segment.y, bar.width, segment.height, 0),
        "data-usage-chart-bar": bar.localDate,
      });
      path.style.fill = segment.color;
      svg.appendChild(path);
    }
  }
  for (const tick of model.xTicks) {
    const text = svgEl(doc, "text", {
      x: tick.x,
      y: model.height - 3,
      "font-size": 8,
      "text-anchor": "middle",
    });
    text.style.fill = TEXT_SECONDARY;
    text.textContent = tick.label;
    svg.appendChild(text);
  }
  return svg;
}

function chartLegend(doc: Document, palette: UsagePalette): HTMLDivElement {
  const legend = el(
    doc,
    "div",
    `display: flex; align-items: center; gap: 12px; font-size: 11px;` +
      ` color: ${TEXT_SECONDARY};`,
  );
  for (const [label, color] of [
    ["Paper chat", palette.paper],
    ["Library chat", palette.library],
  ] as const) {
    const entry = el(
      doc,
      "div",
      "display: flex; align-items: center; gap: 5px;",
    );
    entry.appendChild(colorDot(doc, color));
    entry.appendChild(el(doc, "span", "", t(label)));
    legend.appendChild(entry);
  }
  return legend;
}

// ── sections ────────────────────────────────────────────────────────

/** `heading` is the section's stable English name; the user reads `t()` of it. */
function section(doc: Document, heading: string, aside?: Node): HTMLDivElement {
  const wrap = el(
    doc,
    "div",
    "display: flex; flex-direction: column; gap: 6px;",
  );
  wrap.setAttribute("data-usage-section", heading);
  const head = row(
    doc,
    "display: flex; align-items: center; justify-content: space-between; gap: 10px;",
  );
  head.appendChild(sectionHeading(doc, t(heading)));
  if (aside) head.appendChild(aside);
  wrap.appendChild(head);
  return wrap;
}

/**
 * Turns in these rows whose provider never reported a token count.
 *
 * The Tokens card needs it so a small total next to a large question count
 * can say how much of the ledger is missing rather than implying a cheap turn.
 */
function countUnreportedTurns(models: readonly UsageModelUsage[]): number {
  return models.reduce((sum, model) => sum + (model.unreportedTurns || 0), 0);
}

/** Turns in these rows whose tokens were rebuilt from stored chat history. */
function countEstimatedTurns(models: readonly UsageModelUsage[]): number {
  return models.reduce((sum, model) => sum + (model.estimatedTurns || 0), 0);
}

/**
 * The read layer's two display fallbacks are copy, not data, so they are the
 * one thing in a list row that gets translated; a real paper or conversation
 * title is the user's own text and is never touched.
 */
function displayTitle(title: string): string {
  return title === UNTITLED_CONVERSATION_LABEL || title === MISSING_PAPER_LABEL
    ? t(title)
    : title;
}

/**
 * One 11px line under the cards when the range reaches back before the ledger.
 *
 * The heatmap needs no such line: questions and papers come from real
 * messages and are exact. Only the token numbers are reconstructed.
 */
function appendEstimateNote(
  doc: Document,
  body: HTMLElement,
  models: readonly UsageModelUsage[],
): void {
  const note = describeUsageEstimateNote({
    estimatedTurns: countEstimatedTurns(models),
  });
  if (!note) return;
  const line = mutedLine(doc, note);
  line.setAttribute("data-usage-estimate-note", "true");
  body.appendChild(line);
}

/** One model row: name and source, a two-segment bar, the split, the tokens. */
function modelRow(
  doc: Document,
  model: UsageModelUsage,
  palette: UsagePalette,
): HTMLDivElement {
  const line = el(
    doc,
    "div",
    "display: flex; align-items: center; gap: 10px; padding: 3px 0;",
  );
  line.setAttribute("data-usage-row", "model");
  const text = el(doc, "div", "flex: 1; min-width: 0;");
  text.appendChild(
    el(
      doc,
      "div",
      `font-size: 12px; color: ${TEXT_PRIMARY}; overflow: hidden;` +
        ` text-overflow: ellipsis; white-space: nowrap;`,
      model.model || t("Unnamed model"),
    ),
  );
  // One model can hold two rows — called directly through its API in one,
  // driven by Claude Code or Codex in the other. Naming the source is what
  // stops one model name with two different token totals reading as a bug.
  const source = describeUsageModelSource(model);
  text.appendChild(
    mutedLine(
      doc,
      source ||
        (model.unreportedTurns > 0
          ? t("tokens not reported")
          : t("unknown source")),
    ),
  );
  line.appendChild(text);

  const bar = el(
    doc,
    "div",
    `width: 96px; flex: 0 0 96px; height: 5px; border-radius: 3px;` +
      ` background: ${SUBTLE_SURFACE}; overflow: hidden; display: flex;`,
  );
  const total = model.paperQuestions + model.libraryQuestions;
  for (const [count, color] of [
    [model.paperQuestions, palette.paper],
    [model.libraryQuestions, palette.library],
  ] as const) {
    if (total <= 0 || count <= 0) continue;
    bar.appendChild(
      el(
        doc,
        "div",
        `width: ${((count / total) * 100).toFixed(2)}%; height: 100%; background: ${color};`,
      ),
    );
  }
  line.appendChild(bar);
  line.appendChild(
    el(
      doc,
      "div",
      `width: 62px; flex: 0 0 62px; text-align: right; font-size: 11px;` +
        ` color: ${TEXT_SECONDARY};`,
      `${formatUsageCount(model.paperQuestions)} / ${formatUsageCount(model.libraryQuestions)}`,
    ),
  );
  line.appendChild(
    el(
      doc,
      "div",
      `width: 48px; flex: 0 0 48px; text-align: right; font-size: 11px;` +
        ` color: ${TEXT_SECONDARY};`,
      formatUsageTokens(model.totalTokens),
    ),
  );
  return line;
}

function renderOverview(
  doc: Document,
  state: PanelState,
  snapshot: UsageSnapshot,
  palette: UsagePalette,
): HTMLElement {
  const body = el(
    doc,
    "div",
    "display: flex; flex-direction: column; gap: 14px;",
  );
  const { paper, library } = snapshot.totals;
  const tokensCard = describeUsageTokensCard({
    promptTokens: paper.promptTokens + library.promptTokens,
    completionTokens: paper.completionTokens + library.completionTokens,
    totalTokens: paper.totalTokens + library.totalTokens,
    unreportedTurns: countUnreportedTurns(snapshot.models),
    questions: paper.questions + library.questions,
  });
  body.appendChild(
    metricCardRow(doc, [
      {
        label: "Paper chat",
        dotColor: palette.paper,
        value: formatUsageCount(paper.questions),
        sub: usageText(
          paper.distinctPapers === 1
            ? "questions · {count} paper"
            : "questions · {count} papers",
          { count: formatUsageCount(paper.distinctPapers) },
        ),
      },
      {
        label: "Library chat",
        dotColor: palette.library,
        value: formatUsageCount(library.questions),
        sub: usageText(
          library.distinctConversations === 1
            ? "questions · {count} conversation"
            : "questions · {count} conversations",
          { count: formatUsageCount(library.distinctConversations) },
        ),
      },
      { label: "Tokens", value: tokensCard.value, sub: tokensCard.sub },
    ]),
  );
  appendEstimateNote(doc, body, snapshot.models);

  const metricToggle = segmentedControl(doc, {
    name: "metric",
    segments: metricSegments(),
    active: state.metric,
    onPick: (metric) => {
      state.metric = metric;
      render(state);
    },
  });
  const activity = section(doc, "Activity", metricToggle);
  activity.appendChild(
    renderHeatmap(
      doc,
      state,
      new Map(snapshot.heatmap.days.map((day) => [day.localDate, day])),
      buildUsageHeatmapGrid(snapshot.heatmap.days, state.metric),
      palette,
    ),
  );
  const summary = mutedLine(
    doc,
    describeUsageHeatmapSummary(snapshot.heatmap, state.metric),
  );
  summary.setAttribute(
    "style",
    summary.getAttribute("style") + " text-align: right;",
  );
  summary.setAttribute("data-usage-heatmap-summary", "true");
  activity.appendChild(summary);
  activity.appendChild(renderHeatmapLegend(doc, palette));
  body.appendChild(activity);

  const tokens = section(doc, "Tokens per day", chartLegend(doc, palette));
  tokens.appendChild(
    renderTokenChart(
      doc,
      buildUsageTokenChartModel(snapshot.daily, {
        width: SURFACE_WIDTH,
        height: USAGE_CHART_HEIGHT,
        palette,
      }),
    ),
  );
  body.appendChild(tokens);

  const models = section(doc, "Models");
  if (!snapshot.models.length) {
    models.appendChild(
      mutedLine(doc, t("No model recorded a turn in this range.")),
    );
  }
  for (const model of snapshot.models.slice(0, MODEL_TABLE_LIMIT)) {
    models.appendChild(modelRow(doc, model, palette));
  }
  body.appendChild(models);
  return body;
}

function renderPaperTab(
  doc: Document,
  snapshot: UsageSnapshot,
  palette: UsagePalette,
): HTMLElement {
  const body = el(
    doc,
    "div",
    "display: flex; flex-direction: column; gap: 14px;",
  );
  const { paper } = snapshot.totals;
  const tokensCard = describeUsageTokensCard({
    ...paper,
    unreportedTurns: countUnreportedTurns(snapshot.paperModels),
  });
  body.appendChild(
    metricCardRow(doc, [
      {
        label: "Questions",
        dotColor: palette.paper,
        value: formatUsageCount(paper.questions),
        sub: usageText(
          paper.distinctConversations === 1
            ? "in {count} conversation"
            : "in {count} conversations",
          { count: formatUsageCount(paper.distinctConversations) },
        ),
      },
      { label: "Tokens", value: tokensCard.value, sub: tokensCard.sub },
      {
        label: "Papers",
        value: formatUsageCount(paper.distinctPapers),
        sub: t("asked about in this range"),
      },
    ]),
  );
  appendEstimateNote(doc, body, snapshot.paperModels);
  const list = section(doc, "Papers you asked about most");
  if (!snapshot.papers.length) {
    list.appendChild(
      mutedLine(doc, t("No paper chat questions in this range.")),
    );
  }
  const top = snapshot.papers[0]?.questions || 0;
  for (const entry of snapshot.papers.slice(0, DETAIL_LIST_LIMIT)) {
    list.appendChild(
      detailRow(doc, {
        // The list is called "Papers you asked about most", so the primary
        // text is the title the user knows. The citation label is the fallback
        // for a paper Zotero no longer holds, or holds without a title.
        title: entry.paperTitle || displayTitle(entry.title),
        sub: usageText(
          entry.inLibrary
            ? "{tokens} tokens"
            : "{tokens} tokens · removed from your library",
          { tokens: formatUsageTokens(entry.totalTokens) },
        ),
        fraction: top > 0 ? entry.questions / top : 0,
        color: palette.paper,
        value: formatUsageCount(entry.questions),
      }),
    );
  }
  body.appendChild(list);
  return body;
}

function renderLibraryTab(
  doc: Document,
  snapshot: UsageSnapshot,
  palette: UsagePalette,
): HTMLElement {
  const body = el(
    doc,
    "div",
    "display: flex; flex-direction: column; gap: 14px;",
  );
  const { library } = snapshot.totals;
  const tokensCard = describeUsageTokensCard({
    ...library,
    unreportedTurns: countUnreportedTurns(snapshot.libraryModels),
  });
  body.appendChild(
    metricCardRow(doc, [
      {
        label: "Questions",
        dotColor: palette.library,
        value: formatUsageCount(library.questions),
        sub: t("asked in library chat"),
      },
      { label: "Tokens", value: tokensCard.value, sub: tokensCard.sub },
      {
        label: "Conversations",
        value: formatUsageCount(library.distinctConversations),
        sub: t("with a question in this range"),
      },
    ]),
  );
  appendEstimateNote(doc, body, snapshot.libraryModels);
  const list = section(doc, "Heaviest conversations");
  if (!snapshot.conversations.length) {
    list.appendChild(
      mutedLine(doc, t("No library chat questions in this range.")),
    );
  }
  const top = snapshot.conversations[0]?.totalTokens || 0;
  for (const entry of snapshot.conversations.slice(0, DETAIL_LIST_LIMIT)) {
    list.appendChild(
      detailRow(doc, {
        title: displayTitle(entry.title),
        sub: usageText(
          entry.questions === 1 ? "{count} question" : "{count} questions",
          { count: formatUsageCount(entry.questions) },
        ),
        fraction: top > 0 ? entry.totalTokens / top : 0,
        color: palette.library,
        value: formatUsageTokens(entry.totalTokens),
      }),
    );
  }
  body.appendChild(list);
  return body;
}

// ── export and reset ────────────────────────────────────────────────

type SavePickerResult =
  | { status: "selected"; path: string }
  | { status: "cancelled" }
  | { status: "unavailable" };

type SaveFilePicker = {
  init?: (parent: unknown, title: string, mode: number) => void;
  appendFilter?: (title: string, filter: string) => void;
  open?: (callback: (result: number) => void) => void;
  show?: () => number | Promise<number>;
  defaultString?: string;
  defaultExtension?: string;
  file?: string | { path?: string };
  modeSave?: number;
  returnOK?: number;
  returnReplace?: number;
};

/** Zotero builds that do not expose the picker on the namespace still ship it. */
function importZoteroFilePicker(): (new () => SaveFilePicker) | null {
  try {
    const module = (
      globalThis as {
        ChromeUtils?: { importESModule?: (url: string) => unknown };
      }
    ).ChromeUtils?.importESModule?.(
      "chrome://zotero/content/modules/filePicker.mjs",
    ) as { FilePicker?: new () => SaveFilePicker } | undefined;
    return typeof module?.FilePicker === "function" ? module.FilePicker : null;
  } catch (error) {
    log("Usage export could not import Zotero's file picker", error);
    return null;
  }
}

/**
 * Zotero's own save dialog, so the user picks a real destination on their own
 * platform. The path it hands back is already native (backslashes on Windows,
 * slashes on macOS and Linux) and is passed to IOUtils untouched — building a
 * path by hand here is exactly how a cross-platform export breaks.
 */
async function pickCsvSavePath(
  win: Window,
  fileName: string,
): Promise<SavePickerResult> {
  const FilePicker =
    (Zotero as unknown as { FilePicker?: new () => SaveFilePicker })
      .FilePicker || importZoteroFilePicker();
  if (typeof FilePicker !== "function") return { status: "unavailable" };
  let picker: SaveFilePicker;
  try {
    picker = new FilePicker();
    picker.init?.(win, t("Export usage statistics"), picker.modeSave ?? 1);
    picker.defaultString = fileName;
    picker.defaultExtension = "csv";
    picker.appendFilter?.("CSV", "*.csv");
  } catch (error) {
    log("Usage export could not open a file picker", error);
    return { status: "unavailable" };
  }
  const result = await new Promise<number>((resolve) => {
    try {
      if (typeof picker.open === "function") {
        picker.open((value: number) => resolve(value));
        return;
      }
      void Promise.resolve(picker.show?.() ?? -1).then(resolve, () =>
        resolve(-1),
      );
    } catch (error) {
      log("Usage export file picker failed", error);
      resolve(-1);
    }
  });
  const ok =
    result === (picker.returnOK ?? 0) || result === (picker.returnReplace ?? 1);
  if (!ok) return { status: "cancelled" };
  const file = picker.file;
  const path = typeof file === "string" ? file : file?.path || "";
  return path ? { status: "selected", path } : { status: "unavailable" };
}

async function exportUsageCsv(
  state: PanelState,
  status: HTMLElement,
): Promise<void> {
  const win = state.doc.defaultView;
  if (!win) return;
  status.textContent = t("Preparing export…");
  try {
    const rows = await loadUsageEventsForExport({ range: state.range });
    const picked = await pickCsvSavePath(win, usageCsvFileName());
    if (picked.status === "cancelled") {
      status.textContent = "";
      return;
    }
    if (picked.status === "unavailable") {
      status.textContent = t("Could not open a save dialog.");
      return;
    }
    const path = picked.path.toLowerCase().endsWith(".csv")
      ? picked.path
      : `${picked.path}.csv`;
    await IOUtils.write(
      path,
      new TextEncoder().encode(serializeUsageEventsCsv(rows)),
    );
    status.textContent = usageText(
      rows.length === 1 ? "Exported {count} row." : "Exported {count} rows.",
      { count: formatUsageCount(rows.length) },
    );
  } catch (error) {
    log("Usage export failed", error);
    status.textContent = t("Export failed.");
  }
}

/**
 * Destructive, so it says exactly what disappears before anything is deleted,
 * including the reconstructed history that no later pass will bring back.
 *
 * The reconstructed count is read from the ledger here rather than taken from
 * the panel's snapshot: the snapshot is per range and per visit, and a warning
 * about what a delete destroys must not depend on which tab is open.
 */
async function confirmUsageReset(events: number): Promise<boolean> {
  const dialogData: { [key: string]: unknown } = {
    loadCallback: () => undefined,
    unloadCallback: () => undefined,
  };
  const message = describeUsageResetConfirmation({
    events,
    historyEstimateRows: await countHistoryEstimateUsageEvents(),
  });
  const dialog = new ztoolkit.Dialog(1, 1)
    .addCell(0, 0, {
      tag: "div",
      namespace: "html",
      properties: { textContent: message },
      styles: { width: "420px", lineHeight: "1.45", whiteSpace: "pre-line" },
    })
    .addButton(t("Delete usage statistics"), "reset")
    .addButton(t("Cancel"), "cancel")
    .setDialogData(dialogData)
    .open(t("Reset usage statistics?"));
  const unregisterDialog = registerAddonDialog(dialog);
  try {
    await (dialogData as { unloadLock: { promise: Promise<void> } }).unloadLock
      .promise;
  } finally {
    unregisterDialog();
  }
  return (dialogData as { _lastButtonId?: string })._lastButtonId === "reset";
}

function renderFooter(doc: Document, state: PanelState): HTMLDivElement {
  const footer = el(
    doc,
    "div",
    `display: flex; align-items: center; gap: 8px; padding-top: 8px;` +
      ` border-top: ${HAIRLINE};`,
  );
  const status = mutedLine(doc, "");
  status.setAttribute(
    "style",
    `${status.getAttribute("style")} flex: 1; min-width: 0;`,
  );
  footer.appendChild(status);
  const exportBtn = el(doc, "button", "font-size: 11px;", t("Export CSV"));
  exportBtn.className = "llm-pref-button";
  (exportBtn as HTMLButtonElement).type = "button";
  exportBtn.setAttribute("data-usage-action", "export");
  exportBtn.addEventListener("click", () => {
    void exportUsageCsv(state, status);
  });
  footer.appendChild(exportBtn);
  const resetBtn = el(doc, "button", "font-size: 11px;", t("Reset statistics"));
  resetBtn.className = "llm-pref-button llm-pref-button--danger";
  (resetBtn as HTMLButtonElement).type = "button";
  resetBtn.setAttribute("data-usage-action", "reset");
  resetBtn.addEventListener("click", () => {
    void (async () => {
      if (!(await confirmUsageReset(state.totalEvents))) return;
      if (!(await clearAllUsageEvents())) {
        status.textContent = t("Could not clear the usage statistics.");
        return;
      }
      state.snapshots.clear();
      state.totalEvents = 0;
      await reload(state);
    })();
  });
  footer.appendChild(resetBtn);
  return footer;
}

// ── loading ─────────────────────────────────────────────────────────

/**
 * Load one range's worth of numbers.
 *
 * The per-mode cards need a per-mode model breakdown: a model's paper tokens
 * and library tokens cannot be separated after the fact, so the database
 * splits them.
 */
async function loadSnapshot(
  range: UsageRangeKey,
  windows: { heatmapDays: number; chartDays: number },
): Promise<UsageSnapshot> {
  const [
    totals,
    heatmap,
    models,
    paperModels,
    libraryModels,
    papers,
    conversations,
  ] = await Promise.all([
    loadUsageModeTotals({ range }),
    loadUsageHeatmap({ days: windows.heatmapDays }),
    loadUsageModelBreakdown({ range }),
    loadUsageModelBreakdown({ range, mode: "paper" }),
    loadUsageModelBreakdown({ range, mode: "library" }),
    loadTopUsagePapers({ range, limit: DETAIL_LIST_LIMIT }),
    loadHeaviestUsageConversations({ range, limit: DETAIL_LIST_LIMIT }),
  ]);
  const daily = await loadUsageDailyTokens({ days: windows.chartDays });
  return {
    range,
    totals,
    heatmap,
    daily,
    models,
    paperModels,
    libraryModels,
    papers,
    conversations,
  };
}

/**
 * The two windows the charts cover.
 *
 * The heatmap is an activity calendar, not a filtered report: it always spans
 * the history that exists (up to the spec's 53 columns), because squeezing it
 * into a 7-day range would leave two columns of cells where a year-wide grid
 * belongs. Its own summary line says what window it is describing.
 *
 * The daily token chart is the one that follows the range control, and "All"
 * grows with the history that exists so a two-week-old install never sees a
 * year of empty bars.
 */
function resolveWindowDays(
  range: UsageRangeKey,
  firstDate: string | null,
): { heatmapDays: number; chartDays: number } {
  const historyDays = resolveUsageHeatmapDays(firstDate);
  const chartDays =
    range === "last7" ? 7 : range === "last30" ? 30 : historyDays;
  return { heatmapDays: historyDays, chartDays };
}

async function reload(state: PanelState): Promise<void> {
  const pending = (async () => {
    const bounds = await loadUsageHistoryBounds();
    state.totalEvents = bounds.events;
    if (bounds.events > 0 && !state.snapshots.has(state.range)) {
      state.snapshots.set(
        state.range,
        await loadSnapshot(
          state.range,
          resolveWindowDays(state.range, bounds.firstDate),
        ),
      );
    }
  })();
  state.loading = pending;
  try {
    await pending;
  } catch (error) {
    log("Usage statistics could not be loaded", error);
  } finally {
    if (state.loading === pending) state.loading = null;
    state.loadedOnce = true;
  }
  // The preferences window can close while a query is in flight.
  if (!state.root.isConnected) return;
  render(state);
}

// ── panel ───────────────────────────────────────────────────────────

function renderEmptyLedger(doc: Document): HTMLElement {
  const wrap = el(
    doc,
    "div",
    "display: flex; flex-direction: column; gap: 4px;",
  );
  wrap.setAttribute("data-usage-empty", "none");
  wrap.appendChild(sectionHeading(doc, t("No usage recorded yet")));
  wrap.appendChild(
    el(
      doc,
      "div",
      `font-size: 11px; line-height: 1.5; color: ${TEXT_SECONDARY};`,
      t(
        "Ask a question in paper chat or library chat and this tab will start " +
          "counting your questions and tokens. Everything stays in your own " +
          "Zotero database — nothing is sent anywhere.",
      ),
    ),
  );
  return wrap;
}

function render(state: PanelState): void {
  const { doc, root } = state;
  clear(root);
  // The popover lives in the tree the render just threw away, so it is built
  // with it; nothing survives a repaint to leak.
  state.popover = null;
  if (!state.loadedOnce) {
    // "No usage recorded yet" is a claim about the ledger, so it may not be
    // shown before the ledger has answered.
    root.appendChild(mutedLine(doc, t("Loading usage…")));
    return;
  }
  if (state.totalEvents <= 0) {
    root.appendChild(renderEmptyLedger(doc));
    return;
  }
  const controls = row(
    doc,
    "display: flex; align-items: center; justify-content: space-between; gap: 10px;",
  );
  controls.appendChild(
    segmentedControl(doc, {
      name: "subtab",
      segments: subTabSegments(),
      active: state.subTab,
      onPick: (subTab) => {
        state.subTab = subTab;
        render(state);
      },
    }),
  );
  controls.appendChild(
    segmentedControl(doc, {
      name: "range",
      segments: rangeSegments(),
      active: state.range,
      onPick: (range) => {
        state.range = range;
        // A range with no snapshot needs a query; one already cached repaints
        // without touching the database.
        // Repaint immediately either way: a cached range needs no query, and
        // an uncached one must still show that the click was heard.
        render(state);
        if (!state.snapshots.has(range)) void reload(state);
      },
    }),
  );
  root.appendChild(controls);

  const snapshot = state.snapshots.get(state.range);
  if (!snapshot) {
    root.appendChild(mutedLine(doc, t("Loading usage…")));
    root.appendChild(renderFooter(doc, state));
    return;
  }
  const rangeQuestions =
    snapshot.totals.paper.questions + snapshot.totals.library.questions;
  const rangeTokens =
    snapshot.totals.paper.totalTokens + snapshot.totals.library.totalTokens;
  const empty = resolveUsageEmptyState({
    hasAnyUsage: state.totalEvents > 0,
    rangeHasUsage: rangeQuestions > 0 || rangeTokens > 0,
  });
  if (empty === "range") {
    const notice = el(
      doc,
      "div",
      `font-size: 11px; color: ${TEXT_SECONDARY};`,
      t(RANGE_EMPTY_COPY[state.range]),
    );
    notice.setAttribute("data-usage-empty", "range");
    root.appendChild(notice);
    root.appendChild(renderFooter(doc, state));
    return;
  }
  const palette = resolveUsagePalette(resolveColorScheme(doc));
  if (state.subTab === "overview") {
    // Only the Overview draws a heatmap, so only it needs the hover card.
    state.popover = createHeatmapPopover(doc);
    root.appendChild(state.popover);
    root.appendChild(renderOverview(doc, state, snapshot, palette));
  } else if (state.subTab === "paper") {
    root.appendChild(renderPaperTab(doc, snapshot, palette));
  } else {
    root.appendChild(renderLibraryTab(doc, snapshot, palette));
  }
  root.appendChild(renderFooter(doc, state));
}

/**
 * What activating the Usage tab has to do.
 *
 * The snapshots are cached for the life of the preferences window, which is
 * right while the user is working the range and sub-tab controls and wrong the
 * moment they leave the window, ask a question, and come back: the tab would
 * still be showing the ledger as it stood when the window opened. So the FIRST
 * activation loads lazily and every later one — including re-clicking the tab
 * the user is already on — throws the cache away and re-queries. A load
 * already in flight is left alone; it is by definition current.
 */
export function planUsageTabActivation(input: {
  started: boolean;
  loading: boolean;
}): { start: boolean; refresh: boolean } {
  if (!input.started) return { start: true, refresh: false };
  if (input.loading) return { start: false, refresh: false };
  return { start: false, refresh: true };
}

/**
 * The locale the preferences window itself is running in, for the one date
 * the panel spells out. A window that cannot answer leaves it undefined and
 * the runtime's own default decides.
 */
function resolveWindowLocale(win: Window): string | undefined {
  try {
    const language = (win as { navigator?: { language?: unknown } }).navigator
      ?.language;
    return typeof language === "string" && language ? language : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Wire the Usage tab.
 *
 * Nothing is queried here: the panel loads the first time its tab is opened,
 * so the preferences window opens at the same speed it always has.
 */
export function registerUsagePreferencePanel(win: Window): void {
  const doc = win.document;
  const root = doc.querySelector(
    `#${config.addonRef}-usage-root`,
  ) as HTMLElement | null;
  if (!root) return;
  // The hover card is placed in the root's own coordinates, so the root is
  // what it is positioned against.
  root.style.position = "relative";
  const state: PanelState = {
    doc,
    root,
    locale: resolveWindowLocale(win),
    popover: null,
    subTab: "overview",
    range: "last30",
    metric: "questions",
    totalEvents: 0,
    snapshots: new Map(),
    loading: null,
    started: false,
    loadedOnce: false,
  };
  const start = () => {
    if (state.started) return;
    state.started = true;
    render(state);
    void reload(state);
  };
  const tabButton = doc.querySelector(
    '[data-pref-tab="usage"]',
  ) as HTMLElement | null;
  tabButton?.addEventListener("click", () => {
    const plan = planUsageTabActivation({
      started: state.started,
      loading: Boolean(state.loading),
    });
    if (plan.start) {
      start();
      return;
    }
    if (!plan.refresh) return;
    // The cache is dropped but the pane is NOT repainted: what is on screen
    // is last visit's answer, which is better than a flash of "Loading usage…"
    // for the fraction of a second the queries take. `reload` repaints when
    // the numbers land.
    state.snapshots.clear();
    void reload(state);
  });
  // The data colours are fixed hexes chosen per scheme, so a theme switch
  // while the tab is open has to repaint; the CSS variables around them
  // already follow it on their own.
  try {
    const media = win.matchMedia?.("(prefers-color-scheme: dark)");
    media?.addEventListener?.("change", () => {
      if (state.started && state.root.isConnected) render(state);
    });
  } catch (error) {
    log("Usage panel could not watch the colour scheme", error);
  }
  // A build that somehow opens straight onto the tab must still load.
  if (root.getBoundingClientRect().height > 0) start();
}
