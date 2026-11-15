import { HTML_NS } from "../../utils/domHelpers";
import { isRequestPending, subscribeRequestActivity } from "./state";

/** A transient view of the request owner, never persisted in history. */
export function createHistoryActivityIndicator(
  doc: Document,
  conversationKey: number,
  label: string,
): HTMLSpanElement {
  const indicator = doc.createElementNS(HTML_NS, "span") as HTMLSpanElement;
  indicator.className = "llm-history-activity";
  indicator.dataset.conversationKey = String(conversationKey);
  indicator.setAttribute("role", "img");
  indicator.setAttribute("aria-label", label);
  indicator.title = label;
  indicator.hidden = !isRequestPending(conversationKey);
  return indicator;
}

/** Update mounted indicators only; keep rows, selection, and scroll intact. */
export function observeHistoryActivity(root: Element): () => void {
  return subscribeRequestActivity((conversationKey) => {
    const indicators = Array.from(
      root.querySelectorAll(
        `.llm-history-activity[data-conversation-key="${conversationKey}"]`,
      ),
    ) as HTMLElement[];
    for (const indicator of indicators) {
      indicator.hidden = !isRequestPending(conversationKey);
    }
  });
}
