import { assert } from "chai";
import type { TaskPaperScopeEntry } from "../src/agent/context/taskPaperScopeListing";
import type { TaskPaperReadEvent } from "../src/agent/context/taskPaperLedger";
import type { PlanExecutionLedger } from "../src/agent/plans/types";
import {
  applyTaskPaperUpdate,
  beginTaskAction,
  beginTaskRun,
  endTaskAction,
  setTaskActionStep,
  setTaskActionSummary,
  setTaskChecklist,
  clearAllTaskProgress,
  clearTaskProgress,
  completeTaskRun,
  endTaskRun,
  getTaskProgress,
  markTaskAnswering,
  setTaskPlan,
  setTaskScope,
} from "../src/modules/contextPanel/taskProgress/store";
import {
  TASK_PROGRESS_FLASH_MS,
  TASK_PROGRESS_OPEN_PASSAGE_EVENT,
  TASK_PROGRESS_DRAWER_MIN_PX,
  TASK_PROGRESS_WINDOW,
  createTaskProgressDrawer,
  createTaskProgressRow,
  cleanTaskPaperSnippet,
  formatTaskPaperPassageLabel,
  formatTaskProgressCount,
  getRememberedTaskProgressDrawerHeight,
  mountTaskProgressView,
  resetTaskProgressDrawerHeight,
  type TaskProgressLayout,
  type TaskProgressView,
  type TaskProgressViewInput,
} from "../src/modules/contextPanel/taskProgress/view";
import { collectFakeText, fakeDocument, FakeElement } from "./helpers/fakeDom";
import { ledgerDelta, quoteCitation } from "./helpers/taskProgressFixtures";

const KEY = 42;

function scopeEntries(count: number): TaskPaperScopeEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    key: `1:${index + 1}`,
    libraryID: 1,
    itemId: index + 1,
    title: `Paper ${index + 1}`,
    year: "2021",
    firstCreator: "Smith",
    collectionPaths: ["Drift"],
    tags: ["drift"],
    text: "pdf" as const,
  }));
}

function seedScope(count = 200) {
  setTaskScope(KEY, {
    signature: "drift",
    libraryID: 1,
    contexts: { collections: [{ collectionId: 5 }] },
    label: "Drift + Learning",
    listing: {
      libraryID: 1,
      wholeLibrary: false,
      entries: scopeEntries(count),
      totalItems: count,
      listedItems: count,
      truncated: false,
    },
  });
}

type Harness = {
  view: TaskProgressView;
  row: FakeElement;
  drawer: FakeElement;
  body: FakeElement;
  grip: FakeElement;
  shell: FakeElement;
  chatBox: FakeElement;
  panel: FakeElement;
  messages: FakeElement;
  timers: Map<number, { callback: () => void; ms: number }>;
  runTimers: () => void;
  navigated: FakeElement[];
  mineruAsked: number[];
  count: () => string;
  items: () => FakeElement[];
};

function mount(
  input: Partial<TaskProgressViewInput> = {},
  options: {
    mineru?: (itemId: number) => boolean;
    layout?: TaskProgressLayout;
    doc?: Document;
    /** Set to true to make timers throw, as a closed window's do. */
    windowClosed?: { value: boolean };
  } = {},
): Harness {
  const timers = new Map<number, { callback: () => void; ms: number }>();
  let handle = 0;
  let now = 0;
  const row = createTaskProgressRow(fakeDocument) as unknown as FakeElement;
  const drawer = createTaskProgressDrawer(
    fakeDocument,
  ) as unknown as FakeElement;
  const shell = new FakeElement("div");
  shell.className = "llm-chat-shell";
  const messages = new FakeElement("div");
  messages.className = "llm-messages";
  shell.append(drawer, messages);
  const chatBox = messages;
  const panel = new FakeElement("div");
  panel.append(row, shell);
  const navigated: FakeElement[] = [];
  const mineruAsked: number[] = [];
  const view = mountTaskProgressView({
    doc: options.doc || fakeDocument,
    row: row as unknown as HTMLButtonElement,
    drawer: drawer as unknown as HTMLElement,
    shell: shell as unknown as HTMLElement,
    chatBox: chatBox as unknown as HTMLElement,
    keyTarget: panel as unknown as HTMLElement,
    deps: {
      setTimeout: (callback, ms) => {
        if (options.windowClosed?.value) {
          throw new Error("Component not initialized");
        }
        timers.set(++handle, { callback, ms });
        return handle;
      },
      clearTimeout: (id) => timers.delete(id as number),
      now: () => now,
      resolveMineru: options.mineru
        ? async ({ itemId }) => {
            mineruAsked.push(itemId);
            return options.mineru!(itemId);
          }
        : undefined,
      navigateToCitation: (card) => navigated.push(card as never),
      layout: options.layout,
    },
  });
  view.setInput({
    conversationKey: KEY,
    recordsReads: true,
    visibility: {
      conversationKind: "global",
      isWebChat: false,
      isNoteSession: false,
      collectionCount: 1,
      tagCount: 0,
      paperCount: 0,
    },
    ...input,
  });
  return {
    view,
    row,
    drawer,
    body: drawer.findByClass("llm-task-progress-drawer-body")!,
    grip: drawer.findByClass("llm-task-progress-drawer-grip")!,
    shell,
    chatBox,
    panel,
    messages,
    timers,
    runTimers() {
      now += 1000;
      for (const [id, timer] of Array.from(timers)) {
        timers.delete(id);
        timer.callback();
      }
    },
    navigated,
    mineruAsked,
    count: () => row.findByClass("llm-task-progress-count")!.textContent,
    items: () => drawer.findAllByClass("llm-task-paper"),
  };
}

const MAX_VAR = "--llm-task-progress-drawer-max";

/** A layout whose motion, chat strip and resize callbacks a test drives. */
function fakeLayout(options: { ms?: number; strip?: number } = {}) {
  const observers: Array<() => void> = [];
  let chatResized = 0;
  const layout: TaskProgressLayout = {
    motionMs: () => options.ms ?? 200,
    chatStripPx: () => options.strip ?? 96,
    observeResize: (_target, onResize) => {
      observers.push(onResize);
      return () => observers.splice(0);
    },
    onChatResized: () => {
      chatResized += 1;
    },
  };
  return {
    layout,
    fireResize: () => observers.forEach((onResize) => onResize()),
    chatResized: () => chatResized,
  };
}

/**
 * Give the fake drawer and chat heights: the drawer is `natural` tall unless
 * an inline height or a dragged maximum says less; the chat takes the rest of
 * a `shell` tall column.
 */
function fakeHeights(
  harness: Harness,
  natural: number,
  shell: number,
): () => number {
  const drawerHeight = () => {
    const inline = String(harness.drawer.style.height || "");
    if (inline) return parseFloat(inline);
    const max = parseFloat(String(harness.drawer.style[MAX_VAR] || ""));
    return Number.isFinite(max) ? Math.min(natural, max) : natural;
  };
  (harness.drawer as any).getBoundingClientRect = () => ({
    height: drawerHeight(),
  });
  (harness.chatBox as any).getBoundingClientRect = () => ({
    height: shell - drawerHeight(),
  });
  return drawerHeight;
}

function transitionEnd(target: FakeElement, propertyName = "height") {
  return target.dispatchFakeEvent("transitionend", {
    target,
    propertyName,
  } as never);
}

/** A document the drag listeners can attach to. */
function draggableDocument(): { doc: Document; target: FakeElement } {
  const target = new FakeElement("document");
  const doc = {
    ...(fakeDocument as unknown as Record<string, unknown>),
    addEventListener: (type: string, listener: (event: any) => void) =>
      target.addEventListener(type, listener),
    removeEventListener: (type: string, listener: (event: any) => void) =>
      target.removeEventListener(type, listener),
  } as unknown as Document;
  return { doc, target };
}

describe("task progress view", function () {
  const views: TaskProgressView[] = [];
  afterEach(function () {
    for (const view of views.splice(0)) view.dispose();
    clearAllTaskProgress();
    resetTaskProgressDrawerHeight();
  });
  function track(harness: Harness): Harness {
    views.push(harness.view);
    return harness;
  }

  it("stops listening once its window is gone, without breaking store writers", function () {
    seedScope();
    const windowClosed = { value: false };
    const harness = track(mount({}, { windowClosed }));
    beginTaskRun(KEY, { runId: "run-a" });
    harness.runTimers();
    windowClosed.value = true;
    // A write repaints every view; this one's timer throws. The writer must
    // still finish, and the view must stop listening.
    assert.doesNotThrow(() => clearTaskProgress(KEY));
    windowClosed.value = false;
    beginTaskRun(KEY, { runId: "run-b" });
    assert.equal(harness.timers.size, 0, "a dead view schedules nothing");
  });

  it("hides the row where it does not apply and names the scope where it does", function () {
    seedScope();
    const hidden = track(
      mount({
        visibility: {
          conversationKind: "paper",
          isWebChat: false,
          isNoteSession: false,
          collectionCount: 0,
          tagCount: 0,
          paperCount: 1,
        },
      }),
    );
    assert.isTrue((hidden.row as any).hidden);
    const shown = track(mount());
    assert.isFalse((shown.row as any).hidden);
    assert.equal(shown.row.dataset.state, "idle");
    assert.equal(shown.count(), "200 papers in scope");
    assert.equal(shown.row.getAttribute("aria-expanded"), "false");
    assert.equal(
      shown.row.getAttribute("aria-controls"),
      "llm-task-progress-drawer",
    );
    assert.equal(shown.drawer.getAttribute("role"), "region");
  });

  it("walks the row through working, answering, completed, failed and cancelled", function () {
    seedScope();
    const harness = track(mount());
    beginTaskRun(KEY, { runId: "run-a" });
    harness.view.flush();
    assert.equal(harness.row.dataset.state, "working");
    assert.equal(harness.count(), "0 of 200 read");
    applyTaskPaperUpdate(
      KEY,
      ledgerDelta("c1", [
        [1, "read", "One"],
        [2, "skimmed"],
        [3, "matched"],
      ]),
      "run-a",
    );
    harness.view.flush();
    assert.equal(harness.count(), "2 of 200 read");
    markTaskAnswering(KEY, "run-a");
    harness.view.flush();
    assert.equal(harness.row.dataset.state, "answering");
    assert.equal(harness.count(), "Answering… · 2 of 200 read");
    completeTaskRun(KEY, {
      runId: "run-a",
      quoteCitations: [quoteCitation("q1", 1)],
    });
    harness.view.flush();
    assert.equal(harness.row.dataset.state, "completed");
    assert.equal(harness.count(), "2 of 200 read · 1 cited");
    const pill = () => harness.row.findByClass("llm-task-progress-pill") as any;
    assert.isFalse(pill().hidden);
    assert.equal(pill().textContent, "Completed");

    beginTaskRun(KEY, { runId: "run-b" });
    endTaskRun(KEY, "failed", "run-b");
    harness.view.flush();
    assert.equal(harness.row.dataset.state, "failed");
    assert.equal(
      harness.count(),
      "0 of 200 read",
      "the row summarizes the latest question",
    );
    assert.equal(pill().textContent, "Failed");
    assert.equal(pill().dataset.tone, "failed");
    beginTaskRun(KEY, { runId: "run-c" });
    endTaskRun(KEY, "cancelled");
    harness.view.flush();
    assert.equal(harness.row.dataset.state, "cancelled");
    assert.equal(harness.count(), "0 of 200 read");
    assert.equal(pill().textContent, "Cancelled");
  });

  it("offers removal for the context bar's papers, never the chat's own paper", function () {
    seedScope(3);
    const harness = track(mount({ basePaperItemId: 2 }));
    harness.view.flush();
    harness.row.dispatchFakeEvent("click");
    const [first, own, third] = harness.items();
    const removeOf = (item: FakeElement) =>
      item.findByClass("llm-task-paper-remove") as any;
    assert.isFalse(removeOf(first).hidden);
    assert.isTrue(removeOf(own).hidden, "the paper chat's own paper stays");
    assert.isFalse(removeOf(third).hidden);
    assert.include(first.className, "llm-task-paper-removable");
  });

  it("lists only the scope in plain chat, with the Agent-mode note", function () {
    seedScope(12);
    const harness = track(mount({ recordsReads: false }));
    beginTaskRun(KEY);
    harness.view.flush();
    assert.equal(harness.count(), "12 papers in scope");
    harness.row.dispatchFakeEvent("click");
    const note = harness.drawer.findByClass("llm-task-progress-note")!;
    assert.isFalse((note as any).hidden);
    const first = harness.items()[0];
    first.findByClass("llm-task-paper-summary")!.dispatchFakeEvent("click");
    assert.include(
      collectFakeText(first.findByClass("llm-task-paper-details")),
      "Reads are recorded in Agent mode.",
    );
  });

  it("counts plan steps while a plan runs", function () {
    seedScope(10);
    const harness = track(mount());
    beginTaskRun(KEY, { runId: "run-a" });
    const task = (id: string, status: string) => ({
      taskId: id,
      kind: "required_step",
      status,
      content: `Step ${id}`,
      activeForm: `Doing ${id}`,
      acceptanceCriteria: [],
      evidenceIds: [],
      failureReasons: [],
    });
    setTaskPlan(KEY, {
      ledger: {
        executionId: "e1",
        planId: "p1",
        revision: 1,
        status: "running",
        createdAt: 1,
        updatedAt: 1,
        tasks: [task("a", "completed"), task("b", "in_progress")],
      } as unknown as PlanExecutionLedger,
    });
    harness.view.flush();
    assert.equal(harness.count(), "1/2 steps · 0 of 10 read");
    harness.row.dispatchFakeEvent("click");
    const steps = harness.drawer.findByClass("llm-task-progress-steps")!;
    assert.isFalse((steps as any).hidden);
    assert.include(collectFakeText(steps), "Doing b");
    setTaskPlan(KEY, null);
    harness.view.flush();
    assert.isTrue((steps as any).hidden, "steps show only while live");
    assert.isFalse((harness.row as any).hidden, "the row stays");
  });

  it("unrolls in the chat shell, windows the list and grows it on scroll", function () {
    seedScope(200);
    const harness = track(mount());
    harness.row.dispatchFakeEvent("click");
    assert.isTrue(harness.view.isOpen());
    assert.isFalse((harness.drawer as any).hidden);
    assert.equal(harness.drawer.dataset.state, "open");
    assert.isTrue(harness.shell.classList.contains("llm-task-progress-shown"));
    assert.equal(harness.row.getAttribute("aria-expanded"), "true");
    assert.isUndefined(
      (harness.messages.style as any).display,
      "messages are never display:none",
    );
    assert.equal(harness.view.renderedRowCount(), TASK_PROGRESS_WINDOW);
    assert.deepEqual(
      harness
        .items()
        .slice(0, 3)
        .map((item) => item.findByClass("llm-task-paper-index")!.textContent),
      ["1", "2", "3"],
    );
    Object.assign(harness.body, {
      scrollHeight: 4000,
      clientHeight: 600,
      scrollTop: 3300,
    });
    harness.body.dispatchFakeEvent("scroll");
    assert.equal(harness.view.renderedRowCount(), 2 * TASK_PROGRESS_WINDOW);
    assert.equal(
      harness.items()[159].findByClass("llm-task-paper-index")!.textContent,
      "160",
    );
    harness.row.dispatchFakeEvent("click");
    assert.isFalse(harness.view.isOpen());
    assert.isTrue((harness.drawer as any).hidden);
    assert.equal(harness.drawer.dataset.state, "closed");
    assert.isFalse(harness.shell.classList.contains("llm-task-progress-shown"));
  });

  it("expands a paper to show its reads grouped by question", function () {
    seedScope(5);
    const harness = track(mount());
    beginTaskRun(KEY, { runId: "run-a" });
    applyTaskPaperUpdate(
      KEY,
      ledgerDelta("c1", [
        [2, "read", "Drift grows with time."],
        [3, "matched"],
      ]),
      "run-a",
    );
    harness.row.dispatchFakeEvent("click");
    const [first, second, third] = harness.items();
    assert.equal(first.dataset.state, "listed");
    assert.equal(second.dataset.state, "read");
    assert.equal(third.dataset.state, "matched");
    assert.equal(
      second.findByClass("llm-task-paper-tail")!.textContent,
      "1 passage",
    );
    assert.equal(
      second.findByClass("llm-task-paper-meta-text")!.textContent,
      "Smith 2021 · Drift · drift",
    );
    const summary = second.findByClass("llm-task-paper-summary")!;
    summary.dispatchFakeEvent("click");
    const details = second.findByClass("llm-task-paper-details")!;
    assert.isFalse((details as any).hidden);
    assert.equal(summary.getAttribute("aria-expanded"), "true");
    const text = collectFakeText(details);
    // Where it was read, and what: no tool, method or question heading when
    // a single question read the paper.
    assert.include(text, "Results");
    assert.include(text, "Drift grows with time.");
    assert.notInclude(text, "Retrieve Library");
    assert.notInclude(text, "BM25");
    assert.notInclude(text, "Question");
    third.findByClass("llm-task-paper-summary")!.dispatchFakeEvent("click");
    assert.include(
      collectFakeText(third.findByClass("llm-task-paper-details")),
      "Matched by title or abstract; text not opened.",
    );
    first.findByClass("llm-task-paper-summary")!.dispatchFakeEvent("click");
    assert.include(
      collectFakeText(first.findByClass("llm-task-paper-details")),
      "Listed in scope; not read for this question.",
    );
    summary.dispatchFakeEvent("click");
    assert.isTrue((details as any).hidden);
    assert.equal(summary.getAttribute("aria-expanded"), "false");
  });

  it("labels a read by its section, never by the paper's own title", function () {
    const read = (patch: Partial<TaskPaperReadEvent>): TaskPaperReadEvent => ({
      key: "1:1",
      callId: "c",
      toolName: "library_retrieve",
      granularity: "passage",
      ...patch,
    });
    const title = "Emergence of stable striatal ensembles";
    assert.equal(
      formatTaskPaperPassageLabel(read({ label: "Methods §2.3" }), title),
      "Methods §2.3",
    );
    assert.equal(
      formatTaskPaperPassageLabel(
        read({ label: "Emergence of stable striatal ensembles" }),
        title,
      ),
      "Passage",
    );
    assert.equal(
      formatTaskPaperPassageLabel(read({ granularity: "abstract" }), title),
      "Abstract",
    );
    assert.equal(
      formatTaskPaperPassageLabel(
        read({ granularity: "full", label: "12/40 chunks" }),
        title,
      ),
      "Full text",
    );
    assert.equal(
      cleanTaskPaperSnippet(
        "# Emergence of stable ensembles\nMeng-jun Sheng, Di $\\mathbf { L }$ Lu and Mu-ming Poo",
      ),
      "Emergence of stable ensembles Meng-jun Sheng, Di Lu and Mu-ming Poo",
    );
  });

  it("closes on Escape and returns focus to the row", function () {
    seedScope(5);
    const harness = track(mount());
    let focused = 0;
    (harness.row as any).focus = () => focused++;
    harness.row.dispatchFakeEvent("click");
    const other = harness.panel.dispatchFakeEvent("keydown", { key: "Enter" });
    assert.isTrue(harness.view.isOpen());
    assert.isFalse(other.defaultPrevented);
    const escape = harness.panel.dispatchFakeEvent("keydown", {
      key: "Escape",
    });
    assert.isFalse(harness.view.isOpen());
    assert.isTrue(escape.defaultPrevented);
    assert.equal(focused, 1);
    const ignored = harness.panel.dispatchFakeEvent("keydown", {
      key: "Escape",
    });
    assert.isFalse(ignored.defaultPrevented, "a closed drawer leaves Escape");
  });

  it("collapses the moment the answer starts streaming", function () {
    seedScope(5);
    const harness = track(mount());
    beginTaskRun(KEY, { runId: "run-a" });
    harness.row.dispatchFakeEvent("click");
    assert.isTrue(harness.view.isOpen());
    markTaskAnswering(KEY, "run-a");
    assert.isFalse(harness.view.isOpen(), "no coalescing delay");
    assert.isFalse(harness.shell.classList.contains("llm-task-progress-shown"));
    harness.row.dispatchFakeEvent("click");
    assert.isTrue(harness.view.isOpen(), "it reopens on request");
    harness.view.flush();
    assert.isTrue(harness.view.isOpen(), "a later paint does not collapse it");
  });

  it("coalesces store updates to at most four repaints a second", function () {
    seedScope(20);
    const harness = track(mount());
    beginTaskRun(KEY, { runId: "run-a" });
    harness.runTimers();
    for (let n = 1; n <= 10; n++) {
      applyTaskPaperUpdate(KEY, ledgerDelta(`c${n}`, [[n, "read"]]), "run-a");
    }
    assert.equal(harness.timers.size, 1, "one pending repaint");
    const [timer] = Array.from(harness.timers.values());
    assert.isAtLeast(timer.ms, 0);
    assert.isAtMost(timer.ms, 250);
    assert.equal(harness.count(), "0 of 20 read", "not painted yet");
    harness.runTimers();
    assert.equal(harness.count(), "10 of 20 read");
  });

  it("offers Source on passages with text or a named page, and asks the panel to open it", function () {
    seedScope(3);
    class FakeCustomEvent {
      constructor(
        public type: string,
        public init: { bubbles?: boolean; detail?: unknown },
      ) {}
    }
    const doc = {
      ...(fakeDocument as unknown as Record<string, unknown>),
      defaultView: { CustomEvent: FakeCustomEvent },
    } as unknown as Document;
    const harness = track(mount({}, { doc }));
    applyTaskPaperUpdate(
      KEY,
      {
        version: 1,
        callId: "c1",
        toolName: "library_retrieve",
        papers: [
          {
            key: "1:2",
            libraryID: 1,
            itemId: 2,
            contextItemId: 22,
            title: "Paper 2",
            state: "read",
          },
        ],
        reads: [
          {
            key: "1:2",
            callId: "c1",
            toolName: "library_retrieve",
            granularity: "section",
            label: "Results",
            snippet: "## Results\nDrift grows with time…",
          },
          {
            key: "1:2",
            callId: "c1",
            toolName: "paper_read",
            granularity: "page",
            label: "p. 3",
          },
          {
            key: "1:2",
            callId: "c1",
            toolName: "paper_read",
            granularity: "page",
            label: "Figures",
          },
          {
            key: "1:2",
            callId: "c1",
            toolName: "library_retrieve",
            granularity: "outline",
            label: "Methods",
          },
        ],
      },
      "run-a",
    );
    harness.row.dispatchFakeEvent("click");
    const paper = harness.items()[1];
    const summary = paper.findByClass("llm-task-paper-summary")!;
    summary.dispatchFakeEvent("click");
    const details = paper.findByClass("llm-task-paper-details")!;
    const reads = details.findAllByClass("llm-task-paper-read");
    assert.lengthOf(reads, 4);
    const sources = reads.map((node) =>
      node.findByClass("llm-task-paper-open"),
    );
    assert.deepEqual(
      sources.map(Boolean),
      [true, true, false, false],
      "a snippet or a named page: never a page read without one, nor an outline",
    );
    const source = sources[0]!;
    assert.equal(source.tagName.toLowerCase(), "button");
    assert.equal(source.type, "button");
    assert.equal(source.textContent, "Source");
    assert.equal(
      source.attributes["aria-label"],
      "Open this passage in the paper",
    );
    assert.equal(
      reads[0].findByClass("llm-task-paper-how")!.textContent,
      "Results",
      "the label row keeps its label text",
    );
    const dispatched: FakeCustomEvent[] = [];
    (source as any).dispatchEvent = (event: FakeCustomEvent) => {
      dispatched.push(event);
      return true;
    };
    const click = source.dispatchFakeEvent("click");
    assert.isTrue(click.propagationStopped, "the click stays on the button");
    assert.lengthOf(dispatched, 1);
    assert.equal(dispatched[0].type, TASK_PROGRESS_OPEN_PASSAGE_EVENT);
    assert.isTrue(dispatched[0].init.bubbles);
    assert.deepEqual(dispatched[0].init.detail, {
      itemId: 2,
      contextItemId: 22,
      libraryID: 1,
      rawSnippet: "## Results\nDrift grows with time…",
      cleanedSnippet: "Results Drift grows with time…",
      label: "Results",
      granularity: "section",
    });
    assert.isFalse((details as any).hidden, "the paper stays expanded");
    assert.equal(summary.getAttribute("aria-expanded"), "true");
    assert.isTrue(harness.view.isOpen(), "the drawer stays open");

    const page = sources[1]!;
    (page as any).dispatchEvent = (event: FakeCustomEvent) => {
      dispatched.push(event);
      return true;
    };
    page.dispatchFakeEvent("click");
    assert.deepInclude(dispatched[1].init.detail as object, {
      rawSnippet: "",
      cleanedSnippet: "",
      label: "p. 3",
      granularity: "page",
    });
  });

  it("jumps from a citation to its quote chip, collapsing the drawer", function () {
    seedScope(5);
    const harness = track(mount());
    const card = new FakeElement("div");
    card.className = "llm-quote-card llm-quote-citation-anchor";
    card.dataset.quoteCitationId = "q1";
    const decoy = new FakeElement("div");
    decoy.className = "llm-quote-card llm-quote-citation-anchor";
    decoy.dataset.quoteCitationId = "q2";
    harness.chatBox.append(decoy, card);
    beginTaskRun(KEY, { runId: "run-a" });
    applyTaskPaperUpdate(KEY, ledgerDelta("c1", [[1, "read", "One"]]), "run-a");
    completeTaskRun(KEY, {
      runId: "run-a",
      quoteCitations: [quoteCitation("q1", 1)],
    });
    harness.row.dispatchFakeEvent("click");
    const item = harness.items()[0];
    assert.equal(item.dataset.state, "cited");
    assert.equal(
      item.findByClass("llm-task-paper-tail")!.textContent,
      "1 passage · cited 1",
    );
    item.findByClass("llm-task-paper-summary")!.dispatchFakeEvent("click");
    const link = item.findByClass("llm-task-paper-citation")!;
    assert.include(link.textContent, "Quoted evidence q1");
    link.dispatchFakeEvent("click");
    assert.isFalse(harness.view.isOpen());
    assert.deepEqual(harness.navigated, [card]);
    assert.isTrue(card.classList.contains("llm-task-progress-flash"));
    const flash = Array.from(harness.timers.values()).find(
      (timer) => timer.ms === TASK_PROGRESS_FLASH_MS,
    );
    assert.exists(flash);
    flash!.callback();
    assert.isFalse(card.classList.contains("llm-task-progress-flash"));
  });

  it("asks for MinerU text only for the rows on screen", async function () {
    seedScope(200);
    const harness = track(mount({}, { mineru: (itemId) => itemId === 2 }));
    assert.lengthOf(harness.mineruAsked, 0, "nothing asked while closed");
    harness.row.dispatchFakeEvent("click");
    assert.lengthOf(harness.mineruAsked, TASK_PROGRESS_WINDOW);
    await Promise.resolve();
    await Promise.resolve();
    const sources = harness
      .items()
      .slice(0, 3)
      .map((item) => item.findByClass("llm-task-paper-source")!.textContent);
    assert.deepEqual(sources, ["PDF", "MinerU", "PDF"]);
  });

  it("starts fresh when the panel switches conversation", function () {
    seedScope(5);
    const harness = track(mount());
    harness.row.dispatchFakeEvent("click");
    assert.equal(harness.view.renderedRowCount(), 5);
    harness.view.setInput({
      conversationKey: KEY + 1,
      recordsReads: true,
      visibility: {
        conversationKind: "paper",
        isWebChat: false,
        isNoteSession: false,
        collectionCount: 0,
        tagCount: 0,
        paperCount: 1,
      },
    });
    assert.isFalse(harness.view.isOpen());
    assert.equal(harness.view.renderedRowCount(), 0);
    assert.isTrue((harness.row as any).hidden);
    assert.isNull(getTaskProgress(KEY + 1));
  });

  it("formats an empty scope without inventing counts", function () {
    assert.equal(formatTaskProgressCount(null, true), "");
  });

  it("shows each paper's strongest state over the conversation, and counts the latest question", function () {
    seedScope(5);
    const harness = track(mount());
    beginTaskRun(KEY, { runId: "q1", turnIndex: 1 });
    applyTaskPaperUpdate(
      KEY,
      ledgerDelta("c1", [
        [1, "read", "Earlier passage."],
        [2, "skimmed"],
      ]),
      "q1",
    );
    completeTaskRun(KEY, {
      runId: "q1",
      quoteCitations: [quoteCitation("a", 2)],
    });
    beginTaskRun(KEY, { runId: "q2", turnIndex: 2 });
    applyTaskPaperUpdate(KEY, ledgerDelta("c2", [[3, "read", "Now."]]), "q2");
    harness.view.flush();
    assert.equal(
      harness.count(),
      "1 of 5 read",
      "the row counts the latest question",
    );
    harness.row.dispatchFakeEvent("click");
    const [first, second, third, fourth] = harness.items();
    assert.equal(first.dataset.state, "read", "read in question 1 stays read");
    assert.equal(second.dataset.state, "cited");
    assert.equal(third.dataset.state, "read");
    assert.equal(fourth.dataset.state, "listed");
    assert.equal(
      first.findByClass("llm-task-paper-tail")!.textContent,
      "1 passage",
    );
    const head = harness.drawer.findByClass("llm-task-progress-head")!;
    assert.isTrue(head.hidden, "no summary line above the paper list");
    assert.equal(collectFakeText(head), "");
    first.findByClass("llm-task-paper-summary")!.dispatchFakeEvent("click");
    const details = collectFakeText(
      first.findByClass("llm-task-paper-details")!,
    );
    assert.include(details, "Earlier passage.");
    assert.notInclude(details, "not read for this question");
  });

  it("shows a built-in action as the row's steps, even in a one-paper chat", function () {
    seedScope(1);
    const harness = track(
      mount({
        visibility: {
          conversationKind: "paper",
          isWebChat: false,
          isNoteSession: false,
          collectionCount: 0,
          tagCount: 0,
          paperCount: 1,
        },
      }),
    );
    assert.isTrue((harness.row as any).hidden, "hidden before any action");
    beginTaskAction(KEY, { runId: "action-1", title: "Auto Tag" });
    setTaskActionStep(KEY, "action-1", {
      step: "Reading papers",
      index: 1,
      total: 3,
    });
    harness.view.flush();
    assert.isFalse((harness.row as any).hidden);
    assert.equal(harness.row.dataset.state, "working");
    assert.equal(harness.count(), "0/3 steps · Reading papers");
    setTaskActionSummary(KEY, "action-1", "Read 4 papers");
    harness.view.flush();
    assert.equal(harness.count(), "0/3 steps · Read 4 papers");
    harness.row.dispatchFakeEvent("click");
    const steps = harness.drawer.findByClass("llm-task-progress-steps")!;
    assert.isFalse((steps as any).hidden);
    const text = collectFakeText(steps);
    assert.include(text, "Auto Tag");
    assert.include(text, "Reading papers");
    assert.include(text, "Read 4 papers");
    endTaskAction(KEY, "action-1", "completed", "Tagged 3 items");
    harness.view.flush();
    assert.equal(harness.row.dataset.state, "completed");
    assert.equal(harness.count(), "3/3 steps · Tagged 3 items");
    assert.include(collectFakeText(steps), "Tagged 3 items");
    assert.isFalse((harness.row as any).hidden, "the row stays afterwards");
  });

  it("says why an action failed", function () {
    seedScope(1);
    const harness = track(mount());
    beginTaskAction(KEY, { runId: "action-2", title: "Auto Tag" });
    setTaskActionStep(KEY, "action-2", {
      step: "Proposing",
      index: 2,
      total: 3,
    });
    endTaskAction(KEY, "action-2", "failed", "Auto Tag failed: offline");
    harness.view.flush();
    assert.equal(harness.row.dataset.state, "failed");
    assert.equal(harness.count(), "1/3 steps · Auto Tag failed: offline");
    harness.row.dispatchFakeEvent("click");
    const failure = harness.drawer.findByClass("llm-plan-task-failure");
    assert.equal(failure?.textContent, "Auto Tag failed: offline");
  });

  it("shows Codex's plan as the steps, with the read counts", function () {
    seedScope(6);
    const harness = track(mount());
    beginTaskRun(KEY, { runId: "codex-1", turnIndex: 1 });
    setTaskChecklist(KEY, {
      source: "codex",
      runId: "codex-1",
      steps: [
        { label: "Inspect the scope", status: "completed" },
        { label: "Read the methods", status: "in_progress" },
        { label: "Compare results", status: "pending" },
      ],
    });
    applyTaskPaperUpdate(KEY, ledgerDelta("m1", [[1, "read"]]), "codex-1");
    harness.view.flush();
    assert.equal(harness.count(), "1/3 steps · 1 of 6 read");
    harness.row.dispatchFakeEvent("click");
    const steps = harness.drawer.findByClass("llm-task-progress-steps")!;
    assert.isFalse((steps as any).hidden);
    const lines = steps.findAllByClass("llm-plan-task");
    assert.deepEqual(
      lines.map((line) => line.className),
      [
        "llm-plan-task llm-plan-task-completed",
        "llm-plan-task llm-plan-task-in_progress",
        "llm-plan-task llm-plan-task-pending",
      ],
    );
    assert.include(collectFakeText(steps), "Compare results");
  });

  it("unrolls and rolls up between measured heights, settling on transitionend", function () {
    seedScope(5);
    const motion = fakeLayout({ ms: 200 });
    const harness = track(mount({}, { layout: motion.layout }));
    fakeHeights(harness, 300, 700);
    harness.row.dispatchFakeEvent("click");
    assert.isTrue(harness.view.isOpen());
    assert.equal(harness.row.getAttribute("aria-expanded"), "true");
    assert.equal(harness.drawer.dataset.state, "opening");
    assert.equal(harness.view.drawerState(), "opening");
    assert.isFalse((harness.drawer as any).hidden);
    assert.isTrue(harness.shell.classList.contains("llm-task-progress-shown"));
    assert.equal(harness.drawer.style.height, "300px", "toward its content");
    assert.isTrue(
      Array.from(harness.timers.values()).some((timer) => timer.ms === 280),
      "a fallback settles a missed transitionend",
    );
    transitionEnd(harness.drawer, "box-shadow");
    const child = harness.drawer.findByClass("llm-task-progress-list")!;
    harness.drawer.dispatchFakeEvent("transitionend", {
      target: child,
      propertyName: "height",
    } as never);
    assert.equal(harness.drawer.dataset.state, "opening", "only its height");
    transitionEnd(harness.drawer);
    assert.equal(harness.drawer.dataset.state, "open");
    assert.equal(harness.drawer.style.height, "", "released to its content");

    harness.row.dispatchFakeEvent("click");
    assert.isFalse(harness.view.isOpen());
    assert.equal(harness.row.getAttribute("aria-expanded"), "false");
    assert.equal(harness.drawer.dataset.state, "closing");
    assert.isFalse((harness.drawer as any).hidden, "still rolling up");
    assert.equal(harness.drawer.style.height, "0px");
    assert.isTrue(harness.shell.classList.contains("llm-task-progress-shown"));
    transitionEnd(harness.drawer);
    assert.equal(harness.drawer.dataset.state, "closed");
    assert.isTrue((harness.drawer as any).hidden);
    assert.equal(harness.drawer.style.height, "");
    assert.isFalse(harness.shell.classList.contains("llm-task-progress-shown"));
  });

  it("reverses mid-way and settles from the fallback when no transitionend comes", function () {
    seedScope(5);
    const harness = track(mount({}, { layout: fakeLayout().layout }));
    fakeHeights(harness, 300, 700);
    harness.row.dispatchFakeEvent("click");
    harness.row.dispatchFakeEvent("click");
    assert.equal(harness.drawer.dataset.state, "closing");
    assert.equal(harness.drawer.style.height, "0px");
    harness.row.dispatchFakeEvent("click");
    assert.equal(harness.drawer.dataset.state, "opening");
    assert.equal(harness.drawer.style.height, "300px");
    harness.runTimers();
    assert.equal(harness.drawer.dataset.state, "open");
    assert.equal(harness.drawer.style.height, "");
  });

  it("rolls up with the same motion on Escape and at the first answer text", function () {
    seedScope(5);
    const harness = track(mount({}, { layout: fakeLayout().layout }));
    fakeHeights(harness, 300, 700);
    let focused = 0;
    (harness.row as any).focus = () => focused++;
    const settleOpen = () => {
      harness.row.dispatchFakeEvent("click");
      transitionEnd(harness.drawer);
      assert.equal(harness.drawer.dataset.state, "open");
    };
    settleOpen();
    harness.panel.dispatchFakeEvent("keydown", { key: "Escape" });
    assert.equal(harness.drawer.dataset.state, "closing");
    assert.equal(focused, 1, "Escape returns focus to the row");
    transitionEnd(harness.drawer);
    beginTaskRun(KEY, { runId: "run-a" });
    settleOpen();
    markTaskAnswering(KEY, "run-a");
    assert.equal(harness.drawer.dataset.state, "closing");
    transitionEnd(harness.drawer);
    assert.equal(harness.drawer.dataset.state, "closed");
  });

  it("settles at once when motion is reduced", function () {
    seedScope(5);
    const harness = track(mount({}, { layout: fakeLayout({ ms: 0 }).layout }));
    fakeHeights(harness, 300, 700);
    harness.row.dispatchFakeEvent("click");
    assert.equal(harness.drawer.dataset.state, "open");
    assert.equal(harness.drawer.style.height, "");
    harness.panel.dispatchFakeEvent("keydown", { key: "Escape" });
    assert.equal(harness.drawer.dataset.state, "closed");
    assert.isTrue((harness.drawer as any).hidden);
  });

  it("closes without motion when the panel switches conversation", function () {
    seedScope(5);
    const harness = track(mount({}, { layout: fakeLayout().layout }));
    fakeHeights(harness, 300, 700);
    harness.row.dispatchFakeEvent("click");
    harness.view.setInput({
      conversationKey: KEY + 1,
      recordsReads: true,
      visibility: {
        conversationKind: "global",
        isWebChat: false,
        isNoteSession: false,
        collectionCount: 1,
        tagCount: 0,
        paperCount: 0,
      },
    });
    assert.equal(harness.drawer.dataset.state, "closed");
    assert.isTrue((harness.drawer as any).hidden);
    assert.isFalse(harness.shell.classList.contains("llm-task-progress-shown"));
  });

  it("drops the header divider only while the row shows", function () {
    seedScope(5);
    const shown = track(mount());
    assert.equal(shown.panel.getAttribute("data-task-progress-row"), "shown");
    shown.view.setInput({
      conversationKey: KEY,
      recordsReads: true,
      visibility: {
        conversationKind: "paper",
        isWebChat: false,
        isNoteSession: false,
        collectionCount: 0,
        tagCount: 0,
        paperCount: 1,
      },
    });
    assert.isTrue((shown.row as any).hidden);
    assert.isNull(shown.panel.getAttribute("data-task-progress-row"));
  });

  it("keeps the chat's place while the drawer changes size", function () {
    seedScope(5);
    const motion = fakeLayout();
    const harness = track(mount({}, { layout: motion.layout }));
    fakeHeights(harness, 300, 700);
    motion.fireResize();
    assert.equal(motion.chatResized(), 0, "nothing while closed");
    harness.row.dispatchFakeEvent("click");
    motion.fireResize();
    assert.equal(motion.chatResized(), 1);
    assert.equal(harness.shell.style["--llm-task-progress-inset"], "300px");
    transitionEnd(harness.drawer);
    harness.row.dispatchFakeEvent("click");
    transitionEnd(harness.drawer);
    assert.equal(harness.shell.style["--llm-task-progress-inset"], "");
  });

  it("drags the handle within its bounds and remembers the height for the session", function () {
    seedScope(40);
    const { doc, target } = draggableDocument();
    const harness = track(
      mount({}, { layout: fakeLayout({ ms: 0 }).layout, doc }),
    );
    const drawerHeight = fakeHeights(harness, 500, 700);
    const down = (clientY: number) =>
      harness.grip.dispatchFakeEvent("mousedown", {
        button: 0,
        clientY,
      } as never);
    const move = (clientY: number) =>
      target.dispatchFakeEvent("mousemove", { clientY } as never);
    down(500);
    assert.isFalse(
      harness.panel.classList.contains("llm-task-progress-resizing"),
      "a closed drawer has no handle to hold",
    );
    harness.row.dispatchFakeEvent("click");
    down(500);
    assert.isTrue(
      harness.panel.classList.contains("llm-task-progress-resizing"),
    );
    move(300);
    assert.equal(harness.drawer.style[MAX_VAR], "300px");
    move(-1000);
    assert.equal(
      harness.drawer.style[MAX_VAR],
      `${TASK_PROGRESS_DRAWER_MIN_PX}px`,
      "no shorter than the minimum",
    );
    move(5000);
    // 500 now, plus the chat's 200 less its 96px strip.
    assert.equal(
      harness.drawer.style[MAX_VAR],
      "604px",
      "the chat keeps a strip",
    );
    move(350);
    assert.isNull(getRememberedTaskProgressDrawerHeight(), "not until release");
    target.dispatchFakeEvent("mouseup", { clientY: 350 } as never);
    assert.isFalse(
      harness.panel.classList.contains("llm-task-progress-resizing"),
    );
    assert.equal(getRememberedTaskProgressDrawerHeight(), 350);
    move(100);
    assert.equal(harness.drawer.style[MAX_VAR], "350px", "released");
    assert.equal(drawerHeight(), 350);

    harness.panel.dispatchFakeEvent("keydown", { key: "Escape" });
    harness.row.dispatchFakeEvent("click");
    assert.equal(harness.drawer.style[MAX_VAR], "350px", "reopens at it");
    const other = track(mount({}, { layout: fakeLayout({ ms: 0 }).layout }));
    // Another view of the conversation comes back open, as it was left.
    assert.isTrue(other.view.isOpen());
    assert.equal(
      other.drawer.style[MAX_VAR],
      "350px",
      "every panel, this session",
    );

    const key = (name: string, shiftKey = false) =>
      harness.grip.dispatchFakeEvent("keydown", {
        key: name,
        shiftKey,
      } as never);
    key("ArrowUp");
    assert.equal(getRememberedTaskProgressDrawerHeight(), 334);
    key("ArrowDown", true);
    assert.equal(getRememberedTaskProgressDrawerHeight(), 398);
    key("Home");
    assert.equal(
      getRememberedTaskProgressDrawerHeight(),
      TASK_PROGRESS_DRAWER_MIN_PX,
    );
    harness.grip.dispatchFakeEvent("dblclick");
    assert.isNull(getRememberedTaskProgressDrawerHeight());
    assert.equal(harness.drawer.style[MAX_VAR], "", "back to its content");
  });

  describe("per-conversation card state", function () {
    const OTHER = KEY + 1;
    function seedOther() {
      setTaskScope(OTHER, {
        signature: "other",
        libraryID: 1,
        contexts: { collections: [{ collectionId: 6 }] },
        label: "Other",
        listing: {
          libraryID: 1,
          wholeLibrary: false,
          entries: scopeEntries(5),
          totalItems: 5,
          listedItems: 5,
          truncated: false,
        },
      });
    }
    const globalInput = (conversationKey: number): TaskProgressViewInput => ({
      conversationKey,
      recordsReads: true,
      visibility: {
        conversationKind: "global",
        isWebChat: false,
        isNoteSession: false,
        collectionCount: 1,
        tagCount: 0,
        paperCount: 0,
      },
    });
    const expandedKeys = (harness: Harness) =>
      harness
        .items()
        .filter(
          (item) =>
            item
              .findByClass("llm-task-paper-summary")!
              .getAttribute("aria-expanded") === "true",
        )
        .map((item) => item.dataset.key);
    function openAndExpand(harness: Harness, index: number) {
      harness.row.dispatchFakeEvent("click");
      const item = harness.items()[index];
      item.findByClass("llm-task-paper-summary")!.dispatchFakeEvent("click");
    }

    it("comes back open, expanded, windowed and scrolled on a new mount, without motion", function () {
      seedScope(200);
      const first = track(mount());
      openAndExpand(first, 1);
      Object.assign(first.body, {
        scrollHeight: 4000,
        clientHeight: 600,
        scrollTop: 3300,
      });
      first.body.dispatchFakeEvent("scroll");
      assert.equal(first.view.renderedRowCount(), 2 * TASK_PROGRESS_WINDOW);
      first.view.dispose();

      // The panel is rebuilt (a tab switch): the new view takes it up again.
      const again = track(
        mount({}, { layout: fakeLayout({ ms: 200 }).layout }),
      );
      assert.isTrue(again.view.isOpen(), "the drawer is open");
      assert.equal(again.drawer.dataset.state, "open", "with no motion");
      assert.isFalse((again.drawer as any).hidden);
      assert.equal(again.row.getAttribute("aria-expanded"), "true");
      assert.deepEqual(expandedKeys(again), ["1:2"], "the paper is expanded");
      const details = again
        .items()[1]
        .findByClass("llm-task-paper-details")! as any;
      assert.isFalse(details.hidden, "with its details");
      assert.equal(again.view.renderedRowCount(), 2 * TASK_PROGRESS_WINDOW);
      assert.equal(again.body.scrollTop, 3300, "at the same place");
    });

    it("keeps the user's own close on the next mount", function () {
      seedScope(5);
      const first = track(mount());
      openAndExpand(first, 0);
      first.row.dispatchFakeEvent("click");
      assert.isFalse(first.view.isOpen());
      first.view.dispose();
      const closed = track(mount());
      assert.isFalse(closed.view.isOpen(), "the user closed it");
      closed.row.dispatchFakeEvent("click");
      assert.deepEqual(
        expandedKeys(closed),
        ["1:1"],
        "the paper stays expanded",
      );
    });

    it("stays closed after the answer starts, mounted or not", function () {
      seedScope(5);
      beginTaskRun(KEY, { runId: "run-a" });
      const first = track(mount());
      first.row.dispatchFakeEvent("click");
      markTaskAnswering(KEY, "run-a");
      assert.isFalse(first.view.isOpen(), "the answer collapses it");
      first.view.dispose();
      assert.isFalse(track(mount()).view.isOpen(), "and it stays collapsed");

      beginTaskRun(KEY, { runId: "run-b" });
      const reopened = track(mount());
      reopened.row.dispatchFakeEvent("click");
      assert.isTrue(reopened.view.isOpen());
      reopened.view.dispose();
      // No view shows the conversation when its next answer starts.
      markTaskAnswering(KEY, "run-b");
      assert.isFalse(track(mount()).view.isOpen(), "collapsed while away");
    });

    it("forgets the state when the conversation's record is cleared", function () {
      seedScope(5);
      const first = track(mount());
      openAndExpand(first, 0);
      first.view.dispose();
      clearTaskProgress(KEY);
      seedScope(5);
      const fresh = track(mount());
      assert.isFalse(fresh.view.isOpen());
      fresh.row.dispatchFakeEvent("click");
      assert.deepEqual(expandedKeys(fresh), [], "nothing expanded");
    });

    it("drops the expanded papers of a record cleared under a mounted view", function () {
      seedScope(5);
      const harness = track(mount());
      openAndExpand(harness, 0);
      clearTaskProgress(KEY);
      seedScope(5);
      harness.view.flush();
      if (!harness.view.isOpen()) harness.row.dispatchFakeEvent("click");
      assert.deepEqual(
        expandedKeys(harness),
        [],
        "the rebuilt list starts folded",
      );
      // Its next write must not bring the old expansion back either.
      harness.row.dispatchFakeEvent("click");
      harness.view.dispose();
      const again = track(mount());
      again.row.dispatchFakeEvent("click");
      assert.deepEqual(expandedKeys(again), []);
    });

    it("keeps each conversation's own state when the panel switches", function () {
      seedScope(200);
      seedOther();
      const harness = track(mount());
      openAndExpand(harness, 2);
      harness.view.setInput(globalInput(OTHER));
      assert.isFalse(
        harness.view.isOpen(),
        "another conversation starts closed",
      );
      harness.row.dispatchFakeEvent("click");
      assert.deepEqual(expandedKeys(harness), [], "with nothing expanded");
      harness
        .items()[4]
        .findByClass("llm-task-paper-summary")!
        .dispatchFakeEvent("click");
      harness.row.dispatchFakeEvent("click");
      assert.isFalse(harness.view.isOpen());

      harness.view.setInput(globalInput(KEY));
      assert.isTrue(
        harness.view.isOpen(),
        "the first conversation is open again",
      );
      assert.equal(harness.drawer.dataset.state, "open");
      assert.deepEqual(expandedKeys(harness), ["1:3"]);
      harness.view.setInput(globalInput(OTHER));
      assert.isFalse(harness.view.isOpen(), "the other one was closed");
      harness.row.dispatchFakeEvent("click");
      assert.deepEqual(expandedKeys(harness), ["1:5"]);
    });
  });
});
