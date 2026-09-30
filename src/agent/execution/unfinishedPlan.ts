/**
 * A plan execution the conversation left unfinished, said in the prompt.
 *
 * A stored execution resumes only when the user's message answers its
 * question or asks, as a whole, to continue it. Every other message runs as
 * an ordinary turn, and without a host line naming the plan the model cannot
 * tell the user that the plan is still waiting, or how to pick it up again.
 *
 * The line names the step and the one command that resumes it. It does not
 * point at the plan card's Resume button: that button renders only on the
 * latest assistant message, so it is gone once this turn has answered.
 */
import type { PlanExecutionLedger } from "../plans/types";

const STEP_TEXT_MAX_LENGTH = 120;

const SETTLED_TASK_STATUSES = new Set(["completed", "skipped", "cancelled"]);

/**
 * A step's text is model-authored. It is quoted inside a host-written line,
 * so strip anything that could forge a second line or close the quote early,
 * and cap the length.
 */
function quotedStepText(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ")
    .trim()
    .slice(0, STEP_TEXT_MAX_LENGTH)
    .replace(/"/gu, '\\"');
}

/**
 * The host line that names an unfinished plan this turn did not resume.
 * Empty when there is none.
 */
export function formatUnfinishedPlanRecoveryLines(
  ledger: PlanExecutionLedger | null | undefined,
): string[] {
  if (!ledger) return [];
  const steps = ledger.tasks.filter((task) => task.kind === "required_step");
  const open = steps.findIndex(
    (task) => !SETTLED_TASK_STATUSES.has(task.status),
  );
  const step =
    open >= 0
      ? `: step ${open + 1} of ${steps.length}, "${quotedStepText(steps[open].content)}"`
      : "";
  return [
    `Unfinished plan (status=${ledger.status})${step}. The current message was not taken as a resume of the plan; mention the plan only if it bears on the request, and the user can resume it by saying "continue".`,
  ];
}
