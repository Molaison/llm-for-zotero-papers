import { getAgentApi } from "../../../../agent";
import type {
  ActionProgressEvent,
  ActionRequestContext,
} from "../../../../agent/actions";
import type { ModelProfileOverride } from "../../../../modelCapabilities";
import { getAbortController as getAbortControllerCtor } from "../../../../utils/apiHelpers";
import type { ModelProviderAuthMode } from "../../../../utils/modelProviders";
import type { ProviderProtocol } from "../../../../utils/providerProtocol";
import {
  formatActionLabel,
  resolveActionCompletionFeedback,
  resolveActionCompletionStatusText,
  resolveActionFailureFeedback,
} from "../../actionStatusText";
import { getAbortController, setAbortController } from "../../state";
import {
  beginTaskAction,
  endTaskAction,
  setTaskActionStep,
  setTaskActionSummary,
} from "../../taskProgress/store";
import type { ActionCommandLifecycle } from "./actionCommandLifecycle";

export type ActionExecutionLlmConfig = {
  model: string;
  apiBase: string;
  apiKey?: string;
  authMode?: ModelProviderAuthMode;
  providerProtocol?: ProviderProtocol;
  profileOverride?: ModelProfileOverride;
};

/**
 * Publish the run's controller so the panel's existing stop button cancels it.
 *
 * A slash action can start while a chat turn is still streaming, and that turn
 * owns the same slot. Claiming it only when free — and releasing it only while
 * it is still ours — keeps the action cancellable without ever stranding the
 * chat's controller.
 */
function claimActionAbortSlot(conversationKey: number | null): {
  signal?: AbortSignal;
  release: () => void;
} {
  // The Zotero chrome scope does not dependably expose AbortController.
  const Ctor = getAbortControllerCtor();
  if (!Ctor || conversationKey === null) return { release: () => {} };
  if (getAbortController(conversationKey)) return { release: () => {} };
  const controller = new Ctor();
  setAbortController(conversationKey, controller);
  return {
    signal: controller.signal,
    release: () => {
      if (getAbortController(conversationKey) === controller) {
        setAbortController(conversationKey, null);
      }
    },
  };
}

type RunAction = ReturnType<typeof getAgentApi>["runAction"];

let actionRunSeq = 0;

/**
 * The action's progress, told to the Task progress store: the row and the
 * overlay's Steps block show it (there is no card in the chat). `userQuery`
 * is the request the user typed with the action, if any.
 */
function createActionTaskProgress(
  conversationKey: number | null,
  actionName: string,
  userQuery?: string,
) {
  const key = conversationKey && conversationKey > 0 ? conversationKey : 0;
  const runId = `action-${Date.now()}-${++actionRunSeq}`;
  if (key)
    beginTaskAction(key, {
      runId,
      title: formatActionLabel(actionName),
      text: userQuery,
    });
  return {
    step: (step: string, index: number, total: number) => {
      if (key) setTaskActionStep(key, runId, { step, index, total });
    },
    summary: (summary: string) => {
      if (key) setTaskActionSummary(key, runId, summary);
    },
    end: (outcome: "completed" | "failed" | "cancelled", detail?: string) => {
      if (key) endTaskAction(key, runId, outcome, detail);
    },
  };
}

function feedbackText(feedback: { title: string; description?: string }) {
  return feedback.description
    ? `${feedback.title}: ${feedback.description}`
    : feedback.title;
}

export async function runAgentActionWithLifecycle(params: {
  actionName: string;
  input: Record<string, unknown>;
  requestContext: ActionRequestContext & { mode: "paper" | "library" };
  libraryID: number;
  llm?: ActionExecutionLlmConfig;
  isPagedLibraryAction?: boolean;
  conversationKey?: number | null;
  lifecycle: ActionCommandLifecycle;
  setStatus: (message: string, level: "ready" | "warning" | "error") => void;
  logError: (message: string, error?: unknown) => void;
  /** Test seam; the agent API's `runAction` by default. */
  runAction?: RunAction;
}): Promise<void> {
  const {
    actionName,
    conversationKey,
    input,
    isPagedLibraryAction,
    libraryID,
    lifecycle,
    llm,
    logError,
    requestContext,
    setStatus,
  } = params;
  const abortSlot = claimActionAbortSlot(conversationKey ?? null);
  setStatus(`Running: ${formatActionLabel(actionName)}...`, "ready");
  const progress = createActionTaskProgress(
    conversationKey ?? null,
    actionName,
    typeof input.userQuery === "string" ? input.userQuery : undefined,
  );
  let lastProgressSummary = "";
  const endFailed = (error: unknown) => {
    const feedback = resolveActionFailureFeedback({
      actionName,
      error,
      lastProgressSummary,
    });
    progress.end(
      abortSlot.signal?.aborted ? "cancelled" : "failed",
      feedbackText(feedback),
    );
    return feedback;
  };
  try {
    const runAction = params.runAction || getAgentApi().runAction;
    const commonOptions = {
      libraryID,
      // Files the run's changes under the user's conversation so undo and
      // the change history can find them.
      conversationKey: conversationKey ?? undefined,
      requestContext,
      llm,
      signal: abortSlot.signal,
      onProgress: (event: ActionProgressEvent) => {
        if (event.type === "step_start") {
          progress.step(event.step, event.index, event.total);
          setStatus(`${event.step} (${event.index}/${event.total})`, "ready");
        } else if (event.type === "step_done") {
          if (event.summary) {
            lastProgressSummary = event.summary;
            progress.summary(event.summary);
            setStatus(event.summary, "ready");
          }
        }
      },
    };
    if (isPagedLibraryAction) {
      getAgentApi()
        .getZoteroGateway()
        .invalidateLibrarySearchCache?.(libraryID);
    }
    const result = await runAction(actionName, input, {
      ...commonOptions,
      confirmationMode: "native_ui",
      requestConfirmation: (requestId, pendingAction) =>
        lifecycle.showActionHitlCard(requestId, pendingAction),
    });
    setStatus(
      result.ok
        ? resolveActionCompletionStatusText({
            actionName,
            lastProgressSummary,
          })
        : `${formatActionLabel(actionName)} failed: ${result.error}`,
      result.ok ? "ready" : "error",
    );
    if (result.ok) {
      const feedback = resolveActionCompletionFeedback({
        actionName,
        output: result.output,
        lastProgressSummary,
      });
      progress.end("completed", feedback.title);
      lifecycle.showActionCompletionCard(feedback);
    } else {
      lifecycle.closeActionHitlPanel();
      lifecycle.showActionCompletionCard(endFailed(result.error));
    }
  } catch (error) {
    lifecycle.closeActionHitlPanel();
    logError("LLM: action picker run error", error);
    setStatus(`Error: ${String(error)}`, "error");
    lifecycle.showActionCompletionCard(endFailed(error));
  } finally {
    abortSlot.release();
  }
}
