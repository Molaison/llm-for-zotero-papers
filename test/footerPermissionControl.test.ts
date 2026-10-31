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

  it("keeps the permission selector in the tools body and the context gauge with the model controls", function () {
    const buildUi = readFileSync("src/modules/contextPanel/buildUI.ts", "utf8");

    assert.include(buildUi, "footerControls.append(permissionControl)");
    assert.include(buildUi, "statusBar.append(statusLine, statusToggle)");
    assert.include(
      buildUi,
      "modelControls.append(modelDropdown, reasoningDropdown, contextUsageControl)",
    );
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

  it("keeps run status fully readable while utility status can expand on demand", function () {
    const css = readFileSync("addon/content/zoteroPane.css", "utf8");

    assert.match(
      css,
      /\.llm-status-control\s*\{[^}]*display: flex;[^}]*align-items: center;/,
    );
    assert.match(
      css,
      /\.llm-status-control > \.llm-status\s*\{[^}]*clip-path: inset\(50%\);[^}]*white-space: nowrap;/,
    );
    assert.match(
      css,
      /\.llm-status-control:not\(\.llm-run-status-strip\):hover\s*>\s*\.llm-status:not\(:empty\),\s*\.llm-status-control:not\(\.llm-run-status-strip\):focus-within\s*>\s*\.llm-status:not\(:empty\)\s*\{[^}]*white-space: normal;/,
    );
    assert.match(
      css,
      /\.llm-run-status-strip > \.llm-status\s*\{[^}]*position: static;[^}]*clip-path: none;[^}]*white-space: normal;[^}]*overflow-wrap: anywhere;/,
    );
    assert.match(
      css,
      /\.llm-footer-controls\s*\{[^}]*display: flex;[^}]*align-items: center;/,
    );
  });
});
