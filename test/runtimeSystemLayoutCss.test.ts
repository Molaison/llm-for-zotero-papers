import { assert } from "chai";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "mocha";

const testDir = dirname(fileURLToPath(import.meta.url));

function source(path: string): string {
  return readFileSync(resolve(testDir, "..", path), "utf8");
}

function extractCssRule(css: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    css.match(
      new RegExp(`^[ \t]*${escapedSelector}\\s*\\{[^}]*\\}`, "m"),
    )?.[0] || ""
  );
}

describe("runtime system control layout", function () {
  it("scales the mode toggle labels with the plugin font setting at every width", function () {
    const css = source("addon/content/zoteroPane.css");
    const tabRule = extractCssRule(css, ".llm-standalone-tab");
    const toggleRowRule = extractCssRule(css, ".llm-header-toggle-row");

    // The labels follow --llm-font-scale like the rest of the plugin's text,
    // at the standalone window's own size: the sidebar row supplies the same
    // values the standalone root does.
    const standaloneRootRule = extractCssRule(
      css,
      "#llmforzotero-standalone-chat-root",
    );
    assert.include(tabRule, "font-size: var(--llm-standalone-ui-font-size)");
    for (const declaration of [
      "--llm-standalone-ui-font-size: var(--llm-fs-12);",
      "--llm-standalone-ui-line-height: calc(20px * var(--llm-font-scale));",
    ]) {
      assert.include(standaloneRootRule, declaration);
      assert.include(toggleRowRule, declaration);
    }

    // No width breakpoint may pin it either: the compact header shrinks buttons
    // to icons, but the toggle keeps scaling.
    const compactBlock =
      css.match(/@container \(max-width: 380px\) \{[\s\S]*?\n\}/)?.[0] || "";
    assert.notEqual(compactBlock, "", "compact header block must still exist");
    assert.notInclude(compactBlock, ".llm-header-mode-tab");
    assert.notInclude(css, ".llm-mode-chip");
  });

  it("lays the sidebar header out as the mode toggle, then actions", function () {
    const css = source("addon/content/zoteroPane.css");
    const toggleRowRule = extractCssRule(css, ".llm-header-toggle-row");
    const modeTabRule = extractCssRule(
      css,
      ".llm-header-toggle-row .llm-header-mode-tab",
    );
    const navRowRule = extractCssRule(css, ".llm-header-nav-row");
    const dividerRule = extractCssRule(css, ".llm-header-runtime-divider");

    // No docked title row in either layout: the header opens with the toggle.
    assert.notInclude(css, ".llm-docked-");
    assert.notInclude(
      source("src/modules/contextPanel/buildUI.ts"),
      "createDockedPanelTitle",
    );

    // Row 1: the centered toggle, free of any divider or fixed height.
    assert.notInclude(toggleRowRule, "border");
    assert.notMatch(toggleRowRule, /(^|\s)height:/);
    assert.include(toggleRowRule, "justify-content: center");
    assert.include(toggleRowRule, "padding: 6px 0 8px");
    assert.include(modeTabRule, "min-width: 64px");
    assert.include(modeTabRule, "padding-inline: 12px");

    // Row 2: actions, closed off from the chat by the pane divider.
    assert.include(navRowRule, "border-bottom: var(--material-panedivider)");
    assert.include(dividerRule, "width: 1px");
    assert.include(dividerRule, "height: 16px");
    assert.include(
      dividerRule,
      "border-inline-start: var(--material-panedivider)",
    );

    // The items-list alignment is gone for good.
    assert.notInclude(css, "--llm-items-header");
    assert.notInclude(css, ".llm-header-mode-row");
    assert.notInclude(
      source("src/modules/contextPanel/dedicatedChatPane.ts"),
      "itemsHeaderHeight",
    );
    assert.notInclude(
      source("src/modules/contextPanel/buildUI.ts"),
      "itemsHeaderHeight",
    );
  });

  it("shows the toggle row exactly when the history bar shows", function () {
    const css = source("addon/content/zoteroPane.css");
    // The history bar is always laid out: its display is !important so no
    // transient inline write can hide it (see the tab-switch fix that made
    // it so). The toggle row carries no inline display writes of its own, so
    // the two rows can never fall out of step.
    assert.include(
      extractCssRule(css, ".llm-history-bar"),
      "display: flex !important",
    );
    assert.include(
      extractCssRule(css, ".llm-header-toggle-row"),
      "display: flex",
    );
    for (const path of [
      "src/modules/contextPanel/buildUI.ts",
      "src/modules/contextPanel/setupHandlers.ts",
      "src/modules/contextPanel/setupHandlers/controllers/historyLifecycleController.ts",
      "src/modules/contextPanel/panelHostOwnership.ts",
    ]) {
      const text = source(path);
      assert.notInclude(text, "headerToggleRow", path);
      assert.notInclude(text, "#llm-header-toggle-row", path);
    }
  });

  it("uses the shared mask assets instead of inline runtime glyph markup", function () {
    const css = source("addon/content/zoteroPane.css");
    const sidebarSource = source("src/modules/contextPanel/buildUI.ts");
    const standaloneSource = source(
      "src/modules/contextPanel/standaloneWindow.ts",
    );

    assert.include(css, 'mask-image: url("icons/claude-code.svg")');
    assert.include(sidebarSource, "createRuntimeSystemControls");
    assert.include(standaloneSource, "createRuntimeSystemControls");
    assert.notInclude(sidebarSource, "<svg");
    assert.notInclude(standaloneSource, "20.998 10.949");
  });

  it("uses the existing compact trash icon at every sidebar width", function () {
    const css = source("addon/content/zoteroPane.css");
    const sidebarSource = source("src/modules/contextPanel/buildUI.ts");
    const handlerSource = source("src/modules/contextPanel/setupHandlers.ts");
    const standaloneSource = source(
      "src/modules/contextPanel/standaloneWindow.ts",
    );
    const deleteButtonRule = extractCssRule(css, ".llm-clear-btn");
    const deleteIconRule = extractCssRule(css, ".llm-clear-btn::before");

    assert.include(sidebarSource, "llm-btn-icon llm-clear-btn");
    assert.include(sidebarSource, 'title: t("Delete conversation")');
    assert.include(
      sidebarSource,
      'clearBtn.setAttribute("aria-label", t("Delete conversation"))',
    );
    assert.notInclude(sidebarSource, 'textContent: t("Clear")');
    assert.include(deleteButtonRule, "width: 28px");
    assert.include(deleteButtonRule, "font-size: 0");
    assert.include(deleteIconRule, "display: block");
    assert.notInclude(css, '.llm-clear-btn[data-compact="true"]');
    assert.include(css, "@container (max-width: 380px)");
    assert.equal(
      css.split('url("icons/action-clear.svg")').length - 1,
      4,
      "the sidebar and standalone masks must share the existing trash asset",
    );
    assert.notInclude(handlerSource, "syncResponsiveHeaderClearButton");
    assert.notInclude(handlerSource, "shouldCompactHeaderClearButton");
    assert.include(handlerSource, 'clearBtn.textContent = ""');
    assert.include(handlerSource, 't("Delete conversation")');
    assert.include(
      standaloneSource,
      'iconClear.title = t("Delete conversation")',
    );
    assert.notInclude(standaloneSource, 'iconClear.title = t("Clear")');
  });
});
