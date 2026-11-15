import { assert } from "chai";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const wordWrapIconPath = resolve("addon/content/icons/action-word-wrap.svg");
const sourceCodeIconPath = resolve(
  "addon/content/icons/action-source-code.svg",
);

describe("code-block toolbar SVG icons", function () {
  it("ships the approved turnover-arrow and source-code SVG assets", function () {
    assert.isTrue(existsSync(wordWrapIconPath));
    assert.isTrue(existsSync(sourceCodeIconPath));

    const wordWrapIcon = readFileSync(wordWrapIconPath, "utf8");
    const sourceCodeIcon = readFileSync(sourceCodeIconPath, "utf8");

    assert.equal(wordWrapIcon.match(/<path\b/g)?.length, 2);

    assert.equal(sourceCodeIcon.match(/<path\b/g)?.length, 3);
  });
});
