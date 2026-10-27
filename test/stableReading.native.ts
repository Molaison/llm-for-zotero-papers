// Native-only replay adapter; bundled separately, never exposed by the plugin.
import { renderAssistantRichText } from "../src/modules/contextPanel/assistantRichText";
import { refreshChat } from "../src/modules/contextPanel/chat";
import { chatHistory } from "../src/modules/contextPanel/state";
import { bindProvisionedConversationKey } from "../src/modules/contextPanel/conversationIdentity";
import { disposeChatScrollViewport } from "../src/modules/contextPanel/chatScrollSnapshots";
import type { Message } from "../src/modules/contextPanel/types";
import { disposeStreamingMarkdown } from "../src/modules/contextPanel/streamingMarkdown";

/** Unsaved local paper has no attachments, collections, or best attachment. */
export function createStableReadingReplayItem(): Zotero.Item {
  const key = 2147000001;
  return { id: key, libraryID: 1, key: "LOCAL_REPLAY", isAttachment: () => false,
      isNote: () => false, isRegularItem: () => true, getAttachments: () => [], getCollections: () => [], getBestAttachment: async () => null, getField: () => "本地流式回放" } as unknown as Zotero.Item;
}

(_globalThis as any).__nativeMath = {
  render(bubble: HTMLDivElement, text: string, streaming: boolean, item: Zotero.Item, panel: Element) {
    renderAssistantRichText({
      body: panel, bubble, panelItem: item, incremental: true,
      assistantMessage: { role: "assistant", text, streaming, timestamp: 1 },
    });
  },
  dispose: disposeStreamingMarkdown,
  /** The separate replay bundle uses an in-memory Prefs facade and rejects DB/network calls. */
  mountCaller(mount: HTMLElement) {
    const doc = mount.ownerDocument;
    const key = 2147000001;
    const item = createStableReadingReplayItem();
    bindProvisionedConversationKey(item, key);
    const body = doc.createElement("div");
    const panel = doc.createElement("div"); panel.id = "llm-main"; panel.className = "llm-panel";
    panel.style.setProperty("--llm-font-scale", "inherit");
    panel.dataset.itemId = String(key); panel.dataset.conversationSystem = "upstream";
    const shell = doc.createElement("div"); shell.id = "llm-chat-shell"; shell.className = "llm-chat-shell";
    const box = doc.createElement("div"); box.id = "llm-chat-box"; box.className = "llm-messages";
    shell.style.height = "560px"; shell.style.minHeight = "0";
    shell.append(box); panel.append(shell); body.append(panel); mount.append(body);
    // Replay has no actionable production controls. Only render() changes fixture memory.
    const preventAction = (e: Event) => { e.preventDefault(); e.stopImmediatePropagation(); };
    body.addEventListener("click", preventAction, true);
    body.addEventListener("keydown", preventAction, true);
    const assistant: Message = {role: "assistant", text: "", streaming: true, timestamp: 10202};
    chatHistory.set(key, [
      {role: "user", text: "本地流式回放，不发送模型", timestamp: 10201}, assistant,
    ]);
    let mounted = false;
    return {
      body, box,
      render(text: string, streaming = true) {
        assistant.text = text; assistant.streaming = streaming;
        refreshChat(body, item, mounted ? {rerenderAssistantMessages: new Set([assistant])} : {});
        mounted = true;
        return box.querySelector<HTMLElement>(".llm-assistant-answer");
      },
      dispose() {
        for (const answer of Array.from(box.querySelectorAll<HTMLElement>(".llm-assistant-answer"))) disposeStreamingMarkdown(answer);
        disposeChatScrollViewport(box);
        chatHistory.delete(key);
        body.remove();
      },
    };
  },
};
