import type { ConversationSystem } from "../../shared/types";
import { t } from "../../utils/i18n";

/** Recovery is local and must remain reachable after changing API/model settings. */
export function shouldOfferCprLocalHistoryRecovery(params: {
  conversationSystem: ConversationSystem;
  paperItemId: number | null | undefined;
  isNoteSession: boolean;
}): boolean {
  return (
    params.conversationSystem === "upstream" &&
    Boolean(params.paperItemId) &&
    !params.isNoteSession
  );
}

export type CprLocalHistoryRecoveryAttempt = {
  signal: AbortSignal;
  isCurrent: () => boolean;
  hasRestorePoint: () => Promise<boolean>;
  restoreHistory: () => Promise<void>;
  finish: () => void;
};

export type CprLocalHistoryRecoveryDeps = {
  /** Reserve the same slot used by sends and remote synchronization. */
  begin: () => CprLocalHistoryRecoveryAttempt | null;
  confirmRestore: () => boolean | Promise<boolean>;
  setBusy: (busy: boolean) => void;
  setStatusMessage: (
    message: string,
    level: "ready" | "warning" | "error",
  ) => void;
  logError: (message: string, error: unknown) => void;
};

export function createCprLocalHistoryRecoveryController(
  deps: CprLocalHistoryRecoveryDeps,
): { open: () => Promise<void>; isBusy: () => boolean } {
  let inFlight = false;
  const open = async (): Promise<void> => {
    if (inFlight) return;
    const attempt = deps.begin();
    if (!attempt) return;
    inFlight = true;
    deps.setBusy(true);
    const isCurrent = () => !attempt.signal.aborted && attempt.isCurrent();
    try {
      const available = await attempt.hasRestorePoint();
      if (!isCurrent()) return;
      if (!available) {
        deps.setStatusMessage(
          t("No local history restore point is available"),
          "warning",
        );
        return;
      }
      const confirmed = await deps.confirmRestore();
      if (!isCurrent()) return;
      if (!confirmed) {
        deps.setStatusMessage(t("Local history restore cancelled"), "ready");
        return;
      }
      await attempt.restoreHistory();
      if (!isCurrent()) return;
      deps.setStatusMessage(t("Local history restored"), "ready");
    } catch (error) {
      if (!isCurrent()) return;
      deps.setStatusMessage(
        error instanceof Error && error.message
          ? error.message
          : t("Could not restore local history"),
        "error",
      );
      deps.logError("LLM: restore local paper history failed", error);
    } finally {
      inFlight = false;
      attempt.finish();
      deps.setBusy(false);
    }
  };
  return { open, isBusy: () => inFlight };
}
