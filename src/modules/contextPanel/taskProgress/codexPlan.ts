/**
 * Codex's own plan (its `update_plan` checklist) as a run event.
 *
 * The native Codex turn keeps its plan in one `codex_progress` event with a
 * fixed item id, persisted with the run like every other event. The trace
 * does not render it; the Task progress Steps block reads it, live and when
 * the conversation is reopened. Older runs stored the list only as text
 * ("✓ step" / "• step"), which is read too.
 */
import type { AgentEvent } from "../../../agent/types";
import type { TaskProgressStep, TaskProgressStepStatus } from "./store";

export const CODEX_PLAN_CHECKLIST_ITEM_ID = "codex-plan-checklist";

export type CodexPlanStep = { content: string; status?: string };

function stepStatus(status: string | undefined): TaskProgressStepStatus {
  const key = (status || "").replace(/[-_\s]+/g, "").toLowerCase();
  if (key === "completed" || key === "done") return "completed";
  if (key === "inprogress" || key === "running" || key === "active")
    return "in_progress";
  return "pending";
}

/** Codex's steps as the Steps block shows them. */
export function codexPlanTaskSteps(
  steps: readonly CodexPlanStep[],
): TaskProgressStep[] {
  return steps
    .filter((step) => step.content?.trim())
    .map((step) => ({
      label: step.content.trim(),
      status: stepStatus(step.status),
    }));
}

/** The legacy text form: one "✓ step" or "• step" per line. */
function stepsFromText(text: string): TaskProgressStep[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const done = line.startsWith("✓");
      return {
        label: line.replace(/^[✓•]\s*/, ""),
        status: (done ? "completed" : "pending") as TaskProgressStepStatus,
      };
    })
    .filter((step) => step.label);
}

/** True for the event that carries Codex's plan. */
export function isCodexPlanChecklistEvent(event: AgentEvent): boolean {
  return (
    event.type === "codex_progress" &&
    event.itemId === CODEX_PLAN_CHECKLIST_ITEM_ID
  );
}

/** The plan an event carries, or null when it carries none. */
export function readCodexPlanChecklist(
  event: AgentEvent,
): TaskProgressStep[] | null {
  if (event.type !== "codex_progress") return null;
  if (event.itemId !== CODEX_PLAN_CHECKLIST_ITEM_ID) return null;
  const steps = event.steps?.length
    ? codexPlanTaskSteps(event.steps)
    : stepsFromText(event.text || "");
  return steps.length ? steps : null;
}
