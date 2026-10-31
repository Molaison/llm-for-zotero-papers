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

    assert.include(buildUi, "historyBar.append(historyNewBtn, historyToggle)");
    assert.include(buildUi, "headerRuntimeControls.append(toggleRow, modeSwitch)");
    assert.include(buildUi, "headerInfo.append(title, headerRuntimeControls)");
    assert.include(buildUi, "headerActions.append(historyBar, conversationTools)");
    assert.include(buildUi, "headerTop.append(headerNavRow)");
    assert.include(buildUi, "clearBtn, runtimeSystemControls.group)", "runtime systems remain reachable in More");
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
