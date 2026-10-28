import { assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";
import { setStatus } from "../src/modules/contextPanel/textUtils";

/** Native Zotero screenshots, with deterministic local data and no LLM account. */
describe("workflow: UI redesign evidence", function () {
  this.timeout(180000);

  it("captures fixed paper, library, history, pending and recovery states", async function () {
    const api = (Zotero as any).LLMForZotero.api
      .workflowTest as WorkflowTestApi;
    const themePref = "browser.theme.toolbar-theme";
    const previousTheme = Zotero.Prefs.get(themePref, true);
    const localePref = "extensions.zotero.llmforzotero.locale";
    const previousLocale = Zotero.Prefs.get(localePref, true);
    let emptyFixture: { body: HTMLElement; dispose: () => void } | undefined;
    let restoreStressProfile: (() => Promise<void>) | undefined;
    const label = String(
      Zotero.Prefs.get(
        "extensions.zotero.llmforzotero.uiRedesignRound",
        true,
      ) || "capture",
    ).replace(/[^a-zA-Z0-9_-]/g, "-");
    const output = `${Zotero.DataDirectory.dir}/ui-redesign/${label}`;
    const captures: Record<string, unknown>[] = [];
    await api.reset();
    const fixture = await api.createPaperWithPdfFixture({
      title: "Retrieval-augmented generation for scientific evidence synthesis",
      pdfTitle: "Scientific evidence synthesis — full text",
      pages: [
        "Retrieval improves factual grounding. We compare the baseline and a citation-aware reranker on twelve research questions.",
        "The ablation supports a directional improvement in evidence precision. Sample size limits generalization to other domains.",
      ],
    });
    let win: Window;
    let io: any;

    async function settle() {
      await Zotero.Promise.delay(450);
      await new Promise<void>((resolve) =>
        win.requestAnimationFrame(() =>
          win.requestAnimationFrame(() => resolve()),
        ),
      );
    }

    async function until(check: () => boolean, message: string) {
      const end = Date.now() + 10000;
      while (!check() && Date.now() < end) await Zotero.Promise.delay(50);
      assert.isTrue(check(), message);
    }

    function visibleSearchOverlay(): HTMLElement | undefined {
      return (
        Array.from(
          win.document.querySelectorAll(".llm-standalone-search-overlay"),
        ) as HTMLElement[]
      ).find(
        (element) =>
          element.getBoundingClientRect().width > 0 &&
          win.getComputedStyle(element)?.display !== "none",
      )!;
    }

    async function openVisibleSearch() {
      const trigger = win.document.querySelector<HTMLButtonElement>(
        "[data-sidebar-action='search-history']",
      )!;
      assert.isAbove(
        trigger.getBoundingClientRect().width,
        0,
        "visible sidebar Search history entry",
      );
      trigger.focus();
      trigger.click();
      await until(
        () => Boolean(visibleSearchOverlay()),
        "actual visible search overlay opens",
      );
      const overlay = visibleSearchOverlay()!;
      const dialog = overlay.querySelector(".llm-standalone-search-popup")!;
      assert.equal(dialog.getAttribute("role"), "dialog");
      assert.equal(dialog.getAttribute("aria-modal"), "true");
      const input = overlay.querySelector<HTMLInputElement>(
        ".llm-standalone-search-input",
      )!;
      assert.equal(
        win.document.activeElement,
        input,
        "visible search input receives focus",
      );
      return { trigger, overlay, input };
    }

    async function capture(name: string) {
      await settle();
      const doc = win.document;
      const selectors = [
        "#llm-main",
        ".llm-header",
        ".llm-scope-bar",
        ".llm-messages",
        "#llm-compose-area",
        "#llm-input",
        "#llm-send",
        "#llm-cancel",
        "#llm-model-toggle",
        "#llm-reasoning-toggle",
        "#llm-upload-file",
        "#llm-status",
        ".llm-standalone-sidebar",
      ];
      const bounds = Object.fromEntries(
        selectors.map((selector) => {
          const element = doc.querySelector<HTMLElement>(selector);
          if (!element) return [selector, null];
          const rect = element.getBoundingClientRect();
          const style = win.getComputedStyle(element);
          return [
            selector,
            {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
              scrollWidth: element.scrollWidth,
              clientWidth: element.clientWidth,
              display: style?.display,
              visibility: style?.visibility,
              text: (element.textContent || "").trim().slice(0, 180),
            },
          ];
        }),
      );
      const path = `${output}/${name}.png`;
      await api.captureStandaloneScreenshot(path);
      const panel = doc.querySelector<HTMLElement>("#llm-main");
      const panelStyle = panel ? win.getComputedStyle(panel) : null;
      captures.push({
        name,
        path,
        innerWidth: win.innerWidth,
        innerHeight: win.innerHeight,
        dpr: win.devicePixelRatio,
        dark: win.matchMedia("(prefers-color-scheme: dark)")?.matches,
        rootFontSize: win.getComputedStyle(doc.documentElement)?.fontSize,
        panelFontSize: panelStyle?.fontSize,
        panelFontScale: panelStyle?.getPropertyValue("--llm-font-scale").trim(),
        diagnostics: await api.getStandaloneDiagnostics(),
        bounds,
      });
      // Flush after each shot so an interrupted run still leaves usable evidence.
      await io.writeUTF8(
        `${output}/manifest.json`,
        JSON.stringify(
          {
            zoteroVersion: Zotero.version,
            fixture: {
              title:
                "Retrieval-augmented generation for scientific evidence synthesis",
            },
            method:
              "Actual Zotero window; production components; privileged canvas drawWindow",
            captures,
          },
          null,
          2,
        ),
      );
    }

    async function size(width: number) {
      const actual = await api.resizeStandaloneWindow(width, 760);
      // Native window managers may impose a minimum width; retain actual size.
      assert.isAbove(actual.innerWidth, 0);
      await settle();
      // Initial titlebar/layout settlement can change the inner height after
      // resizeBy returned. Repeat once against the settled native geometry.
      if (win.innerWidth !== width || win.innerHeight !== 760) {
        await api.resizeStandaloneWindow(width, 760);
        await settle();
      }
    }

    try {
      Zotero.Prefs.set(localePref, "en-US", true);
      api.refreshWorkflowLocale();
      Zotero.Prefs.set(themePref, 1, true);
      await api.openStandaloneForItem(fixture.parentItemId);
      win = (Zotero as any).LLMForZotero.data.standaloneWindow as Window;
      io = (win as any).IOUtils || (globalThis as any).IOUtils;
      assert.isOk(io?.makeDirectory, "native IOUtils available");
      await io.makeDirectory(output, {
        ignoreExisting: true,
        createAncestors: true,
      });
      await size(1000);
      assert.isOk(win.document.querySelector("#llm-input"));
      await capture("01-paper-empty-wide");

      // Seed through the production conversation store and renderer.
      await api.seedStandaloneConversation([
        {
          role: "user",
          text: "Which claims are supported by the ablation, and what are its limitations?",
          timestamp: 1793145600000,
        },
        {
          role: "assistant",
          text: "The ablation supports **better evidence precision** when the citation-aware reranker is enabled.\n\n1. Retrieval improves factual grounding.\n2. The reranker helps select relevant evidence.\n\nThe small evaluation set limits generalization. Treat this as directional evidence and check the full methods before comparing effect sizes.",
          modelName: "Research assistant",
          timestamp: 1793145601000,
        },
      ]);
      await capture("02-paper-conversation-wide");
      const history = await openVisibleSearch();
      await until(
        () =>
          Boolean(history.overlay.querySelector(".llm-standalone-search-item")),
        "initial history rows load",
      );
      await capture("03-paper-history-wide");
      history.overlay
        .querySelector<HTMLButtonElement>(".llm-standalone-search-close")!
        .click();
      await size(380);
      await capture("04-paper-conversation-narrow");

      await size(1000);
      // This helper pauses at the test interceptor, never calling an LLM.
      await api.withPendingStandaloneSend(
        "Check the evidence for the retrieval claim.",
        async () => {
          await capture("05-paper-running-wide");
          await size(380);
          await capture("06-paper-running-narrow");
        },
      );

      // Deterministic failed-stream recovery through the real message renderer.
      await api.seedStandaloneConversation([
        {
          role: "user",
          text: "Check the evidence for the retrieval claim.",
          timestamp: 1793145602000,
        },
        {
          role: "assistant",
          text: "The methods suggest improved grounding, but the response was interrupted before the evidence check finished.",
          interrupted: true,
          timestamp: 1793145603000,
        },
      ]);
      const status = win.document.querySelector<HTMLElement>("#llm-status");
      assert.isOk(status, "production status node exists");
      setStatus(
        status!,
        "Connection interrupted. Retry to continue the evidence check.",
        "error",
      );
      await capture("07-paper-error-narrow");
      await size(1000);
      await capture("08-paper-error-wide");

      const library = await api.clickStandaloneTab("open");
      assert.equal(library.conversationKind, "global", "actual Library switch");
      // The switch already provisions Library chat. The panel's old New chat
      // button is hidden in standalone, so its click helper is unsuitable here.
      await api.seedStandaloneConversation([]);
      await capture("09-library-empty-wide");
      await size(380);
      await capture("10-library-empty-narrow");

      Zotero.Prefs.set(themePref, 0, true);
      await Zotero.Promise.delay(750);
      await capture("11-library-empty-narrow-dark");
      await size(1000);
      await api.clickStandaloneTab("paper");
      await capture("12-paper-conversation-wide-dark");

      // Standalone intentionally has a 500px minimum. Test the actual embedded
      // production panel at 380px separately, without relaxing that product rule.
      const embedded = await api.renderPanelForItem(fixture.parentItemId);
      const mainWin = Zotero.getMainWindow() as Window;
      const host = mainWin.document.querySelector<HTMLElement>(
        `[data-workflow-panel-id="${embedded.panelId}"]`,
      );
      assert.isOk(host, "production embedded panel is mounted");
      Object.assign(host!.style, {
        left: "0",
        top: "0",
        width: "380px",
        height: "760px",
        zIndex: "2147483647",
        background: "var(--llm-slate1)",
      });
      await Zotero.Promise.delay(500);
      const box = host!.getBoundingClientRect();
      assert.closeTo(
        box.width,
        380,
        0.5,
        "embedded viewport is actually 380px",
      );
      const canvas = mainWin.document.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "canvas",
      ) as HTMLCanvasElement;
      canvas.width = 380;
      canvas.height = 760;
      const ctx = canvas.getContext("2d") as any;
      assert.isFunction(
        ctx?.drawWindow,
        "privileged native screenshot available",
      );
      ctx.drawWindow(mainWin, box.x, box.y, 380, 760, "#ffffff");
      const binary = mainWin.atob(canvas.toDataURL("image/png").split(",")[1]);
      await io.write(
        `${output}/13-embedded-paper-380.png`,
        Uint8Array.from(binary, (char) => char.charCodeAt(0)),
      );
      const input = host!.querySelector<HTMLElement>("#llm-input")!;
      const send = host!.querySelector<HTMLElement>("#llm-send")!;
      await io.writeUTF8(
        `${output}/embedded-manifest.json`,
        JSON.stringify(
          {
            method:
              "Actual Zotero main-window production buildUI + setupHandlers; 380px mounted host; drawWindow crop",
            width: box.width,
            height: box.height,
            panelScrollWidth: host!.scrollWidth,
            panelClientWidth: host!.clientWidth,
            input: input.getBoundingClientRect().toJSON(),
            send: send.getBoundingClientRect().toJSON(),
            diagnostics: await api.getDiagnostics(embedded.panelId),
          },
          null,
          2,
        ),
      );
      host!.style.left = "-10000px";

      Zotero.Prefs.set(themePref, 1, true);
      await size(1000);
      const doc = win.document;
      const tools = doc.querySelector<HTMLDetailsElement>(
        "#llm-conversation-tools",
      )!;
      const toolsSummary = tools.querySelector<HTMLElement>("summary")!;
      toolsSummary.focus();
      toolsSummary.click();
      await settle();
      assert.isTrue(tools.open, "visible More disclosure opens");
      assert.isAbove(tools.getBoundingClientRect().height, 0);
      await capture("14-more-expanded-wide");
      tools.dispatchEvent(
        new (win as any).KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
        }),
      );
      assert.isFalse(tools.open, "Escape closes More");
      assert.equal(
        doc.activeElement,
        toolsSummary,
        "More returns focus to its summary",
      );

      const sources = doc.querySelector<HTMLDetailsElement>(
        "#llm-source-control",
      )!;
      const sourceSummary =
        doc.querySelector<HTMLElement>("#llm-source-toggle")!;
      sourceSummary.focus();
      sourceSummary.click();
      await settle();
      assert.isTrue(sources.open, "actual paper source disclosure opens");
      await capture("15-sources-expanded-wide");
      sources.dispatchEvent(
        new (win as any).KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
        }),
      );
      assert.isFalse(sources.open, "Escape closes Sources");
      assert.equal(
        doc.activeElement,
        sourceSummary,
        "Sources returns focus to its summary",
      );

      const recovery = doc.querySelector<HTMLButtonElement>(
        ".llm-recovery-action",
      );
      assert.isOk(recovery, "latest interrupted API response exposes Retry");
      {
        recovery!.focus();
        recovery!.click();
        await settle();
        const retryMenu = doc.querySelector<HTMLElement>(
          "#llm-retry-model-menu",
        )!;
        assert.isAbove(
          retryMenu.getBoundingClientRect().height,
          0,
          "existing Retry model chooser opens",
        );
        await capture("16-retry-model-menu-wide");
        retryMenu.dispatchEvent(
          new (win as any).KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
          }),
        );
      }

      const beforeNew = await api.getStandaloneDiagnostics();
      let newButton = doc.querySelector<HTMLButtonElement>(
        "[data-sidebar-action='new-chat']",
      )!;
      if (!newButton.getBoundingClientRect().width) {
        await api.toggleStandaloneSidebar();
        await settle();
        newButton = doc.querySelector<HTMLButtonElement>(
          "[data-sidebar-action='new-chat']",
        )!;
      }
      assert.isAbove(
        newButton.getBoundingClientRect().width,
        0,
        "actual sidebar New chat is visible",
      );
      newButton.click();
      let afterNew = await api.getStandaloneDiagnostics();
      const deadline = Date.now() + 15000;
      while (
        afterNew.conversationKey === beforeNew.conversationKey &&
        Date.now() < deadline
      ) {
        await Zotero.Promise.delay(50);
        afterNew = await api.getStandaloneDiagnostics();
      }
      assert.notEqual(
        afterNew.conversationKey,
        beforeNew.conversationKey,
        "visible New chat creates a fresh conversation key",
      );
      assert.equal(
        afterNew.conversationKind,
        "paper",
        "New chat keeps Paper scope",
      );
      assert.equal(
        afterNew.basePaperItemId,
        beforeNew.basePaperItemId,
        "New chat keeps the same paper",
      );
      await capture("17-new-paper-from-sidebar-wide");

      // Supplemental R3 evidence: actual 380px production disclosures, using
      // the same mounted embedded panel instead of shrinking a bitmap.
      async function captureEmbeddedState(
        name: string,
        menuSelector: string,
        target = host!,
        panelId: string | null = embedded.panelId,
      ) {
        await Zotero.Promise.delay(500);
        const bounds = target.getBoundingClientRect();
        assert.closeTo(bounds.width, 380, 0.5, "supplemental embedded width");
        ctx.drawWindow(mainWin, bounds.x, bounds.y, 380, 760, "#ffffff");
        const data = mainWin.atob(canvas.toDataURL("image/png").split(",")[1]);
        await io.write(
          `${output}/${name}.png`,
          Uint8Array.from(data, (char) => char.charCodeAt(0)),
        );
        const menu = target.querySelector<HTMLElement>(menuSelector)!;
        await io.writeUTF8(
          `${output}/${name}.json`,
          JSON.stringify(
            {
              method:
                "Actual mounted production embedded panel; native drawWindow crop",
              componentOnly: panelId === null,
              excludedFromProductAB: panelId === null,
              initialization:
                panelId === null
                  ? "buildUI(null) + refreshChat(null); no setupHandlers or dedicated ancestor; not a demonstrated user entry"
                  : "production buildUI + setupHandlers through renderPanelForItem",
              width: bounds.width,
              height: bounds.height,
              panelScrollWidth: target.scrollWidth,
              panelClientWidth: target.clientWidth,
              menu: menu?.getBoundingClientRect().toJSON(),
              menuText: menu?.textContent,
              diagnostics: panelId ? await api.getDiagnostics(panelId) : null,
            },
            null,
            2,
          ),
        );
      }
      host!.style.left = "0";
      const embeddedSources = host!.querySelector<HTMLDetailsElement>(
        "#llm-source-control",
      )!;
      const embeddedSourceSummary =
        host!.querySelector<HTMLElement>("#llm-source-toggle")!;
      embeddedSourceSummary.focus();
      embeddedSourceSummary.click();
      assert.isTrue(
        embeddedSources.open,
        "380px Sources opens through its real summary",
      );
      await captureEmbeddedState("18-sources-embedded-380", ".llm-source-body");
      embeddedSources.dispatchEvent(
        new (mainWin as any).KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
        }),
      );
      assert.isFalse(embeddedSources.open);
      assert.equal(mainWin.document.activeElement, embeddedSourceSummary);
      const embeddedMore = host!.querySelector<HTMLDetailsElement>(
        "#llm-conversation-tools",
      )!;
      const embeddedMoreSummary =
        embeddedMore.querySelector<HTMLElement>("summary")!;
      embeddedMoreSummary.focus();
      embeddedMoreSummary.click();
      assert.isTrue(
        embeddedMore.open,
        "380px More opens through its real summary",
      );
      await captureEmbeddedState(
        "19-more-embedded-380",
        ".llm-conversation-tools-body",
      );
      embeddedMore.dispatchEvent(
        new (mainWin as any).KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
        }),
      );
      assert.isFalse(embeddedMore.open);
      assert.equal(mainWin.document.activeElement, embeddedMoreSummary);
      host!.style.left = "-10000px";

      const {
        trigger: searchTrigger,
        overlay: searchOverlay,
        input: searchInput,
      } = await openVisibleSearch();
      searchInput.value = "no-match-ui-redesign-7f90bb";
      searchInput.dispatchEvent(
        new (win as any).Event("input", { bubbles: true }),
      );
      await until(
        () =>
          searchOverlay.querySelector(".llm-standalone-search-empty")
            ?.textContent === "No matching history" &&
          !searchOverlay.querySelector(".llm-standalone-search-item"),
        "nonexistent query has no result rows",
      );
      searchInput.value = "evidence";
      searchInput.dispatchEvent(
        new (win as any).Event("input", { bubbles: true }),
      );
      await until(
        () =>
          (
            Array.from(
              searchOverlay.querySelectorAll(
                "mark.llm-history-search-highlight",
              ),
            ) as HTMLElement[]
          ).some((mark) => mark.textContent?.toLowerCase() === "evidence"),
        "stored fixture has an actual highlighted query match",
      );
      assert.equal(doc.activeElement, searchInput);
      await size(500);
      await capture("20-history-search-narrow");
      await size(1000);
      const readFocusable = () =>
        (
          Array.from(
            searchOverlay.querySelectorAll(
              'button:not([disabled]), input:not([disabled]), [tabindex="0"]',
            ),
          ) as HTMLElement[]
        ).filter(
          (element) => !element.hidden && element.getClientRects().length > 0,
        );
      const describeFocus = (element: Element | null) =>
        element && {
          tag: element.tagName,
          className: element.className,
          text: element.textContent?.slice(0, 80),
          rect: element.getBoundingClientRect().toJSON(),
        };
      const initialFocusable = readFocusable();
      const initialFocusState = initialFocusable.map(describeFocus);
      const first = initialFocusable[0];
      initialFocusable[initialFocusable.length - 1].focus();
      // Focusing a result reveals its Delete control through :focus-within.
      // Re-read the actual tab boundary after that real state change.
      const afterRowFocus = readFocusable();
      const afterRowFocusState = afterRowFocus.map(describeFocus);
      const last = afterRowFocus[afterRowFocus.length - 1];
      assert.isTrue(
        last.classList.contains("llm-standalone-search-delete"),
        "focusing a result reveals its keyboard Delete action",
      );
      last.focus();
      assert.equal(doc.activeElement, last, "revealed Delete is focusable");
      const forwardTab = new (win as any).KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
        cancelable: true,
      });
      last.dispatchEvent(forwardTab);
      await io.writeUTF8(
        `${output}/search-keyboard-diagnostics.json`,
        JSON.stringify(
          {
            initialFocusable: initialFocusState,
            afterRowFocus: afterRowFocusState,
            forwardPrevented: forwardTab.defaultPrevented,
            forwardActive: describeFocus(doc.activeElement),
          },
          null,
          2,
        ),
      );
      assert.isTrue(
        forwardTab.defaultPrevented,
        "dialog owns forward Tab at its actual boundary",
      );
      assert.equal(
        doc.activeElement,
        first,
        "Tab wraps inside the actual search dialog",
      );
      // Delete hides again when focus leaves the result; reverse Tab must use
      // the boundary that exists while the input is active.
      const reverseFocusable = readFocusable();
      const reverseLast = reverseFocusable[reverseFocusable.length - 1];
      const reverseTab = new (win as any).KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      first.dispatchEvent(reverseTab);
      assert.isTrue(
        reverseTab.defaultPrevented,
        "dialog owns reverse Tab at its actual boundary",
      );
      assert.equal(
        doc.activeElement,
        reverseLast,
        "Shift+Tab wraps inside the actual search dialog",
      );
      const closeSearch = searchOverlay.querySelector<HTMLButtonElement>(
        ".llm-standalone-search-close",
      )!;
      closeSearch.focus();
      closeSearch.dispatchEvent(
        new (win as any).KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
      assert.isFalse(
        Boolean(visibleSearchOverlay()),
        "Escape from a non-input closes search",
      );
      assert.equal(
        doc.activeElement,
        searchTrigger,
        "search returns focus to its actual trigger",
      );

      host!.style.left = "0";
      const longError =
        "Connection interrupted while checking the selected evidence. Your question and partial answer are preserved. Choose Retry to select a model and continue the evidence check.";
      const embeddedStatus = host!.querySelector<HTMLElement>("#llm-status")!;
      setStatus(embeddedStatus, longError, "error");
      await captureEmbeddedState("21-long-error-embedded-380", "#llm-status");
      assert.equal(embeddedStatus.textContent, longError);
      assert.isAtMost(
        embeddedStatus.scrollWidth,
        embeddedStatus.clientWidth + 1,
        "380px error text wraps without clipping",
      );
      assert.isAbove(
        embeddedStatus.getBoundingClientRect().height,
        20,
        "long error uses multiple lines",
      );
      const narrowSend = host!
        .querySelector<HTMLElement>("#llm-send")!
        .getBoundingClientRect();
      assert.isAtMost(
        narrowSend.right,
        host!.getBoundingClientRect().right + 0.5,
        "Send stays inside the 380px panel",
      );
      host!.style.left = "-10000px";

      Zotero.Prefs.set(localePref, "zh-CN", true);
      api.refreshWorkflowLocale();
      const chinese = await api.renderPanelForItem(fixture.parentItemId);
      const chineseHost = mainWin.document.querySelector<HTMLElement>(
        `[data-workflow-panel-id="${chinese.panelId}"]`,
      )!;
      Object.assign(chineseHost.style, {
        left: "0",
        top: "0",
        width: "380px",
        height: "760px",
        zIndex: "2147483647",
        background: "var(--llm-slate1)",
      });
      assert.equal(
        chineseHost.querySelector<HTMLTextAreaElement>("#llm-input")!
          .placeholder,
        "询问这篇论文…",
        "Chinese comes from real locale pref and production rerender",
      );
      await captureEmbeddedState(
        "22-chinese-paper-embedded-380",
        ".llm-compose-area",
        chineseHost,
        chinese.panelId,
      );
      chineseHost.style.left = "-10000px";
      emptyFixture = api.renderEmptyPanel();
      Object.assign(emptyFixture.body.style, {
        left: "0",
        top: "0",
        width: "380px",
        height: "760px",
        zIndex: "2147483647",
        background: "var(--llm-slate1)",
      });
      assert.isTrue(
        emptyFixture.body.querySelector<HTMLTextAreaElement>("#llm-input")!
          .disabled,
        "no-paper input is disabled",
      );
      assert.include(
        emptyFixture.body.querySelector("#llm-chat-box")!.textContent,
        "选择一篇论文或打开 PDF",
        "real refreshChat(null) gives no-paper guidance",
      );
      await captureEmbeddedState(
        "23-no-paper-chinese-embedded-380",
        "#llm-chat-box",
        emptyFixture.body,
        null,
      );
      emptyFixture.body.style.left = "-10000px";

      // R4 A: keep production unchanged and expose the actual narrow search
      // Delete state in both host themes, without activating the delete action.
      Zotero.Prefs.set(localePref, "en-US", true);
      api.refreshWorkflowLocale();
      const deleteSearch = await openVisibleSearch();
      deleteSearch.input.value = "evidence";
      deleteSearch.input.dispatchEvent(
        new (win as any).Event("input", { bubbles: true }),
      );
      await until(
        () =>
          Boolean(
            deleteSearch.overlay.querySelector(
              "mark.llm-history-search-highlight",
            ),
          ),
        "Delete-focus fixture has actual filtered results",
      );
      await size(500);
      for (const theme of ["light", "dark"] as const) {
        Zotero.Prefs.set(themePref, theme === "dark" ? 0 : 1, true);
        await until(
          () =>
            win.matchMedia("(prefers-color-scheme: dark)")?.matches ===
            (theme === "dark"),
          `${theme} host theme settles`,
        );
        const rows = Array.from(
          deleteSearch.overlay.querySelectorAll(".llm-standalone-search-item"),
        ) as HTMLElement[];
        const row = rows[rows.length - 1];
        const readDeleteFocusOrder = () =>
          (
            Array.from(
              deleteSearch.overlay.querySelectorAll(
                'button:not([disabled]), input:not([disabled]), [tabindex="0"]',
              ),
            ) as HTMLElement[]
          ).filter(
            (element) => !element.hidden && element.getClientRects().length > 0,
          );
        const beforeDeleteFocus = readDeleteFocusOrder();
        const beforeDeleteFocusSnapshot = beforeDeleteFocus.map(describeFocus);
        row.focus();
        const deleteButton = row.querySelector<HTMLElement>(
          ".llm-standalone-search-delete",
        )!;
        assert.isOk(deleteButton, "filtered result has its real Delete action");
        deleteButton.focus();
        const afterDeleteFocus = readDeleteFocusOrder();
        assert.equal(
          doc.activeElement,
          deleteButton,
          "actual Delete action receives keyboard focus",
        );
        const deleteStyle = win.getComputedStyle(deleteButton)!;
        assert.notEqual(deleteStyle.display, "none");
        assert.isAbove(
          Number(deleteStyle.opacity),
          0,
          "focused Delete is visibly painted",
        );
        const deleteRect = deleteButton.getBoundingClientRect();
        const popupRect = deleteSearch.overlay
          .querySelector<HTMLElement>(".llm-standalone-search-popup")!
          .getBoundingClientRect();
        assert.isAtLeast(deleteRect.left, popupRect.left - 0.5);
        assert.isAtMost(deleteRect.right, popupRect.right + 0.5);
        assert.isAbove(deleteRect.width, 0);
        await capture(`24-search-delete-focus-narrow-${theme}`);
        await io.writeUTF8(
          `${output}/24-search-delete-focus-${theme}.json`,
          JSON.stringify(
            {
              actualWidth: win.innerWidth,
              actualHeight: win.innerHeight,
              activeClass: doc.activeElement?.className,
              deleteRect: deleteRect.toJSON(),
              popupRect: popupRect.toJSON(),
              display: deleteStyle.display,
              opacity: deleteStyle.opacity,
              color: deleteStyle.color,
              backgroundColor: deleteStyle.backgroundColor,
              outline: deleteStyle.outline,
              focusOrderBefore: beforeDeleteFocusSnapshot,
              focusOrderAfter: afterDeleteFocus.map(describeFocus),
              stableFocusSet:
                beforeDeleteFocus.length === afterDeleteFocus.length &&
                beforeDeleteFocus.every(
                  (element, index) => element === afterDeleteFocus[index],
                ),
              focusSetMethod:
                "Diagnostic A/B comparison; baseline focus-within growth is recorded rather than forced to fail",
              method:
                "Real filtered search result and focused Delete; action not activated",
            },
            null,
            2,
          ),
        );
      }
      await size(1000);
      deleteSearch.overlay.dispatchEvent(
        new (win as any).KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
      Zotero.Prefs.set(themePref, 1, true);

      // R4 A: a real persisted profile fixture and plugin typography preference.
      // The long model name is test configuration; no provider request is made.
      const stressProfile = api.configureWorkflowUiStress(
        "gpt-4o-mini-research-evidence-synthesis-long-context-2026-10",
        150,
      );
      restoreStressProfile = stressProfile.restore;
      const stress = await api.renderPanelForItem(fixture.parentItemId);
      const stressHost = mainWin.document.querySelector<HTMLElement>(
        `[data-workflow-panel-id="${stress.panelId}"]`,
      )!;
      Object.assign(stressHost.style, {
        left: "0",
        top: "0",
        width: "380px",
        height: "760px",
        zIndex: "2147483647",
        background: "var(--llm-slate1)",
      });
      const stressModel =
        stressHost.querySelector<HTMLButtonElement>("#llm-model-toggle")!;
      await until(
        () => stressModel.textContent === stressProfile.modelLabel,
        "production model control reads the persisted long profile",
      );
      await captureEmbeddedState(
        "25-paper-long-model-font150-embedded-380",
        "#llm-model-toggle",
        stressHost,
        stress.panelId,
      );
      const stressRoot = stressHost.querySelector<HTMLElement>("#llm-main")!;
      const stressSend =
        stressHost.querySelector<HTMLButtonElement>("#llm-send")!;
      const stressBounds = stressHost.getBoundingClientRect();
      const stressSendBounds = stressSend.getBoundingClientRect();
      const stressStyle = mainWin.getComputedStyle(stressRoot)!;
      const stressModelStyle = mainWin.getComputedStyle(stressModel)!;
      await io.writeUTF8(
        `${output}/25-stress-profile.json`,
        JSON.stringify(
          {
            method:
              "Actual persisted modelProviderGroups model-name fixture; real panelFontScale preference and production rerender; no LLM call",
            modelLabel: stressProfile.modelLabel,
            originalFontPercent: stressProfile.originalFontPercent,
            actualPluginFontPref: Zotero.Prefs.get(
              "extensions.zotero.llmforzotero.panelFontScale",
              true,
            ),
            relativeToBaselinePercent:
              (100 * stressProfile.fontPercent) /
              stressProfile.originalFontPercent,
            notOSZoom: true,
            computedFontScale: stressStyle.getPropertyValue("--llm-font-scale"),
            computedFontSize: stressStyle.fontSize,
            modelRect: stressModel.getBoundingClientRect().toJSON(),
            modelAccessibleName: stressModel.getAttribute("aria-label"),
            textOverflow: stressModelStyle.textOverflow,
            sendRect: stressSendBounds.toJSON(),
            panelScrollWidth: stressHost.scrollWidth,
            panelClientWidth: stressHost.clientWidth,
          },
          null,
          2,
        ),
      );
      assert.equal(
        stressStyle.getPropertyValue("--llm-font-scale").trim(),
        "1.5",
      );
      assert.include(
        stressModel.getAttribute("aria-label"),
        stressProfile.modelLabel,
        "full model name remains accessible",
      );
      assert.isAtMost(
        stressHost.scrollWidth,
        stressHost.clientWidth + 1,
        "stress panel has no horizontal page overflow",
      );
      assert.isAbove(stressSendBounds.width, 0);
      assert.isAtLeast(stressSendBounds.left, stressBounds.left - 0.5);
      assert.isAtMost(stressSendBounds.right, stressBounds.right + 0.5);
      assert.isAtMost(stressSendBounds.bottom, stressBounds.bottom + 0.5);
      stressHost.style.left = "-10000px";
      assert.isAtLeast(captures.length, 12);
      Zotero.debug(`UI_REDESIGN_EVIDENCE ${output}`);
    } finally {
      await restoreStressProfile?.();
      emptyFixture?.dispose();
      if (previousLocale === undefined) Zotero.Prefs.clear(localePref, true);
      else Zotero.Prefs.set(localePref, previousLocale as never, true);
      api.refreshWorkflowLocale();
      await api.closeStandalone();
      await api.cleanupFixture(fixture);
      await api.reset();
      if (previousTheme === undefined) Zotero.Prefs.clear(themePref, true);
      else Zotero.Prefs.set(themePref, previousTheme as never, true);
    }
  });
});
