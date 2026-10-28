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
      const history = win.document.querySelector<HTMLButtonElement>(
        "#llm-history-toggle",
      );
      history?.click();
      await capture("03-paper-history-wide");
      history?.click();
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
      async function captureEmbeddedState(name: string, menuSelector: string) {
        await Zotero.Promise.delay(500);
        const bounds = host!.getBoundingClientRect();
        assert.closeTo(bounds.width, 380, 0.5, "supplemental embedded width");
        ctx.drawWindow(mainWin, bounds.x, bounds.y, 380, 760, "#ffffff");
        const data = mainWin.atob(canvas.toDataURL("image/png").split(",")[1]);
        await io.write(
          `${output}/${name}.png`,
          Uint8Array.from(data, (char) => char.charCodeAt(0)),
        );
        const menu = host!.querySelector<HTMLElement>(menuSelector)!;
        await io.writeUTF8(
          `${output}/${name}.json`,
          JSON.stringify(
            {
              method:
                "Actual mounted production embedded panel; native drawWindow crop",
              width: bounds.width,
              height: bounds.height,
              panelScrollWidth: host!.scrollWidth,
              panelClientWidth: host!.clientWidth,
              menu: menu?.getBoundingClientRect().toJSON(),
              menuText: menu?.textContent,
              diagnostics: await api.getDiagnostics(embedded.panelId),
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

      const search = doc.querySelector<HTMLButtonElement>(
        "[data-sidebar-action='search-history']",
      )!;
      assert.isAbove(
        search.getBoundingClientRect().width,
        0,
        "history search entry is visible",
      );
      search.click();
      await settle();
      const searchInput = doc.querySelector<HTMLInputElement>(
        ".llm-standalone-search-input",
      )!;
      assert.isOk(searchInput, "real search dialog is mounted");
      searchInput.value = "evidence";
      searchInput.dispatchEvent(
        new (win as any).Event("input", { bubbles: true }),
      );
      const searchDeadline = Date.now() + 10000;
      while (
        !doc.querySelector(".llm-standalone-search-item") &&
        Date.now() < searchDeadline
      ) {
        await Zotero.Promise.delay(50);
      }
      assert.isOk(
        doc.querySelector(".llm-standalone-search-item"),
        "stored fixture matches history query",
      );
      await size(500);
      await capture("20-history-search-narrow");
      assert.isAtLeast(captures.length, 12);
      Zotero.debug(`UI_REDESIGN_EVIDENCE ${output}`);
    } finally {
      await api.closeStandalone();
      await api.cleanupFixture(fixture);
      await api.reset();
      if (previousTheme === undefined) Zotero.Prefs.clear(themePref, true);
      else Zotero.Prefs.set(themePref, previousTheme as never, true);
    }
  });
});
