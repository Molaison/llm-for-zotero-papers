import {
  listPlanDocumentOutboxForConversation,
  loadPlanDocument,
  markPlanDocumentDelivered,
} from "./store";
import {
  areConversationWritesFrozen,
  getConversationWriteGeneration,
  isConversationWriteGenerationCurrent,
  withConversationWriteLock,
} from "../../shared/conversationWriteFence";
import { isConversationKeyRetiredInMemory } from "../../shared/conversationKeyLedger";
import type { PlanDocument } from "./types";
import { notifyDocumentPublication } from "./publicationEvents";

/**
 * The text a chat message carries before the document it ends with, trimmed:
 * "" when the message is the document alone, undefined when it does not end
 * with the document. A message that leads with text the model wrote before
 * calling the tool shows that text above the document card; Copy, Export
 * and Save Note deliver the document alone.
 */
export function documentMessageLead(
  messageText: string,
  documentMarkdown: string,
): string | undefined {
  if (!documentMarkdown || !messageText.endsWith(documentMarkdown))
    return undefined;
  return messageText.slice(0, -documentMarkdown.length).trim();
}

/**
 * Completes the durable outbox only after the ordinary conversation store has
 * persisted the visible assistant text. Repeated calls are idempotent.
 *
 * The persisted text is the document's exact markdown, or -- when the model
 * wrote deliverable text before calling the tool -- that text followed by the
 * document. The second form is accepted only for the named document id.
 */
type PublicationParams = {
  conversationKey: number;
  visibleMarkdown: string;
  messageTimestamp: number;
  documentId?: string;
  conversationGeneration?: number;
  /** Additional caller-owned fence, e.g. a loader's captured instance. */
  isCurrent?: () => boolean;
  /**
   * Runs after the pending document is validated and before it is marked
   * delivered. A failure here leaves the entry pending, so the next load
   * retries it. Must be idempotent.
   */
  beforeDelivered?: (
    document: PlanDocument,
    isCurrent: () => boolean,
  ) => Promise<void>;
};

/** Takes the conversation lock exactly once, capturing intent before waiting. */
export function deliverPendingPlanDocumentMessage(
  params: PublicationParams,
): Promise<PlanDocument | null> {
  const conversationGeneration =
    params.conversationGeneration ??
    getConversationWriteGeneration(params.conversationKey);
  return withConversationWriteLock(params.conversationKey, () =>
    deliverPendingPlanDocumentMessageWithinWriteLock({
      ...params,
      conversationGeneration,
    }),
  );
}

/** Caller MUST already own the conversation write lock; never reenter it. */
export async function deliverPendingPlanDocumentMessageWithinWriteLock(
  params: PublicationParams,
): Promise<PlanDocument | null> {
  const generation =
    params.conversationGeneration ??
    getConversationWriteGeneration(params.conversationKey);
  const isCurrent = () =>
    isConversationWriteGenerationCurrent(params.conversationKey, generation) &&
    !areConversationWritesFrozen(params.conversationKey) &&
    !isConversationKeyRetiredInMemory(params.conversationKey) &&
    (params.isCurrent?.() ?? true);
  if (!isCurrent()) return null;
  const candidates = (
    await listPlanDocumentOutboxForConversation(params.conversationKey)
  ).sort((left, right) => {
    if (params.documentId) return 0;
    const leftTimestamp = Math.abs(
      left.messageTimestamp - params.messageTimestamp,
    );
    const rightTimestamp = Math.abs(
      right.messageTimestamp - params.messageTimestamp,
    );
    return leftTimestamp - rightTimestamp;
  });
  if (!isCurrent()) return null;
  const carries = (visibleMarkdown: string) =>
    params.documentId
      ? documentMessageLead(params.visibleMarkdown, visibleMarkdown) !==
        undefined
      : visibleMarkdown === params.visibleMarkdown;
  const outbox = candidates.find(
    (entry) =>
      carries(entry.visibleMarkdown) &&
      (!params.documentId || entry.documentId === params.documentId),
  );
  if (
    !outbox ||
    outbox.status !== "pending" ||
    outbox.conversationKey !== params.conversationKey
  )
    return null;
  const document = await loadPlanDocument(outbox.documentId);
  if (!isCurrent()) return null;
  if (
    !document ||
    document.conversationKey !== params.conversationKey ||
    !carries(document.visibleMarkdown) ||
    document.visibleMarkdown !== outbox.visibleMarkdown
  ) {
    throw new Error(
      "Pending document does not match the persisted assistant message",
    );
  }
  await params.beforeDelivered?.(document, isCurrent);
  if (!isCurrent()) return null;
  // Roll back if invalidation is observed after a dispatched mark query.
  const stale = new Error("Stale document publication");
  let delivered = false;
  try {
    await Zotero.DB.executeTransaction(async () => {
      if (!isCurrent()) return;
      const marked = await markPlanDocumentDelivered({
        documentId: document.documentId,
        expectedOutbox: outbox,
        isCurrent,
        deliveredAt: Date.now(),
        messageTimestamp: params.messageTimestamp,
      });
      if (!isCurrent()) throw stale;
      delivered = Boolean(marked);
    });
  } catch (error) {
    if (error === stale) return null;
    throw error;
  }
  if (!delivered || !isCurrent()) return null;
  notifyDocumentPublication(document.documentId);
  return document;
}
