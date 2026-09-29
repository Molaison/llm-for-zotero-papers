/**
 * Task progress in a mounted chat panel: binds the row and drawer that
 * `buildUI` placed, keeps each panel's view pointed at the conversation it
 * shows, and resolves the turn's scope listing from the library index.
 *
 * Also owns the request-lifecycle safety net: every request start marks the
 * conversation's run working, and a request that ends while its run is still
 * live settles it (completed, failed or cancelled) from what the turn left,
 * so the row never spins after its request is gone.
 */
import {
  listTaskPaperScope,
  type TaskPaperScopeListing,
} from "../../../agent/context/taskPaperScopeListing";
import { libraryIndexService } from "../../../services/libraryIndexService";
import { t } from "../../../utils/i18n";
import {
  navigateChatToMessage,
  reconcileChatScroll,
} from "../chatScrollSnapshots";
import {
  chatHistory,
  getCancelledRequestId,
  getLivePlanExecution,
  getPendingRequestId,
  isRequestPending,
  subscribeRequestActivity,
} from "../state";
import { agentRunTraceCache } from "../agentState";
import type { AgentRunEventRecord } from "../../../agent/types";
import type { Message } from "../types";
import { ensureTaskProgressHydrated } from "./history";
import { resolveMineruHint } from "./mineruHint";
import {
  beginTaskRun,
  completeTaskRun,
  endTaskRun,
  getTaskProgress,
  setTaskPlan,
  setTaskScope,
  subscribeTaskProgress,
  taskTurnIndexFor,
  type TaskProgressResearch,
} from "./store";
import {
  mountTaskProgressView,
  type TaskProgressView,
  type TaskProgressViewInput,
} from "./view";
import {
  resolveTaskProgressTurnScope,
  shouldShowTaskProgress,
} from "./visibility";

type MountedPanel = {
  view: TaskProgressView;
  /** The row the view is bound to; a rebuilt panel has a new one. */
  row: HTMLElement;
  conversationKey: number | null;
};

const panels = new Map<Element, MountedPanel>();

function latestUserMessage(conversationKey: number): Message | undefined {
  const history = chatHistory.get(conversationKey) || [];
  for (let index = history.length - 1; index >= 0; index--) {
    if (history[index].role === "user") return history[index];
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Scope listing
// ---------------------------------------------------------------------------

const scopeLoads = new Map<string, Promise<void>>();
/** The index snapshot each listing was computed from. */
const listingSources = new WeakMap<TaskPaperScopeListing, object>();

/**
 * Resolve the scope's listing, and resolve it again whenever the library
 * index moved on since (a paper added to the folder, a tag applied): the
 * listing is recomputed from the attached contexts, never patched.
 */
function ensureScopeListing(
  conversationKey: number,
  signature: string,
  libraryID: number,
): void {
  const record = getTaskProgress(conversationKey);
  const scope = record?.scope;
  if (!scope || scope.signature !== signature || !libraryID) return;
  if (
    scope.listing &&
    listingSources.get(scope.listing) ===
      libraryIndexService.peekSnapshot(libraryID)
  ) {
    return;
  }
  const loadKey = `${conversationKey}\u0000${signature}`;
  if (scopeLoads.has(loadKey)) return;
  const load = (async () => {
    // Waits for pending item changes, so a paper added a moment ago is listed.
    const snapshot = await libraryIndexService.getSnapshot(libraryID);
    const current = getTaskProgress(conversationKey)?.scope;
    if (!current || current.signature !== signature) return;
    if (current.listing && listingSources.get(current.listing) === snapshot) {
      return;
    }
    const listing: TaskPaperScopeListing = listTaskPaperScope(
      snapshot,
      current.contexts,
    );
    listingSources.set(listing, snapshot);
    setTaskScope(conversationKey, { ...current, listing });
  })()
    .catch(() => undefined)
    .finally(() => {
      scopeLoads.delete(loadKey);
    });
  scopeLoads.set(loadKey, load);
}

// ---------------------------------------------------------------------------
// Plan steps
// ---------------------------------------------------------------------------

const researchCache = new WeakMap<
  AgentRunEventRecord[],
  { length: number; executionId: string; research?: TaskProgressResearch }
>();

function latestResearch(
  events: AgentRunEventRecord[] | undefined,
  executionId: string,
): TaskProgressResearch | undefined {
  if (!events?.length) return undefined;
  const cached = researchCache.get(events);
  let from = 0;
  let research: TaskProgressResearch | undefined;
  if (
    cached &&
    cached.executionId === executionId &&
    cached.length <= events.length
  ) {
    from = cached.length;
    research = cached.research;
  }
  for (let index = from; index < events.length; index++) {
    const payload = events[index]?.payload;
    if (
      payload?.type === "plan_research_progress" &&
      payload.progress.executionId === executionId
    ) {
      research = payload.progress;
    }
  }
  researchCache.set(events, { length: events.length, executionId, research });
  return research;
}

/**
 * Point the conversation's Steps block at its live plan execution, or clear
 * it. Progress belongs to the live request, never to a historical trace.
 */
export function syncTaskProgressPlan(conversationKey: number): void {
  const binding = getLivePlanExecution(conversationKey);
  const history = chatHistory.get(conversationKey) || [];
  let latest: Message | undefined;
  for (let index = history.length - 1; index >= 0; index--) {
    if (history[index].role === "assistant") {
      latest = history[index];
      break;
    }
  }
  const message =
    binding && latest?.agentRunId === binding.runId && latest.streaming
      ? latest
      : undefined;
  if (!binding || !message) {
    setTaskPlan(conversationKey, null);
    return;
  }
  const events =
    message.pendingAgentTraceEvents || agentRunTraceCache.get(binding.runId);
  const research = latestResearch(events, binding.ledger.executionId);
  const existing = getTaskProgress(conversationKey)?.plan;
  setTaskPlan(conversationKey, {
    ledger: binding.ledger,
    research:
      research ??
      (existing?.ledger.executionId === binding.ledger.executionId
        ? existing?.research
        : undefined),
  });
}

// ---------------------------------------------------------------------------
// Request lifecycle safety net
// ---------------------------------------------------------------------------

const requestStarts = new Map<number, number>();
let lifecycleInstalled = false;

function settleFromHistory(conversationKey: number, requestId: number): void {
  const record = getTaskProgress(conversationKey);
  if (!record) return;
  if (record.runState !== "working" && record.runState !== "answering") return;
  if (requestId && getCancelledRequestId(conversationKey) >= requestId) {
    endTaskRun(conversationKey, "cancelled");
    return;
  }
  const history = chatHistory.get(conversationKey) || [];
  const latest = history[history.length - 1];
  if (!latest || latest.role !== "assistant") {
    endTaskRun(conversationKey, "failed");
    return;
  }
  if (latest.text === "[Cancelled]") {
    endTaskRun(conversationKey, "cancelled");
    return;
  }
  if (latest.interrupted || /^Error:/.test(latest.text || "")) {
    endTaskRun(conversationKey, "failed");
    return;
  }
  // Plain chat lists the scope only; citations mark papers only for a run
  // that recorded its reads.
  completeTaskRun(conversationKey, {
    runId: record.runId,
    quoteCitations:
      latest.runMode === "agent" ? latest.quoteCitations : undefined,
  });
}

/** Idempotent; the first mounted panel installs it (tests call it directly). */
export function installTaskProgressRequestLifecycle(): void {
  if (lifecycleInstalled) return;
  lifecycleInstalled = true;
  // A plan, an action or a Codex plan makes the row apply mid-conversation
  // (a one-paper chat included): its panels sync once so the scope lists.
  const stepsSeen = new Set<number>();
  subscribeTaskProgress((conversationKey) => {
    const record = getTaskProgress(conversationKey);
    if (!record) {
      stepsSeen.delete(conversationKey);
      return;
    }
    if (!record.planSeen || stepsSeen.has(conversationKey)) return;
    stepsSeen.add(conversationKey);
    syncTaskProgressPanelsForConversation(conversationKey);
  });
  subscribeRequestActivity((conversationKey) => {
    if (isRequestPending(conversationKey)) {
      requestStarts.set(conversationKey, getPendingRequestId(conversationKey));
      beginTaskRun(conversationKey, {
        turnIndex: taskTurnIndexFor(chatHistory.get(conversationKey)),
      });
    } else {
      const requestId = requestStarts.get(conversationKey) || 0;
      requestStarts.delete(conversationKey);
      settleFromHistory(conversationKey, requestId);
      setTaskPlan(conversationKey, null);
    }
    syncTaskProgressPanelsForConversation(conversationKey);
  });
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

function resolvePanelInput(body: Element): TaskProgressViewInput | null {
  const panelRoot = body.querySelector("#llm-main") as HTMLElement | null;
  if (!panelRoot) return null;
  const conversationKey = Math.floor(Number(panelRoot.dataset.itemId || 0));
  const kind = panelRoot.dataset.conversationKind;
  const conversationKind: "global" | "paper" | "" =
    kind === "global" || kind === "paper" ? kind : "";
  const libraryID = Math.floor(Number(panelRoot.dataset.libraryId || 0));
  const basePaperItemId = Math.floor(
    Number(panelRoot.dataset.basePaperItemId || 0),
  );
  const isWebChat = panelRoot.dataset.webchatMode === "true";
  const isNoteSession = Boolean(panelRoot.dataset.noteKind);
  const system = panelRoot.dataset.conversationSystem || "";
  const recordsReads =
    panelRoot.dataset.runtimeMode === "agent" ||
    system === "codex" ||
    system === "claude_code";
  if (!(conversationKey > 0)) {
    return {
      conversationKey: null,
      recordsReads,
      visibility: {
        conversationKind: "",
        isWebChat,
        isNoteSession,
        collectionCount: 0,
        tagCount: 0,
        paperCount: 0,
      },
    };
  }
  // A conversation shown again rebuilds its record from what it persisted,
  // then its panels sync once more (the row may now apply).
  if (!isWebChat && !isNoteSession) {
    ensureTaskProgressHydrated(conversationKey, libraryID || undefined, () =>
      syncTaskProgressPanelsForConversation(conversationKey),
    );
  }
  const scope = resolveTaskProgressTurnScope({
    message: latestUserMessage(conversationKey),
    conversationKind,
    libraryID,
    basePaperItemId,
  });
  const visibility = {
    conversationKind,
    isWebChat,
    isNoteSession,
    collectionCount: scope.collectionCount,
    tagCount: scope.tagCount,
    paperCount: scope.paperCount,
  };
  const record = getTaskProgress(conversationKey);
  if (
    libraryID > 0 &&
    shouldShowTaskProgress({
      ...visibility,
      planSeen: Boolean(record?.planSeen),
    })
  ) {
    const wholeLibrary =
      conversationKind === "global" &&
      !scope.paperCount &&
      !scope.collectionCount &&
      !scope.tagCount;
    setTaskScope(conversationKey, {
      signature: scope.signature,
      libraryID,
      contexts: scope.contexts,
      label: scope.label || (wholeLibrary ? t("Whole library") : ""),
    });
    ensureScopeListing(conversationKey, scope.signature, libraryID);
  }
  return { conversationKey, recordsReads, visibility };
}

/** The longest of a computed `transition-duration` + `-delay` list, in ms. */
function transitionMs(style: CSSStyleDeclaration | null | undefined): number {
  const parse = (value: string | undefined) =>
    String(value || "")
      .split(",")
      .map((part) => {
        const text = part.trim();
        const number = parseFloat(text);
        if (!Number.isFinite(number)) return 0;
        return text.endsWith("ms") ? number : number * 1000;
      });
  const durations = parse(style?.transitionDuration);
  const delays = parse(style?.transitionDelay);
  let longest = 0;
  durations.forEach((duration, index) => {
    longest = Math.max(longest, duration + (delays[index] || 0));
  });
  return longest;
}

/** Bind the row and drawer `buildUI` placed in this panel. Idempotent. */
export function mountTaskProgressPanel(body: Element): TaskProgressView | null {
  installTaskProgressRequestLifecycle();
  for (const [other, mounted] of Array.from(panels)) {
    if (other !== body && !other.isConnected) {
      mounted.view.dispose();
      panels.delete(other);
    }
  }
  const existing = panels.get(body);
  const row = body.querySelector(
    "#llm-task-progress",
  ) as HTMLButtonElement | null;
  const drawer = body.querySelector(
    "#llm-task-progress-drawer",
  ) as HTMLElement | null;
  const shell = body.querySelector("#llm-chat-shell") as HTMLElement | null;
  const chatBox = body.querySelector("#llm-chat-box") as HTMLElement | null;
  const panelRoot = body.querySelector("#llm-main") as HTMLElement | null;
  if (!row || !drawer || !shell || !chatBox || !panelRoot) return null;
  if (existing?.row === row) return existing.view;
  if (existing) {
    existing.view.dispose();
    panels.delete(body);
  }
  const win = body.ownerDocument?.defaultView;
  const mounted: MountedPanel = {
    view: null as never,
    row,
    conversationKey: null,
  };
  mounted.view = mountTaskProgressView({
    doc: body.ownerDocument as Document,
    row,
    drawer,
    shell,
    chatBox,
    keyTarget: panelRoot,
    deps: {
      setTimeout: (callback, ms) =>
        (win || globalThis).setTimeout(callback, ms),
      clearTimeout: (handle) =>
        (win || globalThis).clearTimeout(handle as number),
      now: () => win?.performance?.now?.() ?? Date.now(),
      resolveMineru: resolveMineruHint,
      navigateToCitation: (card) => {
        const key = mounted.conversationKey;
        const navigated =
          key &&
          navigateChatToMessage({
            conversationKey: key,
            chatBox: chatBox as HTMLDivElement,
            targetElement: card,
            behavior: "auto",
            viewportOffsetTop: Math.max(0, chatBox.clientHeight / 3),
          });
        if (!navigated) card.scrollIntoView?.({ block: "center" });
      },
      layout: win
        ? {
            motionMs: () => transitionMs(win.getComputedStyle(drawer)),
            chatStripPx: () =>
              parseFloat(win.getComputedStyle(chatBox)?.minHeight || "") || 0,
            observeResize: (target, onResize) => {
              const Observer = (win as any).ResizeObserver as
                | typeof ResizeObserver
                | undefined;
              if (!Observer) return () => undefined;
              const observer = new Observer(() => onResize());
              observer.observe(target);
              return () => observer.disconnect();
            },
            // Runs in the resize callback, after layout and before paint, so
            // a chat at the bottom stays there on every frame of the motion
            // and a chat being read keeps its anchor (the scroll owner's own
            // observer would correct one frame later).
            onChatResized: () => {
              const key = mounted.conversationKey;
              if (key) reconcileChatScroll(key, chatBox as HTMLDivElement);
            },
          }
        : undefined,
    },
  });
  panels.set(body, mounted);
  return mounted.view;
}

/** Re-point a panel's view at the conversation and mode it shows now. */
export function syncTaskProgressPanel(body: Element): void {
  const view = mountTaskProgressPanel(body);
  const mounted = panels.get(body);
  if (!view || !mounted) return;
  const input = resolvePanelInput(body);
  if (!input) return;
  mounted.conversationKey = input.conversationKey;
  view.setInput(input);
}

export function syncTaskProgressPanelsForConversation(
  conversationKey: number,
): void {
  for (const [body, mounted] of Array.from(panels)) {
    if (!body.isConnected) {
      mounted.view.dispose();
      panels.delete(body);
      continue;
    }
    if (mounted.conversationKey === conversationKey)
      syncTaskProgressPanel(body);
  }
}

export function getTaskProgressPanelView(
  body: Element,
): TaskProgressView | null {
  return panels.get(body)?.view || null;
}

/**
 * Re-sync every mounted panel and repaint it now (workflow harness): the
 * scope listing is re-resolved if the library index moved on.
 */
export function flushTaskProgressPanels(): void {
  for (const [body, mounted] of Array.from(panels)) {
    if (!body.isConnected) continue;
    syncTaskProgressPanel(body);
    mounted.view.flush();
  }
}

export function disposeTaskProgressPanel(body: Element): void {
  const mounted = panels.get(body);
  if (!mounted) return;
  mounted.view.dispose();
  panels.delete(body);
}
