/** Deterministic native memory/rendering diagnostic; never invoked by production UI. */
import {
  buildAgentEngineDepsForTests,
  ensureConversationLoaded,
  getConversationKey,
} from "./chat";
import {
  activeContextPanelRawItems,
  activeContextPanels,
  activeContextPanelStateSync,
  chatHistory,
  finishRequest,
  nextRequestId,
  tryBeginRequest,
} from "./state";
import { getConversationWriteGeneration } from "../../shared/conversationWriteFence";
import type { Message } from "./types";

export type MemoryProbeSample = {
  label: string;
  resident: number;
  residentUnique: number;
  heapAllocated: number;
  jsGcHeap: number;
  rawItemsTotal: number;
  rawItemsDisconnected: number;
  rawItemsDisconnectedNodes: number;
  panelsTotal: number;
  panelsDisconnected: number;
  stateSyncTotal: number;
  chatHistoryConversations: number;
  chatHistoryMessages: number;
  chatHistoryChars: number;
};

function getComponents(): any {
  const C =
    (globalThis as any).Components ||
    (Zotero.getMainWindow() as any)?.Components;
  return C;
}

async function forceGc(rounds: number): Promise<void> {
  const C = getComponents();
  const Cu = C?.utils;
  for (let n = 0; n < rounds; n++) {
    try {
      Cu?.forceGC?.();
      Cu?.forceCC?.();
      Cu?.forceShrinkingGC?.();
    } catch (_err) {
      void _err;
    }
    await Zotero.Promise.delay(150);
  }
  const mgr = C.classes["@mozilla.org/memory-reporter-manager;1"].getService(
    C.interfaces.nsIMemoryReporterManager,
  );
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Memory minimization timed out")),
      10000,
    );
    mgr.minimizeMemoryUsage(() => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

export async function memoryProbeInspect(input: {
  label: string;
  gc?: boolean;
}): Promise<MemoryProbeSample> {
  if (input.gc !== false) await forceGc(3);
  const C = getComponents();
  let resident = -1;
  let residentUnique = -1;
  let heapAllocated = -1;
  let jsGcHeap = -1;
  try {
    const mgr = C.classes["@mozilla.org/memory-reporter-manager;1"].getService(
      C.interfaces.nsIMemoryReporterManager,
    );
    resident = mgr.resident;
    residentUnique = mgr.residentUnique;
    heapAllocated = mgr.heapAllocated;
    jsGcHeap = mgr.JSMainRuntimeGCHeap;
  } catch (_err) {
    void _err;
  }
  let rawItemsDisconnected = 0;
  let rawItemsDisconnectedNodes = 0;
  for (const body of activeContextPanelRawItems.keys()) {
    if (!(body as Element).isConnected) {
      rawItemsDisconnected++;
      rawItemsDisconnectedNodes += (body as Element).querySelectorAll(
        "*",
      ).length;
    }
  }
  let panelsDisconnected = 0;
  for (const body of activeContextPanels.keys()) {
    if (!(body as Element).isConnected) panelsDisconnected++;
  }
  let chatHistoryMessages = 0;
  let chatHistoryChars = 0;
  for (const messages of chatHistory.values()) {
    chatHistoryMessages += messages.length;
    for (const message of messages)
      chatHistoryChars += message.text?.length || 0;
  }
  return {
    label: input.label,
    resident,
    residentUnique,
    heapAllocated,
    jsGcHeap,
    rawItemsTotal: activeContextPanelRawItems.size,
    rawItemsDisconnected,
    rawItemsDisconnectedNodes,
    panelsTotal: activeContextPanels.size,
    panelsDisconnected,
    stateSyncTotal: activeContextPanelStateSync.size,
    chatHistoryConversations: chatHistory.size,
    chatHistoryMessages,
    chatHistoryChars,
  };
}

export type ChatModeTurnResult = {
  turnIndex: number;
  historyMessagesBefore: number;
  chunks: number;
  answerChars: number;
  wrapperReplacements: number;
  flushMsFirst5: number[];
  flushMsLast5: number[];
  flushMsMean: number;
  flushMsMax: number;
  totalMs: number;
  finalizeMs: number;
  frameMs: number[];
  streamedTextVisible: boolean;
  finalTextMatches: boolean;
  chatBoxNodes: number;
};

const CHUNKS = [
  "## Finding\n\nThe **primary** result holds across ",
  "three conditions, with `p < 0.01` in each case. ",
  "- First point about the method\n- Second point about *controls*\n",
  "- Third point with a [reference](https://example.org)\n\n",
  "> Quoted passage from the paper that the model cites verbatim.\n\n",
  "| Metric | Value |\n|---|---|\n| Accuracy | 0.91 |\n| Recall | 0.87 |\n\n",
  "Further discussion continues here with ordinary prose that ",
  "streams token by token and gets re-rendered as it arrives. ",
];

export async function exerciseChatModeStreamingTurn(
  panel: { body: HTMLElement; item: Zotero.Item },
  input: {
    turnIndex: number;
    chunks: number;
  },
): Promise<ChatModeTurnResult> {
  const { body, item } = panel;
  const doc = body.ownerDocument;
  const win = doc.defaultView!;
  const box = body.querySelector<HTMLDivElement>("#llm-chat-box")!;
  await ensureConversationLoaded(item);
  const key = getConversationKey(item);
  const history = chatHistory.get(key) || [];
  chatHistory.set(key, history);
  const historyMessagesBefore = history.length;
  const now = Date.now();
  const user: Message = {
    role: "user",
    text: `Question ${input.turnIndex}: summarize the evidence again`,
    timestamp: now,
  };
  const message: Message = {
    role: "assistant",
    text: "",
    timestamp: now + 1,
    streaming: true,
  };
  history.push(user, message);
  const requestId = nextRequestId();
  if (!tryBeginRequest(key, requestId, null))
    throw new Error("Probe request is already busy");
  const deps = buildAgentEngineDepsForTests(
    item,
    "upstream",
    getConversationWriteGeneration(key),
  );
  const ui = deps.getPanelRequestUI(body);
  const helpers = deps.createPanelUpdateHelpers(body, item, key, ui);
  helpers.refreshChatSafely();
  await Zotero.Promise.delay(50);
  const findWrapper = () =>
    box.querySelector<HTMLElement>(
      `.llm-message-wrapper[data-message-timestamp="${message.timestamp}"]`,
    );
  let wrapper = findWrapper();
  let wrapperReplacements = 0;
  const flushMs: number[] = [];
  const frameMs: number[] = [];
  const startAll = win.performance.now();
  for (let n = 0; n < input.chunks; n++) {
    message.text += CHUNKS[n % CHUNKS.length];
    const start = win.performance.now();
    helpers.refreshAssistantMessageSafely(message);
    flushMs.push(win.performance.now() - start);
    const next = findWrapper();
    if (next !== wrapper) wrapperReplacements++;
    wrapper = next;
    await new Promise<void>((resolve) =>
      win.requestAnimationFrame(() => resolve()),
    );
    frameMs.push(win.performance.now() - start);
  }
  await Zotero.Promise.delay(120);
  const streamedText =
    findWrapper()?.querySelector(".llm-assistant-answer")?.textContent || "";
  const streamedTextVisible =
    streamedText.includes("primary") && streamedText.includes("Accuracy");
  message.streaming = false;
  const finalizeStart = win.performance.now();
  helpers.refreshChatSafely();
  const finalizeMs = win.performance.now() - finalizeStart;
  finishRequest(key, requestId);
  const totalMs = win.performance.now() - startAll;
  const mean = flushMs.reduce((a, b) => a + b, 0) / Math.max(1, flushMs.length);
  return {
    frameMs: frameMs.map((v) => Math.round(v * 10) / 10),
    streamedTextVisible,
    finalTextMatches:
      (findWrapper()?.querySelector(".llm-assistant-answer")?.textContent ||
        "") === streamedText,
    turnIndex: input.turnIndex,
    historyMessagesBefore,
    chunks: input.chunks,
    answerChars: message.text.length,
    wrapperReplacements,
    flushMsFirst5: flushMs.slice(0, 5).map((v) => Math.round(v * 10) / 10),
    flushMsLast5: flushMs.slice(-5).map((v) => Math.round(v * 10) / 10),
    flushMsMean: Math.round(mean * 10) / 10,
    flushMsMax: Math.round(Math.max(...flushMs) * 10) / 10,
    totalMs: Math.round(totalMs),
    finalizeMs: Math.round(finalizeMs * 10) / 10,
    chatBoxNodes: box.querySelectorAll("*").length,
  };
}
