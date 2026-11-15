import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { assert } from "chai";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Namespace hygiene for chat.ts buttons in Zotero's mixed XUL/XHTML document.
 * Every <button> in chat.ts should be created in the XHTML namespace so the
 * plugin's CSS applies consistently.
 */
describe("chat.ts button namespace hygiene", function () {
  const source = readFileSync(
    resolve(here, "../src/modules/contextPanel/chat.ts"),
    "utf8",
  );

  it("never creates <button> elements in the default (XUL) namespace", function () {
    const plain =
      source.match(/createElement\((?=[^)]*["']button["'])[^)]*\)/g) || [];
    assert.deepEqual(
      plain,
      [],
      'chat.ts must not use createElement(...) to create buttons — use createElementNS(HTML_NS, "button") so CSS applies in Zotero\'s XUL document',
    );
  });

  it("creates every <button> via the XHTML namespace and imports HTML_NS", function () {
    assert.include(
      source,
      'import { HTML_NS } from "../../utils/domHelpers"',
      "chat.ts must import HTML_NS from domHelpers",
    );
    const namespaced =
      source.match(/createElementNS\(\s*HTML_NS\s*,\s*"button"\s*,?\s*\)/g) ||
      [];
    assert.isAtLeast(
      namespaced.length,
      12,
      "all chat button creations should be namespaced",
    );
  });
});
