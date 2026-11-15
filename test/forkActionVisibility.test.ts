import { assert } from "chai";
import {
  resolveForkActionConversationSystem,
  shouldShowForkActionForAssistantTurn,
} from "../src/modules/contextPanel/forkActionVisibility";
import type { Message } from "../src/modules/contextPanel/types";

const globalScope = globalThis as typeof globalThis & {
  Zotero?: unknown;
};

function paperItem(id: number): Zotero.Item {
  return {
    id,
    libraryID: 1,
    isAttachment: () => false,
    isNote: () => false,
    isRegularItem: () => true,
  } as unknown as Zotero.Item;
}

function noteItem(id: number): Zotero.Item {
  return {
    id,
    libraryID: 1,
    isAttachment: () => false,
    isNote: () => true,
    getDisplayTitle: () => "Test note",
  } as unknown as Zotero.Item;
}

function bodyWithConversationSystem(system: string): Element {
  const panelRoot = { dataset: { conversationSystem: system } };
  return {
    querySelector: (selector: string) =>
      selector === "#llm-main" ? panelRoot : null,
  } as unknown as Element;
}

function message(role: "user" | "assistant", timestamp: number): Message {
  return {
    role,
    text: role === "user" ? "Question" : "Answer",
    timestamp,
  };
}

describe("fork action visibility", function () {
  const originalZotero = globalScope.Zotero;

  before(function () {
    globalScope.Zotero = {
      Items: { get: () => null },
      getMainWindow: () => null,
      getActiveZoteroPane: () => null,
    };
  });

  after(function () {
    if (originalZotero === undefined) {
      delete globalScope.Zotero;
    } else {
      globalScope.Zotero = originalZotero;
    }
  });

  it("shows fork for an ordinary upstream paper item using the panel system", function () {
    const item = paperItem(42);
    const visible = shouldShowForkActionForAssistantTurn({
      body: bodyWithConversationSystem("upstream"),
      item,
      assistantTimestamp: 200,
      assistantMessage: message("assistant", 200),
      history: [message("user", 100), message("assistant", 200)],
    });

    assert.isTrue(visible);
  });

  it("falls back to storage routing for ordinary default paper items", function () {
    const item = paperItem(42);

    assert.equal(resolveForkActionConversationSystem({ item }), "upstream");
    assert.isTrue(
      shouldShowForkActionForAssistantTurn({
        item,
        assistantTimestamp: 200,
        assistantMessage: message("assistant", 200),
        history: [message("user", 100), message("assistant", 200)],
      }),
    );
  });

  it("keeps note editing sessions hidden even when a panel system is present", function () {
    const item = noteItem(123);

    for (const system of ["upstream", "codex"]) {
      assert.isFalse(
        shouldShowForkActionForAssistantTurn({
          body: bodyWithConversationSystem(system),
          item,
          assistantTimestamp: 200,
          assistantMessage: message("assistant", 200),
          history: [message("user", 100), message("assistant", 200)],
        }),
      );
    }
  });

  it("keeps Codex visibility limited to the latest assistant turn", function () {
    const item = paperItem(42);
    const body = bodyWithConversationSystem("codex");
    const history = [
      message("user", 100),
      message("assistant", 200),
      message("user", 300),
      message("assistant", 400),
    ];

    assert.isFalse(
      shouldShowForkActionForAssistantTurn({
        body,
        item,
        assistantTimestamp: 200,
        assistantMessage: history[1],
        history,
      }),
    );
    assert.isTrue(
      shouldShowForkActionForAssistantTurn({
        body,
        item,
        assistantTimestamp: 400,
        assistantMessage: history[3],
        history,
      }),
    );
  });
});
