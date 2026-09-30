/**
 * The Task progress row and its drawer, on every surface that hosts the chat:
 * the sidebar in its independent and stacked layouts, and the standalone
 * window. A synthetic agent run goes through the real turn event handler:
 * paper ledger updates, the first answer text, and the final answer with a
 * quote citation. The drawer's geometry is read from live layout: attached
 * under the row, as tall as a short list, capped above a strip of chat for a
 * long one, draggable, and never moving the chat's reading place.
 */
import { assert } from "chai";
import { buildQuoteCitation } from "../src/services/quotes/quoteCitations";
import { getReaderContextPanelForTab } from "../src/modules/contextPanel/readerPopupPanelRouting";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";

const PAPERS = [
  { title: "Representational drift in hippocampal CA1", author: "Ziv" },
  { title: "Stable population codes under constant behavior", author: "Rule" },
  { title: "Synaptic turnover predicts place field drift", author: "Mau" },
  { title: "Drift scales with experience, not time", author: "Geva" },
  { title: "Continual learning with noisy plasticity", author: "Kossio" },
  { title: "Homeostatic control of drifting assemblies", author: "Aitken" },
];
const SNIPPETS: Record<number, string> = {
  2: "Turnover of dendritic spines predicts the rate at which place fields reorganize over two weeks.",
  3: "The rate of drift scaled with the amount of experience in the environment rather than elapsed time.",
};

type Surface = "independent" | "stacked" | "standalone";

/** Papers in the long folder: more than one window of rows (80). */
const LONG_COUNT = 90;
/** The chat strip the CSS keeps below the drawer. */
const CHAT_STRIP = 96;
/** The least height a drag leaves the drawer. */
const DRAWER_MIN = 96;
/** The gap between the Task progress card and the chat below it. */
const CARD_GAP = 6;

describe("workflow: task progress", function () {
  this.timeout(240000);
  const layoutPref = "extensions.zotero.llmforzotero.sidebarLayout";
  // Reads are recorded in Agent mode; plain chat lists the scope only.
  const agentPrefs: Array<[string, unknown]> = [
    ["extensions.zotero.llmforzotero.enableAgentMode", true],
    ["extensions.zotero.llmforzotero.lastUsedRuntimeMode", "agent"],
  ];
  const savedAgentPrefs = new Map<string, unknown>();
  let api: WorkflowTestApi;
  let win: any;
  let savedLayout: unknown;
  let savedWindowSize: { width: number; height: number } | null = null;
  const fixtures: WorkflowTestFixture[] = [];
  let collection: Zotero.Collection;
  let longCollection: Zotero.Collection;
  const longItems: Zotero.Item[] = [];
  let libraryID: number;
  const shots: string[] = [];

  async function until(check: () => boolean, message: string | (() => string)) {
    const deadline = Date.now() + 15000;
    while (!check() && Date.now() < deadline) await Zotero.Promise.delay(40);
    assert.isTrue(check(), typeof message === "function" ? message() : message);
  }

  async function capture(target: any, filename: string) {
    const canvas = target.document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "canvas",
    );
    const scale = target.devicePixelRatio || 1;
    canvas.width = target.innerWidth * scale;
    canvas.height = target.innerHeight * scale;
    const context = canvas.getContext("2d");
    context.scale(scale, scale);
    context.drawWindow(
      target,
      0,
      0,
      target.innerWidth,
      target.innerHeight,
      "#ffffff",
    );
    const binary = target.atob(canvas.toDataURL("image/png").split(",")[1]);
    const path = `${Zotero.DataDirectory.dir}/${filename}`;
    await win.IOUtils.write(
      path,
      Uint8Array.from(binary, (char: any) => char.charCodeAt(0)),
    );
    shots.push(path);
  }

  function paperId(index: number): number {
    return fixtures[index].parentItemId;
  }

  function paperKey(index: number): string {
    return `${libraryID}:${paperId(index)}`;
  }

  function paperRef(index: number) {
    return {
      itemId: paperId(index),
      contextItemId: fixtures[index].pdfAttachmentId,
      title: PAPERS[index].title,
      libraryID,
    };
  }

  /** A `paper_ledger_update` as `library_retrieve` would emit it. */
  function ledgerUpdate(
    callId: string,
    entries: Array<[number, "matched" | "skimmed" | "read"]>,
  ) {
    return {
      type: "paper_ledger_update" as const,
      callId,
      delta: {
        version: 1 as const,
        callId,
        toolName: "library_retrieve",
        papers: entries.map(([index, state]) => ({
          key: paperKey(index),
          libraryID,
          itemId: paperId(index),
          title: PAPERS[index].title,
          text: "pdf_text" as const,
          state,
        })),
        reads: entries.map(([index, state]) => ({
          key: paperKey(index),
          callId,
          toolName: "library_retrieve",
          granularity:
            state === "read"
              ? ("passage" as const)
              : state === "skimmed"
                ? ("abstract" as const)
                : ("metadata" as const),
          method: "bm25",
          ...(state === "read"
            ? { label: "Results", snippet: SNIPPETS[index] }
            : {}),
        })),
      },
    };
  }

  function activeDetails(): any {
    const readerPane = getReaderContextPanelForTab(
      win.document,
      win.Zotero_Tabs.selectedID,
    );
    if (readerPane) return readerPane;
    return Array.from(win.document.querySelectorAll("item-details")).find(
      (node: any) =>
        node.tabType === "library" && node.getBoundingClientRect().width > 0,
    );
  }

  /** Select the first paper and open its chat in a sidebar layout. */
  async function openSidebarChat(
    layout: "independent" | "stacked",
  ): Promise<HTMLElement> {
    Zotero.Prefs.set(layoutPref, layout, true);
    const view = layout === "independent" ? "chat" : "stacked";
    await win.ZoteroPane.selectItem(paperId(0));
    const details = activeDetails();
    assert.isOk(details, "native item details is visible");
    const section = () =>
      details.querySelector(".llm-dedicated-chat-pane") as HTMLElement;
    const mainVisible = () =>
      (section()?.querySelector("#llm-main")?.getBoundingClientRect().height ||
        0) > 0;
    if (
      win.document.documentElement.getAttribute("data-llm-pane-view") !==
        view ||
      details.sidenav._collapsed ||
      !mainVisible()
    ) {
      const paneID = section()?.dataset.pane;
      const button: any = Array.from(
        details.sidenav.querySelectorAll("[data-pane]"),
      ).find((node: any) => node.getAttribute("data-pane") === paneID);
      assert.isOk(button, "the plugin's rail icon exists");
      button.dispatchEvent(
        new win.MouseEvent("click", { bubbles: true, detail: 1, button: 0 }),
      );
    }
    await until(
      () =>
        win.document.documentElement.getAttribute("data-llm-pane-view") ===
          view &&
        !details.sidenav._collapsed &&
        mainVisible(),
      `${layout} chat is open`,
    );
    if (layout === "stacked") section().scrollIntoView?.();
    const root = section().querySelector("#llm-main") as HTMLElement;
    // A previous test may have left the pane in Library chat.
    if (root.dataset.conversationKind === "global") {
      (root.querySelector("#llm-paper-chat-tab") as HTMLElement).dispatchEvent(
        new win.MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    }
    await until(
      () =>
        root.dataset.conversationKind === "paper" &&
        root.dataset.basePaperItemId === String(paperId(0)),
      "the chat shows the first paper",
    );
    return root;
  }

  async function openStandaloneChat(): Promise<{
    root: HTMLElement;
    window: any;
  }> {
    await api.openStandaloneForItem(paperId(0));
    await api.clickStandaloneTab("paper");
    const standalone = (Zotero as any).LLMForZotero.data.standaloneWindow;
    const root = () =>
      standalone.document.querySelector(
        ".llm-standalone-content #llm-main",
      ) as HTMLElement | null;
    await until(
      () => root()?.dataset.conversationKind === "paper",
      "the standalone window shows a paper chat",
    );
    return { root: root()!, window: standalone };
  }

  function part(root: HTMLElement) {
    return {
      row: root.querySelector("#llm-task-progress") as HTMLButtonElement,
      card: root.querySelector(".llm-task-progress-card") as HTMLElement,
      count: () =>
        root.querySelector(".llm-task-progress-count")?.textContent || "",
      shell: root.querySelector("#llm-chat-shell") as HTMLElement,
      box: root.querySelector("#llm-chat-box") as HTMLElement,
      drawer: root.querySelector("#llm-task-progress-drawer") as HTMLElement,
      body: root.querySelector(".llm-task-progress-drawer-body") as HTMLElement,
      grip: root.querySelector(".llm-task-progress-drawer-grip") as HTMLElement,
      items: () =>
        Array.from(root.querySelectorAll(".llm-task-paper")) as HTMLElement[],
    };
  }

  type View = ReturnType<typeof part>;

  async function settle(view: View, state: "open" | "closed", label: string) {
    await until(
      () => view.drawer.dataset.state === state,
      () =>
        `${label}: the drawer settles ${state} (${view.drawer.dataset.state})`,
    );
    // One more frame for the chat's scroll owner.
    await Zotero.Promise.delay(40);
  }

  /** The top of the first visible thing under the chat: shortcuts or composer. */
  function composerTop(root: HTMLElement): number {
    const tops = ["#llm-shortcuts", ".llm-input-section"]
      .map((selector) => root.querySelector(selector) as HTMLElement | null)
      .map((node) => node?.getBoundingClientRect())
      .filter((rect): rect is DOMRect => Boolean(rect && rect.height > 0))
      .map((rect) => rect.top);
    assert.isNotEmpty(tops, "the composer is laid out");
    return Math.min(...tops);
  }

  /** Visible horizontal lines (bottom borders) just above the row. */
  function linesAboveRow(root: HTMLElement): string[] {
    const doc = root.ownerDocument;
    const win = doc.defaultView as any;
    const row = part(root).row.getBoundingClientRect();
    const lines: string[] = [];
    for (const node of Array.from(doc.querySelectorAll("*")) as HTMLElement[]) {
      const rect = node.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      if (rect.right <= row.left || rect.left >= row.right) continue;
      if (rect.bottom < row.top - 6 || rect.bottom > row.top + 0.5) continue;
      const style = win.getComputedStyle(node);
      if (style.visibility !== "visible") continue;
      const width = parseFloat(style.borderBottomWidth) || 0;
      const color = style.borderBottomColor;
      if (
        width > 0 &&
        style.borderBottomStyle !== "none" &&
        color !== "transparent" &&
        !/rgba\([^)]*,\s*0\)$/.test(color)
      ) {
        lines.push(`${node.tagName}.${node.className} ${width}px ${color}`);
      }
    }
    return lines;
  }

  /** The first message whose top is inside the chat viewport, and its offset. */
  function readingAnchor(box: HTMLElement): { node: Element; offset: number } {
    const top = box.getBoundingClientRect().top;
    const node = Array.from(
      box.querySelectorAll(".llm-message-wrapper, .llm-bubble"),
    ).find((candidate) => candidate.getBoundingClientRect().top >= top);
    assert.isOk(node, "a message is in view");
    return { node: node!, offset: node!.getBoundingClientRect().top - top };
  }

  function bottomGap(box: HTMLElement): number {
    return box.scrollHeight - box.clientHeight - box.scrollTop;
  }

  /**
   * One container: the drawer unrolls inside the card, right under its
   * header row and exactly as wide.
   */
  function assertAttached(view: View, surface: Surface) {
    const row = view.row.getBoundingClientRect();
    const drawer = view.drawer.getBoundingClientRect();
    const card = view.card.getBoundingClientRect();
    assert.closeTo(drawer.top, row.bottom, 1, `under the header (${surface})`);
    assert.closeTo(drawer.left, row.left, 0.5, `same card (${surface}, left)`);
    assert.closeTo(
      drawer.right,
      row.right,
      0.5,
      `same card (${surface}, right)`,
    );
    assert.isAtMost(
      card.top,
      row.top + 0.5,
      `the card holds the header (${surface})`,
    );
    assert.isAtLeast(
      card.bottom,
      drawer.bottom - 0.5,
      `the card holds the drawer (${surface})`,
    );
  }

  /** The chat under the drawer: its viewport starts at the drawer's bottom. */
  function assertChatBelow(view: View, root: HTMLElement, surface: Surface) {
    const drawer = view.drawer.getBoundingClientRect();
    const box = view.box.getBoundingClientRect();
    assert.closeTo(
      box.top,
      view.card.getBoundingClientRect().bottom + CARD_GAP,
      1,
      `the chat starts below the card (${surface})`,
    );
    assert.isAtLeast(
      box.height,
      CHAT_STRIP - 1,
      `a strip of chat stays (${surface})`,
    );
    assert.isAtMost(
      drawer.bottom,
      composerTop(root) - CHAT_STRIP + 1,
      `the drawer stays clear of the composer by the strip (${surface})`,
    );
    const view$ = root.ownerDocument.defaultView as any;
    assert.isTrue(view.box.isConnected, "messages stay mounted");
    assert.equal(view$.getComputedStyle(view.box).visibility, "visible");
    assert.notEqual(view$.getComputedStyle(view.box).display, "none");
  }

  function surfaceOf(surface: Surface): "embedded" | "standalone" {
    return surface === "standalone" ? "standalone" : "embedded";
  }

  /**
   * In a paper chat the card is for multi-paper work: hidden for one paper
   * and for four, shown from five (the chat's own paper counts).
   */
  async function assertPaperChatThreshold(
    rootOf: () => HTMLElement,
    surface: Surface,
    shotWindow: any,
  ) {
    const noHeaderDivider = (label: string) => {
      if (surface === "standalone") return;
      const navRow = rootOf().querySelector(
        ".llm-header-nav-row",
      ) as HTMLElement;
      const style = (
        rootOf().ownerDocument.defaultView as any
      ).getComputedStyle(navRow);
      assert.equal(
        style.borderBottomStyle,
        "none",
        `no divider under the header ${label} (${surface})`,
      );
    };
    for (const papers of [[], [1, 2, 3]]) {
      const small = await api.startTaskProgressReplay({
        surface: surfaceOf(surface),
        user: papers.length
          ? { paperContexts: papers.map((index) => paperRef(index)) }
          : {},
      });
      try {
        api.flushTaskProgress();
        assert.isTrue(
          part(rootOf()).row.hidden,
          `a ${papers.length + 1}-paper chat has no card (${surface})`,
        );
        noHeaderDivider("without the card");
      } finally {
        small.finish();
      }
    }
    const four = await api.startTaskProgressReplay({
      surface: surfaceOf(surface),
      user: {
        paperContexts: [paperRef(1), paperRef(2), paperRef(3), paperRef(4)],
      },
    });
    try {
      await until(
        () => {
          api.flushTaskProgress();
          return part(rootOf()).count() === "0 of 5 read";
        },
        () =>
          `a five-paper chat shows the card (${surface}): ${JSON.stringify({
            count: part(rootOf()).count(),
            hidden: part(rootOf()).row.hidden,
            snapshot: api.getTaskProgressSnapshot(four.conversationKey),
            key: four.conversationKey,
            itemId: rootOf().dataset.itemId,
          })}`,
      );
      noHeaderDivider("with the card");
      const root = rootOf();
      const view = part(root);
      assert.isFalse(view.row.hidden);
      assert.deepEqual(
        linesAboveRow(root),
        [],
        `no line between the header and the row (${surface})`,
      );
      await capture(shotWindow, `tp-dropdown-collapsed-${surface}.png`);

      // A short list: the drawer is exactly as tall as its content.
      await until(() => {
        api.flushTaskProgress();
        return Boolean(
          api.getTaskProgressSnapshot(four.conversationKey)?.listingLoaded,
        );
      }, "the five papers list");
      view.row.click();
      await settle(view, "open", `short list (${surface})`);
      assert.lengthOf(view.items(), 5);
      assertAttached(view, surface);
      assertChatBelow(view, root, surface);
      assert.isAtMost(
        view.body.scrollHeight,
        view.body.clientHeight + 1,
        `a short list does not scroll (${surface})`,
      );
      // The unscrolled body plus the card's 1px bottom border.
      assert.closeTo(
        view.drawer.getBoundingClientRect().height,
        view.body.getBoundingClientRect().height + 1,
        0.5,
        `a short list's drawer is its content's height (${surface})`,
      );
      await capture(shotWindow, `tp-dropdown-short-${surface}.png`);
      view.row.click();
      await settle(view, "closed", `short list (${surface})`);
      assert.isTrue(view.drawer.hidden);
    } finally {
      four.finish();
    }
  }

  async function switchToLibrary(rootOf: () => HTMLElement, surface: Surface) {
    const root = rootOf();
    if (surface === "standalone") await api.clickStandaloneTab("open");
    else
      (
        root.querySelector("#llm-library-chat-tab") as HTMLElement
      ).dispatchEvent(
        new (root.ownerDocument.defaultView as any).MouseEvent("click", {
          bubbles: true,
          cancelable: true,
        }),
      );
    await until(
      () => rootOf()?.dataset.conversationKind === "global",
      `library chat opens (${surface})`,
    );
  }

  async function exerciseLibraryRun(
    rootOf: () => HTMLElement,
    surface: Surface,
    shotWindow: any,
  ) {
    const handle = await api.startTaskProgressReplay({
      surface: surfaceOf(surface),
      historyTurns: 4,
      user: {
        selectedCollectionContexts: [
          { collectionId: collection.id, name: collection.name, libraryID },
        ],
      },
    });
    const root = rootOf();
    const view = part(root);
    const doc = root.ownerDocument;
    const view$ = doc.defaultView as any;
    try {
      await until(() => {
        api.flushTaskProgress();
        return Boolean(
          api.getTaskProgressSnapshot(handle.conversationKey)?.listingLoaded,
        );
      }, "the scope listing resolves");
      api.flushTaskProgress();
      const snapshot = api.getTaskProgressSnapshot(handle.conversationKey)!;
      assert.sameMembers(
        snapshot.scopeKeys,
        PAPERS.map((_, index) => paperKey(index)),
        "the folder's papers are the scope",
      );
      assert.equal(snapshot.label, collection.name);
      assert.isFalse(
        view.row.hidden,
        `library chat shows the row (${surface})`,
      );
      assert.closeTo(view.row.getBoundingClientRect().height, 38, 1);
      assert.isFalse(view.card.hidden, "the card shows with its header");
      assert.isAtMost(
        view.card.getBoundingClientRect().top -
          view.shell.getBoundingClientRect().top,
        4,
        "the card sits at the top of the chat area",
      );
      assert.equal(view.row.dataset.state, "working");
      assert.equal(view.count(), "0 of 6 read");

      await handle.emit(
        ledgerUpdate("retrieve-1", [
          [0, "matched"],
          [1, "skimmed"],
          [2, "read"],
          [3, "read"],
        ]),
      );
      api.flushTaskProgress();
      assert.equal(view.count(), "3 of 6 read");
      await capture(shotWindow, `task-progress-${surface}-row-mid-run.png`);

      // Open: the drawer unrolls under the row and the chat below shrinks;
      // the messages stay mounted and keep their reading place.
      view.box.scrollTop = Math.max(
        0,
        (view.box.scrollHeight - view.box.clientHeight) / 2,
      );
      await Zotero.Promise.delay(80);
      const scrollTop = view.box.scrollTop;
      assert.isAbove(scrollTop, 0, "the chat has history to scroll");
      const anchor = readingAnchor(view.box);
      const boxHeight = view.box.getBoundingClientRect().height;
      const shellRect = view.shell.getBoundingClientRect();
      view.row.click();
      assert.equal(view.row.getAttribute("aria-expanded"), "true");
      assert.equal(view.drawer.dataset.state, "opening", "it unrolls");
      assert.isFalse(view.drawer.hidden);
      await settle(view, "open", `open (${surface})`);
      assert.equal(view.drawer.style.height, "", "no height left behind");
      assertAttached(view, surface);
      assertChatBelow(view, root, surface);
      assert.closeTo(
        view.box.getBoundingClientRect().height,
        boxHeight - view.drawer.getBoundingClientRect().height,
        1,
        "the chat gives the drawer its height",
      );
      const shellNow = view.shell.getBoundingClientRect();
      assert.closeTo(shellNow.top, shellRect.top, 0.5, "the shell stays put");
      assert.closeTo(shellNow.height, shellRect.height, 0.5);
      assert.closeTo(view.box.scrollTop, scrollTop, 1, "scrollTop is kept");
      assert.closeTo(
        anchor.node.getBoundingClientRect().top -
          view.box.getBoundingClientRect().top,
        anchor.offset,
        1,
        "the reading anchor stays where it was",
      );

      const items = view.items();
      assert.lengthOf(items, 6);
      assert.deepEqual(
        items.map((item) => item.dataset.key),
        snapshot.scopeKeys,
        "rows follow scope order",
      );
      assert.deepEqual(
        items.map(
          (item) => item.querySelector(".llm-task-paper-index")!.textContent,
        ),
        ["1", "2", "3", "4", "5", "6"],
      );
      const stateOf = (index: number) =>
        items.find((item) => item.dataset.key === paperKey(index))!.dataset
          .state;
      assert.deepEqual([0, 1, 2, 3, 4, 5].map(stateOf), [
        "matched",
        "skimmed",
        "read",
        "read",
        "listed",
        "listed",
      ]);

      const readItem = items.find((item) => item.dataset.key === paperKey(2))!;
      const summary = readItem.querySelector(
        ".llm-task-paper-summary",
      ) as HTMLButtonElement;
      summary.click();
      const details = readItem.querySelector(
        ".llm-task-paper-details",
      ) as HTMLElement;
      assert.isFalse(details.hidden, "a paper expands");
      assert.include(details.textContent!, SNIPPETS[2]);
      // One question read it: no question heading, no tool or method names.
      assert.notInclude(details.textContent!, "Question");
      assert.notInclude(details.textContent!, "Retrieve Library");
      await Zotero.Promise.delay(450); // the reads fade in
      await capture(shotWindow, `tp-paper-details-${surface}.png`);
      // Scrolling the drawer never moves the chat below it.
      view.body.scrollTop +=
        readItem.getBoundingClientRect().top -
        view.body.getBoundingClientRect().top;
      await Zotero.Promise.delay(50);
      assert.closeTo(view.box.scrollTop, scrollTop, 1);
      summary.click();
      assert.isTrue(details.hidden, "and collapses");

      summary.dispatchEvent(
        new view$.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
      assert.equal(view.drawer.dataset.state, "closing", "Escape rolls it up");
      assert.equal(view.row.getAttribute("aria-expanded"), "false");
      await settle(view, "closed", `Escape (${surface})`);
      assert.isTrue(view.drawer.hidden);
      assert.isFalse(view.shell.classList.contains("llm-task-progress-shown"));
      assert.closeTo(view.box.getBoundingClientRect().height, boxHeight, 1);
      assert.closeTo(
        view.box.scrollTop,
        scrollTop,
        1,
        "the chat's scroll position survives the drawer",
      );

      // At the bottom, the chat stays at the bottom through both motions.
      view.box.scrollTop = view.box.scrollHeight;
      await Zotero.Promise.delay(80);
      assert.isAtMost(bottomGap(view.box), 1);
      view.row.click();
      await settle(view, "open", `follow bottom (${surface})`);
      assert.isAtMost(bottomGap(view.box), 1, "still at the bottom, open");
      view.row.click();
      await settle(view, "closed", `follow bottom (${surface})`);
      assert.isAtMost(bottomGap(view.box), 1, "still at the bottom, closed");

      // The first answer text collapses an open drawer.
      view.row.click();
      await settle(view, "open", `before the answer (${surface})`);
      const quote = SNIPPETS[3];
      const citation = buildQuoteCitation({
        quoteText: quote,
        citationLabel: `(${PAPERS[3].author}, 2021)`,
        sourceMatchText: quote,
        sourceMatchKind: "exact",
        sourceMatchSource: "context-text",
        itemId: paperId(3),
        contextItemId: fixtures[3].pdfAttachmentId,
      })!;
      const answer =
        `Across the folder, drift tracks experience.\n\n> ${quote}\n\n` +
        `(${PAPERS[3].author}, 2021)\n\n[[quote:${citation.id}]] ` +
        "Population readouts stay stable while single cells change.\n\n" +
        "Further discussion follows so the answer has length.\n\n".repeat(8);
      await handle.emit({ type: "message_delta", text: "Across the folder, " });
      assert.equal(
        view.drawer.dataset.state,
        "closing",
        "the answer rolls the drawer up",
      );
      await settle(view, "closed", `answer (${surface})`);
      api.flushTaskProgress();
      assert.equal(view.row.dataset.state, "answering");

      await handle.emit({
        type: "final",
        text: answer,
        quoteCitations: [citation],
      });
      handle.refreshChat();
      await Zotero.Promise.delay(200);
      api.flushTaskProgress();
      assert.equal(view.row.dataset.state, "completed", "✓ at final");
      assert.equal(view.count(), "3 of 6 read · 1 cited");
      await capture(shotWindow, `task-progress-${surface}-completed.png`);

      // "Cited in answer" collapses the drawer and brings the chip into view.
      view.box.scrollTop = 0;
      await Zotero.Promise.delay(50);
      view.row.click();
      await settle(view, "open", `citation (${surface})`);
      const citedItem = view
        .items()
        .find((item) => item.dataset.key === paperKey(3))!;
      assert.equal(citedItem.dataset.state, "cited");
      (
        citedItem.querySelector(".llm-task-paper-summary") as HTMLElement
      ).click();
      const link = citedItem.querySelector(
        ".llm-task-paper-citation",
      ) as HTMLButtonElement;
      assert.isOk(link, "the cited paper links to its chip");
      link.click();
      assert.equal(
        view.drawer.dataset.state,
        "closing",
        "the link rolls the drawer up",
      );
      const card = Array.from(
        view.box.querySelectorAll(".llm-quote-citation-anchor"),
      ).find(
        (node) => (node as HTMLElement).dataset.quoteCitationId === citation.id,
      ) as HTMLElement;
      assert.isOk(card, "the answer renders the cited chip");
      assert.isTrue(card.classList.contains("llm-task-progress-flash"));
      await settle(view, "closed", `citation (${surface})`);
      await Zotero.Promise.delay(150);
      const cardRect = card.getBoundingClientRect();
      const boxRect = view.box.getBoundingClientRect();
      assert.isAtLeast(cardRect.bottom, boxRect.top, "the chip is in view");
      assert.isAtMost(cardRect.top, boxRect.bottom, "the chip is in view");
      assert.equal(
        doc.querySelectorAll(
          ".llm-plan-progress-floating, .llm-plan-container-execution",
        ).length,
        0,
        "no floating plan capsule",
      );
    } finally {
      handle.finish();
    }
  }

  /** Drag the drawer's handle by `dy` pixels, as a mouse would. */
  async function dragGrip(view: View, dy: number) {
    const doc = view.grip.ownerDocument;
    const win = doc.defaultView as any;
    const rect = view.grip.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const mouse = (type: string, clientY: number) =>
      new win.MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: x,
        clientY,
      });
    view.grip.dispatchEvent(mouse("mousedown", y));
    for (const step of [0.5, 1]) {
      doc.documentElement.dispatchEvent(mouse("mousemove", y + dy * step));
      await Zotero.Promise.delay(20);
    }
    doc.documentElement.dispatchEvent(mouse("mouseup", y + dy));
    await Zotero.Promise.delay(60);
  }

  const heightOf = (node: HTMLElement) => node.getBoundingClientRect().height;

  /**
   * A folder longer than the chat: the drawer takes all but a strip of chat,
   * scrolls inside, windows its rows, and drags between its bounds.
   */
  async function exerciseLongList(
    rootOf: () => HTMLElement,
    surface: Surface,
    shotWindow: any,
  ) {
    const handle = await api.startTaskProgressReplay({
      surface: surfaceOf(surface),
      historyTurns: 4,
      user: {
        selectedCollectionContexts: [
          {
            collectionId: longCollection.id,
            name: longCollection.name,
            libraryID,
          },
        ],
      },
    });
    const root = rootOf();
    const view = part(root);
    try {
      await until(() => {
        api.flushTaskProgress();
        return Boolean(
          api.getTaskProgressSnapshot(handle.conversationKey)?.listingLoaded,
        );
      }, "the long folder lists");
      api.flushTaskProgress();
      assert.equal(view.count(), `0 of ${LONG_COUNT} read`);
      view.box.scrollTop = Math.max(
        0,
        (view.box.scrollHeight - view.box.clientHeight) / 2,
      );
      await Zotero.Promise.delay(80);
      const scrollTop = view.box.scrollTop;
      const anchor = readingAnchor(view.box);
      const shell = view.shell.getBoundingClientRect();
      const closedBox = heightOf(view.box);
      view.row.click();
      if (surface === "independent") {
        await Zotero.Promise.delay(70);
        await capture(shotWindow, "tp-dropdown-mid-animation.png");
      }
      await settle(view, "open", `long list (${surface})`);
      assertAttached(view, surface);
      assertChatBelow(view, root, surface);
      assert.closeTo(
        heightOf(view.box),
        CHAT_STRIP,
        1,
        `a long list takes all but the chat strip (${surface})`,
      );
      assert.isAbove(
        view.body.scrollHeight,
        view.body.clientHeight + 100,
        "and scrolls inside",
      );
      assert.closeTo(view.box.scrollTop, scrollTop, 1, "scrollTop is kept");
      assert.closeTo(
        anchor.node.getBoundingClientRect().top -
          view.box.getBoundingClientRect().top,
        anchor.offset,
        1,
        "the reading anchor stays where it was",
      );
      assert.lengthOf(view.items(), 80, "one window of rows");
      await capture(shotWindow, `tp-dropdown-long-${surface}.png`);
      view.body.scrollTop = view.body.scrollHeight;
      await until(
        () => view.items().length === LONG_COUNT,
        () => `scrolling the drawer adds rows (${view.items().length})`,
      );
      view.body.scrollTop = 0;

      // Drag to about half of the chat area.
      const half = Math.round(shell.height / 2);
      await dragGrip(view, half - heightOf(view.drawer));
      assert.closeTo(heightOf(view.drawer), half, 1.5, "dragged to half");
      assert.closeTo(heightOf(view.box), closedBox - half, 1.5);
      assertChatBelow(view, root, surface);
      await capture(shotWindow, `tp-dropdown-dragged-${surface}.png`);
      await dragGrip(view, -5000);
      assert.closeTo(heightOf(view.drawer), DRAWER_MIN, 1, "down to its least");
      await dragGrip(view, 5000);
      assert.closeTo(heightOf(view.box), CHAT_STRIP, 1, "up to the chat strip");
      await dragGrip(view, half - heightOf(view.drawer));
      assert.closeTo(heightOf(view.drawer), half, 1.5);
      // The dragged height is kept when the drawer opens again.
      view.row.click();
      await settle(view, "closed", `long list (${surface})`);
      assert.closeTo(heightOf(view.box), closedBox, 1);
      view.row.click();
      await settle(view, "open", `long list again (${surface})`);
      assert.closeTo(heightOf(view.drawer), half, 1.5, "remembered");
      // Double-click: back to the content's height, up to the strip.
      view.grip.dispatchEvent(
        new (root.ownerDocument.defaultView as any).MouseEvent("dblclick", {
          bubbles: true,
          cancelable: true,
        }),
      );
      await Zotero.Promise.delay(60);
      assert.closeTo(heightOf(view.box), CHAT_STRIP, 1, "reset");
      view.row.click();
      await settle(view, "closed", `long list (${surface})`);
    } finally {
      handle.finish();
    }
  }

  before(async function () {
    assert.include(Zotero.DataDirectory.dir, ".scaffold/test/data");
    api = (Zotero as any).LLMForZotero.api.workflowTest;
    await api.reset();
    win = Zotero.getMainWindow();
    // A window tall enough that a four-paper list fits above the chat strip
    // in every sidebar layout; restored afterwards.
    if (win.outerHeight < 900) {
      savedWindowSize = { width: win.outerWidth, height: win.outerHeight };
      win.resizeTo(win.outerWidth, 900);
      const deadline = Date.now() + 5000;
      while (win.outerHeight < 900 && Date.now() < deadline)
        await Zotero.Promise.delay(50);
    }
    savedLayout = Zotero.Prefs.get(layoutPref, true);
    for (const [key, value] of agentPrefs) {
      savedAgentPrefs.set(key, Zotero.Prefs.get(key, true));
      Zotero.Prefs.set(key, value as never, true);
    }
    libraryID = Zotero.Libraries.userLibraryID;
    collection = new Zotero.Collection();
    collection.libraryID = libraryID;
    collection.name = `Drift ${Date.now()}`;
    await collection.saveTx();
    for (const [index, paper] of PAPERS.entries()) {
      const fixture = await api.createPaperWithPdfFixture({
        title: paper.title,
        pdfTitle: paper.title,
        pages: [SNIPPETS[index] || `${paper.title} evidence.`],
      });
      fixtures.push(fixture);
      const item = Zotero.Items.get(fixture.parentItemId);
      item.setCreators([
        { creatorType: "author", firstName: "Test", lastName: paper.author },
      ]);
      item.setField("date", "2021");
      item.setCollections([collection.id]);
      item.addTag(index % 2 ? "drift" : "place cells");
      await item.saveTx();
    }
    longCollection = new Zotero.Collection();
    longCollection.libraryID = libraryID;
    longCollection.name = `Drift long ${Date.now()}`;
    await longCollection.saveTx();
    await Zotero.DB.executeTransaction(async () => {
      for (let index = 0; index < LONG_COUNT; index++) {
        const item = new Zotero.Item("journalArticle");
        item.libraryID = libraryID;
        item.setField("title", `Drift study ${index + 1}`);
        item.setField("date", `${2000 + (index % 25)}`);
        item.setCollections([longCollection.id]);
        await item.save();
        longItems.push(item);
      }
    });
  });

  after(async function () {
    await api.reset();
    for (const fixture of fixtures) await api.cleanupFixture(fixture);
    await collection?.eraseTx().catch(() => undefined);
    if (longItems.length) {
      await Zotero.Items.erase(longItems.map((item) => item.id)).catch(
        () => undefined,
      );
    }
    await longCollection?.eraseTx().catch(() => undefined);
    for (const [key, value] of savedAgentPrefs) {
      if (value === undefined) Zotero.Prefs.clear(key, true);
      else Zotero.Prefs.set(key, value as never, true);
    }
    if (savedWindowSize) {
      win.resizeTo(savedWindowSize.width, savedWindowSize.height);
      await Zotero.Promise.delay(200);
    }
    if (savedLayout === undefined) Zotero.Prefs.clear(layoutPref, true);
    else Zotero.Prefs.set(layoutPref, savedLayout as string, true);
    Zotero.debug(`TASK_PROGRESS_SCREENSHOTS ${JSON.stringify(shots)}`, 1);
  });

  for (const layout of ["independent", "stacked"] as const) {
    it(`runs in the sidebar (${layout})`, async function () {
      await openSidebarChat(layout);
      const rootOf = () =>
        activeDetails().querySelector(
          ".llm-dedicated-chat-pane #llm-main",
        ) as HTMLElement;
      await assertPaperChatThreshold(rootOf, layout, win);
      await switchToLibrary(rootOf, layout);
      await exerciseLibraryRun(rootOf, layout, win);
      await exerciseLongList(rootOf, layout, win);
    });
  }

  it("runs in the standalone window", async function () {
    const { window } = await openStandaloneChat();
    const rootOf = () =>
      window.document.querySelector(
        ".llm-standalone-content #llm-main",
      ) as HTMLElement;
    await assertPaperChatThreshold(rootOf, "standalone", window);
    await switchToLibrary(rootOf, "standalone");
    await exerciseLibraryRun(rootOf, "standalone", window);
    await exerciseLongList(rootOf, "standalone", window);
    await api.closeStandalone();
  });
});
