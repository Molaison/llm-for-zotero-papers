import { assert } from "chai";
import { updateHeaderSpacing } from "../src/modules/contextPanel/setupHandlers/controllers/headerSpacing";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

describe("workflow: standalone responsive chrome", function () {
  this.timeout(45000);
  let api: WorkflowTestApi;
  let fixture: Awaited<
    ReturnType<WorkflowTestApi["createPaperWithPdfFixture"]>
  >;
  let win: Window;

  beforeEach(async function () {
    api = (Zotero as any).LLMForZotero.api.workflowTest;
    await api.reset();
    fixture = await api.createPaperWithPdfFixture({
      title: "Responsive chrome",
      pdfTitle: "Responsive chrome PDF",
    });
    await api.openStandaloneForItem(fixture.parentItemId);
    win = (Zotero as any).LLMForZotero.data.standaloneWindow;
  });

  afterEach(async function () {
    await api.closeStandalone();
    if (fixture) await api.cleanupFixture(fixture);
    await api.reset();
  });

  it("keeps embedded header controls on one line at every font size", async function () {
    const doc = win.document;
    const panel = doc.createElement("div");
    panel.className = "llm-panel";
    // The native XUL window has no HTML body. Keep this fixture independent
    // of the window's flex layout so each requested width is measured exactly.
    panel.style.position = "fixed";
    panel.style.left = "0";
    panel.style.top = "0";
    const header = doc
      .querySelector(".llm-header")!
      .cloneNode(true) as HTMLElement;
    panel.appendChild(header);
    (doc.body || doc.documentElement).appendChild(panel);
    try {
      const runtime = panel.querySelector(
        ".llm-runtime-system-controls",
      ) as HTMLElement;
      runtime.dataset.visibleCount = "2";
      runtime.style.display = "inline-flex";
      for (const child of Array.from(runtime.children) as HTMLElement[])
        child.style.display = "inline-flex";
      const chip = panel.querySelector(".llm-mode-chip") as HTMLElement;
      for (const label of ["Library chat", "Paper chat", "Note chat"]) {
        chip.textContent = label;
        for (const scale of [0.8, 1.2, 1.8]) {
          panel.style.setProperty("--llm-font-scale", String(scale));
          for (const width of [320, 340, 380, 500]) {
            panel.style.width = `${width}px`;
            await new Promise<void>((resolve) =>
              win.requestAnimationFrame(() => resolve()),
            );
            updateHeaderSpacing(header.querySelector(".llm-header-top"));
            if (width >= 380) {
              assert.equal(
                header
                  .querySelector<HTMLElement>(".llm-header-top")!
                  .style.getPropertyValue("--llm-runtime-compression"),
                "0",
                "Ample room must restore the original runtime spacing",
              );
            }
            const bounds = header.getBoundingClientRect();
            const buttons = (
              Array.from(
                header.querySelectorAll("button"),
              ) as HTMLButtonElement[]
            )
              .map((button) => button.getBoundingClientRect())
              .filter((rect) => rect.width > 0 && rect.height > 0);
            const context = `${label}, ${width}px, scale ${scale}`;
            for (const button of Array.from(
              header.querySelectorAll(".llm-header-actions button"),
            ) as Element[]) {
              assert.closeTo(
                button.getBoundingClientRect().width,
                bounds.width <= 380 ? 24 : 28,
                0.5,
                `Action-button padding must be preserved: ${context}`,
              );
            }
            for (const button of Array.from(
              header.querySelectorAll(".llm-history-new, .llm-history-toggle"),
            ) as Element[]) {
              assert.closeTo(button.getBoundingClientRect().width, 20, 0.5);
            }
            const runtimeGlyphs = (
              Array.from(
                runtime.querySelectorAll(".llm-runtime-system-toggle-icon"),
              ) as Element[]
            ).map((icon) => icon.getBoundingClientRect());
            assert.lengthOf(runtimeGlyphs, 2);
            for (const glyph of runtimeGlyphs) {
              assert.closeTo(glyph.width, 16, 0.5);
              assert.closeTo(glyph.height, 16, 0.5);
            }
            assert.isAtLeast(
              runtimeGlyphs[1].left - runtimeGlyphs[0].right,
              1.5,
              `Runtime glyphs need visible separation: ${context}`,
            );
            assert.lengthOf(
              buttons,
              9,
              `All header controls visible: ${context}`,
            );
            for (const [index, rect] of buttons.entries()) {
              assert.closeTo(
                (rect.top + rect.bottom) / 2,
                (buttons[0].top + buttons[0].bottom) / 2,
                0.5,
                `Header must stay on one line: ${context}`,
              );
              assert.isAtLeast(rect.left, bounds.left - 0.5, context);
              assert.isAtMost(rect.right, bounds.right + 0.5, context);
              for (const other of buttons.slice(index + 1)) {
                const overlaps =
                  Math.min(rect.right, other.right) -
                    Math.max(rect.left, other.left) >
                    0.5 &&
                  Math.min(rect.bottom, other.bottom) -
                    Math.max(rect.top, other.top) >
                    0.5;
                assert.isFalse(overlaps, `Header buttons overlap: ${context}`);
              }
            }
          }
        }
      }
    } finally {
      panel.remove();
    }
  });

  it("animates the occupied sidebar width to zero when narrowing the window", async function () {
    await api.resizeStandaloneWindow(900, 650);
    const sidebar = win.document.querySelector(".llm-standalone-sidebar")!;
    const before = sidebar.getBoundingClientRect().width;
    const widths: number[] = [];
    const start = win.performance!.now();
    const sampling = new Promise<void>((resolve) => {
      const sample = () => {
        widths.push(sidebar.getBoundingClientRect().width);
        if (win.performance!.now() - start < 600)
          win.requestAnimationFrame(sample);
        else resolve();
      };
      win.requestAnimationFrame(sample);
    });
    await api.resizeStandaloneWindow(650, 650);
    await sampling;
    assert.equal(sidebar.getAttribute("data-sidebar-state"), "collapsed");
    assert.equal(sidebar.getBoundingClientRect().width, 0);
    assert.isTrue(
      widths.some((width) => width > 1 && width < before - 10),
      `Expected intermediate collapse frames: ${JSON.stringify(widths)}`,
    );
    await api.resizeStandaloneWindow(900, 650);
    assert.closeTo(sidebar.getBoundingClientRect().width, before, 1);
    await api.toggleStandaloneSidebar();
    const hover = await api.hoverStandaloneSidebarToggle();
    assert.equal(hover.sidebarWidthPx, 0);
    assert.isAbove(hover.sidebarPanelWidthPx ?? 0, 100);
  });

  it("keeps both runtime icons clear of the tabs and compacts title actions in sync", async function () {
    const doc = win.document;
    const root = doc.querySelector(
      "#llmforzotero-standalone-chat-root",
    ) as HTMLElement;
    const runtime = doc.querySelector(
      ".llm-standalone-runtime-system-controls",
    ) as HTMLElement;
    // Exercise both optional runtimes without starting a provider session.
    runtime.dataset.visibleCount = "2";
    runtime.style.display = "inline-flex";
    for (const child of Array.from(runtime.children) as HTMLElement[])
      child.style.display = "inline-flex";
    const rect = (selector: string) =>
      doc.querySelector(selector)!.getBoundingClientRect();
    const actionWidth = () => rect(".llm-standalone-icon-export").width;
    await api.resizeStandaloneWindow(1000, 650);
    const wideAction = actionWidth();
    for (const scale of [1, 1.8]) {
      root.style.setProperty("--llm-font-scale", String(scale));
      for (const width of [700, 550, 500]) {
        await api.resizeStandaloneWindow(width, 650);
        const leading = rect(".llm-standalone-tab-row-leading");
        const tabs = rect(".llm-standalone-tab-group");
        assert.isAtMost(
          leading.right,
          tabs.left + 0.5,
          `Controls overlap tabs at ${width}px / scale ${scale}`,
        );
        assert.isAtMost(tabs.right, win.innerWidth);
        for (const tab of Array.from(
          doc.querySelectorAll(".llm-standalone-tab"),
        ) as HTMLElement[]) {
          assert.isAtMost(
            tab.scrollWidth,
            tab.clientWidth + 1,
            "Tab label must remain fully visible",
          );
        }
        assert.closeTo(
          actionWidth(),
          rect(".llm-standalone-icon-clear").width,
          0.01,
          "Action widths must match within subpixel DOMRect rounding",
        );
      }
    }
    await api.hoverStandaloneSidebarToggle();
    for (const tab of Array.from(
      doc.querySelectorAll(".llm-standalone-tab"),
    ) as HTMLElement[]) {
      const bounds = tab.getBoundingClientRect();
      assert.isTrue(
        tab.contains(
          doc.elementFromPoint(bounds.left + 2, bounds.top + bounds.height / 2),
        ),
        "Hover sidebar must not cover the tab's leading edge",
      );
    }
    assert.isBelow(
      actionWidth(),
      wideAction,
      "Export and trash spacing must compact with the toolbar",
    );
  });
});
