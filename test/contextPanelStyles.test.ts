import { assert } from "chai";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { config, version } from "../package.json";

// Execute the actual entry function without loading unrelated Zotero services.
const source = ts.createSourceFile("index.ts", readFileSync("src/modules/contextPanel/index.ts", "utf8"), ts.ScriptTarget.Latest, true);
const entry = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "registerLLMStyles")!;
const compiled = ts.transpileModule(entry.getText(source), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const context = { exports: {} as { registerLLMStyles: (win: unknown) => void }, config, version };
runInNewContext(compiled, context);

function documentHarness() {
  const elements = new Map<string, any>();
  let hrefWrites = 0;
  const doc = {
    getElementById: (id: string) => elements.get(id) || null,
    createElement: () => {
      let href = "";
      return { id: "", rel: "", type: "", get href() { return href; },
        set href(value: string) { href = value; hrefWrites++; } };
    },
    documentElement: { appendChild: (link: any) => elements.set(link.id, link) },
  };
  return { doc, elements, writes: () => hrefWrites, register: () => context.exports.registerLLMStyles({ document: doc }) };
}

describe("native context panel stylesheet registration", () => {
  const id = `${config.addonRef}-styles`;
  const katexID = `${config.addonRef}-katex-styles`;
  const href = `chrome://${config.addonRef}/content/zoteroPane.css?v=${encodeURIComponent(version)}`;

  it("loads versioned main CSS and the existing KaTeX resource for a new window", () => {
    const h = documentHarness(); h.register();
    assert.equal(h.elements.get(id).href, href);
    assert.equal(h.elements.get(katexID).href, `chrome://${config.addonRef}/content/vendor/katex/katex.min.css`);
    assert.equal(h.elements.size, 2);
  });

  for (const previous of ["", "?v=3.10.5-papers.1"]) {
    it(`upgrades a retained ${previous || "unversioned"} link without duplicating sheets`, () => {
      const h = documentHarness();
      const old = h.doc.createElement(); old.id = id;
      old.href = `chrome://${config.addonRef}/content/zoteroPane.css${previous}`;
      h.doc.documentElement.appendChild(old);
      h.register();
      assert.strictEqual(h.elements.get(id), old);
      assert.equal(old.href, href);
      const katex = h.elements.get(katexID), writes = h.writes();
      h.register();
      assert.equal(h.writes(), writes);
      assert.strictEqual(h.elements.get(katexID), katex);
      assert.equal(h.elements.size, 2);
    });
  }
});
