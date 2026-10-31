import { assert } from "chai";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync("addon/content/zoteroPane.css", "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selector: m[1].trim(),
  body: m[2],
}));
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(join(dir, entry.name))
      : entry.name.endsWith(".ts")
        ? [join(dir, entry.name)]
        : [],
  );
// These are content-rendering/export/acceptance code, not sidebar chrome.
const contentExceptions = new Set([
  "renderedMarkdown.ts",
  "workflowTestHarness.ts",
  "standaloneDocumentWindow.ts",
]);

describe("reading sidebar complete bounded style inventory", function () {
  this.timeout(10000);
  it("uses all 12 Radix steps in both host themes and has no literal colors outside the frozen palette", function () {
    for (const family of ["slate", "indigo", "red", "green", "amber"])
      for (let step = 1; step <= 12; step++)
        assert.lengthOf(
          [
            ...css.matchAll(
              new RegExp(`--llm-${family}${step}: #[0-9a-f]{6};`, "g"),
            ),
          ],
          2,
          `${family}${step}`,
        );
    assert.include(css, ":root[lwtheme-brighttext]");
    for (const { selector, body } of rules) {
      for (const line of body.split("\n")) {
        if (/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i.test(line))
          assert.match(
            line.trim(),
            /^--llm-(?:(?:slate|indigo|red|green|amber)\d+|on-solid|primary-hover): #[0-9a-f]{6};$/,
            selector,
          );
      }
    }
    assert.notMatch(css, /var\(--(?:fill-|color-|material-|stroke-)/);
    assert.include(css, "--llm-on-solid: #fcfcfd;");
    assert.include(css, "--llm-primary-hover: #3358d4;");
  });
  it("limits chrome type to the host-scaled 12/14/16 system, removes shadows, and bounds functional motion", function () {
    assert.include(
      css,
      "--llm-text-small: max(12px, calc(0.75rem * var(--llm-font-scale, 1)))",
    );
    assert.include(
      css,
      "--llm-text-control: max(14px, calc(0.875rem * var(--llm-font-scale, 1)))",
    );
    assert.include(
      css,
      "--llm-text-body: max(16px, calc(1rem * var(--llm-font-scale, 1)))",
    );
    assert.include(css, "--llm-text-title: var(--llm-text-body)");
    assert.notMatch(css, /--llm-text-\w+:.*[\d]em\)/);
    for (const { selector, body } of rules) {
      for (const m of body.matchAll(/(?:^|[;\n])\s*font-size:\s*([^;]+);/g)) {
        if (selector.endsWith(" .katex")) {
          assert.equal(m[1], "1.21em", "KaTeX keeps its own relative metrics");
          continue;
        }
        assert.match(
          m[1],
          /^(?:0|inherit|1em|var\(--llm-(?:text-(?:small|control|body|title)|fs-12|action-icon-size)\))$/,
          selector,
        );
      }
      for (const m of body.matchAll(
        /(?:^|[;\n])\s*(?:box-shadow|--llm-[\w-]*shadow):\s*([^;]+);/g,
      ))
        assert.match(m[1], /^none(?: !important)?$/, selector);
      for (const m of body.matchAll(
        /(?:^|[;\n])\s*(animation|transition):\s*([^;]+);/g,
      )) {
        if (
          selector === ".llm-history-activity" &&
          m[1] === "animation" &&
          m[2] === "llm-plan-progress-spin 1s linear infinite"
        )
          continue;
        assert.match(
          m[2],
          /^(?:none|height 250ms ease-out)(?: !important)?$/,
          selector,
        );
      }
      // Circle/spinner/checkmark strokes are functional icon geometry.
      if (!/::(?:before|after)|\.llm-task-paper-dot/.test(selector))
        assert.notMatch(
          body,
          /(?:^|[;\n])\s*border(?:-width)?:\s*(?:1|1\.5|2|3|4)px\b/,
          selector,
        );
      assert.notMatch(
        body,
        /border-(?:left|inline-start):\s*[234]px solid/,
        selector,
      );
    }
  });
  it("covers JS chrome literals and authored separators without rewriting scientific/model/user content", function () {
    for (const path of files("src/modules/contextPanel")) {
      if (contentExceptions.has(path.split("/").at(-1)!)) continue;
      const text = readFileSync(path, "utf8");
      const lines = text.split("\n");
      for (const [index, line] of lines.entries()) {
        if (line.trim().startsWith("//") || line.trim().startsWith("*"))
          continue;
        assert.notMatch(
          line,
          /\\u00b7|&middot;|&#183;/i,
          `${path}:${index + 1}`,
        );
        if (line.includes("·"))
          assert.match(
            line,
            /endsWith\(|return \/\^continuing agent|blocked: `inflight/,
            `${path}:${index + 1}`,
          );
        assert.notMatch(
          line,
          /(?:fontSize\s*[:=]\s*["']|font-size:\s*)(?:[0-9]|1[0135])px/,
          `${path}:${index + 1}`,
        );
        if (/#[0-9a-f]{6}\b|rgba?\(/i.test(line)) {
          // Precisely retain categorical palettes and the heatmap value scale.
          assert.match(path, /cpr(?:Special)?ChartRenderer\.ts$/);
          assert.match(line, /const COLORS =|fill: "#2563eb", opacity:/);
        }
      }
    }
  });
  it("styles chart controls separately while retaining source palettes and finite-value rendering", function () {
    for (const name of ["cprChartRenderer.ts", "cprSpecialChartRenderer.ts"]) {
      const text = readFileSync(`src/modules/contextPanel/${name}`, "utf8");
      assert.include(
        text,
        'const COLORS = ["#2563eb", "#dc2626", "#16a34a", "#9333ea", "#ea580c", "#0891b2"]',
      );
      assert.include(text, 'element.className = "llm-cpr-chart-control"');
      assert.notInclude(text, "borderLeft");
    }
  });
});
