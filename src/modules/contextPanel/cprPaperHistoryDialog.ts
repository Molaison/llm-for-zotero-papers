/**
 * Read-only view of a papers conversation stored on the remote CPR server.
 *
 * The dialog only renders what the server returned. It never touches the
 * local conversation: no append, no clear, no upload, no remote write.
 */
import type { ConversationSystem } from "../../shared/types";
import {
  isCprPapersModel,
  type CprPaperHistory,
  type CprPaperHistoryMessage,
} from "../../utils/cprPapers";
import { registerAddonInPanelDialog } from "../../utils/dialogRegistry";
import { createElement } from "../../utils/domHelpers";
import { t } from "../../utils/i18n";

/** The transport the button reuses: the current chat's own model settings. */
export type CprPaperHistoryRequest = {
  itemId: number;
  apiBase: string;
  apiKey: string;
  model: string;
};

/** One click's request, plus what tells a late answer whether it is still valid. */
export type CprPaperHistoryAttempt = {
  request: CprPaperHistoryRequest;
  signal: AbortSignal;
  /** False once the panel moved to another paper/window: drop the answer. */
  isCurrent: () => boolean;
  finish: () => void;
};

/**
 * Offer the button only for an upstream chat whose model is a papers alias and
 * whose conversation is bound to exactly one paper.
 */
export function shouldOfferCprPaperHistory(params: {
  conversationSystem: ConversationSystem;
  model: string;
  paperItemId: number | null | undefined;
}): boolean {
  return (
    params.conversationSystem === "upstream" &&
    Boolean(params.paperItemId) &&
    isCprPapersModel(params.model)
  );
}

/** The history protocol uses Unix milliseconds. */
export function formatCprHistoryTimestamp(
  createdAt: number | null | undefined,
): string {
  if (
    typeof createdAt !== "number" ||
    !Number.isFinite(createdAt) ||
    createdAt <= 0
  ) {
    return "";
  }
  const date = new Date(createdAt);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

const LIST_STYLE =
  "display:flex;flex-direction:column;gap:10px;max-height:55vh;overflow:auto;";
const MESSAGE_HEADER_STYLE =
  "font-size:var(--llm-fs-11,11px);opacity:0.7;margin-bottom:2px;";
const MESSAGE_TEXT_STYLE = "white-space:pre-wrap;word-break:break-word;";

/** The open dialog's closer, so a second open replaces instead of stacking. */
let closeOpenHistoryDialog: (() => void) | null = null;

function createMessageRow(
  doc: Document,
  message: CprPaperHistoryMessage,
): HTMLElement {
  const row = createElement(doc, "div", "llm-remote-history-message");
  row.dataset.role = message.role;
  const header = createElement(
    doc,
    "div",
    "llm-remote-history-message-header",
  );
  header.setAttribute("style", MESSAGE_HEADER_STYLE);
  header.textContent = [
    t(message.role === "user" ? "You" : "Assistant"),
    formatCprHistoryTimestamp(message.created_at),
  ]
    .filter(Boolean)
    .join(" · ");
  const text = createElement(doc, "div", "llm-remote-history-message-text");
  text.setAttribute("style", MESSAGE_TEXT_STYLE);
  // Remote text is untrusted: it is set as text and never as markup.
  text.textContent = message.text;
  row.append(header, text);
  return row;
}

/** Show the fetched history in a read-only, scrollable modal for `doc`. */
export function showCprPaperHistoryDialog(
  doc: Document,
  history: CprPaperHistory,
): void {
  const parent = doc.body ?? doc.documentElement;
  if (!parent) return;
  closeOpenHistoryDialog?.();

  const overlay = createElement(
    doc,
    "div",
    "llm-modal-overlay llm-remote-history-overlay",
  );
  overlay.setAttribute("role", "presentation");
  const dialog = createElement(
    doc,
    "div",
    "llm-modal-dialog llm-remote-history-dialog",
  );
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.style.width = "min(92vw, 800px)";
  dialog.setAttribute("aria-label", history.title || t("Remote record"));

  const title = createElement(doc, "div", "llm-modal-title", {
    textContent: history.title || t("Remote record"),
  });
  const link = createElement(doc, "a", "llm-remote-history-link", {
    textContent: t("Open original conversation"),
  });
  link.setAttribute("href", history.conversation_url);
  link.setAttribute("target", "_blank");
  link.setAttribute("rel", "noreferrer");

  const list = createElement(doc, "div", "llm-remote-history-list");
  list.setAttribute("style", LIST_STYLE);
  if (history.messages.length) {
    for (const message of history.messages) {
      list.appendChild(createMessageRow(doc, message));
    }
  } else {
    list.textContent = t("No remote messages yet.");
  }

  const actions = createElement(doc, "div", "llm-modal-actions");
  const closeBtn = createElement(doc, "button", "llm-modal-btn llm-modal-cancel", {
    type: "button",
    textContent: t("Close"),
  });
  actions.appendChild(closeBtn);
  dialog.append(title, link, list, actions);
  overlay.appendChild(dialog);

  let unregisterDialog = () => {};
  const close = () => {
    if (closeOpenHistoryDialog === close) closeOpenHistoryDialog = null;
    unregisterDialog();
    overlay.removeEventListener("click", onOverlayClick);
    doc.removeEventListener?.("keydown", onKeydown, true);
    overlay.remove();
  };
  const onOverlayClick = (event: Event) => {
    if (event.target === overlay) close();
  };
  const onKeydown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };

  overlay.addEventListener("click", onOverlayClick);
  closeBtn.addEventListener("click", close);
  doc.addEventListener?.("keydown", onKeydown, true);
  unregisterDialog = registerAddonInPanelDialog(doc, close);
  closeOpenHistoryDialog = close;
  parent.appendChild(overlay);
}

export type CprPaperHistoryControllerDeps = {
  /** Claims the conversation's request slot; null when it is busy or not ours. */
  begin: () => CprPaperHistoryAttempt | null;
  loadHistory: (
    params: CprPaperHistoryRequest & { signal?: AbortSignal },
  ) => Promise<CprPaperHistory>;
  showHistory: (history: CprPaperHistory) => void;
  setBusy: (busy: boolean) => void;
  setStatusMessage: (message: string, level: "ready" | "warning" | "error") => void;
  logError: (message: string, error: unknown) => void;
};

/**
 * The button's flow: one request at a time, the answer shown only while its own
 * paper/conversation is still the one on screen.
 */
export function createCprPaperHistoryController(
  deps: CprPaperHistoryControllerDeps,
): { open: () => Promise<void>; isBusy: () => boolean } {
  let inFlight = false;
  const open = async (): Promise<void> => {
    if (inFlight) return;
    const attempt = deps.begin();
    if (!attempt) return;
    inFlight = true;
    deps.setBusy(true);
    try {
      const history = await deps.loadHistory({
        ...attempt.request,
        signal: attempt.signal,
      });
      if (attempt.signal.aborted || !attempt.isCurrent()) return;
      deps.showHistory(history);
      deps.setStatusMessage(t("Ready"), "ready");
    } catch (error) {
      // Aborted or superseded: the panel already moved on, so say nothing.
      if (attempt.signal.aborted || !attempt.isCurrent()) return;
      deps.setStatusMessage(
        error instanceof Error && error.message
          ? error.message
          : t("Could not fetch remote record"),
        "error",
      );
      deps.logError("LLM: fetch remote paper history failed", error);
    } finally {
      inFlight = false;
      attempt.finish();
      deps.setBusy(false);
    }
  };
  return { open, isBusy: () => inFlight };
}
