/**
 * The sidebar header, identical in the independent and stacked layouts: a
 * centered Paper chat | Library chat toggle, then an actions row with new
 * chat, history, the runtime systems after a thin divider, and the panel
 * actions, closed off from the chat by the pane divider. Clicking a tab navigates the way the
 * history menu does: each mode returns to the conversation it last showed.
 */
import { assert } from "chai";
import { getReaderContextPanelForTab } from "../src/modules/contextPanel/readerPopupPanelRouting";
import type {
  WorkflowTestApi,
  WorkflowTestDiagnostics,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";

function getWorkflowTestApi(): WorkflowTestApi {
  const api = (Zotero as any).LLMForZotero?.api?.workflowTest;
  assert.isOk(api, "workflow test API should be installed");
  return api as WorkflowTestApi;
}

function getPanelRoot(panelId: string): HTMLElement {
  const doc = Zotero.getMainWindow().document;
  const root = doc.querySelector<HTMLElement>(
    `[data-workflow-panel-id="${panelId}"]`,
  );
  assert.isOk(root, "workflow panel root should be in the document");
  return root as HTMLElement;
}

function clickTab(root: HTMLElement, selector: string): void {
  const tab = root.querySelector<HTMLButtonElement>(selector);
  assert.isOk(tab, `${selector} should be rendered`);
  tab!.dispatchEvent(
    new (root.ownerDocument.defaultView as any).MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    }),
  );
}

async function waitForKind(
  api: WorkflowTestApi,
  panelId: string,
  kind: "global" | "paper",
): Promise<WorkflowTestDiagnostics> {
  const deadline = Date.now() + 15000;
  let diagnostics = await api.getDiagnostics(panelId);
  while (diagnostics.conversationKind !== kind && Date.now() < deadline) {
    await Zotero.Promise.delay(25);
    diagnostics = await api.getDiagnostics(panelId);
  }
  assert.equal(
    diagnostics.conversationKind,
    kind,
    JSON.stringify(diagnostics, null, 2),
  );
  return diagnostics;
}

function assertActiveTab(root: HTMLElement, tab: "paper" | "library"): void {
  const paperTab = root.querySelector("#llm-paper-chat-tab")!;
  const libraryTab = root.querySelector("#llm-library-chat-tab")!;
  const active = tab === "paper" ? paperTab : libraryTab;
  const inactive = tab === "paper" ? libraryTab : paperTab;
  assert.isTrue(active.classList.contains("active"), `${tab} tab is active`);
  assert.equal(active.getAttribute("aria-pressed"), "true");
  assert.isFalse(inactive.classList.contains("active"));
  assert.equal(inactive.getAttribute("aria-pressed"), "false");
}

describe("workflow: sidebar chat mode toggle", function () {
  this.timeout(45000);

  let api: WorkflowTestApi;
  let fixture: WorkflowTestFixture | null = null;

  beforeEach(async function () {
    api = getWorkflowTestApi();
    await api.reset();
  });

  afterEach(async function () {
    if (fixture) await api.cleanupFixture(fixture);
    fixture = null;
    await api.reset();
  });

  describe("in the native item pane", function () {
    const PREF_PREFIX = "extensions.zotero.llmforzotero";
    const layoutPref = `${PREF_PREFIX}.sidebarLayout`;
    const runtimePrefs = [
      `${PREF_PREFIX}.enableCodexAppServerMode`,
      `${PREF_PREFIX}.enableClaudeCodeMode`,
    ];
    const savedPrefs = new Map<string, unknown>();
    let win: any;

    before(function () {
      win = Zotero.getMainWindow();
      for (const key of [layoutPref, ...runtimePrefs]) {
        savedPrefs.set(key, Zotero.Prefs.get(key, true));
      }
      for (const key of runtimePrefs) Zotero.Prefs.set(key, true, true);
    });

    after(function () {
      for (const [key, value] of savedPrefs) {
        if (value === undefined) Zotero.Prefs.clear?.(key, true);
        else Zotero.Prefs.set(key, value as never, true);
      }
    });

    async function until(check: () => boolean, message: string) {
      const deadline = Date.now() + 10000;
      while (!check() && Date.now() < deadline) {
        await Zotero.Promise.delay(50);
      }
      assert.isTrue(check(), message);
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

    /** Select the fixture and open its chat in the given layout. */
    async function openChat(
      layout: "independent" | "stacked",
      itemId: number,
    ): Promise<HTMLElement> {
      Zotero.Prefs.set(layoutPref, layout, true);
      const view = layout === "independent" ? "chat" : "stacked";
      await win.ZoteroPane.selectItem(itemId);
      const details = activeDetails();
      assert.isOk(details, "native item details is visible");
      const section = () =>
        details.querySelector(".llm-dedicated-chat-pane") as HTMLElement;
      const mainVisible = () =>
        (section()?.querySelector("#llm-main")?.getBoundingClientRect()
          .height || 0) > 0;
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
        `${layout} chat is open and visible`,
      );
      if (layout === "stacked") {
        section().scrollIntoView?.();
      }
      const root = section().querySelector("#llm-main") as HTMLElement;
      await until(
        () =>
          root.dataset.conversationKind === "paper" &&
          root.dataset.basePaperItemId === String(itemId),
        "the chat shows the selected paper",
      );
      return section();
    }

    function assertToggleAndActionRows(section: HTMLElement): void {
      const view = win as Window;
      const toggleRow = section.querySelector<HTMLElement>(
        ".llm-header-toggle-row",
      );
      const navRow = section.querySelector<HTMLElement>(".llm-header-nav-row");
      assert.isOk(toggleRow, "the toggle row is rendered");
      assert.isOk(navRow, "the actions row is rendered");
      const toggleRect = toggleRow!.getBoundingClientRect();
      const navRect = navRow!.getBoundingClientRect();
      assert.isAbove(toggleRect.height, 0, "the toggle row is visible");
      assert.isAtMost(
        toggleRect.bottom,
        navRect.top + 0.5,
        "the toggle row sits above the actions row",
      );
      const toggleStyle = view.getComputedStyle(toggleRow!)!;
      assert.equal(
        toggleStyle.borderBottomStyle,
        "none",
        "the toggle row has no divider",
      );
      assert.equal(
        view.getComputedStyle(navRow!)!.borderBottomStyle,
        "none",
        "no divider under the actions row",
      );

      // The standalone window's wording.
      const paperTab = toggleRow!.querySelector<HTMLElement>(
        "#llm-paper-chat-tab",
      )!;
      const libraryTab = toggleRow!.querySelector<HTMLElement>(
        "#llm-library-chat-tab",
      )!;
      assert.equal(paperTab.textContent!.trim(), "Paper chat");
      assert.equal(libraryTab.textContent!.trim(), "Library chat");
      const tabsRect = toggleRow!
        .querySelector(".llm-header-mode-tabs")!
        .getBoundingClientRect();
      assert.closeTo(
        tabsRect.left + tabsRect.width / 2,
        toggleRect.left + toggleRect.width / 2,
        1,
        "the toggle is centered",
      );
      assert.closeTo(
        paperTab.getBoundingClientRect().width,
        libraryTab.getBoundingClientRect().width,
        12,
        "the two tabs are balanced",
      );
      for (const tab of [paperTab, libraryTab]) {
        assert.isAtLeast(tab.getBoundingClientRect().width, 63.5);
      }

      // New chat, history, divider, Codex, Claude; then the panel actions.
      const order = [
        "#llm-history-new",
        "#llm-history-toggle",
        ".llm-header-runtime-divider",
        "#llm-codex-system-toggle",
        "#llm-claude-system-toggle",
        "#llm-popout",
        "#llm-settings",
        "#llm-export",
        "#llm-clear",
      ].map((selector) => {
        const element = navRow!.querySelector<HTMLElement>(selector);
        assert.isOk(element, `${selector} sits in the actions row`);
        const rect = element!.getBoundingClientRect();
        assert.isAbove(rect.width, 0, `${selector} is visible`);
        return { selector, rect };
      });
      // Centers, not edges: the compact actions overlap their hit areas by
      // design (negative margins below the 380px container breakpoint).
      const center = (rect: DOMRect) => rect.left + rect.width / 2;
      for (let index = 1; index < order.length; index += 1) {
        assert.isAbove(
          center(order[index].rect),
          center(order[index - 1].rect),
          `${order[index].selector} follows ${order[index - 1].selector}`,
        );
      }
      assert.isAtLeast(
        order[2].rect.left,
        order[1].rect.right,
        "the divider clears the history button",
      );
      assert.isAtLeast(
        order[3].rect.left,
        order[2].rect.right,
        "the runtime systems clear the divider",
      );
      const divider = order[2].rect;
      assert.closeTo(divider.width, 1, 0.5, "the divider is a thin rule");
      assert.closeTo(divider.height, 16, 0.5);
      for (const { selector, rect } of order) {
        if (selector === ".llm-header-runtime-divider") continue;
        assert.closeTo(
          rect.top + rect.height / 2,
          order[0].rect.top + order[0].rect.height / 2,
          0.5,
          `${selector} shares the actions row's line`,
        );
      }
      assert.isNull(section.querySelector("#llm-mode-chip"));
      assert.isNull(section.querySelector(".llm-header-mode-row"));
      // No docked title row: the toggle opens the header.
      assert.isNull(section.querySelector(".llm-docked-title-row"));
      const panelTop = section
        .querySelector(".llm-panel")!
        .getBoundingClientRect().top;
      assert.isAtMost(
        toggleRect.top - panelTop,
        12,
        "the toggle row leads the header",
      );
    }

    it("opens the independent pane with the toggle and follows Paper chat | Library chat", async function () {
      fixture = await api.createPaperWithPdfFixture({
        title: "Sidebar Header Independent Paper",
        pdfTitle: "Sidebar Header Independent PDF",
      });
      const section = await openChat("independent", fixture.parentItemId);
      const root = section.querySelector("#llm-main") as HTMLElement;
      assertToggleAndActionRows(section);
      const navRow = section.querySelector(".llm-header-nav-row")!;
      assert.closeTo(
        navRow.getBoundingClientRect().width,
        root.getBoundingClientRect().width,
        0.5,
        "the header divider spans the whole panel",
      );

      clickTab(root, "#llm-library-chat-tab");
      await until(
        () => root.dataset.conversationKind === "global",
        "Library chat opens",
      );
      assertActiveTab(root, "library");
      assertToggleAndActionRows(section);

      clickTab(root, "#llm-paper-chat-tab");
      await until(
        () => root.dataset.conversationKind === "paper",
        "Paper chat returns",
      );
      assertActiveTab(root, "paper");
    });

    it("shows the same toggle and actions rows when stacked", async function () {
      fixture = await api.createPaperWithPdfFixture({
        title: "Sidebar Header Stacked Paper",
        pdfTitle: "Sidebar Header Stacked PDF",
      });
      const section = await openChat("stacked", fixture.parentItemId);
      assertToggleAndActionRows(section);
      Zotero.Prefs.set(layoutPref, "independent", true);
    });
  });

  it("switches Library chat and Paper chat through the header toggle", async function () {
    fixture = await api.createPaperWithPdfFixture({
      title: "Sidebar Mode Toggle Switch",
      pdfTitle: "Sidebar Mode Toggle Switch PDF",
    });
    const panel = await api.renderPanelForItem(fixture.parentItemId);
    const root = getPanelRoot(panel.panelId);
    const initial = await waitForKind(api, panel.panelId, "paper");
    assertActiveTab(root, "paper");

    // The active tab is a no-op.
    clickTab(root, "#llm-paper-chat-tab");
    await Zotero.Promise.delay(300);
    const unchanged = await api.getDiagnostics(panel.panelId);
    assert.equal(unchanged.conversationKind, "paper");
    assert.equal(unchanged.conversationKey, initial.conversationKey);

    clickTab(root, "#llm-library-chat-tab");
    const library = await waitForKind(api, panel.panelId, "global");
    assert.notEqual(library.conversationKey, initial.conversationKey);
    assertActiveTab(root, "library");

    clickTab(root, "#llm-paper-chat-tab");
    const paper = await waitForKind(api, panel.panelId, "paper");
    assert.equal(
      paper.conversationKey,
      initial.conversationKey,
      "Paper chat returns to the paper's remembered conversation",
    );
    assertActiveTab(root, "paper");

    clickTab(root, "#llm-library-chat-tab");
    const libraryAgain = await waitForKind(api, panel.panelId, "global");
    assert.equal(
      libraryAgain.conversationKey,
      library.conversationKey,
      "Library chat returns to the remembered library conversation",
    );
    assertActiveTab(root, "library");
  });
});
