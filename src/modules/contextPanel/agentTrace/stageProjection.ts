import type {
  AgentEvent,
  AgentRunEventRecord,
  AgentWorkCategory,
} from "../../../agent/types";
import type { MaterialRef } from "../../../agent/documents/materialRef";
import {
  buildAgentStageEvent as buildStage,
  type AgentStageEvent,
} from "../../../agent/stageEvents";

type AgentStagePayload = AgentStageEvent;
type ToolCallPayload = Extract<AgentEvent, { type: "tool_call" }>;
type ToolResultPayload = Extract<AgentEvent, { type: "tool_result" }>;
type ToolErrorPayload = Extract<AgentEvent, { type: "tool_error" }>;
type CodexToolActivityPayload = Extract<
  AgentEvent,
  { type: "codex_tool_activity" }
>;

/**
 * Events that would carry a work category if the run that wrote them had
 * known about categories. A trace holding one of these and no category at
 * all is older than the category contract itself.
 */
const CATEGORY_BEARING_EVENT_TYPES: ReadonlySet<AgentEvent["type"]> = new Set([
  "tool_call",
  "tool_result",
  "tool_error",
  "codex_tool_activity",
]);

/**
 * What an old run's stored plan event says about the planning stage, the
 * way the runtime once published it: a revision still being drafted opened
 * the stage and a reviewable plan closed it. Every other plan event reported
 * work inside a stage rather than a transition of one -- an execution ledger
 * advancing would otherwise close a stage nothing had opened, once per task.
 */
const PLANNING_STAGE_STATUS_BY_PLAN_EVENT: Readonly<
  Record<string, "started" | "completed">
> = {
  plan_updated: "started",
  plan_ready: "completed",
};

/** What a trace says about one tool call, gathered before the walk. */
type ProjectedCall = {
  /**
   * The category the call's own events declared, read once for all of them:
   * the stage that opens a call and the stage that closes it must resolve
   * the same category, or a partly stamped trace would open a stage nothing
   * ever closes.
   */
  category?: AgentWorkCategory;
  toolName?: string;
  toolLabel?: string;
  /** Whether a result ever answered the call, so an error is not its close. */
  hasResult: boolean;
  /** The material the call finalized, as its own announcement reported it. */
  materialRef?: MaterialRef;
};

function readCalls(
  events: readonly AgentRunEventRecord[],
): Map<string, ProjectedCall> {
  const calls = new Map<string, ProjectedCall>();
  const readCall = (callId: string): ProjectedCall => {
    const existing = calls.get(callId);
    if (existing) return existing;
    const created: ProjectedCall = { hasResult: false };
    calls.set(callId, created);
    return created;
  };
  for (const entry of events) {
    const payload = entry.payload;
    if (
      payload.type === "tool_call" ||
      payload.type === "tool_result" ||
      payload.type === "tool_error"
    ) {
      const call = readCall(payload.callId);
      call.category = call.category || payload.workCategory;
      call.toolName = call.toolName || payload.name;
      call.toolLabel = call.toolLabel || payload.toolLabel;
      if (payload.type === "tool_result") call.hasResult = true;
      continue;
    }
    if (payload.type === "material_finalized" && payload.callId) {
      const call = readCall(payload.callId);
      call.materialRef = call.materialRef || payload.materialRef;
      continue;
    }
    if (payload.type === "batch_item_outcome") readCall(payload.callId);
  }
  return calls;
}

function projectToolCall(
  payload: ToolCallPayload,
  call: ProjectedCall | undefined,
): AgentStagePayload | null {
  const stage = call?.category;
  if (!stage) return null;
  return buildStage({
    stage,
    status: "started",
    callId: payload.callId,
    toolName: payload.name,
    toolLabel: payload.toolLabel,
    projected: true,
  });
}

function projectToolResult(
  payload: ToolResultPayload,
  call: ProjectedCall | undefined,
): AgentStagePayload | null {
  const stage = call?.category;
  if (!stage) return null;
  return buildStage({
    stage,
    status: payload.ok ? "completed" : "failed",
    callId: payload.callId,
    toolName: payload.name,
    toolLabel: payload.toolLabel,
    materialRef: call?.materialRef,
    receiptIds: payload.actionReceipts?.length
      ? payload.actionReceipts.map((receipt) => receipt.id)
      : undefined,
    projected: true,
  });
}

/**
 * An error is a detail inside the open stage, not the event a stage
 * describes, so the result that reports the call's outcome closes the stage
 * and the error stays inside it. Only a call no result ever answered -- a
 * run cut off mid-call -- is closed after its error, which would otherwise
 * leave the stage open forever.
 */
function projectToolError(
  payload: ToolErrorPayload,
  call: ProjectedCall | undefined,
): AgentStagePayload | null {
  if (call?.hasResult) return null;
  const stage = call?.category;
  if (!stage) return null;
  return buildStage({
    stage,
    status: "failed",
    callId: payload.callId,
    toolName: payload.name,
    toolLabel: payload.toolLabel,
    projected: true,
  });
}

function projectCodexToolActivity(
  payload: CodexToolActivityPayload,
): AgentStagePayload | null {
  if (!payload.workCategory) return null;
  return buildStage({
    stage: payload.workCategory,
    status:
      payload.phase === "started"
        ? "started"
        : payload.ok === false
          ? "failed"
          : "completed",
    toolName: payload.toolName,
    toolLabel: payload.toolLabel,
    receiptIds: payload.actionReceipts?.length
      ? payload.actionReceipts.map((receipt) => receipt.id)
      : undefined,
    projected: true,
  });
}

/**
 * The stage the runtime would have emitted immediately before this event,
 * or `null` for an event that announces no stage transition.
 *
 * The category is never inferred from a tool name: it comes from the
 * category the event declares, or from the fixed category of the event kind
 * -- material is generation, a batch item is a Zotero action.
 */
function projectStageBeforeEvent(
  entry: AgentRunEventRecord,
  calls: Map<string, ProjectedCall>,
): AgentStagePayload | null {
  const payload = entry.payload;
  const planningStatus: "started" | "completed" | undefined =
    PLANNING_STAGE_STATUS_BY_PLAN_EVENT[payload.type];
  if (planningStatus)
    return buildStage({
      stage: "planning",
      status: planningStatus,
      projected: true,
    });
  switch (payload.type) {
    case "tool_call":
      return projectToolCall(payload, calls.get(payload.callId));
    case "tool_result":
      return projectToolResult(payload, calls.get(payload.callId));
    case "codex_tool_activity":
      return projectCodexToolActivity(payload);
    case "material_finalized": {
      const call = payload.callId ? calls.get(payload.callId) : undefined;
      return buildStage({
        stage: "generation",
        status: "completed",
        callId: payload.callId,
        toolName: call?.toolName,
        toolLabel: call?.toolLabel,
        materialRef: payload.materialRef,
        projected: true,
      });
    }
    case "batch_item_outcome": {
      // A pending row is one this run has not written yet: not a completion
      // and not a failure, and the stage vocabulary has no third outcome.
      if (payload.status === "pending") return null;
      const call = calls.get(payload.callId);
      return buildStage({
        stage: "zotero_action",
        status: payload.status === "saved" ? "completed" : "failed",
        callId: payload.callId,
        toolName: call?.toolName,
        toolLabel: call?.toolLabel,
        batchId: payload.batchId,
        itemKey: payload.itemKey,
        materialRef: payload.materialRef,
        projected: true,
      });
    }
    default:
      return null;
  }
}

/** The stage, if any, that closes only once this event has been read. */
function projectStageAfterEvent(
  entry: AgentRunEventRecord,
  calls: Map<string, ProjectedCall>,
): AgentStagePayload | null {
  return entry.payload.type === "tool_error"
    ? projectToolError(entry.payload, calls.get(entry.payload.callId))
    : null;
}

/**
 * A sequence number between the event already projected and the event this
 * stage announces.
 *
 * Fractional rather than a re-numbering: every original event keeps the
 * sequence number it was stored under, so anything keyed by it -- the
 * renderer's incremental item keys above all -- stays stable as a run grows.
 */
function interleavedSeq(
  previous: AgentRunEventRecord | undefined,
  target: AgentRunEventRecord,
): number {
  const floor =
    previous && previous.seq < target.seq ? previous.seq : target.seq - 1;
  return (floor + target.seq) / 2;
}

function stageRecord(
  target: AgentRunEventRecord,
  previous: AgentRunEventRecord | undefined,
  payload: AgentStagePayload,
): AgentRunEventRecord {
  return {
    runId: target.runId,
    seq: interleavedSeq(previous, target),
    eventType: "agent_stage",
    payload,
    createdAt: target.createdAt,
  };
}

/** The same, for a stage that follows the event it closes. */
function trailingStageRecord(
  target: AgentRunEventRecord,
  next: AgentRunEventRecord | undefined,
  payload: AgentStagePayload,
): AgentRunEventRecord {
  const ceiling = next && next.seq > target.seq ? next.seq : target.seq + 1;
  return {
    runId: target.runId,
    seq: (target.seq + ceiling) / 2,
    eventType: "agent_stage",
    payload,
    createdAt: target.createdAt,
  };
}

/**
 * The single stage a trace older than work categories reports.
 *
 * Such a run did tool work but recorded nothing about what kind, so it gets
 * one open stage covering everything it did rather than a category invented
 * per tool. `retrieval` is the stage vocabulary's neutral member and the
 * renderer labels an undifferentiated stage as agent activity instead.
 *
 * The fallback triggers on "the walk synthesized nothing", which means "no
 * work category anywhere" only because every category-free source --
 * `material_finalized`, `batch_item_outcome`, the plan events -- post-dates
 * the category contract, so a trace old enough to need this fallback holds
 * none of them. A future source that fires unconditionally would silently
 * disable it.
 */
function projectUndifferentiatedRun(
  events: AgentRunEventRecord[],
): AgentRunEventRecord[] {
  const firstWorkIndex = events.findIndex((entry) =>
    CATEGORY_BEARING_EVENT_TYPES.has(entry.payload.type),
  );
  if (firstWorkIndex < 0) return events;
  const projected = events.slice();
  projected.splice(
    firstWorkIndex,
    0,
    stageRecord(
      events[firstWorkIndex],
      events[firstWorkIndex - 1],
      buildStage({
        stage: "retrieval",
        status: "started",
        projected: true,
        undifferentiated: true,
      }),
    ),
  );
  return projected;
}

/**
 * Stage events for a trace recorded before the runtime emitted them.
 *
 * A run that already reports its own stages is returned untouched; anything
 * older is reconstructed from what its events declare -- the work category
 * stamped on tool events and connected-runtime activity, and the fixed
 * category of material, batch and plan announcements -- placed immediately
 * before
 * the event each stage describes, exactly where the live run emits it. The
 * projection never guesses a category from a tool name: a run that declares
 * none reports one undifferentiated stage.
 *
 * Deletion date: 2027-03-31.
 * Rule: delete when no persisted trace older than Phase 4 needs rendering.
 * This function and its two optional event fields (`projected`,
 * `undifferentiated`) are the whole of the compatibility path.
 */
export function projectStageEvents(
  events: AgentRunEventRecord[],
): AgentRunEventRecord[] {
  if (events.some((entry) => entry.payload.type === "agent_stage"))
    return events;
  const calls = readCalls(events);
  const projected: AgentRunEventRecord[] = [];
  let synthesized = 0;
  for (let index = 0; index < events.length; index += 1) {
    const entry = events[index];
    const opening = projectStageBeforeEvent(entry, calls);
    if (opening) {
      projected.push(
        stageRecord(entry, projected[projected.length - 1], opening),
      );
      synthesized += 1;
    }
    projected.push(entry);
    const closing = projectStageAfterEvent(entry, calls);
    if (closing) {
      projected.push(trailingStageRecord(entry, events[index + 1], closing));
      synthesized += 1;
    }
  }
  if (!synthesized) return projectUndifferentiatedRun(events);
  return projected;
}
