/**
 * When the quote gate runs, and what the panel is told afterwards.
 *
 * Validating a turn's quotes is expensive and must never compete with the
 * reader, so it runs one conversation at a time, in idle time, on the
 * messages nearest the viewport first, and it re-renders only the messages
 * whose display actually changed.
 */
import { appLogger } from "../../../core/logging";
import { getConversationKey } from "../conversationIdentity";
import { isQuoteValidationPreempted } from "../quoteValidationActivity";
import { activeContextPanels, chatHistory } from "../state";
import type { Message } from "../types";
import type { QuoteCitation } from "../../../shared/types";
import { buildQuoteExpandedMarkdown } from "../quoteRenderPlan";
import { refreshQuoteValidatedConversation } from "./chatRefreshBridge";
import {
  applyAssistantMessageQuoteGate,
  collectLivePdfQuoteSecondaryEvidence,
} from "./gate";
import {
  buildQuoteValidationEvidenceSignature,
  getOrBuildCachedQuoteSourceIndex,
} from "./caches";
import {
  assistantMarkdownNeedsBackgroundQuoteSearch,
  assistantMarkdownNeedsQuoteSourceSearch,
  buildCachedQuoteSourceEvidenceForPaperContexts,
  quoteSourcePaperContextGroups,
  warmQuoteSourceCachesForPaperContexts,
  type AssistantQuoteFinalizationOptions,
} from "./sourceEvidence";

const quoteValidationSignatures = new WeakMap<Message, string>();
type PendingQuoteValidation = {
  assistantMessage: Message;
  rawMarkdown: string;
  rawQuoteCitations: QuoteCitation[] | undefined;
  options: AssistantQuoteFinalizationOptions;
  signature: string;
};
const pendingQuoteValidations = new Map<
  number,
  Map<Message, PendingQuoteValidation>
>();
const quoteValidationTasks = new Map<number, Promise<void>>();

function refreshConversationAfterQuoteValidation(
  conversationKey: number,
  changedMessages: ReadonlySet<Message>,
): void {
  for (const [body, getItem] of activeContextPanels.entries()) {
    if (!body.isConnected) continue;
    const item = getItem?.() || null;
    if (!item || getConversationKey(item) !== conversationKey) continue;
    refreshQuoteValidatedConversation(body, item, {
      rerenderAssistantMessages: changedMessages,
    });
  }
}

type QuoteValidationIdleDeadline = {
  didTimeout: boolean;
  timeRemaining: () => number;
};

type QuoteValidationWindow = Window & {
  requestIdleCallback?: (
    callback: (deadline: QuoteValidationIdleDeadline) => void,
    options?: { timeout?: number },
  ) => number;
};

function getQuoteValidationWindow(
  conversationKey: number,
): QuoteValidationWindow | null {
  for (const [body, getItem] of activeContextPanels.entries()) {
    if (!body.isConnected) continue;
    const item = getItem?.() || null;
    if (!item || getConversationKey(item) !== conversationKey) continue;
    return (body.ownerDocument?.defaultView as QuoteValidationWindow) || null;
  }
  return null;
}

export function conversationHasStreamingMessage(
  conversationKey: number,
): boolean {
  return Boolean(
    chatHistory.get(conversationKey)?.some((message) => message.streaming),
  );
}

// The first idle wait of a validation pass gates how soon the first quote block
// can flip to its verified/unverified state. Keep it short so the on-screen
// message classifies within a frame or two; the long tail stays cooperative.
const QUOTE_VALIDATION_PROMPT_IDLE_MS = 32;

/**
 * Order a validation batch so the messages nearest the bottom of the
 * conversation — the ones actually on screen when a chat is opened (it scrolls
 * to the latest message) — are classified first. Messages no longer present in
 * history are stale and sort last. Pure and non-mutating for testability.
 */
export function orderQuoteValidationBatchByViewportPriority<
  T extends { assistantMessage: Message },
>(batch: readonly T[], history: readonly Message[]): T[] {
  return batch
    .map((request, originalIndex) => ({
      request,
      originalIndex,
      historyIndex: history.indexOf(request.assistantMessage),
    }))
    .sort((a, b) => {
      if (a.historyIndex !== b.historyIndex) {
        return b.historyIndex - a.historyIndex;
      }
      return a.originalIndex - b.originalIndex;
    })
    .map((entry) => entry.request);
}

/**
 * Resolve the idle-callback timeout and setTimeout-fallback delay for a
 * validation wait. A `promptTimeoutMs` collapses both to a short, prompt budget;
 * otherwise the cooperative defaults apply (longer while panels are open to stay
 * responsive during heavy work).
 */
export function resolveQuoteValidationIdleTimeouts(
  hasActivePanels: boolean,
  promptTimeoutMs?: number,
): { idleTimeout: number; fallbackDelayMs: number } {
  if (typeof promptTimeoutMs === "number" && Number.isFinite(promptTimeoutMs)) {
    const clamped = Math.max(0, promptTimeoutMs);
    return { idleTimeout: clamped, fallbackDelayMs: clamped };
  }
  return { idleTimeout: 1200, fallbackDelayMs: hasActivePanels ? 250 : 16 };
}

async function waitForQuoteValidationIdle(
  conversationKey: number,
  shouldContinue: () => boolean = () => true,
  options?: { promptTimeoutMs?: number },
): Promise<boolean> {
  while (true) {
    if (!shouldContinue()) return false;
    const win = getQuoteValidationWindow(conversationKey);
    const { idleTimeout, fallbackDelayMs } = resolveQuoteValidationIdleTimeouts(
      activeContextPanels.size > 0,
      options?.promptTimeoutMs,
    );
    const deadline = await new Promise<QuoteValidationIdleDeadline>(
      (resolve) => {
        if (typeof win?.requestIdleCallback === "function") {
          win.requestIdleCallback(resolve, { timeout: idleTimeout });
          return;
        }
        const schedule = win?.setTimeout?.bind(win) || setTimeout;
        schedule(
          () =>
            resolve({
              didTimeout: false,
              timeRemaining: () => 8,
            }),
          fallbackDelayMs,
        );
      },
    );
    if (!shouldContinue()) return false;
    const currentWindow = getQuoteValidationWindow(conversationKey);
    const visibilityState = currentWindow?.document?.visibilityState;
    if (
      (activeContextPanels.size > 0 && !currentWindow) ||
      isQuoteValidationPreempted() ||
      conversationHasStreamingMessage(conversationKey) ||
      visibilityState === "hidden"
    ) {
      continue;
    }
    if (deadline.didTimeout || deadline.timeRemaining() >= 4) return true;
  }
}

function isPendingQuoteValidationCurrent(
  conversationKey: number,
  request: PendingQuoteValidation,
): boolean {
  return (
    quoteValidationSignatures.get(request.assistantMessage) ===
      request.signature &&
    Boolean(
      chatHistory.get(conversationKey)?.includes(request.assistantMessage),
    )
  );
}

function startConversationQuoteValidation(conversationKey: number): void {
  if (quoteValidationTasks.has(conversationKey)) return;
  const task = (async () => {
    const hasPendingRequest = () =>
      Boolean(pendingQuoteValidations.get(conversationKey)?.size);
    if (
      !(await waitForQuoteValidationIdle(conversationKey, hasPendingRequest, {
        promptTimeoutMs: QUOTE_VALIDATION_PROMPT_IDLE_MS,
      }))
    ) {
      return;
    }
    while (true) {
      const pending = pendingQuoteValidations.get(conversationKey);
      if (!pending?.size) break;
      pendingQuoteValidations.delete(conversationKey);
      // Classify the messages nearest the bottom (the ones on screen when the
      // chat opens) first, so their quotes flip without waiting on scrolled-off
      // history.
      const batch = orderQuoteValidationBatchByViewportPriority(
        Array.from(pending.values()),
        chatHistory.get(conversationKey) || [],
      );
      try {
        const batchHasCurrentRequest = () =>
          batch.some((request) =>
            isPendingQuoteValidationCurrent(conversationKey, request),
          );
        await warmQuoteSourceCachesForPaperContexts(
          batch.flatMap((request) =>
            quoteSourcePaperContextGroups(request.options),
          ),
          {
            yieldToMain: async () => {
              await waitForQuoteValidationIdle(
                conversationKey,
                batchHasCurrentRequest,
              );
            },
            shouldContinue: batchHasCurrentRequest,
          },
        );
        for (const request of batch) {
          const { assistantMessage, rawMarkdown, rawQuoteCitations, options } =
            request;
          const hasIdleTime = await waitForQuoteValidationIdle(
            conversationKey,
            () => isPendingQuoteValidationCurrent(conversationKey, request),
          );
          if (!hasIdleTime) continue;
          if (!isPendingQuoteValidationCurrent(conversationKey, request)) {
            continue;
          }
          const evidence = buildCachedQuoteSourceEvidenceForPaperContexts(
            ...quoteSourcePaperContextGroups(options),
          );
          const evidenceSignature =
            buildQuoteValidationEvidenceSignature(evidence);
          const sourceIndex = evidenceSignature
            ? getOrBuildCachedQuoteSourceIndex(
                evidenceSignature,
                evidence.sourceTexts,
              )
            : undefined;
          const yieldQuoteValidation = async () => {
            await waitForQuoteValidationIdle(conversationKey, () =>
              isPendingQuoteValidationCurrent(conversationKey, request),
            );
          };
          const shouldContinueQuoteValidation = () =>
            isPendingQuoteValidationCurrent(conversationKey, request);
          const secondaryEvidence = sourceIndex
            ? await collectLivePdfQuoteSecondaryEvidence({
                markdown: buildQuoteExpandedMarkdown({
                  markdown: rawMarkdown,
                  quoteCitations: rawQuoteCitations,
                }),
                sourceIndex,
                yieldToMain: yieldQuoteValidation,
                shouldContinue: shouldContinueQuoteValidation,
              })
            : [];
          const changed = await applyAssistantMessageQuoteGate(
            assistantMessage,
            rawMarkdown,
            rawQuoteCitations,
            evidence,
            options,
            sourceIndex,
            secondaryEvidence,
            {
              yieldToMain: yieldQuoteValidation,
              shouldContinue: shouldContinueQuoteValidation,
            },
          );
          if (changed) {
            // Flip this message the moment it is classified so quotes appear
            // progressively, rather than holding every result until the whole
            // batch finishes. The targeted re-render only rebuilds this one
            // message, and cached syntax highlighting keeps it cheap.
            refreshConversationAfterQuoteValidation(
              conversationKey,
              new Set([assistantMessage]),
            );
          }
        }
      } finally {
        for (const { assistantMessage, signature } of batch) {
          if (quoteValidationSignatures.get(assistantMessage) === signature) {
            quoteValidationSignatures.delete(assistantMessage);
          }
        }
      }
    }
  })().catch((error) => {
    appLogger.warn("LLM: background quote validation failed", error);
  });
  quoteValidationTasks.set(conversationKey, task);
  void task.finally(() => {
    if (quoteValidationTasks.get(conversationKey) === task) {
      quoteValidationTasks.delete(conversationKey);
    }
    if (pendingQuoteValidations.get(conversationKey)?.size) {
      startConversationQuoteValidation(conversationKey);
    }
  });
}

function scheduleAssistantMessageQuoteValidation(
  assistantMessage: Message,
  rawMarkdown: string,
  rawQuoteCitations: QuoteCitation[] | undefined,
  options: AssistantQuoteFinalizationOptions,
): void {
  const conversationKey = Math.floor(Number(options.conversationKey || 0));
  if (
    !conversationKey ||
    !assistantMarkdownNeedsBackgroundQuoteSearch(rawMarkdown, rawQuoteCitations)
  ) {
    return;
  }
  const signature = `${assistantMessage.timestamp}\u241f${rawMarkdown}`;
  if (quoteValidationSignatures.get(assistantMessage) === signature) return;
  quoteValidationSignatures.set(assistantMessage, signature);
  let pending = pendingQuoteValidations.get(conversationKey);
  if (!pending) {
    pending = new Map();
    pendingQuoteValidations.set(conversationKey, pending);
  }
  pending.set(assistantMessage, {
    assistantMessage,
    rawMarkdown,
    rawQuoteCitations,
    options,
    signature,
  });
  startConversationQuoteValidation(conversationKey);
}

async function waitForConversationQuoteValidation(
  conversationKey: number,
): Promise<void> {
  while (
    quoteValidationTasks.has(conversationKey) ||
    pendingQuoteValidations.get(conversationKey)?.size
  ) {
    const task = quoteValidationTasks.get(conversationKey);
    if (task) {
      await task;
    } else {
      startConversationQuoteValidation(conversationKey);
      await quoteValidationTasks.get(conversationKey);
    }
  }
}

export async function waitForAssistantQuoteValidationForTests(
  conversationKey: number,
): Promise<void> {
  await waitForConversationQuoteValidation(conversationKey);
}

function clearPendingQuoteValidation(message: Message): void {
  quoteValidationSignatures.delete(message);
  for (const [conversationKey, pending] of pendingQuoteValidations.entries()) {
    pending.delete(message);
    if (!pending.size) {
      pendingQuoteValidations.delete(conversationKey);
    }
  }
}

export function resetAssistantQuoteDisplay(message: Message): void {
  clearPendingQuoteValidation(message);
  message.quoteDisplayOverride = undefined;
}

export function finalizeAssistantMessageQuoteCitations(
  assistantMessage: Message,
  options: AssistantQuoteFinalizationOptions = {},
): void {
  const rawMarkdown = assistantMessage.text || "";
  if (!assistantMarkdownNeedsQuoteSourceSearch(rawMarkdown)) {
    resetAssistantQuoteDisplay(assistantMessage);
    return;
  }
  const rawQuoteCitations = assistantMessage.quoteCitations?.map(
    (citation) => ({
      ...citation,
    }),
  );
  scheduleAssistantMessageQuoteValidation(
    assistantMessage,
    rawMarkdown,
    rawQuoteCitations,
    options,
  );
}

export const finalizeAssistantMessageQuoteCitationsForTests =
  finalizeAssistantMessageQuoteCitations;

export function validateLoadedConversationQuoteMessages(
  messages: Message[],
  conversationKey: number,
): void {
  let pairedUserMessage: Message | null = null;
  for (const message of messages) {
    if (message.role === "user") {
      pairedUserMessage = message;
      continue;
    }
    if (
      message.compactMarker ||
      !assistantMarkdownNeedsQuoteSourceSearch(message.text || "")
    ) {
      continue;
    }
    finalizeAssistantMessageQuoteCitations(message, {
      pairedUserMessage,
      conversationKey,
    });
  }
}

/**
 * Re-run the authoritative provenance gate after citation navigation has
 * populated fresher page-text evidence. This schedules the same background
 * validator used on load; navigation itself cannot change quote provenance.
 */
export function scheduleConversationQuoteRevalidation(
  conversationKey: number,
): void {
  const normalizedKey = Math.floor(Number(conversationKey || 0));
  if (!normalizedKey) return;
  const messages = chatHistory.get(normalizedKey);
  if (!messages?.length) return;
  validateLoadedConversationQuoteMessages(messages, normalizedKey);
}
