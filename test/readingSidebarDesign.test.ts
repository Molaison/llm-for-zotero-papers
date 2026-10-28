import { clearInactivePaperContextHint, setStatus } from "../src/modules/contextPanel/textUtils";
import { formatPaperContextChipLabel } from "../src/modules/contextPanel/setupHandlers/controllers/composeContextController";
import { t } from "../src/utils/i18n";
import { getPaperChatStartPageHtml, getStandaloneLibraryChatStartPageHtml } from "../src/utils/i18n";
import { assert } from "chai";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { FakeElement } from "./helpers/fakeDom";
import { createElement } from "../src/utils/domHelpers";
import * as constants from "../src/modules/contextPanel/constants";
import { conversationScopeLabel } from "../src/modules/contextPanel/standaloneTabLabel";

// Execute the actual UI builder, isolating only Zotero conversation/runtime
// resolution; the DOM hierarchy and action IDs come from production code.
const source = ts.createSourceFile("buildUI.ts", readFileSync("src/modules/contextPanel/buildUI.ts", "utf8"), ts.ScriptTarget.Latest, true);
const functions = source.statements.filter(n => ts.isFunctionDeclaration(n));
const compiled = ts.transpileModule(functions.map(n => n.getText(source)).join("\n") + "\nexports.buildUI = buildUI;", { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
function build(mode: "paper" | "global" = "paper", hasItem = true) {
  let focused: FakeElement | undefined;
  class Node extends FakeElement {
    get ownerDocument() { return doc; }
    focus() { focused = this; }
    prepend(...children: FakeElement[]) {
      for (const child of children.reverse()) this.insertBefore(child, this.children[0] || null);
    }
  }
  const doc = { createElementNS: (_ns: string, tag: string) => new Node(tag), defaultView: { HTMLElement: Node } };
  const exports = {} as { buildUI: (body: unknown, item: unknown) => void };
  runInNewContext(compiled, {
    ...constants, exports, createElement, conversationScopeLabel, HTMLElement: Node, t: (s: string) => s,
    resolveActiveNoteSession: () => null,
    resolveDisplayConversationKind: () => mode,
    getConversationKey: () => 7,
    resolveConversationBaseItem: () => ({id: 7}),
    resolvePreferredConversationSystem: () => "chat",
    resolveSidebarChatModeToggleState: () => ({activeTab: "paper", paperTabLabel: "Paper chat", libraryTabLabel: "Library chat", disabled: false}),
    createSidebarModeSwitch: () => new Node("div"),
    createRuntimeSystemControls: () => ({group: new Node("div")}),
    createTaskProgressCurtain: () => new Node("div"),
    createChatLatestButton: () => new Node("button"),
    getBaseSlashMenuItems: () => ["upload", "reference", "pdfPage", "pdfMultiplePages"],
    resolveSlashActionChatMode: () => "paper",
    buildContextUsagePresentation: () => ({title: "Usage", label: "Usage", summary: "", detail: ""}),
  });
  const body = new Node("div");
  exports.buildUI(body, hasItem ? {id: 7, libraryID: 1} : null);
  const all = (node: FakeElement): FakeElement[] => [node, ...node.children.flatMap(all)];
  const find = (id: string) => all(body).find(n => n.id === id)!;
  return { body, all: all(body), find, focused: () => focused };
}

describe("reading sidebar design system", () => {
  it("keeps original entry IDs, one Send and a complete context/input/footer composer", () => {
    const h = build();
    for (const id of ["llm-send", "llm-input", "llm-paper-chat-tab", "llm-library-chat-tab", "llm-history-toggle", "llm-history-new", "llm-remote-history", "llm-settings", "llm-popout", "llm-export", "llm-clear", "llm-model-toggle", "llm-reasoning-toggle", "llm-select-text", "llm-screenshot", "llm-slash-upload-option", "llm-slash-reference-option", "llm-paper-context-preview", "llm-selected-context-list"])
      assert.exists(h.find(id), id);
    assert.lengthOf(h.all.filter(n => n.id === "llm-send"), 1);
    assert.equal(h.find("llm-send").getAttribute("aria-label"), "Send");
    assert.isTrue(h.find("llm-send").classList.contains("llm-action-icon-only"));
    const config = h.find("llm-model-controls");
    assert.strictEqual(h.find("llm-model-dropdown").parentElement, config);
    assert.strictEqual(h.find("llm-reasoning-dropdown").parentElement, config);
    assert.isTrue(config.parentElement!.classList.contains("llm-actions"));
    assert.strictEqual(config.parentElement!.parentElement, h.find("llm-compose-area"));
    assert.strictEqual(h.find("llm-context-previews").parentElement, h.find("llm-compose-area"));
    assert.strictEqual(h.find("llm-input").nextSibling, h.find("llm-status").parentElement);
    assert.strictEqual(h.find("llm-status").parentElement!.nextSibling, config.parentElement);
    assert.strictEqual(h.find("llm-history-bar").parentElement!.parentElement,
      h.find("llm-header-runtime-controls").parentElement!.parentElement);
    assert.isFalse(h.find("llm-model-dropdown").parentElement!.classList.contains("llm-actions-left"));
    assert.isNotEmpty(h.find("llm-input").getAttribute("aria-label"));
  });
  it("keeps every prompt action under a default-closed native disclosure", () => {
    const h = build(), disclosure = h.find("llm-shortcuts-disclosure");
    assert.isFalse(disclosure.open);
    assert.equal(disclosure.children[0].textContent, "Quick questions");
    assert.strictEqual(h.find("llm-shortcuts").parentElement, disclosure);
    assert.strictEqual(disclosure.parentElement!.parentElement, h.find("llm-conversation-tools"));
  });
  it("folds advanced tools without removing them and Escape returns focus to disclosure", () => {
    const h = build(), tools = h.find("llm-conversation-tools");
    assert.isFalse(tools.open);
    assert.equal(tools.children[0].textContent, "…");
    assert.equal(tools.children[0].title, "More actions");
    assert.equal(tools.children[0].getAttribute("aria-label"), "More actions");
    for (const id of ["llm-popout", "llm-settings", "llm-remote-history", "llm-restore-history", "llm-export", "llm-clear"])
      assert.strictEqual(h.find(id).parentElement!.parentElement, tools);
    tools.open = true;
    tools.dispatchFakeEvent("keydown", {key: "Escape"});
    assert.isFalse(tools.open);
    assert.strictEqual(h.focused(), tools.children[0]);
    const css = readFileSync("addon/content/zoteroPane.css", "utf8");
    const icons = /\.llm-conversation-tools-body > button::before\s*\{([^}]+)\}/.exec(css)![1];
    assert.include(icons, "content: none");
    assert.include(icons, "display: none");
    const rows = /\.llm-header-actions \.llm-conversation-tools-body > button\s*\{([^}]+)\}/.exec(css)![1];
    assert.include(rows, "text-align: start");

  });
  it("owns host-themed surfaces, content-sized controls, focus and reduced motion in the main stylesheet", () => {
    const css = readFileSync("addon/content/zoteroPane.css", "utf8");
    assert.include(css, "--llm-ui-surface: var(--llm-slate1)");
    assert.include(css, "--llm-ui-accent: var(--llm-indigo9)");
    assert.include(css, "@media (prefers-reduced-motion: reduce)");
    assert.include(css, 'summary, select, textarea, input[type="checkbox"]):focus-visible');
    const config = /\.llm-model-controls\s*\{([^}]+)\}/.exec(css)![1];
    assert.include(config, "flex-wrap: nowrap");
    assert.match(css, /\.llm-actions\s*\{[^}]*grid-template-columns: auto minmax\(0, 1fr\) auto;/);
    assert.match(css, /\.llm-compose-area\s*\{[^}]*border-radius: 20px/);
    assert.match(css, /\.llm-input\s*\{[^}]*appearance: none;[^}]*border: none;/);
    const primary = /\.llm-action-btn-primary\s*\{([^}]+)\}/.exec(css)![1];
    assert.include(primary, "background: var(--llm-slate12)");
    const bubble = /\.llm-bubble\.user\s*\{([^}]+)\}/.exec(css)![1];
    assert.include(bubble, "background: var(--llm-slate3)");
    assert.notInclude(css, ".llm-model-btn.llm-model-btn-collapsed::after");
  });
  it("owns dark input hints and header mask ink without requiring a native dark control theme", () => {
    const css = readFileSync("addon/content/zoteroPane.css", "utf8");
    const body = (selector: string) => {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(escaped + "\\s*\\{([^}]+)\\}").exec(css)![1];
    };
    assert.include(body(".llm-btn-icon"), "color: var(--llm-slate12)");
    for (const name of ["settings", "popout"]) {
      const icon = body(`.llm-${name}-btn::before`);
      assert.include(icon, "background-color: currentColor");
      assert.include(icon, `mask-image: url("icons/action-${name}.svg")`);
    }
    for (const selector of [".llm-input", ".llm-standalone-search-input", ".llm-history-menu-search-input"]) {
      const hint = body(selector + "::placeholder");
      assert.include(hint, "color: var(--llm-slate11) !important");
      assert.include(hint, "opacity: 1");
    }
    assert.match(css, /\.llm-input\s*\{[^}]*color: var\(--llm-ui-ink\);[^}]*caret-color: var\(--llm-ui-ink\);/);
    assert.include(body(".llm-action-btn-primary"), "color: var(--llm-slate1)");
  });

  it("keeps full model metadata in a folded footer rather than a heading above every answer", () => {
    const chat = readFileSync("src/modules/contextPanel/chat.ts", "utf8");
    assert.include(chat, 'const modelHeader = doc.createElement("details")');
    assert.include(chat, 'modelSummary.setAttribute("aria-label", t("Model"))');
    assert.include(chat, 'if (modelDetails) meta.appendChild(modelDetails)');
    assert.notInclude(chat, 'bubbleHeaderNodes.push(modelHeader)');
  });

  it("uses short paper/library empty states without removing the original settings action", () => {
    const previous = (globalThis as any).Zotero;
    try {
      for (const locale of ["zh-CN", "en-US"]) {
        (globalThis as any).Zotero = {...previous, locale, Prefs: {get: () => locale}};
        for (const html of [getPaperChatStartPageHtml(), getStandaloneLibraryChatStartPageHtml()]) {
          assert.notInclude(html, "MinerU");
          assert.notInclude(html, "<ol");
          assert.notInclude(html, "llm-start-page-title");
          assert.lengthOf([...html.matchAll(/<p /g)], 1);
        }
      }
    } finally { (globalThis as any).Zotero = previous; }
    assert.exists(build().find("llm-settings"));
  });

  it("clears only the initial inactive-paper hint and keeps real request/error statuses", () => {
    const hint = t("No active paper context. Type / to add papers.");
    const el = {className: "llm-status", textContent: hint} as HTMLElement;
    clearInactivePaperContextHint(el);
    assert.equal(el.textContent, "");
    for (const variant of ["error", "warning", "sending"]) {
      const status = {className: `llm-status llm-status-${variant}`, textContent: hint} as HTMLElement;
      clearInactivePaperContextHint(status);
      assert.equal(status.textContent, hint);
    }
    el.className = "llm-status"; el.textContent = "Connection failed";
    clearInactivePaperContextHint(el);
    assert.equal(el.textContent, "Connection failed");
    const handlers = readFileSync("src/modules/contextPanel/setupHandlers.ts", "utf8");
    assert.include(handlers, 'if (mode === "paper" && status) clearInactivePaperContextHint(status)');
  });
  it("uses concise paper prompts and a translated metadata-free PDF chip", () => {
    assert.equal(build().find("llm-input").placeholder, "Ask about this paper…");
    const previous = (globalThis as any).Zotero;
    try {
      (globalThis as any).Zotero = {...previous, locale: "zh-CN", Prefs: {get: () => "zh-CN"}};
      assert.equal(t("Ask about this paper…"), "询问这篇论文…");
      assert.equal(formatPaperContextChipLabel({itemId: 1, contextItemId: 1, title: "Fixture"}, "pdf"), "论文/PDF");
    } finally { (globalThis as any).Zotero = previous; }
  });
  it("reveals turn ticks only on the existing rail hover or keyboard focus", () => {
    const css = readFileSync("addon/content/zoteroPane.css", "utf8");
    assert.match(css, /\.llm-turn-navigator\s*\{[^}]*opacity: 0;/);
    assert.match(css, /\.llm-turn-navigator:hover,\s*\.llm-turn-navigator:focus-within\s*\{[^}]*opacity: 1;/);
    assert.notMatch(css, /\.llm-turn-navigator\s*\{[^}]*(?:visibility: hidden|display: none)/);
  });

  it("omits default Ready on first paper render and updates, without hiding useful statuses", () => {
    assert.equal(build().find("llm-status").textContent, "");
    const node = {className: "llm-status", textContent: ""} as HTMLElement;
    setStatus(node, t("Ready"), "ready");
    assert.equal(node.textContent, "");
    for (const level of ["error", "warning", "sending"] as const) {
      setStatus(node, t("Ready"), level);
      assert.equal(node.textContent, t("Ready"));
    }
    setStatus(node, "批注已写回", "ready");
    assert.equal(node.textContent, "批注已写回");
    const css = readFileSync("addon/content/zoteroPane.css", "utf8");
    assert.include(css, ".llm-status:empty + .llm-status-toggle { display: none; }");
    assert.include(css, ".llm-annotation-summary { display: none; }");
  });

  it("starts global chat with an idle footer but preserves the no-item guidance", () => {
    assert.equal(build("global").find("llm-status").textContent, "");
    assert.equal(build("global").find("llm-input").placeholder, "Ask a research question…");
    assert.equal(build("paper", false).find("llm-status").textContent, "Select an item or open a PDF");
    assert.equal(build("global", false).find("llm-status").textContent, "Select an item or open a PDF");
  });

  it("aligns moved capture actions with base add-menu rows without changing toolbar buttons", () => {
    const h = build();
    for (const id of ["llm-select-text", "llm-screenshot"]) {
      assert.strictEqual(h.find(id).parentElement, h.find("llm-slash-upload-option").parentElement);
      assert.isTrue(h.find(id).classList.contains("llm-action-picker-item"));
    }
    const css = readFileSync("addon/content/zoteroPane.css", "utf8");
    const rule = /#llm-slash-menu #llm-select-text,\s*#llm-slash-menu #llm-screenshot\s*\{([^}]+)\}/.exec(css)![1];
    for (const declaration of ["display: flex", "justify-content: flex-start", "text-align: left", "box-sizing: border-box", "width: 100%", "height: auto", "min-height: 0", "padding: 5px 8px", "font: inherit"])
      assert.include(rule, declaration);
  });

  it("gives the context entry a visible semantic border without changing its outer dimensions", () => {
    const css = readFileSync("addon/content/zoteroPane.css", "utf8");
    const rule = /\.llm-context-gauge\s*\{([^}]+)\}/.exec(css)![1];
    for (const declaration of ["box-sizing: border-box", "width: var(--llm-fs-11)", "height: var(--llm-fs-11)", "border: 0.5px solid var(--llm-slate9)"])
      assert.include(rule, declaration);
  });

  it("keeps request settings together and reserves a separate composer row for full status text", () => {
    const h = build(), config = h.find("llm-model-controls"), row = config.parentElement!;
    const usage = h.find("llm-context-gauge").parentElement!;
    assert.strictEqual(usage.parentElement, config);
    assert.strictEqual(h.find("llm-reasoning-dropdown").nextSibling, usage);
    assert.strictEqual(h.find("llm-source-shortcut").parentElement!.parentElement, row);
    assert.strictEqual(h.find("llm-source-control").parentElement, h.find("llm-paper-bar"));
    assert.strictEqual(h.find("llm-chat-shell").parentElement, h.find("llm-reading-workspace"));
    assert.strictEqual(h.find("llm-paper-context-preview").parentElement!.parentElement, h.find("llm-source-control"));
    for (const id of ["llm-select-text", "llm-screenshot"])
      assert.strictEqual(h.find(id).parentElement!.parentElement, h.find("llm-slash-menu"));
    assert.strictEqual(h.find("llm-status").nextSibling, h.find("llm-status-toggle"));
    assert.strictEqual(h.find("llm-status-toggle").parentElement!.parentElement, h.find("llm-compose-area"));
    assert.equal(h.find("llm-status-toggle").getAttribute("aria-describedby"), "llm-status");
    const source = h.find("llm-source-control"); source.open = true;
    source.dispatchFakeEvent("keydown", {key:"Escape"});
    assert.isFalse(source.open); assert.strictEqual(h.focused(), h.find("llm-source-toggle"));
  });

});
