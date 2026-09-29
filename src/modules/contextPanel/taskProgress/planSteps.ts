/**
 * The Steps block of the Task progress drawer: the live plan's status, its
 * required-step progress bar, the task list, and the research line — or,
 * with no plan, a checklist: a built-in action's steps and summary, or the
 * plan Codex keeps with `update_plan`.
 *
 * This is the one place step progress renders (the floating capsule, the
 * in-chat action "Working" card and the Codex checklist trace row it
 * replaces are gone). Updates patch the previous block in place,
 * matching task rows by id, so an open `<details>` row and the nodes a
 * reader is looking at survive every ledger update.
 */
import type { PlanExecutionLedger } from "../../../agent/plans/types";
import { t } from "../../../utils/i18n";
import { applyStableAnimationPhase } from "../stableAnimationPhase";
import type { TaskProgressChecklist, TaskProgressPlan } from "./store";

const PLAN_STATUS_SYMBOLS: Record<string, string> = {
  pending: "",
  in_progress: "",
  waiting_for_user: "!",
  interrupted: "↻",
  completed: "✓",
  blocked: "!",
  failed: "×",
  skipped: "–",
  cancelled: "×",
};

/** Plan execution states the Steps block shows as live. */
export function isLivePlanExecutionStatus(status: string | undefined): boolean {
  return status === "pending" || status === "running";
}

export function executionStatusLabel(
  status: PlanExecutionLedger["status"],
): string {
  switch (status) {
    case "pending":
      return t("Starting");
    case "running":
      return t("In progress");
    case "waiting_for_user":
      return t("Needs input");
    case "interrupted":
      return t("Interrupted");
    case "completed":
      return t("Completed");
    case "completed_with_exceptions":
      return t("Completed with exceptions");
    case "blocked":
      return t("Blocked");
    case "failed":
      return t("Failed");
    case "cancelled":
      return t("Cancelled");
    case "superseded":
      return t("Superseded");
  }
  return status;
}

/** Required steps completed, and required steps in all. */
export function countPlanSteps(ledger: PlanExecutionLedger): {
  completed: number;
  total: number;
} {
  const required = ledger.tasks.filter((task) => task.kind === "required_step");
  return {
    completed: required.filter((task) => task.status === "completed").length,
    total: required.length,
  };
}

/** Only presentation nodes are patched here; interactive controls keep their own listeners. */
function patchPresentation(target: HTMLElement, source: HTMLElement): void {
  for (const attr of Array.from(target.attributes)) {
    if (attr.name !== "open" && !source.hasAttribute(attr.name))
      target.removeAttribute(attr.name);
  }
  for (const attr of Array.from(source.attributes)) {
    if (attr.name !== "open" && target.getAttribute(attr.name) !== attr.value)
      target.setAttribute(attr.name, attr.value);
  }
  let cursor = target.firstChild;
  for (const next of Array.from(source.childNodes)) {
    if (!next) continue;
    const taskId = (next as HTMLElement).dataset?.taskId;
    if (taskId) {
      const match = Array.from(target.children).find(
        (child) => (child as HTMLElement).dataset.taskId === taskId,
      );
      if (match && match !== cursor) target.insertBefore(match, cursor);
      if (match) cursor = match;
      else {
        target.insertBefore(next, cursor);
        continue;
      }
    }
    if (
      cursor &&
      cursor.nodeType === next.nodeType &&
      cursor.nodeName === next.nodeName
    ) {
      if (cursor.nodeType === 3) {
        if (cursor.nodeValue !== next.nodeValue)
          cursor.nodeValue = next.nodeValue;
      } else patchPresentation(cursor as HTMLElement, next as HTMLElement);
      cursor = cursor.nextSibling;
    } else target.insertBefore(next, cursor);
  }
  while (cursor) {
    const next = cursor.nextSibling;
    target.removeChild(cursor);
    cursor = next;
  }
}

function renderExecutionTasks(
  doc: Document,
  ledger: PlanExecutionLedger,
): HTMLElement {
  const tasks = doc.createElement("div");
  tasks.className = "llm-plan-task-list";
  tasks.setAttribute("role", "list");
  ledger.tasks.forEach((entry, index) => {
    const hasDetails = Boolean(
      entry.acceptanceCriteria.length ||
      entry.evidenceIds.length ||
      entry.failureReasons.length ||
      entry.parentTaskId,
    );
    const row = doc.createElement(hasDetails ? "details" : "div") as
      | HTMLDetailsElement
      | HTMLDivElement;
    row.dataset.taskId = entry.taskId;
    row.className = `llm-plan-task llm-plan-task-${entry.status}`;
    row.setAttribute("role", "listitem");
    if (hasDetails) {
      (row as HTMLDetailsElement).open = [
        "waiting_for_user",
        "interrupted",
        "blocked",
        "failed",
      ].includes(entry.status);
    }

    const line = doc.createElement(hasDetails ? "summary" : "div");
    line.className = "llm-plan-task-line";
    const badge = doc.createElement("span");
    badge.className = `llm-plan-task-badge llm-plan-task-badge-${entry.status}`;
    badge.setAttribute("aria-hidden", "true");
    applyStableAnimationPhase(badge, entry.startedAt || ledger.createdAt);
    const symbol = PLAN_STATUS_SYMBOLS[entry.status] || "";
    badge.textContent = symbol || `${index + 1}`;

    const content = doc.createElement("span");
    content.className = "llm-plan-task-content";
    const label = doc.createElement("span");
    label.className = "llm-plan-task-label";
    label.textContent =
      entry.status === "in_progress" ? entry.activeForm : entry.content;
    content.appendChild(label);
    if (entry.status === "in_progress" && entry.activeForm !== entry.content) {
      const original = doc.createElement("span");
      original.className = "llm-plan-task-original";
      original.textContent = entry.content;
      content.appendChild(original);
    } else if (entry.parentTaskId) {
      const supporting = doc.createElement("span");
      supporting.className = "llm-plan-task-original";
      supporting.textContent = t("Supporting step");
      content.appendChild(supporting);
    }

    const pill = doc.createElement("span");
    pill.className = `llm-plan-task-pill llm-plan-task-pill-${entry.status}`;
    const pillText: Record<string, string> = {
      completed: "Done",
      failed: "Failed",
      blocked: "Blocked",
      waiting_for_user: "Needs input",
      interrupted: "Interrupted",
      skipped: "Skipped",
      cancelled: "Cancelled",
    };
    pill.textContent = pillText[entry.status] ? t(pillText[entry.status]) : "";
    if (!pill.textContent) pill.hidden = true;

    line.append(badge, content, pill);
    row.appendChild(line);

    if (hasDetails) {
      const detail = doc.createElement("div");
      detail.className = "llm-plan-task-details";
      if (entry.acceptanceCriteria.length) {
        const criteria = doc.createElement("p");
        criteria.className = "llm-plan-task-criteria";
        criteria.textContent = `${t("Done when:")} ${entry.acceptanceCriteria
          .map((criterion) =>
            typeof criterion === "string" ? criterion : criterion.description,
          )
          .join(" · ")}`;
        detail.appendChild(criteria);
      }
      if (entry.evidenceIds.length) {
        const evidence = doc.createElement("p");
        evidence.className = "llm-plan-task-evidence";
        evidence.textContent = `${entry.evidenceIds.length} evidence record${
          entry.evidenceIds.length === 1 ? "" : "s"
        } attached`;
        detail.appendChild(evidence);
      }
      if (entry.failureReasons.length) {
        const failure = doc.createElement("p");
        failure.className = "llm-plan-task-failure";
        failure.textContent = entry.failureReasons.join(" · ");
        detail.appendChild(failure);
      }
      row.appendChild(detail);
    }
    tasks.appendChild(row);
  });
  return tasks;
}

function buildStepsContent(doc: Document, plan: TaskProgressPlan): HTMLElement {
  const ledger = plan.ledger;
  const content = doc.createElement("div");
  content.className = "llm-task-progress-steps-body";
  // Attributes, not dataset: the in-place patch copies attributes.
  content.setAttribute("data-llm-plan-id", ledger.planId);
  content.setAttribute("data-llm-plan-execution-id", ledger.executionId);
  content.setAttribute("data-llm-plan-execution-status", ledger.status);
  const { completed, total } = countPlanSteps(ledger);
  const header = doc.createElement("div");
  header.className = "llm-plan-header";
  const heading = doc.createElement("div");
  heading.className = "llm-plan-heading";
  const title = doc.createElement("h4");
  title.className = "llm-task-progress-steps-title";
  title.textContent = t("Steps");
  heading.appendChild(title);
  if (ledger.revision > 1) {
    const version = doc.createElement("span");
    version.className = "llm-plan-version";
    version.textContent = `${t("Revision")} ${ledger.revision}`;
    heading.appendChild(version);
  }
  const status = doc.createElement("span");
  status.className = "llm-plan-status";
  status.textContent = executionStatusLabel(ledger.status);
  status.dataset.status = ledger.status;
  header.append(heading, status);
  const progress = doc.createElement("div");
  progress.className = "llm-plan-progress";
  progress.setAttribute("role", "progressbar");
  progress.setAttribute("aria-label", t("Required task completion"));
  progress.setAttribute("aria-valuemin", "0");
  progress.setAttribute("aria-valuemax", `${total}`);
  progress.setAttribute("aria-valuenow", `${completed}`);
  const track = doc.createElement("span");
  track.className = "llm-plan-progress-track";
  track.setAttribute("aria-hidden", "true");
  const fill = doc.createElement("span");
  fill.className = "llm-plan-progress-fill";
  fill.style.width = `${total ? Math.round((completed / total) * 100) : 0}%`;
  track.appendChild(fill);
  progress.appendChild(track);
  content.append(header, progress, renderExecutionTasks(doc, ledger));
  const research = plan.research;
  if (research && research.executionId === ledger.executionId) {
    const text = doc.createElement("div");
    text.className = "llm-plan-research-progress";
    const quality = research.quality;
    const phase = research.phase;
    text.textContent = `Screened ${research.screenedItems.toLocaleString()}/${research.totalItems.toLocaleString()}; deep-read ${research.deepReadCompleted.toLocaleString()}/${research.candidateItems.toLocaleString()}${
      phase && phase !== "complete" ? `; phase ${phase}` : ""
    }${
      quality
        ? `; ${quality.edges.toLocaleString()} relationships (${quality.edgesVerified.toLocaleString()} verified)`
        : ""
    }`;
    content.appendChild(text);
  }
  return content;
}

/**
 * Render the Steps block for a plan into `host`, patching the block already
 * there when it shows the same execution.
 */
export function renderPlanSteps(
  doc: Document,
  host: HTMLElement,
  plan: TaskProgressPlan,
): void {
  const next = buildStepsContent(doc, plan);
  const previous = host.firstChild as HTMLElement | null;
  if (
    previous &&
    previous.getAttribute?.("data-llm-plan-execution-id") ===
      plan.ledger.executionId
  ) {
    patchPresentation(previous, next);
    return;
  }
  host.replaceChildren(next);
}

function checklistStatusLabel(checklist: TaskProgressChecklist): string {
  switch (checklist.outcome) {
    case "completed":
      return t("Completed");
    case "failed":
      return t("Failed");
    case "cancelled":
      return t("Cancelled");
  }
  return t("In progress");
}

function buildChecklistContent(
  doc: Document,
  checklist: TaskProgressChecklist,
): HTMLElement {
  const content = doc.createElement("div");
  content.className = "llm-task-progress-steps-body";
  content.setAttribute("data-llm-checklist-run-id", checklist.runId);
  content.setAttribute("data-llm-checklist-source", checklist.source);
  const header = doc.createElement("div");
  header.className = "llm-plan-header";
  const heading = doc.createElement("div");
  heading.className = "llm-plan-heading";
  const title = doc.createElement("h4");
  title.className = "llm-task-progress-steps-title";
  title.textContent = checklist.title
    ? `${t("Steps")} · ${checklist.title}`
    : t("Steps");
  heading.appendChild(title);
  const status = doc.createElement("span");
  status.className = "llm-plan-status";
  status.textContent = checklistStatusLabel(checklist);
  status.dataset.status = checklist.outcome || "running";
  header.append(heading, status);
  const children: HTMLElement[] = [header];
  if (checklist.total > 0) {
    const progress = doc.createElement("div");
    progress.className = "llm-plan-progress";
    progress.setAttribute("role", "progressbar");
    progress.setAttribute("aria-label", t("Required task completion"));
    progress.setAttribute("aria-valuemin", "0");
    progress.setAttribute("aria-valuemax", `${checklist.total}`);
    progress.setAttribute("aria-valuenow", `${checklist.done}`);
    const track = doc.createElement("span");
    track.className = "llm-plan-progress-track";
    track.setAttribute("aria-hidden", "true");
    const fill = doc.createElement("span");
    fill.className = "llm-plan-progress-fill";
    fill.style.width = `${Math.round((checklist.done / checklist.total) * 100)}%`;
    track.appendChild(fill);
    progress.appendChild(track);
    children.push(progress);
  }
  const tasks = doc.createElement("div");
  tasks.className = "llm-plan-task-list";
  tasks.setAttribute("role", "list");
  checklist.steps.forEach((step, index) => {
    if (!step.label) return;
    const row = doc.createElement("div");
    row.dataset.taskId = `step-${index + 1}`;
    row.className = `llm-plan-task llm-plan-task-${step.status}`;
    row.setAttribute("role", "listitem");
    const line = doc.createElement("div");
    line.className = "llm-plan-task-line";
    const badge = doc.createElement("span");
    badge.className = `llm-plan-task-badge llm-plan-task-badge-${step.status}`;
    badge.setAttribute("aria-hidden", "true");
    badge.textContent =
      PLAN_STATUS_SYMBOLS[step.status] ||
      (step.status === "in_progress" ? "" : `${index + 1}`);
    const content = doc.createElement("span");
    content.className = "llm-plan-task-content";
    const label = doc.createElement("span");
    label.className = "llm-plan-task-label";
    label.textContent = step.label;
    content.appendChild(label);
    line.append(badge, content);
    row.appendChild(line);
    tasks.appendChild(row);
  });
  children.push(tasks);
  if (checklist.summary) {
    const summary = doc.createElement("div");
    summary.className = "llm-plan-research-progress";
    summary.textContent = checklist.summary;
    children.push(summary);
  }
  if (checklist.detail) {
    const detail = doc.createElement("p");
    detail.className =
      checklist.outcome === "failed"
        ? "llm-plan-task-failure"
        : "llm-plan-research-progress";
    detail.textContent = checklist.detail;
    children.push(detail);
  }
  content.append(...children);
  return content;
}

/**
 * Render a checklist's Steps block into `host`, patching the block already
 * there when it shows the same run's steps.
 */
export function renderChecklistSteps(
  doc: Document,
  host: HTMLElement,
  checklist: TaskProgressChecklist,
): void {
  const next = buildChecklistContent(doc, checklist);
  const previous = host.firstChild as HTMLElement | null;
  if (
    previous &&
    previous.getAttribute?.("data-llm-checklist-run-id") === checklist.runId
  ) {
    patchPresentation(previous, next);
    return;
  }
  host.replaceChildren(next);
}
