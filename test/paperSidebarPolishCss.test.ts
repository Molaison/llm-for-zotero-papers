import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "chai";

const here = dirname(fileURLToPath(import.meta.url));

function readSource(path: string): string {
  return readFileSync(resolve(here, "..", path), "utf8");
}

function readPanelCss(): string {
  return readSource("addon/content/zoteroPane.css");
}

function normalize(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")");
}

/** The flat rule for `selector`, matched after whitespace is collapsed. */
function rule(css: string, selector: string): string {
  const flat = normalize(css);
  const target = normalize(selector);
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = flat.match(new RegExp(`(?:^|}) ${escaped} \\{[^}]*\\}`));
  return match?.[0].replace(/^}\s*/, "") || "";
}

describe("paper sidebar polish CSS", function () {
  describe("keyboard focus", function () {
    it("defines one focus ring in the panel and in the standalone root", function () {
      const css = readPanelCss();
      for (const scope of [
        ".llm-panel",
        "#llmforzotero-standalone-chat-root",
      ]) {
        const scopeRule = rule(css, scope);
        assert.include(
          scopeRule,
          "--llm-focus-ring-color: var(--llm-indigo8);",
        );
        assert.include(scopeRule, "--llm-focus-ring-width: 2px;");
      }
    });

    it("rings the flat composer buttons inside their own box", function () {
      const css = readPanelCss();
      const flatFocus = rule(
        css,
        ".llm-select-text-btn:focus-visible, .llm-screenshot-btn:focus-visible, .llm-upload-file-btn:focus-visible, .llm-model-btn:focus-visible, .llm-runtime-mode-btn:focus-visible, .llm-reasoning-btn:focus-visible",
      );

      assert.include(flatFocus, "outline:");
      assert.include(flatFocus, "outline: 2px solid var(--llm-indigo8)");
      assert.include(flatFocus, "--llm-focus-ring-width, 2px");
      // The actions row clips overflow, so an outer ring would be cut off.
      assert.include(
        flatFocus,
        "outline-offset: calc(-1 * var(--llm-focus-ring-width",
      );
    });

    it("rings Send and Cancel with a gap so the circle stays legible", function () {
      const css = readPanelCss();
      const sendFocus = rule(
        css,
        ".llm-send-btn:focus-visible, .llm-cancel-btn:focus-visible",
      );

      assert.include(sendFocus, "outline:");
      assert.include(
        sendFocus,
        "outline-offset: var(--llm-focus-ring-width, 2px);",
      );
    });

    it("keeps the previously ringed controls on the accent outline", function () {
      const css = readPanelCss();
      for (const selector of [
        "#llm-runtime-mode-toggle:focus-visible",
        ".llm-permission-toggle:focus-visible",
        ".llm-web-source-chip:focus-visible",
        ".llm-remove-img-btn:focus-visible",
      ]) {
        assert.include(rule(css, selector), "outline:", selector);
      }
    });
  });

  describe("composer status colours", function () {
    it("reads the ready, busy, error and warning colours from tokens", function () {
      const css = readPanelCss();
      const panel = rule(css, ".llm-panel");

      assert.include(
        panel,
        "--llm-status-ready-text: var(--llm-green11);",
      );
      assert.include(
        panel,
        "--llm-status-busy-text: var(--llm-slate11);",
      );
      assert.include(
        panel,
        "--llm-status-error-text: var(--llm-red11);",
      );
      assert.include(
        panel,
        "--llm-status-warning-text: var(--llm-amber11);",
      );
      // The hidden status text is announced through the toggle, whose glyph
      // carries the state colour in the toolbar.
      assert.include(
        rule(css, ".llm-status-error + .llm-status-toggle"),
        "color: var(--llm-red11);",
      );
      assert.include(
        rule(css, ".llm-status-warning + .llm-status-toggle"),
        "color: var(--llm-amber11);",
      );
    });

    it("gives the error and warning text a dark-theme value", function () {
      const css = readPanelCss();
      const panel = rule(css, ".llm-panel");

      assert.include(panel, "--llm-status-error-text: var(--llm-red11);");
      assert.include(panel, "--llm-status-warning-text: var(--llm-amber11);");

      const darkCss = css.slice(
        css.indexOf(".window-is-dark .llm-panel"),
        css.indexOf(".window-is-dark .llm-mermaid-viewer"),
      );
      assert.include(darkCss, "--llm-status-error-text: var(--llm-red11);");
      assert.include(darkCss, "--llm-status-warning-text: var(--llm-amber11);");
      // Radix step 11 is the readable text step, and it differs per theme.
      assert.include(css, "--llm-red11: #ce2c31;");
      assert.include(css, "--llm-red11: #ff9592;");
      assert.include(css, "--llm-amber11: #ab6400;");
      assert.include(css, "--llm-amber11: #ffca16;");
    });

    it("no longer hard-codes the light-only red and amber in the composer", function () {
      const css = readPanelCss();

      for (const selector of [
        ".llm-status-ready",
        ".llm-status-sending",
        ".llm-status-error",
        ".llm-status-warning",
      ]) {
        const statusRule = rule(css, selector);
        assert.notInclude(statusRule, "#e74c3c", selector);
        assert.notInclude(statusRule, "#f39c12", selector);
      }
    });
  });

  describe("context chips", function () {
    it("gives every chip clear button a 20px pointer target", function () {
      const css = readPanelCss();
      for (const selector of [
        ".llm-paper-context-summary-clear",
        ".llm-other-ref-chip-header .llm-other-ref-clear",
        ".llm-collection-chip-header .llm-collection-clear, .llm-tag-chip-header .llm-tag-clear",
        ".llm-paper-context-chip-header .llm-paper-context-clear",
      ]) {
        const clearRule = rule(css, selector);
        assert.include(
          clearRule,
          "width: var(--llm-chip-clear-size, 20px);",
          selector,
        );
        assert.include(
          clearRule,
          "min-width: var(--llm-chip-clear-size, 20px);",
          selector,
        );
        assert.include(
          clearRule,
          "height: var(--llm-chip-clear-size, 20px);",
          selector,
        );
      }
    });

    it("draws the full, MinerU and PDF chips with one hairline", function () {
      const css = readPanelCss();
      const chips: Array<[string, string]> = [
        [
          ".llm-paper-context-chip.llm-paper-context-chip-full .llm-paper-context-chip-header",
          "--llm-pin-border-color",
        ],
        [
          ".llm-paper-context-chip.llm-paper-context-chip-full.llm-paper-context-chip-mineru .llm-paper-context-chip-header",
          "--llm-mineru-border-color",
        ],
        [
          ".llm-paper-context-chip.llm-paper-context-chip-pdf .llm-paper-context-chip-header",
          "--llm-pdf-border-color",
        ],
      ];

      for (const [selector, borderToken] of chips) {
        const headerRule = rule(css, selector);
        assert.include(
          headerRule,
          `border: 0.5px solid var(${borderToken});`,
          selector,
        );
        assert.notInclude(
          headerRule,
          "box-shadow",
          `${selector} must not double its own border with an inset stroke`,
        );
      }
    });

    it("keeps the chip classes and source badges the panel already ships", function () {
      const css = readPanelCss();

      for (const selector of [
        ".llm-selected-context",
        ".llm-selected-context-header",
        ".llm-selected-context-expanded",
        ".llm-paper-context-chip-header",
        ".llm-paper-context-chip-label",
        ".llm-paper-context-chip-text",
        ".llm-other-ref-chip-label",
        ".llm-collection-chip-label, .llm-tag-chip-label",
        ".llm-context-previews",
        ".llm-input-section",
        ".llm-input",
        ".llm-actions",
        ".llm-status-control",
        ".llm-message-wrapper",
      ]) {
        assert.notEqual(rule(css, selector), "", `${selector} disappeared`);
      }

      assert.notEqual(
        rule(css, ".llm-status-control > .llm-status"),
        "",
        ".llm-status disappeared",
      );

      assert.include(
        rule(
          css,
          ".llm-paper-context-chip.llm-paper-context-chip-pdf .llm-paper-context-chip-icon",
        ),
        "color: var(--llm-pdf-color);",
      );
    });

    it("keeps a context chip inside a narrow sidebar", function () {
      const css = readPanelCss();

      assert.include(rule(css, ".llm-context-previews"), "flex-wrap: wrap;");
      assert.include(
        rule(
          css,
          ".llm-context-previews > #llm-runtime-mode-toggle, .llm-context-previews > #llm-selected-context-list > .llm-selected-context, .llm-context-previews > .llm-image-preview, .llm-context-previews > #llm-file-context-preview, .llm-context-previews > #llm-paper-context-preview",
        ),
        "max-width: 100%;",
      );
      assert.include(
        rule(css, ".llm-selected-context-header"),
        "max-width: 100%;",
      );
    });
  });

  describe("command row", function () {
    it("names the command-row clear button for assistive tech", function () {
      const source = readSource("src/modules/contextPanel/buildUI.ts");

      assert.match(
        source,
        /commandRowClear\.setAttribute\(\s*"aria-label",\s*t\("Clear"\),?\s*\)/,
      );
      assert.match(source, /title: t\("Clear"\)/);
    });
  });
});
