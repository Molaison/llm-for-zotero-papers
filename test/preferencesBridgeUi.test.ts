import { assert } from "chai";
import { describe, it } from "mocha";
import { readFileSync } from "node:fs";
import { t } from "../src/utils/i18n";
import { getOriginalPermissionOptions } from "../src/shared/permissionOptions";
import ts from "typescript";

// Exercise the shipped nested refresh bodies without importing the Zotero
// preferences window or launching its backends. This is not live GUI evidence.
function refreshHarness(name: string) {
  const source = ts.createSourceFile(
    "preferenceScript.ts",
    readFileSync("src/modules/preferenceScript.ts", "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  let body = "";
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) {
      body = node.initializer!.getText(source);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.isNotEmpty(body);
  const state = { enabled: false, applied: 0 };
  const select = {
    disabled: false,
    value: "customized",
    setAttribute: () => {},
    replaceChildren: () => {},
  };
  const button = { disabled: false };
  const status = { textContent: "", style: { color: "" }, title: "" };
  const requests: Array<(value: unknown) => void> = [];
  const fetchCatalog = () => new Promise((resolve) => requests.push(resolve));
  const deps = {
    CLAUDE_CUSTOMIZED_MODEL_OPTION_KEY: "customized",
    isCodexAppServerModeEnabled: () => state.enabled,
    isClaudeCodeModeEnabled: () => state.enabled,
    codexPermissionProfileSelect: select,
    codexPermissionProfileRefresh: button,
    codexPermissionProfileStatus: status,
    agentPermissionModeSelect: select,
    claudePermissionModeRefresh: button,
    claudePermissionModeStatus: status,
    claudeCodeModelSelect: select,
    claudeCodeModelRefreshButton: button,
    claudeCodeModelStatus: status,
    claudeCodeCustomModelInput: null,
    doc: { activeElement: null },
    getCodexPermissionOptionCatalog: fetchCatalog,
    fetchClaudePermissionModeCatalog: fetchCatalog,
    fetchClaudeModelCatalog: fetchCatalog,
    getConfiguredCodexAppServerBinaryPath: () => "unused",
    getClaudeBridgeUrl: () => "unused",
    getClaudeSettingSourcesByPref: () => [],
    getClaudeRuntimeModelPref: () => "unused",
    getClaudePermissionModePref: () => "default",
    getCodexPermissionStatusText: () => "unused",
    shouldPreserveClaudeCustomModelDraft: () => false,
    reconcileClaudePermissionMode: () => ({ selectedId: "default" }),
    setClaudePermissionModePref: () =>
      assert.fail("unexpected preference write"),
    renderPermissionPreferenceOptions: () => {
      state.applied++;
      return true;
    },
    buildClaudeModelPreferenceOptions: () => [],
    syncClaudeModelPreferenceUi: () => {
      state.applied++;
    },
    renderClaudeModelCatalogStatus: (text: string) => {
      status.textContent = text;
    },
    refreshAgentRowSummaries: () => {},
    t: (text: string) => text,
  };
  const compiled = ts.transpileModule(`const refresh = ${body};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const refresh = new Function(
    ...Object.keys(deps),
    `let codexPermissionRefreshId = 0, claudePermissionRefreshId = 0,
      claudeModelCatalogRequestId = 0, currentCodexPermissionCatalog = null,
      claudeModelPreferenceOptions = [];
     ${compiled}; return refresh;`,
  )(...Object.values(deps)) as () => Promise<void>;
  const catalog = {
    models: [],
    options: [],
    selectedKey: "default",
    state: { boundary: { kind: "profile", profileId: "default" } },
    capabilities: { profiles: [], protocol: "profiles" },
  };
  return { state, select, button, status, requests, refresh, catalog };
}

describe("bridge settings UI behavior", function () {
  for (const name of [
    "refreshCodexPermissionOptions",
    "refreshClaudePermissionOptions",
    "refreshClaudeModelSuggestions",
  ]) {
    it(`${name}: disabled mode never requests a catalog`, async function () {
      const h = refreshHarness(name);
      await h.refresh();
      assert.lengthOf(h.requests, 0);
      assert.isTrue(h.select.disabled);
      assert.isTrue(h.button.disabled);
      assert.include(h.status.textContent, "off");
    });

    it(`${name}: disable invalidates old results and re-enable refreshes`, async function () {
      const h = refreshHarness(name);
      h.state.enabled = true;
      const old = h.refresh();
      assert.lengthOf(h.requests, 1);
      h.state.enabled = false;
      await h.refresh();
      h.state.enabled = true;
      const current = h.refresh();
      assert.lengthOf(h.requests, 2);
      h.requests[0](h.catalog);
      await old;
      assert.equal(h.state.applied, 0);
      assert.isTrue(h.select.disabled);
      assert.isTrue(h.button.disabled);
      h.requests[1](h.catalog);
      await current;
      assert.equal(h.state.applied, 1);
      assert.isFalse(h.select.disabled);
      assert.isFalse(h.button.disabled);
    });
  }
  it("translates model input mode preference strings in Chinese locale", function () {
    const globalWithZotero = globalThis as typeof globalThis & {
      Zotero?: { locale?: string };
    };
    const previousZotero = globalWithZotero.Zotero;
    globalWithZotero.Zotero = { locale: "zh-CN" };

    try {
      assert.equal(t("Input mode"), "输入模式");
      assert.equal(t("Text only"), "仅文本");
      assert.equal(t("Vision allowed"), "允许视觉");
      assert.equal(
        t(
          "Temperature: randomness (0–2)  ·  Edited Max tokens and set Input cap override detected/default limits  ·  Input mode: auto/text-only/vision",
        ),
        "温度：随机性 (0–2)  ·  编辑后的最大 Token 数和已设置的输入上限会覆盖检测值/默认值  ·  输入模式：自动/仅文本/视觉",
      );
      assert.equal(
        t(
          "Temperature: randomness (0–2)  ·  Edited Max tokens and set Input cap override detected/default limits",
        ),
        "温度：随机性 (0–2)  ·  编辑后的最大 Token 数和已设置的输入上限会覆盖检测值/默认值",
      );
    } finally {
      if (previousZotero) {
        globalWithZotero.Zotero = previousZotero;
      } else {
        delete globalWithZotero.Zotero;
      }
    }
  });

  it("translates the Original Agent permission instructions precisely", function () {
    const globalWithZotero = globalThis as typeof globalThis & {
      Zotero?: { locale?: string };
    };
    const previousZotero = globalWithZotero.Zotero;
    globalWithZotero.Zotero = { locale: "zh-CN" };

    try {
      assert.equal(t("Original Agent Mode"), "原生 Agent 模式");
      assert.equal(t("Permission mode"), "权限模式");
      const options = getOriginalPermissionOptions();
      const safe = options.find(
        (option) => option.selectionKey === "original:safe",
      )!;
      assert.equal(
        t(safe.description),
        "所有外部写入（包括创建新笔记）在执行前都会显示以供审核。读取操作无需审核。",
      );
      // Reading the English text from the option catalog keeps the Chinese
      // string from silently falling back to English when the copy changes.
      const yolo = options.find(
        (option) => option.selectionKey === "original:yolo",
      )!;
      assert.equal(
        t(yolo.description),
        "原生 Agent 执行操作时不会请求权限确认或调用审批模型，包括有歧义或危险的操作。用户要求的审核流程、执行完整性及所发现论文的选择卡片仍然有效。Claude Code、Codex 和外部 MCP 调用方保留各自的权限控制。",
      );
    } finally {
      if (previousZotero) {
        globalWithZotero.Zotero = previousZotero;
      } else {
        delete globalWithZotero.Zotero;
      }
    }
  });

  it("groups Original Agent controls and Tavily in one card", function () {
    const preferences = readFileSync("addon/content/preferences.xhtml", "utf8");
    const originalAgentCardStart = preferences.indexOf(
      'id="__addonRef__-original-agent-card"',
    );
    const originalAgentCardEnd = preferences.indexOf(
      'id="__addonRef__-codex-app-server-card"',
    );
    const originalAgentCard = preferences.slice(
      originalAgentCardStart,
      originalAgentCardEnd,
    );

    assert.isAtLeast(originalAgentCardStart, 0);
    assert.isAbove(originalAgentCardEnd, originalAgentCardStart);
    assert.include(originalAgentCard, 'id="__addonRef__-enable-agent-mode"');
    assert.include(
      originalAgentCard,
      'id="__addonRef__-original-agent-permission-mode"',
    );
    assert.include(originalAgentCard, 'id="__addonRef__-tavily-card"');
  });
});
