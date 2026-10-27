import type { Message } from "./types";
import { t } from "../../utils/i18n";

// The old empty-stream catch persisted this whole notice without a failure flag.
// Do not infer failures from arbitrary model prose containing "Error:".
const LEGACY_MODEL_CONTROLS_NOTICE =
  "Error: ChatGPT model controls are unavailable. Reload ChatGPT and retry the task.";

export function assistantFailureTitle(message: Message): string | undefined {
  if (message.role !== "assistant" || message.streaming) return;
  const recordedFailure = message.webchatRunState === "error" ||
    message.webchatCompletionReason === "error" || message.completionStatus === "blocked";
  const legacyControlsFailure = message.text.trim() === LEGACY_MODEL_CONTROLS_NOTICE &&
    message.completionStatus !== "complete";
  if (legacyControlsFailure) return t("Model controls unavailable");
  if (recordedFailure) return t("Answer incomplete");
}
