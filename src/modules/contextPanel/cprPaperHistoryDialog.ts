import type { ConversationSystem } from "../../shared/types";
import {
  isCprPapersModel,
  type CprPaperHistory,
} from "../../utils/cprPapers";
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
  /** Persist and refresh the captured conversation while this request owns its slot. */
  applyHistory: (history: CprPaperHistory) => Promise<void>;
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

export type CprPaperHistoryControllerDeps = {
  /** Claims the conversation's request slot; null when it is busy or not ours. */
  begin: () => CprPaperHistoryAttempt | null;
  loadHistory: (
    params: CprPaperHistoryRequest & { signal?: AbortSignal },
  ) => Promise<CprPaperHistory>;
  setBusy: (busy: boolean) => void;
  setStatusMessage: (message: string, level: "ready" | "warning" | "error") => void;
  logError: (message: string, error: unknown) => void;
};

/**
 * Hold the request slot until the fetched snapshot is durably applied to its
 * captured conversation; late results never target the newly selected panel.
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
      await attempt.applyHistory(history);
      if (attempt.signal.aborted || !attempt.isCurrent()) return;
      deps.setStatusMessage(t("Remote conversation synchronized"), "ready");
    } catch (error) {
      // Aborted or superseded: the panel already moved on, so say nothing.
      if (attempt.signal.aborted || !attempt.isCurrent()) return;
      deps.setStatusMessage(
        error instanceof Error && error.message
          ? error.message
          : t("Could not sync remote conversation"),
        "error",
      );
      deps.logError("LLM: synchronize remote paper conversation failed", error);
    } finally {
      inFlight = false;
      attempt.finish();
      deps.setBusy(false);
    }
  };
  return { open, isBusy: () => inFlight };
}
