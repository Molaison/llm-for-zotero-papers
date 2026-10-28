import { assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";
import { getReaderContextPanelForTab } from "../src/modules/contextPanel/readerPopupPanelRouting";

/** Full-window evidence through Zotero's real per-reader section lifecycle. */
describe("workflow: native PDF and chat sidebar evidence", function () {
  this.timeout(150000);

  it("keeps the paper, conversation and draft usable in the native sidebar", async function () {
    const api = (Zotero as any).LLMForZotero.api
      .workflowTest as WorkflowTestApi;
    const win = Zotero.getMainWindow() as any;
    const doc = win.document as Document;
    const io = win.IOUtils || (globalThis as any).IOUtils;
    const output = `${Zotero.DataDirectory.dir}/reader-sidebar`;
    const layoutPref = "extensions.zotero.llmforzotero.sidebarLayout";
    const prefs: Array<[string, boolean]> = [
      [layoutPref, true],
      ["extensions.zotero.llmforzotero.locale", true],
      ["browser.theme.toolbar-theme", true],
      ["layout", false],
    ];
    const previousPrefs = prefs.map(([key, global]) => ({
      key,
      global,
      value: Zotero.Prefs.get(key, global),
    }));
    const previousSize = { width: win.innerWidth, height: win.innerHeight };
    const previousTab = win.Zotero_Tabs.selectedID;
    const nativePane = doc.getElementById("zotero-context-pane")!;
    const previousWidth = nativePane.getAttribute("width");
    const previousPaneStyle = nativePane.getAttribute("style");
    const previousCollapsed = win.ZoteroContextPane.collapsed;
    const fixtures: Awaited<
      ReturnType<WorkflowTestApi["createPaperWithPdfFixture"]>
    >[] = [];
    const readers: any[] = [];
    const captures: Record<string, unknown>[] = [];
    const nativeEntryActions: Record<string, unknown>[] = [];
    const draft = "Check whether the evidence supports this interpretation.";
    let reader: any;
    let narrowRequest: Record<string, unknown> | undefined;

    async function settle() {
      await Zotero.Promise.delay(450);
      await new Promise<void>((resolve) =>
        win.requestAnimationFrame(() => win.requestAnimationFrame(resolve)),
      );
    }

    async function until(check: () => boolean, message: string) {
      const deadline = Date.now() + 10000;
      while (!check() && Date.now() < deadline) await Zotero.Promise.delay(50);
      assert.isTrue(
        check(),
        `${message}; view=${doc.documentElement.getAttribute("data-llm-pane-view")}; nativeCollapsed=${win.ZoteroContextPane.collapsed}; sidenavCollapsed=${details()?.sidenav?._collapsed}; rootRect=${JSON.stringify(panel()?.getBoundingClientRect().toJSON())}; nativeEntryActions=${JSON.stringify(nativeEntryActions)}`,
      );
    }

    function details(): any {
      return getReaderContextPanelForTab(doc, win.Zotero_Tabs.selectedID);
    }

    function panel(): HTMLElement {
      return details()?.querySelector(".llm-dedicated-chat-pane #llm-main");
    }

    async function clickChatIcon() {
      const host = details();
      const paneID = host.querySelector(".llm-dedicated-chat-pane")?.dataset
        .pane;
      const button: any = Array.from(
        host.sidenav.querySelectorAll("[data-pane]"),
      ).find((node: any) => node.getAttribute("data-pane") === paneID);
      assert.isOk(button, "the native chat sidenav icon exists");
      const buttonBox = button.getBoundingClientRect();
      assert.isAbove(buttonBox.width, 0, "the native chat icon is visible");
      assert.isAbove(buttonBox.height, 0, "the native chat icon is visible");
      assert.isAtLeast(buttonBox.left, 0);
      assert.isAtMost(buttonBox.right, win.innerWidth);
      assert.isAtLeast(buttonBox.top, 0);
      assert.isAtMost(buttonBox.bottom, win.innerHeight);
      assert.notEqual(win.getComputedStyle(button).visibility, "hidden");
      assert.notEqual(win.getComputedStyle(button).display, "none");
      nativeEntryActions.push({
        action: "visible-chat-rail-click",
        tabId: reader.tabID,
        bounds: buttonBox.toJSON(),
      });
      button.dispatchEvent(
        new win.MouseEvent("click", {
          bubbles: true,
          detail: 1,
          button: 0,
        }),
      );
      await until(
        () => !host._disableScrollHandler,
        "native navigation settles",
      );
      await settle();
    }

    async function openChat() {
      let reopenedViaToolbar = false;
      if (win.ZoteroContextPane.collapsed) {
        // Zotero removes the entire native rail when the right pane closes.
        // Reopen through its visible PDF toolbar button before using the rail.
        const readerWindow = reader._iframeWindow;
        const toggle = readerWindow.document.querySelector(
          "button.context-pane-toggle",
        ) as HTMLButtonElement;
        assert.isOk(
          toggle,
          "PDF toolbar exposes the native context-pane toggle",
        );
        const toggleBox = toggle.getBoundingClientRect();
        assert.isAbove(toggleBox.width, 0, "PDF toolbar toggle is visible");
        assert.isAbove(toggleBox.height, 0, "PDF toolbar toggle is visible");
        assert.isAtLeast(toggleBox.left, 0);
        assert.isAtMost(toggleBox.right, readerWindow.innerWidth);
        assert.isAtLeast(toggleBox.top, 0);
        assert.isAtMost(toggleBox.bottom, readerWindow.innerHeight);
        assert.notEqual(
          readerWindow.getComputedStyle(toggle).visibility,
          "hidden",
        );
        assert.notEqual(readerWindow.getComputedStyle(toggle).display, "none");
        assert.isTrue(
          toggle.contains(
            readerWindow.document.elementFromPoint(
              toggleBox.left + toggleBox.width / 2,
              toggleBox.top + toggleBox.height / 2,
            ),
          ),
          "visible PDF toolbar toggle is reachable at its center",
        );
        nativeEntryActions.push({
          action: "visible-reader-context-toggle-click",
          tabId: reader.tabID,
          selector: "button.context-pane-toggle",
          readerLocalBounds: toggleBox.toJSON(),
        });
        toggle.click();
        await until(
          () => !win.ZoteroContextPane.collapsed,
          "visible PDF toolbar toggle reopens the native context pane",
        );
        reopenedViaToolbar = true;
        await settle();
      }
      await until(
        () => Boolean(details()?.querySelector(".llm-dedicated-chat-pane")),
        "native section initializes",
      );
      const view = doc.documentElement.getAttribute("data-llm-pane-view");
      if (
        reopenedViaToolbar ||
        details().sidenav._collapsed ||
        !["chat", "stacked"].includes(view || "")
      )
        await clickChatIcon();
      await until(
        () =>
          !details().sidenav._collapsed &&
          Boolean(panel()?.getBoundingClientRect().height),
        "native chat is open",
      );
      await settle();
    }

    async function selectPaper(index: number) {
      reader = readers[index];
      win.Zotero_Tabs.select(reader.tabID);
      await openChat();
      await until(
        () =>
          panel()?.dataset.contextOwnerItemId ===
          String(fixtures[index].parentItemId),
        "reader sidebar belongs to the selected paper",
      );
    }

    function rect(node: Element) {
      return node.getBoundingClientRect();
    }

    async function capture(name: string, expectOpen = true) {
      await settle();
      const browser = reader._iframe as Element;
      const browserBox = rect(browser);
      assert.equal(
        Zotero.Prefs.get("layout"),
        "standard",
        "native Zotero keeps the PDF and sidebar side by side",
      );
      assert.isAbove(browserBox.width, 300, "PDF browser retains usable width");
      assert.isAbove(
        browserBox.height,
        200,
        "PDF browser retains usable height",
      );
      const root = panel();
      const rootBox = rect(root);
      const input = root.querySelector<HTMLElement>("#llm-input")!;
      const send = root.querySelector<HTMLElement>("#llm-send")!;
      if (expectOpen) {
        assert.isAbove(rootBox.width, 0, "native chat has positive width");
        assert.isAtMost(
          browserBox.right,
          rootBox.left + 2,
          "PDF browser and sidebar do not overlap",
        );
        for (const element of [input, send]) {
          const box = rect(element);
          assert.isAbove(box.width, 0, "composer control is visible");
          assert.isAtLeast(box.left, rootBox.left - 1);
          assert.isAtMost(box.right, rootBox.right + 1);
          assert.isAtLeast(box.top, rootBox.top - 1);
          assert.isAtMost(
            box.bottom,
            Math.min(rootBox.bottom, win.innerHeight) + 1,
          );
        }
        assert.isAtMost(
          root.scrollWidth,
          root.clientWidth + 1,
          "native panel has no horizontal overflow",
        );
        assert.isAtMost(
          doc.documentElement.scrollWidth,
          win.innerWidth + 1,
          "main window has no horizontal overflow",
        );
      }
      const canvas = doc.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "canvas",
      ) as HTMLCanvasElement;
      const scale = Number(win.devicePixelRatio) || 1;
      canvas.width = Math.ceil(win.innerWidth * scale);
      canvas.height = Math.ceil(win.innerHeight * scale);
      const context = canvas.getContext("2d") as any;
      assert.isFunction(context?.drawWindow);
      context.scale(scale, scale);
      context.drawWindow(win, 0, 0, win.innerWidth, win.innerHeight, "#ffffff");
      const binary = win.atob(canvas.toDataURL("image/png").split(",")[1]);
      await io.write(
        `${output}/${name}.png`,
        Uint8Array.from(binary, (char: any) => char.charCodeAt(0)),
      );
      captures.push({
        name,
        selectedTabId: win.Zotero_Tabs.selectedID,
        readerTabId: reader.tabID,
        attachmentItemId: reader.itemID || reader._item?.id,
        contextOwnerItemId: root.dataset.contextOwnerItemId,
        conversationKind: root.dataset.conversationKind,
        sidebarLayout: Zotero.Prefs.get(layoutPref, true),
        nativeZoteroLayout: Zotero.Prefs.get("layout"),
        paneView: doc.documentElement.getAttribute("data-llm-pane-view"),
        collapsed: details().sidenav._collapsed,
        window: { width: win.innerWidth, height: win.innerHeight, dpr: scale },
        nativePane: rect(nativePane).toJSON(),
        pdfBrowser: browserBox.toJSON(),
        panel: rootBox.toJSON(),
        input: rect(input).toJSON(),
        send: rect(send).toJSON(),
        panelScrollWidth: root.scrollWidth,
        panelClientWidth: root.clientWidth,
        draft:
          input instanceof win.HTMLTextAreaElement
            ? (input as HTMLTextAreaElement).value
            : "",
        sourcesOpen: root.querySelector<HTMLDetailsElement>(
          "#llm-source-control",
        )?.open,
        panelFontScale: win
          .getComputedStyle(root)
          .getPropertyValue("--llm-font-scale")
          .trim(),
        locale: Zotero.Prefs.get("extensions.zotero.llmforzotero.locale", true),
        dark: win.matchMedia("(prefers-color-scheme: dark)").matches,
        narrowRequest,
        nativeEntryActions: [...nativeEntryActions],
      });
      await io.writeUTF8(
        `${output}/manifest.json`,
        JSON.stringify(
          {
            method:
              "Actual native Zotero PDF reader and registered per-tab item-details sidebar; full main-window privileged drawWindow; no synthetic panel host",
            zoteroVersion: Zotero.version,
            requestedWindow: { width: 1360, height: 900 },
            fixtureTitles: fixtures.map((fixture) =>
              Zotero.Items.get(fixture.parentItemId)?.getField("title"),
            ),
            captures,
          },
          null,
          2,
        ),
      );
    }

    try {
      assert.include(
        Zotero.DataDirectory.dir,
        ".scaffold/test/data",
        "only the isolated native test profile is used",
      );
      await api.closeStandalone();
      await api.reset();
      await io.makeDirectory(output, {
        ignoreExisting: true,
        createAncestors: true,
      });
      Zotero.Prefs.set("extensions.zotero.llmforzotero.locale", "en-US", true);
      api.refreshWorkflowLocale();
      Zotero.Prefs.set("browser.theme.toolbar-theme", 1, true);
      // Zotero's standard left/right geometry is distinct from the plugin's
      // stacked/independent arrangement inside the right-hand native pane.
      Zotero.Prefs.set("layout", "standard");
      Zotero.Prefs.set(layoutPref, "stacked", true);
      win.resizeBy(1360 - win.innerWidth, 900 - win.innerHeight);
      await settle();
      win.resizeBy(1360 - win.innerWidth, 900 - win.innerHeight);
      await settle();
      for (const [index, title] of [
        "Retrieval-augmented generation for scientific evidence synthesis",
        "Independent replication and the limits of evidence precision",
      ].entries()) {
        const paragraphs = [
          title,
          "Abstract. We examine how researchers compare claims with the evidence available in scientific papers. The study separates factual grounding from the broader question of whether a result generalizes to another setting.",
          "Methods. Twelve research questions were evaluated using a fixed collection of papers. The baseline retrieved passages by semantic similarity. A second condition reranked passages using citation context, and both conditions used the same evaluation questions.",
          "Results. The citation-aware condition selected more relevant supporting passages. Several difficult questions still required reading the methods and limitations together. Improved retrieval alone did not establish that every generated statement was correct.",
          "Discussion. Small samples and incomplete reporting limit the strength of the comparison. The observed direction is useful for planning a replication, but it should not be interpreted as a universal effect size across disciplines.",
          `Reader fixture ${index + 1}. This local document exists only to inspect the native PDF and question-answering layout. No model request is needed to read the page or restore a saved conversation.`,
        ];
        const fixture = await api.createPaperWithPdfFixture({
          title,
          pdfTitle: `Paper ${index + 1} full text`,
          pages: [paragraphs.join("\n\n"), paragraphs.slice(2).join("\n\n")],
        });
        fixtures.push(fixture);
        const opened = await Zotero.Reader.open(fixture.pdfAttachmentId, {
          pageIndex: 0,
        });
        const nativeReader =
          opened ||
          (Zotero.Reader as any)._readers.find(
            (entry: any) =>
              entry.itemID === fixture.pdfAttachmentId ||
              entry._item?.id === fixture.pdfAttachmentId,
          );
        assert.isOk(nativeReader);
        readers.push(nativeReader);
        await nativeReader._initPromise;
        await nativeReader._waitForReader();
      }
      await selectPaper(0);
      const seeded = await api.seedTaskProgressConversation({
        surface: "embedded",
        turns: [
          {
            user: { text: "Which claim does the ablation support?" },
            answer:
              "The reranker improves **evidence precision** in this evaluation. The comparison uses the same twelve questions and a fixed paper collection.",
            events: [],
          },
          {
            user: { text: "What limits the conclusion?" },
            answer:
              "The small sample limits generalization. Read the methods alongside the results before interpreting the finding as evidence for another domain.",
            events: [],
          },
        ],
      });
      await api.reopenTaskProgressConversation({ surface: "embedded" });
      await until(
        () =>
          Boolean(
            panel()
              .querySelector(".llm-messages")
              ?.textContent?.includes("small sample"),
          ),
        "stored two-turn conversation is restored in the real reader",
      );
      const input = panel().querySelector<HTMLTextAreaElement>("#llm-input")!;
      input.value = draft;
      input.dispatchEvent(new win.Event("input", { bubbles: true }));
      await capture("01-reader-stacked-full");

      Zotero.Prefs.set(layoutPref, "independent", true);
      await openChat();
      await capture("02-reader-independent-full");

      // The native context pane stores its user-resizable width in this
      // attribute; ZoteroContextPane.update() applies its own layout rules.
      // Include the native rail in the request and retain the measured result.
      if (typeof win.ZoteroContextPane.update === "function") {
        const requestedNativeWidth = 414;
        nativePane.setAttribute("width", String(requestedNativeWidth));
        win.ZoteroContextPane.update();
        await settle();
        narrowRequest = {
          requestedPanelWidth: 380,
          requestedNativeWidth,
          method:
            "Native context-pane width attribute plus ZoteroContextPane.update()",
          actualPanelWidth: rect(panel()).width,
        };
      } else {
        narrowRequest = {
          requestedPanelWidth: 380,
          method:
            "Native resize API unavailable; retained real sidebar geometry",
          actualPanelWidth: rect(panel()).width,
        };
      }
      await capture("03-reader-independent-narrow-full");
      const sources = panel().querySelector<HTMLDetailsElement>(
        "#llm-source-control",
      )!;
      const summary = panel().querySelector<HTMLElement>("#llm-source-toggle")!;
      summary.focus();
      summary.click();
      assert.isTrue(sources.open, "real Sources disclosure opens");
      await capture("04-reader-sources-expanded-full");
      sources.dispatchEvent(
        new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
      assert.isFalse(sources.open, "Escape collapses Sources");
      assert.equal(
        doc.activeElement,
        summary,
        "Sources returns keyboard focus",
      );

      await clickChatIcon();
      assert.isTrue(details().sidenav._collapsed, "native rail closes chat");
      await capture("05-reader-chat-collapsed-full", false);
      const reopenActionStart = nativeEntryActions.length;
      await openChat();
      assert.deepEqual(
        nativeEntryActions
          .slice(reopenActionStart)
          .map((entry) => entry.action),
        ["visible-reader-context-toggle-click", "visible-chat-rail-click"],
        "chat restoration uses the visible reader toggle followed by the visible chat rail",
      );
      assert.equal(
        panel().querySelector<HTMLTextAreaElement>("#llm-input")!.value,
        draft,
        "closing and reopening preserves the draft",
      );
      await capture("06-reader-chat-restored-full");

      await selectPaper(1);
      assert.notInclude(
        panel().querySelector(".llm-messages")?.textContent || "",
        "The small sample",
        "paper B does not show paper A's answer",
      );
      await capture("07-reader-paper-b-full");
      await selectPaper(0);
      await until(
        () =>
          Boolean(
            panel()
              .querySelector(".llm-messages")
              ?.textContent?.includes("small sample"),
          ),
        "paper A restores its own conversation",
      );
      assert.equal(
        panel().querySelector<HTMLTextAreaElement>("#llm-input")!.value,
        draft,
        "switching PDF tabs restores paper A's draft",
      );
      const history = await api.getConversationHistoryTexts(
        seeded.conversationKey,
      );
      assert.equal(
        history.stored.length,
        4,
        "both stored question-answer turns survive reader navigation",
      );
      await capture("08-reader-paper-a-restored-full");
    } finally {
      for (const openReader of readers) await openReader.close();
      for (const fixture of fixtures) await api.cleanupFixture(fixture);
      await api.reset();
      for (const { key, global, value } of previousPrefs) {
        if (value === undefined) Zotero.Prefs.clear(key, global);
        else Zotero.Prefs.set(key, value as string | number | boolean, global);
      }
      api.refreshWorkflowLocale();
      if (previousWidth === null) nativePane.removeAttribute("width");
      else nativePane.setAttribute("width", previousWidth);
      win.ZoteroContextPane.collapsed = previousCollapsed;
      win.ZoteroContextPane.update();
      if (previousPaneStyle === null) nativePane.removeAttribute("style");
      else nativePane.setAttribute("style", previousPaneStyle);
      win.Zotero_Tabs.select(previousTab);
      win.resizeBy(
        previousSize.width - win.innerWidth,
        previousSize.height - win.innerHeight,
      );
    }
  });
});
