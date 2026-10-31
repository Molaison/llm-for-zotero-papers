import { AssertionError, assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";
import { getReaderContextPanelForTab } from "../src/modules/contextPanel/readerPopupPanelRouting";

describe("workflow: dedicated native chat pane", function () {
  this.timeout(45000);
  let api: WorkflowTestApi;
  let win: any;
  let fixtures: Awaited<
    ReturnType<WorkflowTestApi["createPaperWithPdfFixture"]>
  >[];
  const readers: any[] = [];
  const layoutPref = "extensions.zotero.llmforzotero.sidebarLayout";
  // Gecko returns subpixel geometry; keep the precision already used by the
  // sidebar's outer-edge assertions without hiding a real 0.5px overflow.
  const GEOMETRY_PRECISION = 0.05;
  let originalLayout: unknown;

  type NativeCollapsibleSection = HTMLElement & {
    collapsible: boolean;
    open: boolean;
  };

  async function until(check: () => boolean, message: string) {
    const deadline = Date.now() + 10000;
    while (!check() && Date.now() < deadline) await Zotero.Promise.delay(50);
    assert.isTrue(
      check(),
      `${message}; selected=${win.Zotero_Tabs.selectedID}; view=${win.document.documentElement.getAttribute("data-llm-pane-view")}; collapsed=${activeDetails()?.sidenav?._collapsed}; panels=${JSON.stringify(Array.from(win.document.querySelectorAll("#llm-main")).map((node: any) => ({ ...node.dataset, height: node.getBoundingClientRect().height })))}`,
    );
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

  async function clickPane(pane: string) {
    const details = activeDetails();
    assert.isOk(details, "native item details is visible");
    const paneID =
      pane === "llm-context-panel"
        ? details.querySelector(".llm-dedicated-chat-pane")?.dataset.pane
        : pane;
    const button: any = Array.from(
      details.sidenav.querySelectorAll("[data-pane]"),
    ).find((node: any) => node.getAttribute("data-pane") === paneID);
    assert.isOk(button, `native ${pane} icon exists`);
    button.dispatchEvent(
      new win.MouseEvent("click", { bubbles: true, detail: 1, button: 0 }),
    );
    await Zotero.Promise.delay(300);
    await until(
      () => !details._disableScrollHandler,
      "native pane navigation settles",
    );
    return details;
  }

  async function openChatPane() {
    const details = activeDetails();
    assert.isOk(details, "native item details is visible");
    // An open independent chat closes on a second rail click. Setup must
    // preserve that state; clickPane remains a literal click for toggle tests.
    if (
      win.document.documentElement.getAttribute("data-llm-pane-view") !==
        "chat" ||
      details.sidenav._collapsed
    )
      await clickPane("llm-context-panel");
    await until(
      () =>
        !details.sidenav._collapsed &&
        details
          .querySelector(".llm-dedicated-chat-pane #llm-main")
          ?.getBoundingClientRect().height > 0,
      "chat is open and visible",
    );
    return details;
  }

  async function waitForSidebarLayout(layout: "independent" | "stacked") {
    await until(() => {
      return (
        win.document.documentElement.getAttribute("data-llm-sidebar-layout") ===
        layout
      );
    }, `${layout} layout applies`);
  }

  async function waitForNativeLayoutFrame() {
    await new Promise<void>((resolve) => {
      win.requestAnimationFrame(() => resolve());
    });
  }

  async function waitForMountedChat(
    layout: "independent" | "stacked",
  ): Promise<Element> {
    await waitForSidebarLayout(layout);
    const expectedView = layout === "stacked" ? "stacked" : "chat";
    await until(() => {
      const details = activeDetails();
      const panel = details?.querySelector(
        ".llm-dedicated-chat-pane #llm-main",
      ) as HTMLElement | null;
      const composer = panel?.querySelector(":scope > .llm-input-section");
      return Boolean(
        win.document.documentElement.getAttribute("data-llm-pane-view") ===
          expectedView &&
        details?.isConnected &&
        !details.sidenav._collapsed &&
        panel?.isConnected &&
        composer?.isConnected &&
        panel.getBoundingClientRect().height > 0 &&
        composer.getBoundingClientRect().width > 0,
      );
    }, `${layout} chat and composer are mounted`);
    await waitForNativeLayoutFrame();
    const details = activeDetails();
    assert.isOk(details, `${layout} sidebar host is mounted`);
    return details;
  }

  function elementGeometry(node: Element | null) {
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return {
      connected: node.isConnected,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    };
  }

  function stackedSectionDiagnostics(
    previous: NativeCollapsibleSection | null,
    current: NativeCollapsibleSection | null,
  ) {
    return {
      sameElement: previous === current,
      previous: elementGeometry(previous),
      current: elementGeometry(current),
      collapsible: current?.collapsible ?? null,
      open: current?.open ?? null,
      openHeight:
        current?.style.getPropertyValue("--open-height").trim() || null,
      children: current
        ? Array.from(current.children).map((child) => ({
            tag: child.tagName.toLowerCase(),
            id: child.id,
            className: child.getAttribute("class"),
            ...elementGeometry(child),
          }))
        : [],
    };
  }

  async function ensureStackedSectionOpen(details: Element) {
    const initial = details.querySelector(
      ".llm-dedicated-chat-pane > collapsible-section",
    ) as NativeCollapsibleSection | null;
    assert.isOk(initial, "stacked collapsible section is mounted");
    assert.isTrue(initial!.collapsible, "stacked section is collapsible");
    if (!initial!.open) {
      const head = initial!.querySelector(":scope > .head") as HTMLElement;
      assert.isOk(head, "stacked section head is visible");
      head.dispatchEvent(
        new win.MouseEvent("click", { bubbles: true, detail: 1, button: 0 }),
      );
    }
    let current = initial!;
    await until(() => {
      current = details.querySelector(
        ".llm-dedicated-chat-pane > collapsible-section",
      ) as NativeCollapsibleSection;
      const panel = current?.querySelector("#llm-main") as HTMLElement | null;
      return Boolean(
        current?.isConnected &&
        current.open &&
        current.style.getPropertyValue("--open-height").trim() === "auto" &&
        panel?.isConnected &&
        panel.getBoundingClientRect().height > 0,
      );
    }, "stacked section finishes its native open transition");
    await waitForNativeLayoutFrame();
    return { initial, current };
  }

  /**
   * Both layouts keep the header info and actions in one nav row. Independent
   * shows the toggle controls and hides the chip; Stacked does the reverse.
   * The responsive grid puts actions below info only when it marks the nav
   * wrapped; otherwise both cells remain side by side.
   */
  async function assertHeaderRows(
    details: Element,
    layout: "independent" | "stacked",
  ) {
    await waitForNativeLayoutFrame();
    const section = details.querySelector(".llm-dedicated-chat-pane")!;
    assert.isNull(
      section.querySelector(".llm-docked-title-row"),
      `no docked title row (${layout})`,
    );
    const toggleRow = section.querySelector(".llm-header-toggle-row")!;
    const navRow = section.querySelector(".llm-header-nav-row")!;
    const chip = section.querySelector("#llm-mode-capsule")!;
    const headerInfo = navRow.querySelector(
      ":scope > .llm-header-info",
    ) as HTMLElement;
    const headerActions = navRow.querySelector(
      ":scope > .llm-header-actions",
    ) as HTMLElement;
    assert.isOk(headerInfo, "header info is in the nav row");
    assert.isOk(headerActions, "header actions are in the nav row");
    assert.isTrue(navRow.contains(toggleRow), "toggle row is in the nav row");
    assert.isTrue(navRow.contains(chip), "mode chip is in the nav row");
    if (layout === "independent") {
      assert.isAbove(toggleRow.getBoundingClientRect().height, 0);
      assert.equal(
        chip.getBoundingClientRect().width,
        0,
        `no mode chip (${layout})`,
      );
    } else {
      assert.equal(
        toggleRow.getBoundingClientRect().height,
        0,
        `no toggle row (${layout})`,
      );
      assert.isAbove(
        chip.getBoundingClientRect().width,
        0,
        `the mode chip shows (${layout})`,
      );
      assert.isTrue(navRow.contains(chip), `the chip is in the one row`);
    }

    const navRect = navRow.getBoundingClientRect();
    const infoRect = headerInfo.getBoundingClientRect();
    const actionsRect = headerActions.getBoundingClientRect();
    const modeControl =
      layout === "independent" ? toggleRow : (chip as HTMLElement);
    const modeRect = modeControl.getBoundingClientRect();
    for (const [name, rect] of [
      ["mode controls", modeRect],
      ["header info", infoRect],
      ["header actions", actionsRect],
    ] as const) {
      assert.isAtLeast(
        rect.left,
        navRect.left - GEOMETRY_PRECISION,
        `${name} stay in nav row`,
      );
      assert.isAtMost(
        rect.right,
        navRect.right + GEOMETRY_PRECISION,
        `${name} stay in nav row`,
      );
      assert.isAtLeast(
        rect.top,
        navRect.top - GEOMETRY_PRECISION,
        `${name} stay in nav row`,
      );
      assert.isAtMost(
        rect.bottom,
        navRect.bottom + GEOMETRY_PRECISION,
        `${name} stay in nav row`,
      );
    }
    if (navRow.classList.contains("llm-header-nav-wrapped")) {
      assert.isAtLeast(
        actionsRect.top,
        infoRect.bottom - GEOMETRY_PRECISION,
        `wrapped ${layout} actions follow the info row`,
      );
    } else {
      assert.isAtMost(
        infoRect.right,
        actionsRect.left + GEOMETRY_PRECISION,
        `unwrapped ${layout} info and actions do not overlap`,
      );
    }

    const navStyle = win.getComputedStyle(navRow);
    assert.equal(
      navStyle.borderBottomStyle,
      "solid",
      `the nav row closes with the design divider (${layout})`,
    );
    const dividerWidth = parseFloat(navStyle.borderBottomWidth);
    assert.isTrue(Number.isFinite(dividerWidth) && dividerWidth > 0);
    assert.notEqual(navStyle.borderBottomColor, "transparent");
    assert.notEqual(navStyle.borderBottomColor, "rgba(0, 0, 0, 0)");

    const panel = section.querySelector(".llm-panel") as HTMLElement;
    const header = section.querySelector(".llm-header") as HTMLElement;
    const headerPaddingTop = parseFloat(
      win.getComputedStyle(header).paddingTop,
    );
    assert.equal(headerPaddingTop, 0, "header has no invented top padding");
    assert.closeTo(
      navRect.top - panel.getBoundingClientRect().top,
      headerPaddingTop,
      GEOMETRY_PRECISION,
      `the nav row is the first header content (${layout})`,
    );
  }

  /**
   * Pick a mode with the control the layout shows: the tab (Independent) or
   * the chip (Stacked), which toggles on a click without hover.
   */
  function pickMode(panel: Element, mode: "paper" | "library") {
    const layout = win.document.documentElement.getAttribute(
      "data-llm-sidebar-layout",
    );
    if (layout === "stacked") {
      const chip = panel.querySelector("#llm-mode-capsule") as HTMLElement;
      assert.isAbove(chip.getBoundingClientRect().width, 0, "chip shows");
      if (chip.dataset.mode === mode) return;
      const shown = panel.querySelector(
        `#llm-mode-option-${chip.dataset.mode}`,
      ) as HTMLElement;
      shown.dispatchEvent(
        new win.MouseEvent("click", { bubbles: true, cancelable: true }),
      );
      return;
    }
    (
      panel.querySelector(
        mode === "paper" ? "#llm-paper-chat-tab" : "#llm-library-chat-tab",
      ) as HTMLElement
    ).click();
  }

  function assertComposerGeometry(
    details: Element,
    layout: "independent" | "stacked",
  ) {
    assert.equal(
      win.document.documentElement.getAttribute("data-llm-sidebar-layout"),
      layout,
      `measure the ${layout} layout`,
    );
    const panel = details.querySelector(".llm-dedicated-chat-pane .llm-panel")!;
    const panelRect = panel.getBoundingClientRect();
    const composer = panel.querySelector(
      ":scope > .llm-input-section",
    ) as HTMLElement;
    const composerRect = composer.getBoundingClientRect();
    assert.isAbove(composerRect.width, 0, "composer is visible");
    assert.closeTo(
      composerRect.left - panelRect.left,
      0,
      GEOMETRY_PRECISION,
      "composer left edge is flush with the panel",
    );
    assert.closeTo(
      panelRect.right - composerRect.right,
      0,
      GEOMETRY_PRECISION,
      "composer right edge is flush with the panel",
    );
    const style = win.getComputedStyle(composer);
    const expectedInlinePadding = panelRect.width <= 500 ? 10 : 14;
    assert.equal(style.paddingTop, "0px", "composer has no top padding");
    assert.equal(
      style.paddingBottom,
      "14px",
      "composer keeps its bottom breathing room",
    );
    assert.equal(
      style.paddingLeft,
      `${expectedInlinePadding}px`,
      "composer left padding follows the active container width",
    );
    assert.equal(
      style.paddingRight,
      `${expectedInlinePadding}px`,
      "composer right padding follows the active container width",
    );
    const contentLeft = composerRect.left + parseFloat(style.paddingLeft);
    const contentRight = composerRect.right - parseFloat(style.paddingRight);
    const contentTop = composerRect.top + parseFloat(style.paddingTop);
    const contentBottom = composerRect.bottom - parseFloat(style.paddingBottom);
    for (const [name, node] of [
      ["compose area", composer.querySelector(":scope > .llm-compose-area")],
      ["input", composer.querySelector("#llm-input")],
      ["Send", composer.querySelector("#llm-send")],
    ] as const) {
      const rect = node!.getBoundingClientRect();
      assert.isAbove(rect.width, 0, `${name} is visible`);
      assert.isAbove(rect.height, 0, `${name} has height`);
      assert.isAtLeast(
        rect.left,
        contentLeft - GEOMETRY_PRECISION,
        `${name} starts inside padding`,
      );
      assert.isAtMost(
        rect.right,
        contentRight + GEOMETRY_PRECISION,
        `${name} ends inside padding`,
      );
      assert.isAtLeast(
        rect.top,
        contentTop - GEOMETRY_PRECISION,
        `${name} starts below top padding`,
      );
      assert.isAtMost(
        rect.bottom,
        contentBottom + GEOMETRY_PRECISION,
        `${name} ends above bottom padding`,
      );
    }
  }

  async function assertQuickQuestions(details: Element) {
    const panel = details.querySelector(".llm-dedicated-chat-pane .llm-panel")!;
    const tools = panel.querySelector(
      ".llm-conversation-tools",
    ) as HTMLDetailsElement;
    const more = tools.querySelector(":scope > summary") as HTMLElement;
    const toolsBody = tools.querySelector(
      ".llm-conversation-tools-body",
    ) as HTMLElement;
    const disclosure = tools.querySelector(
      "#llm-shortcuts-disclosure",
    ) as HTMLDetailsElement;
    const quickQuestions = disclosure.querySelector(
      ":scope > summary",
    ) as HTMLElement;
    const shortcuts = disclosure.querySelector("#llm-shortcuts") as HTMLElement;
    const original = { tools: tools.open, disclosure: disclosure.open };
    try {
      assert.isFalse(tools.open, "More starts closed");
      assert.isFalse(disclosure.open, "Quick questions starts closed");
      assert.isAbove(more.getBoundingClientRect().width, 0, "More is visible");
      assert.isAbove(more.getBoundingClientRect().height, 0, "More has height");

      more.click();
      await until(
        () =>
          tools.open &&
          toolsBody.getBoundingClientRect().width > 0 &&
          toolsBody.getBoundingClientRect().height > 0,
        "More opens",
      );
      quickQuestions.click();
      await until(() => {
        const buttons = Array.from(
          shortcuts.querySelectorAll(":scope > .llm-shortcut-btn"),
        ) as HTMLElement[];
        return (
          disclosure.open &&
          shortcuts.isConnected &&
          buttons.length > 0 &&
          buttons.every((button) => {
            const rect = button.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          })
        );
      }, "Quick questions opens with visible prompt buttons");

      const buttons = Array.from(
        shortcuts.querySelectorAll(":scope > .llm-shortcut-btn"),
      ) as HTMLElement[];
      const toolsRect = toolsBody.getBoundingClientRect();
      const disclosureRect = disclosure.getBoundingClientRect();
      const shortcutsRect = shortcuts.getBoundingClientRect();
      assert.isAtMost(
        toolsBody.scrollWidth,
        toolsBody.clientWidth,
        "More does not overflow horizontally",
      );
      assert.isAtMost(
        disclosure.scrollWidth,
        disclosure.clientWidth,
        "Quick questions does not overflow its disclosure",
      );
      assert.isAtMost(
        shortcuts.scrollWidth,
        shortcuts.clientWidth,
        "prompt rows do not overflow horizontally",
      );
      for (const [index, button] of buttons.entries()) {
        const rect = button.getBoundingClientRect();
        assert.isAtLeast(
          rect.left,
          disclosureRect.left - GEOMETRY_PRECISION,
          `prompt ${index} starts inside Quick questions`,
        );
        assert.isAtMost(
          rect.right,
          disclosureRect.right + GEOMETRY_PRECISION,
          `prompt ${index} ends inside Quick questions`,
        );
        assert.isAtLeast(
          rect.left,
          shortcutsRect.left - GEOMETRY_PRECISION,
          `prompt ${index} starts inside the prompt row`,
        );
        assert.isAtMost(
          rect.right,
          shortcutsRect.right + GEOMETRY_PRECISION,
          `prompt ${index} ends inside the prompt row`,
        );
        assert.isAtLeast(
          rect.left,
          toolsRect.left - GEOMETRY_PRECISION,
          `prompt ${index} stays inside More`,
        );
        assert.isAtMost(
          rect.right,
          toolsRect.right + GEOMETRY_PRECISION,
          `prompt ${index} stays inside More`,
        );
      }
    } finally {
      tools.open = original.tools;
      disclosure.open = original.disclosure;
    }
  }

  async function assertAdvancedMoreActions(details: Element) {
    const panel = details.querySelector(".llm-dedicated-chat-pane .llm-panel")!;
    const tools = panel.querySelector(
      ".llm-conversation-tools",
    ) as HTMLDetailsElement;
    const more = tools.querySelector(":scope > summary") as HTMLElement;
    const toolsBody = tools.querySelector(
      ".llm-conversation-tools-body",
    ) as HTMLElement;
    const original = tools.open;
    try {
      assert.isFalse(tools.open, "More starts closed before advanced actions");
      more.click();
      await until(() => {
        const actions = [
          "llm-popout",
          "llm-settings",
          "llm-export",
          "llm-clear",
        ]
          .map((id) => tools.querySelector<HTMLElement>(`#${id}`))
          .filter((node): node is HTMLElement => Boolean(node));
        return Boolean(
          tools.open &&
          toolsBody.getBoundingClientRect().width > 0 &&
          actions.length === 4 &&
          actions.every((action) => {
            const rect = action.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          }),
        );
      }, "More exposes its advanced actions");
      assert.isAtMost(
        toolsBody.scrollWidth,
        toolsBody.clientWidth,
        "More advanced actions do not overflow horizontally",
      );
      const bounds = toolsBody.getBoundingClientRect();
      for (const id of [
        "llm-popout",
        "llm-settings",
        "llm-export",
        "llm-clear",
      ]) {
        const action = tools.querySelector(`#${id}`)!;
        const rect = action.getBoundingClientRect();
        assert.isAtLeast(
          rect.left,
          bounds.left - GEOMETRY_PRECISION,
          `${id} stays inside More`,
        );
        assert.isAtMost(
          rect.right,
          bounds.right + GEOMETRY_PRECISION,
          `${id} stays inside More`,
        );
        assert.isAtLeast(
          rect.top,
          bounds.top - GEOMETRY_PRECISION,
          `${id} stays inside More`,
        );
        assert.isAtMost(
          rect.bottom,
          bounds.bottom + GEOMETRY_PRECISION,
          `${id} stays inside More`,
        );
      }
    } finally {
      tools.open = original;
    }
  }

  async function captureWindow(target: any, filename: string) {
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
    await win.IOUtils.write(
      `${Zotero.DataDirectory.dir}/${filename}`,
      Uint8Array.from(binary, (char: any) => char.charCodeAt(0)),
    );
  }

  before(async function () {
    // Native runner always launches an isolated .scaffold/test profile/data.
    assert.include(Zotero.DataDirectory.dir, ".scaffold/test/data");
    api = (Zotero as any).LLMForZotero.api.workflowTest;
    await api.reset();
    originalLayout = Zotero.Prefs.get(layoutPref, true);
    Zotero.Prefs.set(layoutPref, "independent", true);
    win = Zotero.getMainWindow();
    fixtures = [];
    for (const title of ["Dedicated pane A", "Dedicated pane B"])
      fixtures.push(
        await api.createPaperWithPdfFixture({ title, pdfTitle: title }),
      );
    await win.ZoteroPane.selectItem(fixtures[0].parentItemId);
  });

  after(async function () {
    for (const reader of readers) reader.close();
    for (const fixture of fixtures || []) await api.cleanupFixture(fixture);
    await api.reset();
    if (originalLayout === undefined) Zotero.Prefs.clear(layoutPref, true);
    else Zotero.Prefs.set(layoutPref, originalLayout as string, true);
  });

  function libraryIcon() {
    const details = win.document.getElementById("zotero-item-details");
    const paneID = details.querySelector(".llm-dedicated-chat-pane")?.dataset
      .pane;
    return Array.from(details.sidenav.querySelectorAll("[data-pane]")).find(
      (node: any) => node.getAttribute("data-pane") === paneID,
    ) as any;
  }

  it("keeps More > Quick questions controls and composer geometry across sidebar layouts", async function () {
    Zotero.Prefs.set(layoutPref, "independent", true);
    await waitForSidebarLayout("independent");
    await openChatPane();
    let details = await waitForMountedChat("independent");
    await assertQuickQuestions(details);
    await assertHeaderRows(details, "independent");
    assertComposerGeometry(details, "independent");
    Zotero.Prefs.set(layoutPref, "stacked", true);
    details = await waitForMountedChat("stacked");
    await until(
      () =>
        ((
          details.querySelector(
            ".llm-dedicated-chat-pane #llm-mode-capsule",
          ) as HTMLElement | null
        )?.getBoundingClientRect().width ?? 0) > 0,
      "stacked chat header is laid out",
    );
    await assertHeaderRows(details, "stacked");
    assertComposerGeometry(details, "stacked");
    Zotero.Prefs.set(layoutPref, "independent", true);
    await waitForSidebarLayout("independent");
    await openChatPane();
    details = await waitForMountedChat("independent");
    await assertHeaderRows(details, "independent");
    assertComposerGeometry(details, "independent");
  });

  it("greys out the library rail with no selection and blocks activation", async function () {
    win.ZoteroPane.itemsView.selection.clearSelection();
    await until(
      () => Boolean(libraryIcon()?.hasAttribute("disabled")),
      "empty rail is disabled",
    );
    const icon = libraryIcon();
    assert.isAbove(
      icon.getBoundingClientRect().height,
      0,
      "disabled icon stays visible",
    );
    const nativeIcon = win.document.querySelector(
      '#zotero-view-item-sidenav [data-pane="info"]',
    );
    assert.equal(
      win.getComputedStyle(icon).opacity,
      win.getComputedStyle(nativeIcon).opacity,
      "disabled appearance matches native tabs",
    );
    icon.dispatchEvent(
      new win.MouseEvent("click", { bubbles: true, button: 0 }),
    );
    assert.notEqual(
      win.document.documentElement.getAttribute("data-llm-pane-view"),
      "chat",
    );
    await captureWindow(win, "empty-library-sidebar.png");
    await win.ZoteroPane.selectItem(fixtures[0].parentItemId);
    await until(
      () => !libraryIcon().hasAttribute("disabled"),
      "selection enables rail",
    );
  });

  for (const layout of ["independent", "stacked"] as const) {
    it(`drops multiple papers into a fresh sidebar Library chat in ${layout} layout`, async function () {
      let previousKey: string | undefined;
      try {
        Zotero.Prefs.set(layoutPref, layout, true);
        await until(
          () =>
            win.document.documentElement.getAttribute(
              "data-llm-sidebar-layout",
            ) === layout,
          "requested layout applies",
        );
        await win.ZoteroPane.selectItem(fixtures[0].parentItemId);
        await openChatPane();
        const details = win.document.getElementById(
          "zotero-item-details",
        ) as HTMLElement;
        const section = details.querySelector(
          ".llm-dedicated-chat-pane",
        ) as HTMLElement;
        const panel = () =>
          section.querySelector("#llm-main") as HTMLElement | null;
        const requirePanel = (): HTMLElement => {
          const current = panel();
          assert.isOk(current, "the dedicated chat panel remains mounted");
          return current!;
        };
        const fixtureParentItemId = fixtures[0].parentItemId;
        const fixturePdfAttachmentId = fixtures[0].pdfAttachmentId;
        const initialPanel = panel();
        if (initialPanel?.dataset.conversationKind === "global")
          pickMode(initialPanel, "paper");
        await until(() => {
          const current = panel();
          if (!current) return false;
          const basePaperItemId = Number(current.dataset.basePaperItemId || 0);
          const rawContextItemId = Number(
            current.dataset.rawContextItemId || 0,
          );
          const handlersInitialized = Number(
            current.dataset.handlersInitialized || 0,
          );
          return (
            current.dataset.conversationKind === "paper" &&
            basePaperItemId === fixtureParentItemId &&
            [fixtureParentItemId, fixturePdfAttachmentId].includes(
              rawContextItemId,
            ) &&
            handlersInitialized > 0 &&
            current.dataset.handlersInitialized ===
              current.dataset.handlersAttached
          );
        }, `fresh paper panel for fixture ${fixtureParentItemId}/${fixturePdfAttachmentId}`);
        previousKey = requirePanel().dataset.itemId;
        const input =
          requirePanel().querySelector<HTMLTextAreaElement>("#llm-input")!;
        input.value = "Preserve the previous draft";
        input.dispatchEvent(new win.Event("input", { bubbles: true }));
        await win.ZoteroPane.selectItems(fixtures.map((f) => f.parentItemId));
        await until(
          () => !libraryIcon().hasAttribute("disabled"),
          "multiple selection enables rail",
        );
        await openChatPane();
        const transfer = new win.DataTransfer();
        transfer.setData(
          "zotero/item",
          fixtures.map((f) => f.parentItemId).join(","),
        );
        // Cover both the body shown in the request and the existing composer target.
        const dropInput =
          requirePanel().querySelector<HTMLTextAreaElement>("#llm-input")!;
        if (dropInput.disabled) {
          assert.equal(
            win.getComputedStyle(dropInput).pointerEvents,
            "none",
            "disabled textarea lets native drops reach the composer surface",
          );
        }
        const inputRect = dropInput.getBoundingClientRect();
        const dropTarget =
          layout === "independent"
            ? section
            : win.document.elementFromPoint(
                inputRect.left + inputRect.width / 2,
                inputRect.top + inputRect.height / 2,
              );
        for (const type of ["dragenter", "dragover"]) {
          dropTarget.dispatchEvent(
            new win.DragEvent(type, {
              bubbles: true,
              cancelable: true,
              dataTransfer: transfer,
            }),
          );
        }
        assert.isOk(requirePanel().querySelector(".llm-input-drop-active"));
        dropTarget.dispatchEvent(
          new win.DragEvent("drop", {
            bubbles: true,
            cancelable: true,
            dataTransfer: transfer,
          }),
        );
        await until(() => {
          const current = panel();
          return Boolean(
            current &&
            current.dataset.conversationKind === "global" &&
            current.querySelectorAll("[data-paper-context-item-id]").length ===
              2,
          );
        }, "drop prepares a library chat and renders both context chips");
        // The header shows the moment the library chat lands, before any
        // history refresh: the mode control and the history bar never diverge.
        for (const selector of [
          ...(layout === "independent"
            ? [".llm-header-toggle-row", "#llm-library-chat-tab"]
            : ["#llm-mode-capsule", "#llm-mode-option-library"]),
          "#llm-history-bar",
          "#llm-history-new",
        ]) {
          const rect = requirePanel()
            .querySelector(selector)!
            .getBoundingClientRect();
          assert.isAbove(rect.height, 0, `${selector} is visible (${layout})`);
        }
        assert.isTrue(
          requirePanel()
            .querySelector("#llm-library-chat-tab")!
            .classList.contains("active"),
          "Library chat is the active tab",
        );
        assert.equal(
          requirePanel()
            .querySelector("#llm-mode-option-library")!
            .getAttribute("aria-pressed"),
          "true",
          "the chip shows Library chat",
        );
        await assertHeaderRows(details, layout);
        await until(
          () => Boolean(panel()?.querySelector(".llm-standalone-start-page")),
          "the fresh Library chat shows the Library start page",
        );
        assert.isNull(
          requirePanel().querySelector(".llm-start-page"),
          `no Paper chat start page in a Library chat (${layout})`,
        );
        const key = requirePanel().dataset.itemId;
        assert.isNull(
          requirePanel().querySelector(".llm-input-drop-active"),
          "drop feedback clears",
        );
        const persisted = await api.getWorkflowConversationPersistenceSnapshot(
          "upstream",
          Number(key),
        );
        assert.equal(
          persisted.catalogRows,
          1,
          "new chat has a native catalog row",
        );
        assert.equal(persisted.messageRows, 0, "drop does not send a question");
        assert.notEqual(key, previousKey, "drop creates its own conversation");
        assert.sameMembers(
          Array.from(
            requirePanel().querySelectorAll("[data-paper-context-item-id]"),
          ).map((chip: any) => Number(chip.dataset.paperContextItemId)),
          fixtures.map((f) => f.pdfAttachmentId),
        );
        assert.equal(
          requirePanel().querySelector<HTMLTextAreaElement>("#llm-input")!
            .value,
          "",
        );
        assert.isFalse(
          requirePanel().querySelector<HTMLTextAreaElement>("#llm-input")!
            .disabled,
        );
        assert.strictEqual(
          win.document.activeElement,
          requirePanel().querySelector<HTMLTextAreaElement>("#llm-input"),
        );
        await captureWindow(win, `multi-paper-sidebar-${layout}.png`);
        win.ZoteroPane.itemsView.selection.clearSelection();
        await until(
          () => Boolean(libraryIcon()?.hasAttribute("disabled")),
          "clearing selection disables rail",
        );
        await win.ZoteroPane.selectItem(fixtures[1].parentItemId);
        await openChatPane();
        await until(
          () => panel()?.dataset.itemId === key,
          "prepared library chat survives selection changes",
        );
        assert.lengthOf(
          requirePanel().querySelectorAll("[data-paper-context-item-id]"),
          2,
        );
        pickMode(requirePanel(), "paper");
        await until(
          () => panel()?.dataset.conversationKind === "paper",
          "paper mode remains available",
        );
        await win.ZoteroPane.selectItem(fixtures[0].parentItemId);
        await until(
          () => panel()?.dataset.itemId === previousKey,
          `return to the original paper chat; previousKey=${previousKey}; fixtures=${fixtures[0].parentItemId}/${fixtures[0].pdfAttachmentId}`,
        );
        assert.equal(
          requirePanel().querySelector<HTMLTextAreaElement>("#llm-input")!
            .value,
          "Preserve the previous draft",
        );
        Zotero.Prefs.set(layoutPref, "independent", true);
        await until(
          () =>
            win.document.documentElement.getAttribute(
              "data-llm-sidebar-layout",
            ) === "independent",
          "independent layout is restored",
        );
      } catch (error) {
        const mountedNodes = win.document.querySelectorAll(
          "#llm-main",
        ) as NodeListOf<HTMLElement>;
        const mountedPanels = (Array.from(mountedNodes) as HTMLElement[]).map(
          (node) => ({
            ...node.dataset,
            height: node.getBoundingClientRect().height,
          }),
        );
        const original =
          error instanceof Error
            ? `${error.name}: ${error.message}\n${error.stack || ""}`
            : String(error);
        throw new AssertionError(
          `${original}; layout=${layout}; previousKey=${previousKey ?? "<unset>"}; fixtures=${fixtures[0].parentItemId}/${fixtures[0].pdfAttachmentId}; selected=${win.Zotero_Tabs.selectedID}; view=${win.document.documentElement.getAttribute("data-llm-pane-view")}; collapsed=${activeDetails()?.sidenav?._collapsed}; mounted=${JSON.stringify(mountedPanels)}`,
          {
            cause: error,
            previousKey,
            layout,
            fixtureParentItemId: fixtures[0].parentItemId,
            fixturePdfAttachmentId: fixtures[0].pdfAttachmentId,
            mountedPanels,
          },
        );
      }
    });
  }

  it("toggles chat closed and open through its rail icon without losing the draft", async function () {
    const details = await openChatPane();
    const section = details.querySelector(".llm-dedicated-chat-pane");
    const root = section.querySelector("#llm-main");
    const conversationKey = root.dataset.itemId;
    const input = section.querySelector("#llm-input") as HTMLTextAreaElement;
    const previousDraft = input.value;
    const draft = "Keep this draft when toggling the chat rail";
    input.value = draft;
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    try {
      await clickPane("llm-context-panel");
      assert.isTrue(
        details.sidenav._collapsed,
        "clicking the active chat icon closes the native pane",
      );
      assert.equal(
        win.document.documentElement.getAttribute("data-llm-pane-view"),
        "details",
      );
      assert.strictEqual(section.querySelector("#llm-main"), root);
      assert.equal(input.value, draft, "closing retains the draft");

      await clickPane("llm-context-panel");
      await until(
        () =>
          !details.sidenav._collapsed &&
          section.querySelector("#llm-main")?.getBoundingClientRect().height >
            0,
        "the next rail click reopens chat",
      );
      assert.equal(
        win.document.documentElement.getAttribute("data-llm-pane-view"),
        "chat",
      );
      assert.equal(
        section.querySelector("#llm-main").dataset.itemId,
        conversationKey,
        "reopening preserves the conversation",
      );
      assert.equal(
        section.querySelector("#llm-input").value,
        draft,
        "reopening preserves the draft",
      );
    } finally {
      const currentInput = section.querySelector("#llm-input");
      currentInput.value = previousDraft;
      currentInput.dispatchEvent(new win.Event("input", { bubbles: true }));
    }
  });

  it("uses the whole native pane and restores details through their icon", async function () {
    const details = await openChatPane();
    const section = details.querySelector(
      "item-pane-custom-section.llm-dedicated-chat-pane",
    );
    await until(
      () => Boolean(section.querySelector("#llm-main")),
      "chat rendered",
    );
    assert.equal(
      win.document.documentElement.getAttribute("data-llm-pane-view"),
      "chat",
    );
    const header = details.querySelector("item-pane-header");
    assert.equal(
      header.getBoundingClientRect().height,
      0,
      "item header is outside chat view",
    );
    for (const other of details.getPanes()) {
      if (other !== section)
        assert.equal(
          other.getBoundingClientRect().height,
          0,
          "other sections are outside chat view",
        );
    }
    const viewport = details
      .querySelector(".zotero-view-item")
      .getBoundingClientRect();
    const chat = section.getBoundingClientRect();
    assert.isAbove(chat.height, 200);
    assert.closeTo(chat.top, viewport.top, 2);
    assert.closeTo(
      chat.height,
      viewport.height,
      2,
      "chat occupies the pane height",
    );
    const input = section.querySelector("#llm-input") as HTMLTextAreaElement;
    assert.isOk(input);
    input.value = "Unsent draft remains in this conversation";
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    assert.isAtMost(
      input.getBoundingClientRect().bottom,
      viewport.bottom + 2,
      "composer stays in the pane",
    );
    const root = section.querySelector("#llm-main");
    await assertHeaderRows(details, "independent");
    const navRow = section.querySelector(".llm-header-nav-row");
    const panel = section.querySelector(".llm-panel") as HTMLElement;
    const headerRoot = section.querySelector(".llm-header") as HTMLElement;
    const panelStyle = win.getComputedStyle(panel);
    const headerStyle = win.getComputedStyle(headerRoot);
    assert.equal(panelStyle.paddingLeft, "0px");
    assert.equal(panelStyle.paddingRight, "0px");
    assert.equal(headerStyle.paddingLeft, "0px");
    assert.equal(headerStyle.paddingRight, "0px");
    assert.closeTo(
      navRow.getBoundingClientRect().width,
      panel.getBoundingClientRect().width,
      0.5,
      "the header divider spans the whole panel",
    );
    assert.isNull(
      section.querySelector("[data-chat-mode]"),
      "segmented toggle is removed",
    );
    assert.isNull(
      section.querySelector(".llm-docked-more"),
      "overflow toolbar is removed",
    );
    for (const id of [
      "llm-history-new",
      "llm-history-toggle",
      "llm-paper-chat-tab",
      "llm-library-chat-tab",
    ]) {
      const action = section.querySelector(`#${id}`)!;
      assert.isAbove(
        action.getBoundingClientRect().width,
        0,
        `${id} is visible in the pinned header`,
      );
    }
    await assertAdvancedMoreActions(details);
    // With no docked close button, the plugin's rail icon closes the chat.
    const icon: any = Array.from(
      details.sidenav.querySelectorAll("[data-pane]"),
    ).find(
      (node: any) => node.getAttribute("data-pane") === section.dataset.pane,
    );
    icon.dispatchEvent(
      new win.MouseEvent("click", { bubbles: true, detail: 1, button: 0 }),
    );
    await Zotero.Promise.delay(100);
    assert.isTrue(
      details.sidenav._collapsed,
      "the rail icon collapses the native sidebar",
    );
    icon.dispatchEvent(
      new win.MouseEvent("click", { bubbles: true, detail: 1, button: 0 }),
    );
    await Zotero.Promise.delay(300);
    assert.isFalse(
      details.sidenav._collapsed,
      "plugin icon reopens the sidebar",
    );
    assert.equal(
      section.querySelector("#llm-input").value,
      "Unsent draft remains in this conversation",
      "closing preserves the draft",
    );
    await clickPane("info");
    assert.equal(section.getBoundingClientRect().height, 0);
    assert.isAbove(header.getBoundingClientRect().height, 0);
    await clickPane("llm-context-panel");
    assert.strictEqual(
      section.querySelector("#llm-main"),
      root,
      "navigation preserves the mounted conversation",
    );
    assert.equal(
      (section.querySelector("#llm-input") as HTMLTextAreaElement).value,
      "Unsent draft remains in this conversation",
    );

    // Keep a native rendering artifact beside the disposable test database.
    const canvas = win.document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "canvas",
    );
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    canvas
      .getContext("2d")
      .drawWindow(
        win,
        viewport.left,
        viewport.top,
        canvas.width,
        canvas.height,
        "#ffffff",
      );
    const binary = win.atob(canvas.toDataURL("image/png").split(",")[1]);
    await (win.IOUtils as any).write(
      `${Zotero.DataDirectory.dir}/dedicated-chat-pane.png`,
      Uint8Array.from(binary, (char: any) => char.charCodeAt(0)),
    );
  });

  it("switches sidebar layout from Customization without replacing the chat", async function () {
    let preferences: any;
    const prefKey = "extensions.zotero.llmforzotero.sidebarLayout";
    const original = Zotero.Prefs.get(prefKey, true);
    const details = await openChatPane();
    const section = details.querySelector(".llm-dedicated-chat-pane");
    const root = section.querySelector("#llm-main");
    const input = section.querySelector("#llm-input");
    const previousDraft = input.value;
    // Type the draft the way a user does. The composer stores the draft on
    // every input event, and the panel reloads the stored draft whenever the
    // pointer enters it. Setting .value alone leaves the store holding the
    // previous test's draft, which then replaces this one as soon as the
    // cursor rests over the pane.
    input.value = "Keep this draft across layout changes";
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    const openPreferences = async () => {
      preferences = (Zotero.Utilities.Internal as any).openPreferences(
        "llmforzotero-preferences",
      );
      await until(
        () =>
          preferences.document.querySelector("#llmforzotero-sidebar-layout")
            ?.dataset.preferenceBound === "true",
        "sidebar layout setting exists",
      );
      preferences.document
        .querySelector('[data-pref-tab="customization"]')
        .click();
      return preferences.document.querySelector("#llmforzotero-sidebar-layout");
    };
    const choose = (select: any, value: string) => {
      select.value = value;
      const event = preferences.document.createEvent("Event");
      event.initEvent("change", true, false);
      select.dispatchEvent(event);
    };
    try {
      Zotero.Prefs.clear(prefKey, true);
      let select = await openPreferences();
      assert.equal(select.value, "stacked", "Stacked is the default");
      choose(select, "independent");
      await until(
        () =>
          win.document.documentElement.getAttribute("data-llm-pane-view") ===
          "chat",
        "explicit Independent choice applies",
      );
      assert.isAbove(
        select.getBoundingClientRect().height,
        0,
        "setting is in Customization",
      );
      await captureWindow(preferences, "sidebar-layout-customization.png");
      const previousSection = section.querySelector(
        ".llm-dedicated-chat-pane > collapsible-section",
      ) as NativeCollapsibleSection | null;
      choose(select, "stacked");
      await until(
        () =>
          win.document.documentElement.getAttribute("data-llm-pane-view") ===
          "stacked",
        "stacked layout applies immediately",
      );
      assert.isAbove(
        details.querySelector("item-pane-header").getBoundingClientRect()
          .height,
        0,
        "native details return",
      );
      await assertHeaderRows(details, "stacked");
      assert.isTrue(
        section.querySelector("collapsible-section").collapsible,
        "stacked section is collapsible",
      );
      assert.strictEqual(
        section.querySelector("#llm-main"),
        root,
        "layout switch preserves the mounted chat",
      );
      assert.equal(input.value, "Keep this draft across layout changes");
      preferences.close();
      await until(() => preferences.closed, "preferences close");
      await clickPane("llm-context-panel");
      const { current: currentSection } =
        await ensureStackedSectionOpen(details);
      assert.isAbove(
        currentSection.getBoundingClientRect().height,
        100,
        `stacked chat is visible after clicking its rail icon; state=${JSON.stringify(
          stackedSectionDiagnostics(previousSection, currentSection),
        )}`,
      );
      await captureWindow(win, "stacked-sidebar.png");
      select = await openPreferences();
      assert.equal(select.value, "stacked", "layout choice is remembered");
      choose(select, "independent");
      await until(
        () =>
          win.document.documentElement.getAttribute("data-llm-pane-view") ===
          "chat",
        "independent layout returns",
      );
      await assertHeaderRows(details, "independent");
      assert.equal(
        details.querySelector("item-pane-header").getBoundingClientRect()
          .height,
        0,
      );
      assert.strictEqual(section.querySelector("#llm-main"), root);
      assert.equal(input.value, "Keep this draft across layout changes");
    } finally {
      const currentInput = section.querySelector("#llm-input");
      if (currentInput) {
        currentInput.value = previousDraft;
        currentInput.dispatchEvent(new win.Event("input", { bubbles: true }));
      }
      preferences?.close();
      Zotero.Prefs.set(prefKey, original || "stacked", true);
    }
  });

  it("follows reader tabs and preserves an explicitly selected Library chat", async function () {
    for (const fixture of fixtures) {
      const reader = (await Zotero.Reader.open(
        fixture.pdfAttachmentId,
      )) as _ZoteroTypes.ReaderInstance;
      readers.push(reader);
      await reader._initPromise;
      await reader._waitForReader();
    }
    await openChatPane();
    await assertHeaderRows(activeDetails(), "independent");
    const panel = () =>
      activeDetails().querySelector("#llm-main") as HTMLElement;
    await until(
      () =>
        panel()?.dataset.contextOwnerItemId ===
        String(fixtures[1].parentItemId),
      `paper B context follows its tab; selected=${win.Zotero_Tabs.selectedID}, roots=${JSON.stringify(Array.from(win.document.querySelectorAll("#llm-main")).map((node: any) => ({ ...node.dataset })))}`,
    );
    assertComposerGeometry(activeDetails(), "independent");
    win.Zotero_Tabs.select(readers[0].tabID);
    await until(
      () =>
        panel()?.dataset.contextOwnerItemId ===
        String(fixtures[0].parentItemId),
      "paper A context follows its tab",
    );
    assert.equal(
      win.document.documentElement.getAttribute("data-llm-pane-view"),
      "chat",
    );
    (panel().querySelector("#llm-library-chat-tab") as HTMLElement).click();
    await until(
      () => panel()?.dataset.conversationKind === "global",
      "Library chat is selected",
    );
    const conversation = panel().dataset.itemId;
    // The rail icon closes the open chat, and a second click reopens it.
    await clickPane("llm-context-panel");
    assert.isTrue(activeDetails().sidenav._collapsed, "rail icon closes chat");
    await clickPane("llm-context-panel");
    await until(
      () =>
        panel()?.dataset.conversationKind === "global" &&
        panel()?.dataset.itemId === conversation,
      "Library chat survives closing and reopening",
    );
    win.Zotero_Tabs.select(readers[1].tabID);
    await until(
      () =>
        panel()?.dataset.conversationKind === "global" &&
        panel()?.dataset.itemId === conversation,
      "Library chat stays locked across tabs",
    );
    (panel().querySelector("#llm-paper-chat-tab") as HTMLElement).click();
    await until(
      () =>
        panel()?.dataset.conversationKind === "paper" &&
        panel()?.dataset.contextOwnerItemId ===
          String(fixtures[1].parentItemId),
      "Paper chat resumes with the active paper",
    );
  });
  it("keeps stacked reader contexts and disables the empty library rail", async function () {
    const key = "extensions.zotero.llmforzotero.sidebarLayout";
    try {
      Zotero.Prefs.set(key, "stacked", true);
      await clickPane("llm-context-panel");
      await ensureStackedSectionOpen(activeDetails());
      const panel = () => activeDetails().querySelector("#llm-main");
      assert.equal(
        win.document.documentElement.getAttribute("data-llm-pane-view"),
        "stacked",
      );
      assert.isTrue(
        activeDetails().querySelector(
          ".llm-dedicated-chat-pane > collapsible-section",
        ).collapsible,
      );
      pickMode(panel(), "library");
      await until(
        () => panel().dataset.conversationKind === "global",
        "Library chat opens in stacked reader",
      );
      const conversation = panel().dataset.itemId;
      win.Zotero_Tabs.select(readers[0].tabID);
      await until(
        () => panel().dataset.itemId === conversation,
        "stacked reader tabs preserve Library lock",
      );
      await Zotero.Promise.delay(300);
      pickMode(panel(), "paper");
      await until(
        () =>
          panel().dataset.contextOwnerItemId ===
            String(fixtures[0].parentItemId) &&
          panel().dataset.conversationKind === "paper",
        "stacked Paper chat follows active reader",
      );
      win.Zotero_Tabs.select("zotero-pane");
      await win.ZoteroPane.selectItem(fixtures[0].parentItemId);
      win.ZoteroPane.itemsView.selection.clearSelection();
      await Zotero.Promise.delay(300);
      await until(
        () => Boolean(libraryIcon()?.hasAttribute("disabled")),
        "stacked empty rail is disabled",
      );
      assert.equal(
        win.document.documentElement.getAttribute("data-llm-pane-view"),
        "stacked",
      );
      await win.ZoteroPane.selectItem(fixtures[0].parentItemId);
      await until(
        () =>
          win.document.documentElement.getAttribute("data-llm-pane-view") ===
          "stacked",
        "selecting a paper restores the chosen stacked layout",
      );
    } finally {
      Zotero.Prefs.set(key, "independent", true);
    }
  });
});
