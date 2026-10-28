import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { FakeElement } from "../test/helpers/fakeDom.ts";
import {
  getNoPaperStartPageHtml,
  getPaperChatStartPageHtml,
  getNoteEditingStartPageHtml,
  getStandaloneLibraryChatStartPageHtml,
} from "../src/utils/i18n.ts";

// Same source-execution seam as readingSidebarDesign.test.ts: run the real
// renderer with only host, persistence and scroll dependencies substituted.
const file = ts.createSourceFile(
  "chat.ts",
  readFileSync("src/modules/contextPanel/chat.ts", "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
const render = file.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === "refreshChat",
);
const compiled = ts.transpileModule(render.getText(file), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText;

function fixture({
  item = { id: 7 },
  mode = "paper",
  failed = false,
  blocked = false,
  loading = false,
} = {}) {
  const exports = {};
  class Node extends FakeElement {
    get ownerDocument() {
      return doc;
    }
    querySelector(selector) {
      if (selector.startsWith("#")) return this.findId(selector.slice(1));
      return super.querySelector(selector);
    }
    findId(id) {
      return this.id === id
        ? this
        : this.children.map((child) => child.findId(id)).find(Boolean) || null;
    }
  }
  const doc = { createElement: (tag) => new Node(tag) };
  const body = new Node("div"),
    box = new Node("div"),
    root = new Node("div");
  box.id = "llm-chat-box";
  root.id = "llm-main";
  body.append(root);
  root.append(box);
  const history = new Map([[7, []]]),
    errors = new Set(failed ? [7] : []);
  const loaded = new Set([7]),
    pending = new Map(loading ? [[7, Promise.resolve()]] : []);
  let retries = 0;
  runInNewContext(compiled, {
    exports,
    isPanelConversationCurrent: () => true,
    initializeChatScrollViewport() {},
    setPromptMenuTarget() {},
    getNoPaperStartPageHtml,
    getPaperChatStartPageHtml,
    getNoteEditingStartPageHtml,
    getStandaloneLibraryChatStartPageHtml,
    writeChatScrollTop() {},
    syncConversationTurnNavigator() {},
    getConversationKey: () => 7,
    isGlobalPortalItem: () => mode === "global",
    captureChatScrollForRender: () => ({}),
    filterMessagesInPendingTurns: (_key, entries) => entries,
    resolveTargetedAssistantRerenders: () => ({
      useTargetedRerender: false,
      targetedMessageWrappers: new Map(),
    }),
    chatHistory: history,
    loadedConversationKeys: loaded,
    conversationForkLinks: new Map(),
    conversationHistoryLoadErrors: errors,
    blockedConversationLoadKeys: new Set(blocked ? [7] : []),
    loadingConversationTasks: pending,
    resolveEffectiveRequestConfig: () => ({}),
    resolveActiveNoteSession: () => (mode === "note" ? {} : null),
    t: (value) => value,
    async ensureConversationLoaded() {
      retries++;
      history.set(7, []);
      loaded.add(7);
      errors.delete(7);
    },
    appLogger: { warn() {} },
  });
  exports.refreshChat(body, item);
  return { body, box, errors, loaded, retries: () => retries };
}

const absent = fixture({ item: null });
assert.match(absent.box.innerHTML, /Select a paper or open a PDF/);
assert.doesNotMatch(absent.box.innerHTML, /this paper’s/);
assert.match(fixture().box.innerHTML, /this paper’s methods/);
assert.match(fixture({ mode: "global" }).box.innerHTML, /Add papers with @/);
assert.match(
  fixture({ mode: "note" }).box.innerHTML,
  /Select a passage to revise/,
);

const pending = fixture({ loading: true });
assert.equal(pending.box.children[0].getAttribute("role"), "status");
assert.equal(
  pending.box.children[0].children[0].textContent,
  "Loading conversation…",
);
assert.equal(pending.box.children[0].children.length, 1);

const blocked = fixture({ blocked: true });
assert.match(
  blocked.box.children[0].children[0].textContent,
  /unavailable for the selected paper/,
);
assert.equal(blocked.box.children[0].children.length, 1);

const failed = fixture({ failed: true });
assert.equal(failed.box.children[0].getAttribute("role"), "alert");
assert.match(failed.box.children[0].children[0].textContent, /Could not load/);
const retry = failed.box.children[0].children[1];
assert.equal(retry.textContent, "Retry loading conversation");
await retry.dispatchFakeEventAsync("click");
assert.equal(failed.retries(), 1);
assert.equal(failed.errors.size, 0);
assert.equal(failed.loaded.has(7), true);
assert.match(failed.box.innerHTML, /this paper’s methods/);
console.log(
  "PASS: no-paper, Paper, Library, Note, loading, scope-blocked and failed-history retry states",
);
