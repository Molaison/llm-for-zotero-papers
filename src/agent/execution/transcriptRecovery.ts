import { readAgentSemanticCheckpointRootGoal } from "../context/transcriptCompactor";
import type { JournalActionWithSteps } from "../store/changeJournal";
import type {
  AgentModelMessage,
  AgentRunRecord,
  AgentRuntimeRequest,
} from "../types";
import type { ResumableBatch } from "../store/batchItemStore";
import { formatResumableBatchRecoveryLines } from "./batchOutcomes";
import { formatMaterialOutcomeRecoveryLines } from "./materialOutcomes";
import type { MaterialOutcomeEntry } from "./types";

export function isManualCompactRequest(request: AgentRuntimeRequest): boolean {
  return /^\/compact(?:\s|$)/i.test((request.userText || "").trim());
}

export function buildTranscriptUserMessage(
  request: AgentRuntimeRequest,
): AgentModelMessage {
  return {
    role: "user",
    content: `User request:\n${request.userText || ""}`,
  };
}

function transcriptContentToPlainText(
  content: AgentModelMessage["content"],
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n");
}

function normalizeTranscriptUserText(value: string): string {
  return value
    .replace(/^User request:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function isCurrentTurnUserTranscriptMessage(
  message: AgentModelMessage | undefined,
  request: AgentRuntimeRequest,
): boolean {
  if (!message || message.role !== "user") return false;
  return (
    normalizeTranscriptUserText(
      transcriptContentToPlainText(message.content),
    ) === normalizeTranscriptUserText(request.userText || "")
  );
}

export function readLatestTranscriptGoal(
  messages: readonly AgentModelMessage[],
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    const checkpointGoal = readAgentSemanticCheckpointRootGoal(message);
    if (checkpointGoal) {
      return checkpointGoal.length > 600
        ? `${checkpointGoal.slice(0, 597)}...`
        : checkpointGoal;
    }
    const goal = normalizeTranscriptUserText(
      transcriptContentToPlainText(message.content),
    );
    if (!goal) continue;
    return goal.length > 600 ? `${goal.slice(0, 597)}...` : goal;
  }
  return undefined;
}

/**
 * What a turn has to know about work the conversation left unfinished.
 *
 * Every section answers the same question -- what already exists, so that the
 * model continues it instead of making it again -- so they travel as one host
 * message. A second message would stack another block into every prompt for
 * as long as any stayed outstanding. Returns null when nothing is
 * outstanding.
 */
export function buildTurnStartRecoveryMessage(params: {
  materialOutcomes?: readonly MaterialOutcomeEntry[];
  resumableBatches?: readonly ResumableBatch[];
}): AgentModelMessage | null {
  const lines = [
    ...formatMaterialOutcomeRecoveryLines(params.materialOutcomes || []),
    ...formatResumableBatchRecoveryLines(params.resumableBatches || []),
  ];
  // Transient: the ledger and the batch rows behind it are read again at every
  // turn start, so this message must never be copied into the transcript or
  // one of its checkpoints.
  return lines.length
    ? { role: "user", content: lines.join("\n"), transient: true }
    : null;
}

export function buildInterruptedRunRecoveryMessage(params: {
  run: AgentRunRecord;
  actions: JournalActionWithSteps[];
  priorGoal?: string;
  materialOutcomes?: readonly MaterialOutcomeEntry[];
  resumableBatches?: readonly ResumableBatch[];
}): AgentModelMessage {
  const actions = [...params.actions].sort(
    (left, right) =>
      left.createdAt - right.createdAt ||
      left.actionId.localeCompare(right.actionId),
  );
  const lines = [
    `Recovery note for interrupted run ${params.run.runId}.`,
    "Do not automatically repeat any prior write.",
  ];
  if (params.priorGoal) lines.push(`Prior goal: ${params.priorGoal}`);
  if (actions.length) {
    lines.push("Recorded journal actions:");
    for (const action of actions) {
      lines.push(
        `- actionId=${action.actionId}; status=${action.status}; affectedCount=${action.affectedCount}; reversibility=${action.reversibility}`,
      );
    }
  } else {
    lines.push("No journaled writes were recorded.");
  }
  lines.push(
    ...formatMaterialOutcomeRecoveryLines(params.materialOutcomes || []),
    ...formatResumableBatchRecoveryLines(params.resumableBatches || []),
  );
  lines.push(
    "Any unfinished confirmation was discarded and must be proposed and approved again.",
  );
  return { role: "user", content: lines.join("\n") };
}
