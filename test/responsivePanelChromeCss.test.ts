import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "chai";

const here = dirname(fileURLToPath(import.meta.url));

function readPanelCss(): string {
  return readFileSync(resolve(here, "../addon/content/zoteroPane.css"), "utf8");
}

function extractCssRule(css: string, selector: string): string {
  const normalizedCss = css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")");
  const normalizedSelector = selector
    .replace(/\s+/g, " ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")");
  const escapedSelector = normalizedSelector.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
  const match = normalizedCss.match(
    new RegExp(`(?:^|}) ${escapedSelector} \\{[^}]*\\}`),
  );
  return match?.[0].replace(/^}\s*/, "") || "";
}

describe("responsive panel chrome CSS", function () {
  it("lets action-card titles shrink into a responsive ellipsis", function () {
    const css = readPanelCss();
    const effectsRule = extractCssRule(css, ".llm-agent-action-effects");
    const effectRule = extractCssRule(css, ".llm-agent-action-effect");
    const chipRule = extractCssRule(
      css,
      ".llm-agent-action-summary-card .llm-selected-context",
    );
    const headerRule = extractCssRule(
      css,
      ".llm-agent-action-summary-card .llm-selected-context-header",
    );
    const titleRule = extractCssRule(
      css,
      ".llm-agent-action-summary-card :is(.llm-paper-context-chip-text, .llm-collection-chip-title, .llm-tag-chip-title, .llm-other-ref-chip-title)",
    );

    assert.include(effectsRule, "max-width: 100%");
    assert.include(effectRule, "max-width: 100%");
    assert.include(chipRule, "flex: 0 1 auto");
    assert.include(chipRule, "min-width: 0");
    assert.include(chipRule, "max-width: 100%");
    assert.include(headerRule, "min-width: 0");
    assert.include(titleRule, "display: block");
    assert.include(titleRule, "flex: 1 1 auto");
    assert.include(titleRule, "min-width: 0");
    assert.include(titleRule, "overflow: hidden");
    assert.include(titleRule, "text-overflow: ellipsis");
    assert.include(titleRule, "white-space: nowrap");
  });
});
