/**
 * How the background quote validator asks the panel to re-render.
 *
 * The validator changes what an assistant message is allowed to display, and
 * only the renderer can repaint it -- but the renderer imports the validator,
 * so the validator cannot import the renderer back. The panel's composition
 * root (`composePanelSurfaces`) knows both halves and installs one here at
 * startup, the same way every other bridged capability is composed. It is
 * composed there rather than in `hostSurfaces.ts` because installing it means
 * importing the chat renderer, which workflow test bundles cannot carry.
 *
 * The bridge is deliberately loud: reaching it on a surface that never
 * composed is a wiring bug, not a condition to silently skip a repaint over.
 */
import { createSurfaceBridge } from "../../../services/surfaceBridge";
import type { Message } from "../types";

export type QuoteValidationChatRefresher = (
  body: Element,
  item: Zotero.Item,
  options: { rerenderAssistantMessages: ReadonlySet<Message> },
) => void;

const bridge = createSurfaceBridge<QuoteValidationChatRefresher>(
  "quote-validation chat refresh",
);

export function configureQuoteValidationChatRefresher(
  refresher: QuoteValidationChatRefresher | null,
): () => void {
  return bridge.configure(refresher);
}

export function refreshQuoteValidatedConversation(
  body: Element,
  item: Zotero.Item,
  options: { rerenderAssistantMessages: ReadonlySet<Message> },
): void {
  bridge.require()(body, item, options);
}
