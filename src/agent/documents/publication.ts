import {
  listPlanDocumentOutboxForConversation,
  loadPlanDocument,
  markPlanDocumentDelivered,
} from "./store";
import type { PlanDocument } from "./types";
import { notifyDocumentPublication } from "./publicationEvents";

/**
 * Completes the durable outbox only after the ordinary conversation store has
 * persisted the exact visible assistant text. Repeated calls are idempotent.
 */
export async function deliverPendingPlanDocumentMessage(params: {
  conversationKey: number;
  visibleMarkdown: string;
  messageTimestamp: number;
  documentId?: string;
}): Promise<PlanDocument | null> {
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
  const outbox = candidates.find(
    (entry) =>
      entry.visibleMarkdown === params.visibleMarkdown &&
      (!params.documentId || entry.documentId === params.documentId),
  );
  if (!outbox) return null;
  const document = await loadPlanDocument(outbox.documentId);
  if (
    !document ||
    document.visibleMarkdown !== params.visibleMarkdown ||
    document.visibleMarkdown !== outbox.visibleMarkdown
  ) {
    throw new Error(
      "Pending document does not match the persisted assistant message",
    );
  }
  if (outbox.status !== "pending" && outbox.status !== "delivered") return null;
  await Zotero.DB.executeTransaction(async () => {
    await markPlanDocumentDelivered({
      documentId: document.documentId,
      deliveredAt: Date.now(),
      messageTimestamp: params.messageTimestamp,
    });
  });
  notifyDocumentPublication(document.documentId);
  return document;
}
