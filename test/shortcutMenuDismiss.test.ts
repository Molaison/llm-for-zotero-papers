import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "chai";
import { describe, it } from "mocha";

const here = dirname(fileURLToPath(import.meta.url));

function readSource(relativePath: string): string {
  return readFileSync(resolve(here, relativePath), "utf8");
}

describe("shortcut menu dismissal", function () {
  it("dismisses shortcut menus for clicks in the shortcut bar outside the menu", function () {
    const source = readSource(
      "../src/modules/contextPanel/setupHandlers/controllers/floatingMenuInteractionController.ts",
    );
    const shortcutLoopStart = source.indexOf(
      "for (const shortcutMenuEl of shortcutMenus)",
    );
    const nonLeftClickGuard = source.indexOf(
      "if (mouseEvent.button !== 0) return;",
      shortcutLoopStart,
    );
    const shortcutLoop = source.slice(shortcutLoopStart, nonLeftClickGuard);

    assert.include(shortcutLoop, "shortcutMenuEl.contains(target)");
    assert.include(shortcutLoop, "closeShortcutMenu(shortcutMenuEl);");
    assert.notInclude(shortcutLoop, "#llm-shortcuts");
    assert.notInclude(shortcutLoop, "shortcutsEl?.contains(target)");
  });
});
