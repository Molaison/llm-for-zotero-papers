import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "chai";

const here = dirname(fileURLToPath(import.meta.url));

function source(path: string): string {
  return readFileSync(resolve(here, "..", path), "utf8");
}

describe("standalone plan document window", function () {
  it("uses one canonical visible document title", function () {
    const windowSource = source(
      "src/modules/contextPanel/standalonePlanDocumentWindow.ts",
    );

    assert.include(windowSource, "/^h[1-6]$/.test(firstElement.localName)");
    assert.include(
      windowSource,
      'classList.add("llm-plan-document-window-title")',
    );
    assert.include(windowSource, "article.prepend(title)");
    assert.include(windowSource, "root.replaceChildren(article)");
    assert.notInclude(windowSource, "llm-plan-document-window-header");
  });

  it("opens at a useful reading size", function () {
    const markup = source("addon/content/standalonePlanDocument.xhtml");

    assert.match(markup, /\bwidth="980"/);
    assert.match(markup, /\bheight="900"/);
  });

  it("keeps citations compact and blue until interaction", function () {
    const css = source("addon/content/zoteroPane.css");

    assert.match(
      css,
      /\.llm-plan-document-window-content a,\s*\.llm-plan-document-window-content \.llm-plan-document-citation-cluster\s*\{[^}]*color: var\(--color-accent\);[^}]*text-decoration: none;/s,
    );
  });
});
