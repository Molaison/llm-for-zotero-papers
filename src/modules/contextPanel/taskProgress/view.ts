/**
 * The Task progress row (under the panel header) and its drawer: the one
 * task-progress view in the plugin.
 *
 * The row names the run's state and counts; clicking it unrolls the drawer, a
 * card attached under the row at the top of `#llm-chat-shell`. The drawer is
 * in the flow: the chat below it shrinks (to no less than a strip the CSS
 * keeps) while its messages stay mounted, and the chat's scroll owner keeps
 * the reading position or the follow-bottom intent. The drawer is as tall as
 * its content, up to the space above that strip or the height the user
 * dragged it to (remembered for the session, in memory only). It lists every
 * paper in the turn's scope in order, windowed, with what was read from each
 * and where the answer cites it; while a plan, a built-in action or Codex's
 * own plan runs, its steps lead the drawer.
 *
 * Opening and closing animate the drawer's height between measured pixel
 * heights (CSS cannot transition to `auto`); with reduced motion, or without
 * a layout (unit tests), every change settles at once.
 *
 * Across questions the view accumulates: a paper shows the strongest state
 * any question gave it, its details are grouped by question, and the counts
 * (row and header) describe the latest question.
 *
 * Repaints are coalesced to at most four a second. The paper list is built
 * only while the drawer is open, and a paper's details only while expanded.
 */
import type {
  TaskPaperLedgerEntry,
  TaskPaperReadEvent,
  TaskPaperState,
  TaskPaperTextSource,
} from "../../../agent/context/taskPaperLedger";
import type { TaskPaperScopeEntry } from "../../../agent/context/taskPaperScopeListing";
import { t } from "../../../utils/i18n";
import {
  countPlanSteps,
  isLivePlanExecutionStatus,
  renderChecklistSteps,
  renderPlanSteps,
} from "./planSteps";
import {
  getTaskProgress,
  subscribeTaskProgress,
  type TaskProgressRecord,
  type TaskRunState,
} from "./store";
import {
  shouldShowTaskProgress,
  type TaskProgressVisibilityInput,
} from "./visibility";

/** Paper rows built at a time; more are added as the list scrolls. */
export const TASK_PROGRESS_WINDOW = 80;
/** Minimum spacing of store-driven repaints: at most four a second. */
export const TASK_PROGRESS_REPAINT_MS = 250;
/** How long a cited quote card stays highlighted after a jump. */
export const TASK_PROGRESS_FLASH_MS = 1400;
/** The least height a drag leaves the drawer (less only if less fits). */
export const TASK_PROGRESS_DRAWER_MIN_PX = 96;
/** One arrow-key step on the drag handle; Shift makes it four. */
const DRAWER_KEY_STEP_PX = 16;
/** Past the transition's own duration, when a missed `transitionend` settles. */
const SETTLE_GRACE_MS = 80;

const ROW_ID = "llm-task-progress";
const DRAWER_ID = "llm-task-progress-drawer";
/** On the shell from the moment the drawer unrolls until it is rolled up. */
const SHOWN_CLASS = "llm-task-progress-shown";
/** On the chat shell while the Task progress card is in it. */
const PRESENT_CLASS = "llm-task-progress-present";
/** On the panel while the drag handle is held. */
const RESIZING_CLASS = "llm-task-progress-resizing";
/** On the row's parent while the row shows: the header drops its divider. */
const ROW_SHOWN_ATTR = "data-task-progress-row";
const DRAWER_MAX_VAR = "--llm-task-progress-drawer-max";
/** The drawer's current height, for the shell's absolutely placed children. */
const DRAWER_INSET_VAR = "--llm-task-progress-inset";
const FLASH_CLASS = "llm-task-progress-flash";

/**
 * The height the user dragged the drawer to, for this session only. Not a
 * pref: persisted state needs the user's sign-off.
 */
let rememberedDrawerHeight: number | null = null;

export function getRememberedTaskProgressDrawerHeight(): number | null {
  return rememberedDrawerHeight;
}

export function resetTaskProgressDrawerHeight(): void {
  rememberedDrawerHeight = null;
}

function format(template: string, values: Record<string, string | number>) {
  return t(template).replace(/\{(\w+)\}/g, (match, name: string) =>
    name in values ? String(values[name]) : match,
  );
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export type TaskProgressPaperRow = {
  key: string;
  /** 1-based position in scope order. */
  index: number;
  libraryID: number;
  itemId: number;
  title: string;
  creator: string;
  year: string;
  folders: string[];
  tags: string[];
  scopeText: TaskPaperScopeEntry["text"] | "unknown";
  /** False for a paper the ledger holds but the scope listing does not. */
  inScope: boolean;
  entry?: TaskPaperLedgerEntry;
  /** Strongest state over every question in the conversation. */
  state: TaskPaperState;
  /** State in the latest question alone: what the counts add up. */
  turnState: TaskPaperState;
};

/** The turn a row summarizes: the latest run's, or every turn before any. */
function summaryTurn(record: TaskProgressRecord | null): number {
  return record?.turnIndex || 0;
}

export function paperStateForTurn(
  entry: TaskPaperLedgerEntry | undefined,
  turn: number,
): TaskPaperState {
  if (!entry) return "listed";
  if (!turn) return entry.state;
  return entry.turns[turn]?.state || "listed";
}

/**
 * The drawer's rows: the scope in order, then any paper the ledger holds
 * that the scope listing does not (read outside the attached scope, or past
 * the whole-library cap).
 */
export function buildTaskProgressPaperRows(
  record: TaskProgressRecord | null,
): TaskProgressPaperRow[] {
  if (!record) return [];
  const turn = summaryTurn(record);
  const rows: TaskProgressPaperRow[] = [];
  const seen = new Set<string>();
  for (const scope of record.scope?.listing?.entries || []) {
    if (seen.has(scope.key)) continue;
    seen.add(scope.key);
    const entry = record.ledger.papers[scope.key];
    rows.push({
      key: scope.key,
      index: rows.length + 1,
      libraryID: scope.libraryID,
      itemId: scope.itemId,
      title: scope.title || entry?.title || `#${scope.itemId}`,
      creator: scope.firstCreator || entry?.creator || "",
      year: scope.year || entry?.year || "",
      folders: scope.collectionPaths,
      tags: scope.tags,
      scopeText: scope.text,
      inScope: true,
      entry,
      state: entry?.state || "listed",
      turnState: paperStateForTurn(entry, turn),
    });
  }
  for (const key of record.ledger.order) {
    if (seen.has(key)) continue;
    const entry = record.ledger.papers[key];
    if (!entry) continue;
    seen.add(key);
    rows.push({
      key,
      index: rows.length + 1,
      libraryID: entry.libraryID,
      itemId: entry.itemId,
      title: entry.title || `#${entry.itemId}`,
      creator: entry.creator || "",
      year: entry.year || "",
      folders: [],
      tags: [],
      scopeText: "unknown",
      inScope: false,
      entry,
      state: entry.state,
      turnState: paperStateForTurn(entry, turn),
    });
  }
  return rows;
}

/** Counts for the latest question. */
export type TaskProgressCounts = {
  total: number;
  matched: number;
  read: number;
  cited: number;
};

const STATE_RANK: Record<TaskPaperState, number> = {
  listed: 0,
  matched: 1,
  skimmed: 2,
  read: 3,
  cited: 4,
};

export function countTaskProgress(
  record: TaskProgressRecord | null,
  rows: TaskProgressPaperRow[] = buildTaskProgressPaperRows(record),
): TaskProgressCounts {
  const counts: TaskProgressCounts = {
    total: Math.max(
      rows.length,
      (record?.scope?.listing?.totalItems || 0) +
        rows.filter((row) => !row.inScope).length,
    ),
    matched: 0,
    read: 0,
    cited: 0,
  };
  for (const row of rows) {
    const rank = STATE_RANK[row.turnState];
    if (rank >= STATE_RANK.matched) counts.matched += 1;
    if (rank >= STATE_RANK.skimmed) counts.read += 1;
    if (rank >= STATE_RANK.cited) counts.cited += 1;
  }
  return counts;
}

/** The steps the row counts: a live plan's, else the checklist's. */
function currentSteps(record: TaskProgressRecord | null) {
  const ledger = record?.plan?.ledger;
  if (ledger && isLivePlanExecutionStatus(ledger.status)) {
    return countPlanSteps(ledger);
  }
  const checklist = record?.checklist;
  if (checklist && checklist.total > 0) {
    return { completed: checklist.done, total: checklist.total };
  }
  return null;
}

/** What a built-in action is doing, or how it ended. */
function actionText(record: TaskProgressRecord | null): string {
  const checklist = record?.checklist;
  if (checklist?.source !== "action") return "";
  const current = checklist.steps.find((step) => step.status === "in_progress");
  return (
    checklist.detail ||
    checklist.summary ||
    current?.label ||
    (checklist.outcome ? "" : checklist.title)
  );
}

/** The row's count text, e.g. "37 of 200 read · 12 cited". */
export function formatTaskProgressCount(
  record: TaskProgressRecord | null,
  recordsReads: boolean,
  counts: TaskProgressCounts = countTaskProgress(record),
): string {
  const state: TaskRunState = record?.runState || "idle";
  const steps = currentSteps(record);
  const stepsText = steps
    ? format("{done}/{total} steps", {
        done: steps.completed,
        total: steps.total,
      })
    : "";
  // A built-in action records no reads: the row says what it is doing.
  if (record?.checklist?.source === "action") {
    const parts = [stepsText, actionText(record)].filter(Boolean);
    return parts.join(" · ");
  }
  const papersKnown = counts.total > 0;
  if (!papersKnown) {
    return stepsText;
  }
  if (!recordsReads || state === "idle") {
    const inScope =
      counts.total === 1
        ? t("1 paper in scope")
        : format("{count} papers in scope", { count: counts.total });
    return stepsText ? `${stepsText} · ${inScope}` : inScope;
  }
  const readText = format("{read} of {total} read", {
    read: counts.read,
    total: counts.total,
  });
  const parts: string[] = [];
  if (state === "answering") parts.push(t("Answering…"));
  if (stepsText) parts.push(stepsText);
  parts.push(readText);
  if (counts.cited)
    parts.push(format("{count} cited", { count: counts.cited }));
  return parts.join(" · ");
}

const TOOL_LABELS: Record<string, string> = {
  library_retrieve: "Retrieve Library",
  library_search: "Search Library",
  search_paper: "Search Paper",
  query_library: "Query Library",
  library_read: "Read Library",
  paper_read: "Read Paper",
  read_paper: "Read Paper",
  read_attachment: "Read Attachment",
  view_pdf_pages: "View PDF Pages",
};

const GRANULARITY_LABELS: Record<TaskPaperReadEvent["granularity"], string> = {
  metadata: "Title/abstract match",
  abstract: "Abstract",
  outline: "Outline",
  section: "Section",
  passage: "Passage",
  full: "Full text",
  figure: "Figure",
  page: "Page",
};

function formatMethod(method: string | undefined): string {
  if (!method) return "";
  const lower = method.toLowerCase();
  if (lower === "bm25") return "BM25";
  return lower.replace(/_/g, " ");
}

/** "Retrieve Library · Methods §2.3 · BM25" */
export function formatTaskPaperRead(read: TaskPaperReadEvent): string {
  const tool = t(
    TOOL_LABELS[read.toolName] ||
      read.toolName.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()),
  );
  const where = read.label || t(GRANULARITY_LABELS[read.granularity] || "");
  return [tool, where, formatMethod(read.method)].filter(Boolean).join(" · ");
}

function sourceLabel(row: TaskProgressPaperRow, mineruKnown: boolean): string {
  const text: TaskPaperTextSource = row.entry?.text || "unknown";
  if (text === "mineru" || mineruKnown) return "MinerU";
  if (text === "pdf_text" || text === "indexed") return t("PDF text");
  if (text === "pdf") return "PDF";
  if (text === "none") return t("No text");
  if (row.scopeText === "pdf") return "PDF";
  if (row.scopeText === "none") return t("No text");
  return "";
}

function metaText(row: TaskProgressPaperRow): string {
  const who = [row.creator, row.year].filter(Boolean).join(" ");
  return [who, row.folders.join(", "), row.tags.join(", ")]
    .filter(Boolean)
    .join(" · ");
}

/** The row's tail over every question: "3 passages · cited 2". */
export function formatTaskPaperTail(row: TaskProgressPaperRow): string {
  if (row.state === "listed") return "";
  if (row.state === "matched") return t("title/abstract");
  const turns = Object.values(row.entry?.turns || {});
  const reads = turns.flatMap((entry) => entry.reads);
  const citations = turns.flatMap((entry) => entry.citations);
  const passages = reads.filter((read) => read.snippet).length;
  const parts: string[] = [];
  if (passages) {
    parts.push(
      passages === 1
        ? t("1 passage")
        : format("{count} passages", { count: passages }),
    );
  } else if (row.state === "skimmed") {
    const last = reads[reads.length - 1];
    parts.push(last?.granularity === "outline" ? t("outline") : t("abstract"));
  }
  if (citations.length) {
    parts.push(format("cited {count}", { count: citations.length }));
  }
  return parts.join(" · ");
}

const STATE_LABELS: Record<TaskPaperState, string> = {
  listed: "listed",
  matched: "matched",
  skimmed: "skimmed",
  read: "read",
  cited: "cited",
};

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const SVG_NS = "http://www.w3.org/2000/svg";

function svg(
  doc: Document,
  tag: string,
  attrs: Record<string, string>,
  children: Element[] = [],
): Element {
  const node = doc.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs))
    node.setAttribute(name, value);
  node.append(...children);
  return node;
}

/** A 20px status ring: a spinning arc while working, a badge once settled. */
function createStatusRing(doc: Document): HTMLElement {
  const ring = el(doc, "span", "llm-task-progress-ring");
  ring.setAttribute("aria-hidden", "true");
  const circle = (className: string, extra: Record<string, string> = {}) =>
    svg(doc, "circle", {
      class: className,
      cx: "10",
      cy: "10",
      r: "8.5",
      fill: "none",
      "stroke-width": "2",
      ...extra,
    });
  ring.append(
    svg(
      doc,
      "svg",
      {
        class: "llm-task-progress-ring-track",
        width: "20",
        height: "20",
        viewBox: "0 0 20 20",
      },
      [
        circle("llm-task-progress-ring-base"),
        circle("llm-task-progress-ring-arc", {
          "stroke-linecap": "round",
          "stroke-dasharray": "15 38.4",
        }),
      ],
    ),
  );
  const badge = (className: string, path: string) => {
    const node = el(doc, "span", `llm-task-progress-badge ${className}`);
    node.append(
      svg(
        doc,
        "svg",
        {
          width: "11",
          height: "11",
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          "stroke-width": "3.5",
          "stroke-linecap": "round",
          "stroke-linejoin": "round",
        },
        [svg(doc, "path", { d: path })],
      ),
    );
    return node;
  };
  ring.append(
    badge("llm-task-progress-badge-done", "M20 6L9 17l-5-5"),
    badge("llm-task-progress-badge-failed", "M18 6L6 18M6 6l12 12"),
  );
  return ring;
}

/** The card's header: status ring, label, counts, status pill, chevron. */
export function createTaskProgressRow(doc: Document): HTMLButtonElement {
  const row = el(doc, "button", "llm-task-progress");
  row.id = ROW_ID;
  row.type = "button";
  row.hidden = true;
  row.dataset.state = "idle";
  row.setAttribute("aria-expanded", "false");
  row.setAttribute("aria-controls", DRAWER_ID);
  const label = el(
    doc,
    "strong",
    "llm-task-progress-label",
    t("Task progress"),
  );
  const count = el(doc, "span", "llm-task-progress-count");
  const pill = el(doc, "span", "llm-task-progress-pill");
  pill.hidden = true;
  const chevron = el(doc, "span", "llm-task-progress-chevron");
  chevron.setAttribute("aria-hidden", "true");
  chevron.append(
    svg(
      doc,
      "svg",
      {
        width: "15",
        height: "15",
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        "stroke-width": "2.2",
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
      },
      [svg(doc, "path", { d: "M6 9l6 6 6-6" })],
    ),
  );
  row.append(createStatusRing(doc), label, count, pill, chevron);
  return row;
}

/**
 * The one Task progress container, first in `#llm-chat-shell`: its header row
 * and, under it, the drawer that unrolls inside the same card.
 */
export function createTaskProgressCard(doc: Document): HTMLElement {
  const card = el(doc, "section", "llm-task-progress-card");
  card.hidden = true;
  card.append(createTaskProgressRow(doc), createTaskProgressDrawer(doc));
  return card;
}

/**
 * The drawer, first in `#llm-chat-shell`: a scrolling body and a drag handle
 * on its bottom edge. Hidden until the row opens it.
 */
export function createTaskProgressDrawer(doc: Document): HTMLElement {
  const drawer = el(doc, "div", "llm-task-progress-drawer");
  drawer.id = DRAWER_ID;
  drawer.hidden = true;
  drawer.dataset.state = "closed";
  drawer.setAttribute("role", "region");
  drawer.setAttribute("aria-label", t("Task progress details"));
  const body = el(doc, "div", "llm-task-progress-drawer-body");
  const head = el(doc, "div", "llm-task-progress-head");
  const note = el(
    doc,
    "div",
    "llm-task-progress-note",
    t("Reads are recorded in Agent mode. This list shows the papers in scope."),
  );
  note.hidden = true;
  const steps = el(doc, "section", "llm-task-progress-steps");
  steps.hidden = true;
  steps.setAttribute("aria-label", t("Steps"));
  const list = el(doc, "ol", "llm-task-progress-list");
  list.setAttribute("role", "list");
  list.setAttribute("aria-label", t("Papers in scope"));
  const more = el(doc, "div", "llm-task-progress-more");
  more.hidden = true;
  body.append(head, note, steps, list, more);
  const grip = el(doc, "div", "llm-task-progress-drawer-grip");
  grip.tabIndex = 0;
  grip.title = t("Drag to resize Task progress");
  grip.setAttribute("role", "separator");
  grip.setAttribute("aria-orientation", "horizontal");
  grip.setAttribute("aria-label", t("Resize Task progress"));
  drawer.append(body, grip);
  return drawer;
}

type PaperRowRefs = {
  li: HTMLElement;
  summary: HTMLButtonElement;
  index: HTMLElement;
  title: HTMLElement;
  tail: HTMLElement;
  meta: HTMLElement;
  source: HTMLElement;
  details: HTMLElement;
  row: TaskProgressPaperRow;
};

export type TaskProgressViewDeps = {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  now: () => number;
  /** Whether a paper has MinerU text; asked only for rows on screen. */
  resolveMineru?: (paper: {
    libraryID: number;
    itemId: number;
  }) => Promise<boolean>;
  /** Scroll the chat to a quote card; defaults to `scrollIntoView`. */
  navigateToCitation?: (card: HTMLElement) => void;
  /** Live layout; without it (unit tests) the drawer settles at once. */
  layout?: TaskProgressLayout;
};

export type TaskProgressLayout = {
  /** The drawer's height transition in ms; 0 when motion is reduced. */
  motionMs: () => number;
  /** The least height the chat keeps below the shown drawer. */
  chatStripPx: () => number;
  /** Watch the drawer's size; returns the disconnect. */
  observeResize: (target: HTMLElement, onResize: () => void) => () => void;
  /** The chat viewport changed size with the drawer: keep its reading place. */
  onChatResized: () => void;
};

export type TaskProgressDrawerState = "closed" | "opening" | "open" | "closing";

export type TaskProgressViewInput = {
  conversationKey: number | null;
  visibility: Omit<TaskProgressVisibilityInput, "planSeen">;
  /** False in plain chat: reads are not recorded, only the scope lists. */
  recordsReads: boolean;
};

export type TaskProgressView = {
  setInput: (input: TaskProgressViewInput) => void;
  setOpen: (open: boolean, options?: { focusRow?: boolean }) => void;
  /** The state asked for; the drawer may still be animating toward it. */
  isOpen: () => boolean;
  drawerState: () => TaskProgressDrawerState;
  isVisible: () => boolean;
  /** Repaint now, skipping the coalescing delay. */
  flush: () => void;
  dispose: () => void;
  /** Paper rows currently in the DOM. */
  renderedRowCount: () => number;
};

export function mountTaskProgressView(params: {
  doc: Document;
  row: HTMLButtonElement;
  drawer: HTMLElement;
  shell: HTMLElement;
  chatBox: HTMLElement;
  /** Receives Escape while focus is anywhere in the panel. */
  keyTarget: HTMLElement;
  deps: TaskProgressViewDeps;
}): TaskProgressView {
  const { doc, row, drawer, shell, chatBox, keyTarget, deps } = params;
  const body = drawer.querySelector(
    ".llm-task-progress-drawer-body",
  ) as HTMLElement;
  const grip = drawer.querySelector(
    ".llm-task-progress-drawer-grip",
  ) as HTMLElement;
  const head = drawer.querySelector(".llm-task-progress-head") as HTMLElement;
  const note = drawer.querySelector(".llm-task-progress-note") as HTMLElement;
  const steps = drawer.querySelector(".llm-task-progress-steps") as HTMLElement;
  const list = drawer.querySelector(".llm-task-progress-list") as HTMLElement;
  const more = drawer.querySelector(".llm-task-progress-more") as HTMLElement;
  const countEl = row.querySelector(".llm-task-progress-count") as HTMLElement;
  const pillEl = row.querySelector(
    ".llm-task-progress-pill",
  ) as HTMLElement | null;
  const card = row.closest(".llm-task-progress-card") as HTMLElement | null;

  let input: TaskProgressViewInput = {
    conversationKey: null,
    visibility: {
      conversationKind: "",
      isWebChat: false,
      isNoteSession: false,
      collectionCount: 0,
      tagCount: 0,
      paperCount: 0,
    },
    recordsReads: true,
  };
  let open = false;
  let visible = false;
  let disposed = false;
  let paintTimer: unknown = null;
  let lastPaint = -Infinity;
  let paintedVersion = -1;
  let seenCollapseSeq = 0;
  let limit = TASK_PROGRESS_WINDOW;
  let rowsByKey = new Map<string, PaperRowRefs>();
  let orderedRefs: PaperRowRefs[] = [];
  const expanded = new Set<string>();
  const mineruKnown = new Set<string>();
  const mineruAsked = new Set<string>();
  const flashTimers = new Set<unknown>();

  const record = () =>
    input.conversationKey ? getTaskProgress(input.conversationKey) : null;

  const computeVisible = (current: TaskProgressRecord | null) =>
    Boolean(input.conversationKey) &&
    shouldShowTaskProgress({
      ...input.visibility,
      planSeen: Boolean(current?.planSeen),
    });

  // -------------------------------------------------------------------------
  // Drawer motion
  // -------------------------------------------------------------------------

  let drawerState: TaskProgressDrawerState = "closed";
  let settleTimer: unknown = null;

  const heightOf = (node: HTMLElement): number =>
    node.getBoundingClientRect?.().height ?? 0;

  const setDrawerState = (next: TaskProgressDrawerState) => {
    drawerState = next;
    drawer.dataset.state = next;
  };

  const clearSettleTimer = () => {
    if (settleTimer === null) return;
    deps.clearTimeout(settleTimer);
    settleTimer = null;
  };

  /** End the motion: open at its natural height, or rolled up and hidden. */
  const settle = () => {
    clearSettleTimer();
    drawer.style.height = "";
    if (drawerState === "opening") setDrawerState("open");
    if (drawerState === "closing") {
      setDrawerState("closed");
      drawer.hidden = true;
      shell.classList.remove(SHOWN_CLASS);
      shell.style.setProperty(DRAWER_INSET_VAR, "");
    }
  };

  const applyDrawerHeight = (height: number | null) => {
    if (height === null) {
      drawer.style.setProperty(DRAWER_MAX_VAR, "");
      grip.removeAttribute("aria-valuenow");
      return;
    }
    drawer.style.setProperty(DRAWER_MAX_VAR, `${Math.round(height)}px`);
    grip.setAttribute("aria-valuenow", `${Math.round(height)}`);
  };

  /**
   * Unroll or roll up the drawer. Height moves between two measured pixel
   * values (from wherever it is now, so a reversal mid-way is smooth); the
   * inline height is released once the motion ends.
   */
  const moveDrawer = (target: "open" | "closed", animated: boolean) => {
    const from = drawerState === "closed" ? 0 : heightOf(drawer);
    if (target === "open") {
      applyDrawerHeight(rememberedDrawerHeight);
      drawer.hidden = false;
      shell.classList.add(SHOWN_CLASS);
    }
    setDrawerState(target === "open" ? "opening" : "closing");
    const ms = animated && deps.layout ? deps.layout.motionMs() : 0;
    if (!(ms > 0)) {
      settle();
      return;
    }
    let to = 0;
    if (target === "open") {
      drawer.style.height = "";
      to = heightOf(drawer);
    }
    drawer.style.height = `${from}px`;
    // Flush layout so the transition starts from `from`.
    heightOf(drawer);
    drawer.style.height = `${to}px`;
    clearSettleTimer();
    settleTimer = deps.setTimeout(settle, ms + SETTLE_GRACE_MS);
  };

  const applyOpen = (next: boolean, animated = true) => {
    open = next;
    row.setAttribute("aria-expanded", next ? "true" : "false");
    moveDrawer(next ? "open" : "closed", animated);
  };

  const onTransitionEnd = (event: Event) => {
    if (event.target !== drawer) return;
    if ((event as TransitionEvent).propertyName !== "height") return;
    if (drawerState === "opening" || drawerState === "closing") settle();
  };

  const onDrawerResize = () => {
    if (drawerState === "closed") return;
    shell.style.setProperty(
      DRAWER_INSET_VAR,
      `${Math.round(heightOf(drawer))}px`,
    );
    deps.layout?.onChatResized();
  };
  const stopObservingDrawer =
    deps.layout?.observeResize(drawer, onDrawerResize) || (() => undefined);

  // -------------------------------------------------------------------------
  // Drag handle
  // -------------------------------------------------------------------------

  let drag: {
    startY: number;
    startHeight: number;
    min: number;
    max: number;
    height: number;
    moved: boolean;
  } | null = null;

  /** From the least height to all the chat can give while keeping its strip. */
  const dragBounds = () => {
    const current = heightOf(drawer);
    const strip = deps.layout?.chatStripPx() ?? 0;
    const max = Math.max(0, current + Math.max(0, heightOf(chatBox) - strip));
    return { current, min: Math.min(TASK_PROGRESS_DRAWER_MIN_PX, max), max };
  };

  const clamp = (value: number, min: number, max: number) =>
    Math.max(min, Math.min(max, value));

  const commitDrawerHeight = (height: number) => {
    rememberedDrawerHeight = Math.round(height);
    applyDrawerHeight(rememberedDrawerHeight);
  };

  const onDragMove = (event: Event) => {
    if (!drag) return;
    const pointerY = Number((event as MouseEvent).clientY);
    if (!Number.isFinite(pointerY)) return;
    drag.height = clamp(
      drag.startHeight + (pointerY - drag.startY),
      drag.min,
      drag.max,
    );
    drag.moved = true;
    applyDrawerHeight(drag.height);
    event.preventDefault?.();
    event.stopPropagation?.();
  };

  const endDrag = () => {
    if (!drag) return;
    const ended = drag;
    drag = null;
    doc.removeEventListener?.("mousemove", onDragMove, true);
    doc.removeEventListener?.("mouseup", endDrag, true);
    doc.defaultView?.removeEventListener?.("blur", endDrag);
    keyTarget.classList.remove(RESIZING_CLASS);
    try {
      (grip as any).releaseCapture?.();
    } catch {
      // Gecko can throw if capture was already released.
    }
    if (ended.moved) commitDrawerHeight(ended.height);
  };

  const onGripMouseDown = (event: Event) => {
    const pointer = event as MouseEvent;
    if (pointer.button !== 0 || drawerState !== "open") return;
    const bounds = dragBounds();
    drag = {
      startY: pointer.clientY,
      startHeight: bounds.current,
      min: bounds.min,
      max: bounds.max,
      height: bounds.current,
      moved: false,
    };
    grip.setAttribute("aria-valuemin", `${Math.round(bounds.min)}`);
    grip.setAttribute("aria-valuemax", `${Math.round(bounds.max)}`);
    keyTarget.classList.add(RESIZING_CLASS);
    try {
      (grip as any).setCapture?.(true);
    } catch {
      // The document listeners keep the drag going without capture.
    }
    doc.addEventListener?.("mousemove", onDragMove, true);
    doc.addEventListener?.("mouseup", endDrag, true);
    doc.defaultView?.addEventListener?.("blur", endDrag);
    event.preventDefault?.();
    event.stopPropagation?.();
  };

  const onGripKeyDown = (event: Event) => {
    const key = (event as KeyboardEvent).key;
    if (drawerState !== "open") return;
    const bounds = dragBounds();
    const step = (event as KeyboardEvent).shiftKey
      ? DRAWER_KEY_STEP_PX * 4
      : DRAWER_KEY_STEP_PX;
    let next: number | null = null;
    if (key === "ArrowUp") next = bounds.current - step;
    if (key === "ArrowDown") next = bounds.current + step;
    if (key === "Home") next = bounds.min;
    if (key === "End") next = bounds.max;
    if (next === null) return;
    commitDrawerHeight(clamp(next, bounds.min, bounds.max));
    event.preventDefault?.();
    event.stopPropagation?.();
  };

  /** Double-click: back to fitting the content, up to the chat's strip. */
  const onGripDoubleClick = (event: Event) => {
    rememberedDrawerHeight = null;
    applyDrawerHeight(null);
    event.preventDefault?.();
    event.stopPropagation?.();
  };

  const renderDetails = (refs: PaperRowRefs) => {
    const { row: model, details } = refs;
    const children: HTMLElement[] = [];
    const turns = Object.keys(model.entry?.turns || {})
      .map(Number)
      .filter((turn) => Number.isFinite(turn))
      .sort((a, b) => a - b);
    let anyReads = false;
    const citations: Array<{ id: string; quote: string; turn: number }> = [];
    for (const turn of turns) {
      const turnRecord = model.entry!.turns[turn];
      if (turnRecord.reads.length) {
        anyReads = true;
        children.push(
          el(
            doc,
            "div",
            "llm-task-paper-turn",
            turn > 0 ? format("Question {number}", { number: turn }) : "",
          ),
        );
        for (const read of turnRecord.reads) {
          const item = el(doc, "div", "llm-task-paper-read");
          item.append(
            el(doc, "div", "llm-task-paper-how", formatTaskPaperRead(read)),
          );
          if (read.snippet) {
            item.append(
              el(doc, "blockquote", "llm-task-paper-snippet", read.snippet),
            );
          }
          children.push(item);
        }
        if (turnRecord.droppedReads) {
          children.push(
            el(
              doc,
              "div",
              "llm-task-paper-empty",
              format("and {count} more reads", {
                count: turnRecord.droppedReads,
              }),
            ),
          );
        }
      }
      for (const citation of turnRecord.citations) {
        citations.push({
          id: citation.citationId,
          quote: citation.quote || citation.label || citation.citationId,
          turn,
        });
      }
    }
    const state = model.state;
    // Every question's reads are listed above; the line speaks when none read it.
    if (state === "listed") {
      children.push(
        el(
          doc,
          "div",
          "llm-task-paper-empty",
          input.recordsReads
            ? t("Listed in scope; not read for this question.")
            : t("Reads are recorded in Agent mode."),
        ),
      );
    } else if (
      state === "matched" &&
      !turns.some((turn) =>
        model.entry!.turns[turn].reads.some((read) => read.snippet),
      )
    ) {
      children.push(
        el(
          doc,
          "div",
          "llm-task-paper-empty",
          t("Matched by title or abstract; text not opened."),
        ),
      );
    }
    if (citations.length) {
      const citedIn = el(doc, "div", "llm-task-paper-cited");
      citedIn.append(
        el(doc, "div", "llm-task-paper-turn", t("Cited in answer")),
      );
      for (const citation of citations) {
        const link = el(
          doc,
          "button",
          "llm-task-paper-citation",
          `↳ “${citation.quote}”`,
        );
        link.type = "button";
        link.dataset.citationId = citation.id;
        link.addEventListener("click", (event: Event) => {
          event.preventDefault?.();
          event.stopPropagation?.();
          jumpToCitation(citation.id);
        });
        citedIn.append(link);
      }
      children.push(citedIn);
    }
    details.replaceChildren(...children);
  };

  const patchRow = (refs: PaperRowRefs, model: TaskProgressPaperRow) => {
    refs.row = model;
    if (refs.li.dataset.state !== model.state)
      refs.li.dataset.state = model.state;
    const indexText = `${model.index}`;
    if (refs.index.textContent !== indexText)
      refs.index.textContent = indexText;
    if (refs.title.textContent !== model.title) {
      refs.title.textContent = model.title;
      refs.title.title = model.title;
    }
    const tail = formatTaskPaperTail(model);
    if (refs.tail.textContent !== tail) refs.tail.textContent = tail;
    const meta = metaText(model);
    const metaTextEl = refs.meta.firstChild as HTMLElement;
    if (metaTextEl.textContent !== meta) metaTextEl.textContent = meta;
    const source = sourceLabel(model, mineruKnown.has(model.key));
    if (refs.source.textContent !== source) refs.source.textContent = source;
    refs.source.hidden = !source;
    refs.summary.setAttribute(
      "aria-label",
      `${model.index}. ${model.title}, ${t(STATE_LABELS[model.state])}`,
    );
    if (expanded.has(model.key)) renderDetails(refs);
  };

  const askMineru = (refs: PaperRowRefs) => {
    const model = refs.row;
    if (!deps.resolveMineru || mineruAsked.has(model.key)) return;
    if (model.entry?.text === "mineru" || model.scopeText === "none") return;
    mineruAsked.add(model.key);
    const conversation = input.conversationKey;
    void deps
      .resolveMineru({ libraryID: model.libraryID, itemId: model.itemId })
      .then((hasMineru) => {
        if (!hasMineru || disposed) return;
        mineruKnown.add(model.key);
        const current = rowsByKey.get(model.key);
        if (current && input.conversationKey === conversation) {
          patchRow(current, current.row);
        }
      })
      .catch(() => undefined);
  };

  const createRowRefs = (model: TaskProgressPaperRow): PaperRowRefs => {
    const li = el(doc, "li", "llm-task-paper");
    li.dataset.key = model.key;
    li.dataset.itemId = `${model.itemId}`;
    li.setAttribute("role", "listitem");
    const summary = el(doc, "button", "llm-task-paper-summary");
    summary.type = "button";
    summary.setAttribute("aria-expanded", "false");
    const index = el(doc, "span", "llm-task-paper-index");
    const dot = el(doc, "span", "llm-task-paper-dot");
    dot.setAttribute("aria-hidden", "true");
    const title = el(doc, "span", "llm-task-paper-title");
    const tail = el(doc, "span", "llm-task-paper-tail");
    const meta = el(doc, "span", "llm-task-paper-meta");
    const source = el(doc, "span", "llm-task-paper-source");
    meta.append(el(doc, "span", "llm-task-paper-meta-text"), source);
    // Gecko lays a button's children out in an anonymous block, so the grid
    // lives on an inner span.
    const grid = el(doc, "span", "llm-task-paper-grid");
    grid.append(index, dot, title, tail, meta);
    summary.append(grid);
    const details = el(doc, "div", "llm-task-paper-details");
    details.hidden = true;
    li.append(summary, details);
    const refs: PaperRowRefs = {
      li,
      summary,
      index,
      title,
      tail,
      meta,
      source,
      details,
      row: model,
    };
    summary.addEventListener("click", (event: Event) => {
      event.preventDefault?.();
      const key = refs.row.key;
      const next = !expanded.has(key);
      if (next) expanded.add(key);
      else expanded.delete(key);
      summary.setAttribute("aria-expanded", next ? "true" : "false");
      details.hidden = !next;
      if (next) renderDetails(refs);
      else details.replaceChildren();
    });
    if (expanded.has(model.key)) {
      summary.setAttribute("aria-expanded", "true");
      details.hidden = false;
    }
    patchRow(refs, model);
    return refs;
  };

  const renderList = (current: TaskProgressRecord | null) => {
    const rows = buildTaskProgressPaperRows(current);
    const window = rows.slice(0, limit);
    const nextByKey = new Map<string, PaperRowRefs>();
    const nextOrder: PaperRowRefs[] = [];
    let cursor = list.firstChild as HTMLElement | null;
    for (const model of window) {
      let refs = rowsByKey.get(model.key);
      if (refs) patchRow(refs, model);
      else refs = createRowRefs(model);
      if (refs.li !== cursor) list.insertBefore(refs.li, cursor);
      else cursor = cursor.nextSibling as HTMLElement | null;
      nextByKey.set(model.key, refs);
      nextOrder.push(refs);
      askMineru(refs);
    }
    for (const [key, refs] of rowsByKey) {
      if (!nextByKey.has(key)) refs.li.remove();
    }
    rowsByKey = nextByKey;
    orderedRefs = nextOrder;
    const truncated = current?.scope?.listing?.truncated
      ? current.scope.listing.totalItems - current.scope.listing.listedItems
      : 0;
    const hiddenRows = rows.length - window.length;
    more.hidden = !truncated || hiddenRows > 0;
    if (!more.hidden) {
      more.textContent = format("and {count} more", { count: truncated });
    }
  };

  const renderHead = (current: TaskProgressRecord | null) => {
    // The row already carries the counts; the drawer lists what was read and
    // cited per paper. The head only says the list is still being prepared.
    const preparing =
      !current?.scope?.listing && !countTaskProgress(current).total;
    const text = preparing ? t("Preparing the scope…") : "";
    if (head.textContent !== text) head.textContent = text;
    if (head.hidden !== !preparing) head.hidden = !preparing;
    if (note.hidden !== input.recordsReads) note.hidden = input.recordsReads;
    const plan = current?.plan;
    const live = Boolean(plan && isLivePlanExecutionStatus(plan.ledger.status));
    const checklist = current?.checklist;
    if (steps.hidden !== (!live && !checklist))
      steps.hidden = !live && !checklist;
    if (live && plan) renderPlanSteps(doc, steps, plan);
    else if (checklist) renderChecklistSteps(doc, steps, checklist);
    else if (steps.firstChild) steps.replaceChildren();
  };

  const paint = () => {
    paintTimer = null;
    if (disposed) return;
    lastPaint = deps.now();
    const current = record();
    paintedVersion = current?.version ?? -1;
    visible = computeVisible(current);
    // Unchanged values are not written: a same-value write is still a DOM
    // mutation, and a streaming answer must cause none here.
    if (row.hidden !== !visible) row.hidden = !visible;
    if (card && card.hidden !== !visible) card.hidden = !visible;
    if (shell.classList.contains(PRESENT_CLASS) !== visible)
      shell.classList.toggle(PRESENT_CLASS, visible);
    // The card is the separation under the header: the header's own divider
    // gives way while it shows.
    const rowHost = (row.closest(".llm-panel") ||
      row.parentElement) as HTMLElement | null;
    if (rowHost) {
      const shownAttr = visible ? "shown" : null;
      if (rowHost.getAttribute(ROW_SHOWN_ATTR) !== shownAttr) {
        if (shownAttr) rowHost.setAttribute(ROW_SHOWN_ATTR, shownAttr);
        else rowHost.removeAttribute(ROW_SHOWN_ATTR);
      }
    }
    const state = current?.runState || "idle";
    if (row.dataset.state !== state) row.dataset.state = state;
    const countText = formatTaskProgressCount(current, input.recordsReads);
    if (countEl.textContent !== countText) countEl.textContent = countText;
    if (pillEl) {
      const pillText =
        state === "completed"
          ? t("Completed")
          : state === "failed"
            ? t("Failed")
            : state === "cancelled"
              ? t("Cancelled")
              : "";
      if (pillEl.textContent !== pillText) pillEl.textContent = pillText;
      if (pillEl.hidden !== !pillText) pillEl.hidden = !pillText;
      if (pillEl.dataset.tone !== state) pillEl.dataset.tone = state;
    }
    const ariaLabel = countText
      ? `${t("Task progress")}, ${countText}`
      : t("Task progress");
    if (row.getAttribute("aria-label") !== ariaLabel)
      row.setAttribute("aria-label", ariaLabel);
    if (!visible) {
      // Nothing to roll up toward: the row itself is gone.
      closeAtOnce();
      return;
    }
    if (current && current.collapseSeq !== seenCollapseSeq) {
      seenCollapseSeq = current.collapseSeq;
      if (open) {
        endDrag();
        applyOpen(false);
      }
    }
    renderHead(current);
    if (open) renderList(current);
  };

  const schedule = () => {
    if (disposed || paintTimer !== null) return;
    const delay = Math.max(
      0,
      lastPaint + TASK_PROGRESS_REPAINT_MS - deps.now(),
    );
    try {
      paintTimer = deps.setTimeout(paint, delay);
    } catch {
      // The panel's window is gone (a closed standalone window): this view
      // can never paint again, so it stops listening.
      paintTimer = null;
      disposed = true;
      unsubscribe();
    }
  };

  const flush = () => {
    if (paintTimer !== null) {
      deps.clearTimeout(paintTimer);
      paintTimer = null;
    }
    paint();
  };

  /** Close without motion (the row hid, or the panel switched chats). */
  const closeAtOnce = () => {
    endDrag();
    if (open) applyOpen(false, false);
    else if (drawerState === "closing") settle();
  };

  const setOpen = (next: boolean, options?: { focusRow?: boolean }) => {
    if (disposed) return;
    if (next && !visible) return;
    if (next === open) return;
    if (next) {
      // Built before the drawer unrolls, so its height is measured with it.
      const current = record();
      seenCollapseSeq = current?.collapseSeq ?? seenCollapseSeq;
      renderHead(current);
      renderList(current);
    } else {
      endDrag();
    }
    applyOpen(next);
    if (!next && options?.focusRow) row.focus?.({ preventScroll: true });
  };

  function jumpToCitation(citationId: string) {
    setOpen(false);
    const cards = Array.from(
      chatBox.querySelectorAll(".llm-quote-citation-anchor"),
    ) as HTMLElement[];
    const card = cards
      .filter((node) => node?.dataset?.quoteCitationId === citationId)
      .pop();
    if (!card) return;
    if (deps.navigateToCitation) deps.navigateToCitation(card);
    else card.scrollIntoView?.({ block: "center" });
    card.classList.add(FLASH_CLASS);
    const timer = deps.setTimeout(() => {
      flashTimers.delete(timer);
      card.classList.remove(FLASH_CLASS);
    }, TASK_PROGRESS_FLASH_MS);
    flashTimers.add(timer);
  }

  const onRowClick = (event: Event) => {
    event.preventDefault?.();
    setOpen(!open);
  };
  const onKeyDown = (event: Event) => {
    const key = (event as KeyboardEvent).key;
    if (key !== "Escape" || !open) return;
    event.preventDefault?.();
    event.stopPropagation?.();
    setOpen(false, { focusRow: true });
  };
  const onScroll = () => {
    if (!open) return;
    const total = buildTaskProgressPaperRows(record()).length;
    if (limit >= total) return;
    const remaining =
      Number(body.scrollHeight || 0) -
      Number(body.scrollTop || 0) -
      Number(body.clientHeight || 0);
    if (remaining > 240) return;
    limit += TASK_PROGRESS_WINDOW;
    renderList(record());
  };
  const unsubscribe = subscribeTaskProgress((key) => {
    if (key !== input.conversationKey) return;
    const current = record();
    // The answer started: collapse now, not at the next coalesced paint.
    if (current && current.collapseSeq !== seenCollapseSeq) {
      seenCollapseSeq = current.collapseSeq;
      if (open) {
        endDrag();
        applyOpen(false);
      }
    }
    if (current && current.version === paintedVersion) return;
    schedule();
  });
  row.addEventListener("click", onRowClick);
  keyTarget.addEventListener("keydown", onKeyDown);
  body.addEventListener("scroll", onScroll);
  drawer.addEventListener("transitionend", onTransitionEnd);
  grip.addEventListener("mousedown", onGripMouseDown);
  grip.addEventListener("keydown", onGripKeyDown);
  grip.addEventListener("dblclick", onGripDoubleClick);

  return {
    setInput(next) {
      if (disposed) return;
      const switched = next.conversationKey !== input.conversationKey;
      input = next;
      if (switched) {
        closeAtOnce();
        for (const refs of rowsByKey.values()) refs.li.remove();
        rowsByKey = new Map();
        orderedRefs = [];
        expanded.clear();
        mineruKnown.clear();
        mineruAsked.clear();
        limit = TASK_PROGRESS_WINDOW;
        seenCollapseSeq = record()?.collapseSeq ?? 0;
      }
      flush();
    },
    setOpen,
    isOpen: () => open,
    drawerState: () => drawerState,
    isVisible: () => visible,
    flush,
    renderedRowCount: () => orderedRefs.length,
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      if (paintTimer !== null) deps.clearTimeout(paintTimer);
      for (const timer of flashTimers) deps.clearTimeout(timer);
      flashTimers.clear();
      endDrag();
      clearSettleTimer();
      stopObservingDrawer();
      row.removeEventListener("click", onRowClick);
      keyTarget.removeEventListener("keydown", onKeyDown);
      body.removeEventListener("scroll", onScroll);
      drawer.removeEventListener("transitionend", onTransitionEnd);
      grip.removeEventListener("mousedown", onGripMouseDown);
      grip.removeEventListener("keydown", onGripKeyDown);
      grip.removeEventListener("dblclick", onGripDoubleClick);
    },
  };
}
