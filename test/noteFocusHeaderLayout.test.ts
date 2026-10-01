import { assert } from "chai";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));

function source(path: string): string {
  return readFileSync(resolve(testDir, "..", path), "utf8");
}

describe("note focus header layout", function () {
  it("reuses the paper/library header controls for note focus", function () {
    const buildUi = source("src/modules/contextPanel/buildUI.ts");
    const setupHandlers = source("src/modules/contextPanel/setupHandlers.ts");

    assert.include(
      buildUi,
      "historyBar.append(historyNewBtn, historyToggle, headerRuntimeControls)",
      "note focus must keep the same +, history, runtime order as normal chat",
    );
    // Independent: the divider, then the runtime icons (the toggle is its own
    // row above). Stacked: the mode chip in the divider's place, one row.
    // Both are always built; CSS picks one from the root layout attribute.
    assert.match(
      buildUi,
      /headerRuntimeControls\.append\(\s*runtimeDivider,\s*modeSwitch,\s*runtimeSystemControls\.group,?\s*\)/,
      "runtime icons must follow the divider (Independent) or the chip (Stacked)",
    );
    assert.include(buildUi, "headerTop.append(toggleRow, headerNavRow)");
    assert.include(buildUi, "resolveSidebarChatModeToggleState");
    assert.include(setupHandlers, "resolveSidebarChatModeToggleState");
    // Both render paths label the paper slot through the shared resolver,
    // which yields "Note chat" for note sessions, in the tabs and the chip.
    assert.include(buildUi, "t(chatModeToggle.paperTabLabel)");
    assert.include(setupHandlers, "t(state.paperTabLabel)");
    assert.match(
      buildUi,
      /createSidebarModeSwitch\(\s*doc,\s*\{[^}]*paperLabel: t\(chatModeToggle\.paperTabLabel\)/,
      "the chip takes the paper slot's label from the same resolver",
    );
    assert.include(setupHandlers, "syncSidebarModeSwitch(modeSwitch, {");
    assert.notInclude(
      setupHandlers,
      'historyNewBtn.style.display = noteSession ? "none" : ""',
      "note focus must not hide the normal new-chat button",
    );
    assert.notInclude(
      setupHandlers,
      'historyToggleBtn.style.display = noteSession ? "none" : ""',
      "note focus must not hide the normal history button",
    );
  });
});
