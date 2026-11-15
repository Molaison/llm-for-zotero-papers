import { assert } from "chai";
import { readFileSync } from "node:fs";
import { positionFloatingMenu } from "../src/modules/contextPanel/setupHandlers/controllers/menuController";

describe("footer permission control", function () {
  it("uses the existing designed confirmation dialog for Codex full access", function () {
    const controller = readFileSync(
      "src/modules/contextPanel/footerPermissionControl.ts",
      "utf8",
    );
    const preferences = readFileSync("src/modules/preferenceScript.ts", "utf8");

    assert.include(controller, "showStandaloneConfirmationDialog");
    assert.include(controller, 'title: t("Enable Codex full access?")');
    assert.include(controller, 'confirmLabel: t("Enable full access")');
    assert.include(controller, "destructive: true");

    assert.include(preferences, "confirmCodexFullAccess");
    assert.include(preferences, '.open(t("Enable Codex full access?"))');
  });

  it("keeps the permission selector and context gauge together on the footer right", function () {
    const buildUi = readFileSync("src/modules/contextPanel/buildUI.ts", "utf8");

    assert.include(
      buildUi,
      "footerControls.append(permissionControl, contextUsageControl)",
    );
    assert.include(buildUi, "statusBar.append(statusLine, footerControls)");
    assert.notInclude(buildUi, "llm-claude-context-gauge");
  });

  it("centers the menu directly above the permission mode", function () {
    const style: Record<string, string> = {};
    const owner = {
      ownerDocument: {
        defaultView: { innerWidth: 400, innerHeight: 600 },
      },
      getBoundingClientRect: () => ({
        left: 0,
        right: 400,
        top: 0,
        bottom: 600,
        width: 400,
        height: 600,
      }),
    } as unknown as Element;
    const menu = {
      style,
      getBoundingClientRect: () => ({ width: 100, height: 120 }),
    } as unknown as HTMLDivElement;
    const anchor = {
      getBoundingClientRect: () => ({
        left: 260,
        right: 300,
        top: 500,
        bottom: 520,
        width: 40,
        height: 20,
      }),
    } as unknown as HTMLButtonElement;

    positionFloatingMenu(owner, menu, anchor, {
      horizontalAlignment: "center",
      verticalPlacement: "above",
    });

    assert.equal(style.left, "230px");
    assert.equal(style.top, "374px");
  });

  it("pins permission and context controls to the first status line", function () {
    const css = readFileSync("addon/content/zoteroPane.css", "utf8");

    assert.match(
      css,
      /\.llm-status-bar\s*\{[\s\S]*?display: grid;[\s\S]*?grid-template-columns: minmax\(0, 1fr\) auto;[\s\S]*?align-items: baseline;/,
    );
    assert.match(
      css,
      /\.llm-status\s*\{[\s\S]*?grid-column: 1;[\s\S]*?grid-row: 1;[\s\S]*?white-space: normal;/,
    );
    assert.match(
      css,
      /\.llm-footer-controls\s*\{[\s\S]*?grid-column: 2;[\s\S]*?grid-row: 1;[\s\S]*?align-self: baseline;/,
    );
  });
});
