import { assert } from "chai";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));

function source(path: string): string {
  return readFileSync(resolve(testDir, "..", path), "utf8");
}

function extractCssRule(css: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escapedSelector}\\s*\\{[^}]*\\}`));
  return match?.[0] || "";
}

describe("standalone window context preview fitting", function () {
  it("notifies standalone windows after context preview rerenders with height metrics", function () {
    const setupHandlers = source("src/modules/contextPanel/setupHandlers.ts");
    const standaloneWindow = source(
      "src/modules/contextPanel/standaloneWindow.ts",
    );

    assert.include(setupHandlers, "export type ContextPreviewRenderMetrics");
    assert.include(
      setupHandlers,
      "onContextPreviewRendered?: (metrics: ContextPreviewRenderMetrics) => void;",
    );
    assert.include(
      setupHandlers,
      "const previousHeight = measureContextPreviewHeight();",
    );
    assert.include(
      setupHandlers,
      "const nextHeight = measureContextPreviewHeight();",
    );
    assert.include(setupHandlers, "hooks?.onContextPreviewRendered?.({");
    assert.include(
      standaloneWindow,
      "const scheduleStandaloneInputFit = () =>",
    );
    assert.include(
      standaloneWindow,
      "onDefaultContextRendered: scheduleStandaloneInputFit",
    );
    assert.include(
      standaloneWindow,
      "const scheduleStandaloneInputFitAfterContextPreviewRender = (",
    );
    assert.include(
      standaloneWindow,
      "if (metrics.nextHeight <= metrics.previousHeight) {",
    );
    assert.include(standaloneWindow, "cancelPendingStandaloneInputFit();");
    assert.include(
      standaloneWindow,
      "shouldRun: () => fitRequestId === standaloneInputFitRequestId",
    );
    assert.match(
      standaloneWindow,
      /onContextPreviewRendered:\s*scheduleStandaloneInputFitAfterContextPreviewRender/,
    );
    assert.include(
      standaloneWindow,
      "scheduleStandaloneWindowFitForElement(newWin, inputSection, {",
    );
  });

  it("bounds the source disclosure while keeping the composer context row visible", function () {
    const rule = extractCssRule(
      source("addon/content/zoteroPane.css"),
      '[data-standalone="true"] .llm-context-previews',
    );

    assert.include(rule, "max-height: none;");
    assert.include(rule, "overflow: visible;");
    const disclosure = extractCssRule(
      source("addon/content/zoteroPane.css"),
      ".llm-source-body",
    );
    assert.include(disclosure, "max-height: 40vh;");
    assert.include(disclosure, "overflow: auto;");
    assert.include(disclosure, "bottom: calc(100% + 8px);");
  });
});
