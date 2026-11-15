/**
 * An old conversation whose runs drove the research engine still opens. Its
 * stored events -- the research tools' calls and results, the research
 * progress and scope events, an expansion review, and the plan card around
 * them -- render as a read-only trace and rebuild Task progress. The engine
 * that wrote them is gone, and nothing on the way may need it.
 */
import { assert } from "chai";
import type { AgentRunEventRecord } from "../src/agent/types";
import {
  buildAgentTraceDisplayItems,
  renderAgentTrace,
} from "../src/modules/contextPanel/agentTrace/render";
import {
  chatHistory,
  loadedConversationKeys,
} from "../src/modules/contextPanel/state";
import {
  buildTaskProgressHistory,
  ensureTaskProgressHydrated,
  setTaskProgressHistoryLoaderForTests,
  waitForTaskProgressHydrationForTests,
} from "../src/modules/contextPanel/taskProgress/history";
import {
  clearAllTaskProgress,
  getTaskProgress,
} from "../src/modules/contextPanel/taskProgress/store";
import type { Message } from "../src/modules/contextPanel/types";
import { fakeDocument, type FakeElement } from "./helpers/fakeDom";
import { ledgerDelta } from "./helpers/taskProgressFixtures";

const KEY = 640094;
const RUN = "run-research";

const task = (index: number, status: string) => ({
  version: 2,
  taskId: `execution-research:task-${index}`,
  executionId: "execution-research",
  planStepId: `step-${index}`,
  kind: "required_step",
  content: ["Read every paper", "Relate the papers", "Publish the review"][
    index - 1
  ],
  activeForm: "Working",
  acceptanceCriteria: [],
  expectedEffect: index === 3 ? "artifact" : "read",
  obligationIds: [],
  status,
  attemptCount: 1,
  evidenceIds: [],
  failureReasons: [],
  createdAt: 1,
  updatedAt: 2,
});

const artifact = {
  version: 2,
  planId: "plan-research",
  revision: 1,
  conversationKey: KEY,
  provider: "original",
  status: "approved",
  explanation: "Review the three papers.",
  steps: [
    { id: "step-1", content: "Read every paper", status: "pending" },
    { id: "step-2", content: "Relate the papers", status: "pending" },
    { id: "step-3", content: "Publish the review", status: "pending" },
  ],
  contract: {
    deliverable: { kind: "document" },
    investigation: {
      scopeSnapshot: {
        snapshotId: "snapshot-research",
        digest: "sha256:scope",
        itemCount: 3,
        createdAt: 1,
        policyVersion: 1,
      },
    },
  },
  createdAt: 1,
  updatedAt: 1,
};

const ledger = {
  version: 2,
  executionId: "execution-research",
  planId: "plan-research",
  revision: 1,
  planDigest: "sha256:plan",
  conversationKey: KEY,
  attempt: 1,
  provider: "original",
  status: "running",
  activeTaskId: "execution-research:task-2",
  tasks: [task(1, "completed"), task(2, "in_progress"), task(3, "pending")],
  createdAt: 1,
  updatedAt: 2,
};

const progress = {
  researchJobId: "research-job",
  executionId: "execution-research",
  parentTaskId: "execution-research:task-1",
  stage: "synthesis",
  totalItems: 3,
  screenedItems: 3,
  candidateItems: 3,
  deepReadCompleted: 3,
  deepReadPlanned: 3,
};

/** One stored event, typed as the trace store returns it. */
function record(seq: number, payload: Record<string, unknown>) {
  return {
    runId: RUN,
    seq,
    eventType: String(payload.type),
    createdAt: seq,
    payload,
  } as unknown as AgentRunEventRecord;
}

/** A research flight as the engine stored it, in event order. */
const EVENTS: AgentRunEventRecord[] = [
  record(1, { type: "plan_ready", artifact }),
  record(2, { type: "plan_execution_updated", ledger }),
  record(3, {
    type: "tool_call",
    callId: "research-1",
    name: "research_update",
    args: {
      operation: "record_papers",
      papers: [{ libraryID: 1, itemKey: "AAAA1111" }],
    },
    toolLabel: "Record research",
    workCategory: "planning",
    executionId: "execution-research",
    taskId: "execution-research:task-1",
  }),
  record(4, {
    type: "tool_result",
    callId: "research-1",
    name: "research_update",
    ok: true,
    toolLabel: "Record research",
    workCategory: "planning",
    actionReceipts: [],
    content: { progress },
    researchJobId: "research-job",
    executionId: "execution-research",
    taskId: "execution-research:task-1",
  }),
  record(5, { type: "plan_research_progress", progress }),
  record(6, {
    type: "confirmation_required",
    requestId: "research-expansion",
    action: {
      toolName: "approve_research_expansion",
      mode: "review",
      title: "More scoped papers qualify for deep reading.",
      confirmLabel: "Continue research",
      cancelLabel: "Revise or cancel",
      fields: [],
    },
  }),
  record(7, {
    type: "confirmation_resolved",
    requestId: "research-expansion",
    approved: true,
    actionId: "expand_continue",
  }),
  record(8, {
    type: "plan_scope_amended",
    amendmentId: "amendment-research",
    executionId: "execution-research",
    mode: "safe",
    rationale: "One more paper is inside the approved source.",
    previousItemCount: 3,
    newItemCount: 4,
    authority: "user",
  }),
  record(9, {
    type: "codex_tool_activity",
    itemId: "mcp-research",
    phase: "completed",
    toolName: "research_update",
    serverName: "zotero",
    args: { operation: "finalize" },
    ok: true,
    researchJobId: "research-job",
  }),
  record(10, {
    type: "paper_ledger_update",
    callId: "read-1",
    delta: ledgerDelta("read-1", [[1, "read", "Read for the review."]], RUN),
  }),
  record(11, {
    type: "plan_execution_updated",
    ledger: {
      ...ledger,
      status: "completed",
      activeTaskId: undefined,
      tasks: [task(1, "completed"), task(2, "completed"), task(3, "completed")],
    },
  }),
  record(12, { type: "final", text: "The review is published." }),
];

function stored(): Message[] {
  return [
    { role: "user", text: "Review these three papers", timestamp: 1 },
    {
      role: "assistant",
      text: "The review is published.",
      timestamp: 2,
      runMode: "agent",
      agentRunId: RUN,
    },
  ];
}

describe("an old conversation whose runs drove the research engine", function () {
  afterEach(function () {
    setTaskProgressHistoryLoaderForTests();
    chatHistory.delete(KEY);
    loadedConversationKeys.delete(KEY);
    clearAllTaskProgress();
  });

  it("renders its trace read-only, with the plan card and no control", function () {
    const trace = renderAgentTrace({
      doc: fakeDocument as unknown as Document,
      message: stored()[1],
      events: EVENTS,
    }) as unknown as FakeElement;
    assert.exists(trace);
    const card = trace.findByClass("llm-plan-container");
    assert.exists(card, "the plan card still renders from its own events");
    assert.lengthOf(card!.findAllByTag("button"), 0, "no plan control");
    assert.lengthOf(card!.findAllByTag("textarea"), 0);
  });

  it("rebuilds Task progress from its stored events", async function () {
    const history = buildTaskProgressHistory(
      stored(),
      new Map([[RUN, EVENTS]]),
      1,
    );
    assert.isTrue(history.planSeen, "a plan that ran keeps its row");
    assert.isNull(history.checklist, "plans are no Task progress steps source");

    setTaskProgressHistoryLoaderForTests(async () => EVENTS);
    chatHistory.set(KEY, stored());
    loadedConversationKeys.add(KEY);
    ensureTaskProgressHydrated(KEY, 1);
    await waitForTaskProgressHydrationForTests(KEY);
    const rebuilt = getTaskProgress(KEY)!;
    assert.isTrue(rebuilt.hydrated, "the rebuild ran to the end");
    assert.equal(rebuilt.ledger.papers["1:1"].state, "read");
    assert.isNull(rebuilt.checklist);
  });
});

// Moved from test/planAmendments.test.ts with the research engine: an old
// conversation's stored scope amendments still read as trace rows.
describe("the trace of an old research scope amendment", function () {
  it("renders an autonomous amendment as a nonblocking trace row", function () {
    const events = [
      {
        id: 1,
        runId: "run-1",
        sequence: 1,
        createdAt: 1,
        payload: {
          type: "plan_scope_amended",
          amendmentId: "amendment-1",
          executionId: "execution-1",
          mode: "auto",
          rationale:
            "A newly eligible paper remains in the approved collection.",
          previousItemCount: 4,
          newItemCount: 5,
          authority: "auto_policy",
        },
      },
    ] as AgentRunEventRecord[];

    const { items } = buildAgentTraceDisplayItems(events, null);
    const row = items.find(
      (item) =>
        item.type === "action" && item.row.text.includes("Scope amended"),
    );
    assert.exists(row);
    assert.notInclude(JSON.stringify(items), "confirmation");
    assert.include(JSON.stringify(row), "4 to 5");
    assert.include(JSON.stringify(row), "auto_policy");
  });

  it("does not describe a user-authorized Safe amendment as automatic", function () {
    const events = [
      {
        id: 1,
        runId: "run-1",
        sequence: 1,
        createdAt: 1,
        payload: {
          type: "plan_scope_amended",
          amendmentId: "amendment-safe",
          executionId: "execution-1",
          mode: "safe",
          rationale: "The user approved the added paper.",
          previousItemCount: 4,
          newItemCount: 5,
          authority: "user",
        },
      },
    ] as AgentRunEventRecord[];

    const { items } = buildAgentTraceDisplayItems(events, null);
    const row = items.find(
      (item) =>
        item.type === "action" && item.row.text.includes("Scope amended"),
    );
    assert.exists(row);
    assert.notInclude(JSON.stringify(row), "amended automatically");
  });
});
