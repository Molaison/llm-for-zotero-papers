/**
 * Rebuilding a conversation's Task progress from what it persisted: the
 * `paper_ledger_update` events of every run, the citations each answer kept,
 * whether a plan or a Codex plan ran, and the question numbering. Never for
 * a conversation that is being deleted or is retired.
 */
import { assert } from "chai";
import type { AgentRunEventRecord } from "../src/agent/types";
import { rememberConversationKeyRetired } from "../src/shared/conversationKeyLedger";
import {
  bumpConversationWriteGeneration,
  freezeConversationWrites,
  unfreezeConversationWrites,
} from "../src/shared/conversationWriteFence";
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
  clearTaskProgress,
  getTaskProgress,
} from "../src/modules/contextPanel/taskProgress/store";
import type { Message } from "../src/modules/contextPanel/types";
import { ledgerDelta, quoteCitation } from "./helpers/taskProgressFixtures";

function record(
  runId: string,
  seq: number,
  payload: AgentRunEventRecord["payload"],
): AgentRunEventRecord {
  return { runId, seq, eventType: payload.type, payload, createdAt: seq };
}

function conversation(): Message[] {
  return [
    { role: "user", text: "Which papers measure drift?", timestamp: 1 },
    {
      role: "assistant",
      text: "Two do.",
      timestamp: 2,
      runMode: "agent",
      agentRunId: "run-1",
      quoteCitations: [quoteCitation("q1", 2)],
    },
    { role: "user", text: "Compare their methods", timestamp: 3 },
    {
      role: "assistant",
      text: "Codex compared them.",
      timestamp: 4,
      runMode: "agent",
      agentRunId: "run-2",
    },
  ];
}

const EVENTS: AgentRunEventRecord[] = [
  record("run-1", 1, {
    type: "paper_ledger_update",
    callId: "c1",
    delta: ledgerDelta(
      "c1",
      [
        [1, "read", "Drift grows with time."],
        [2, "read", "Drift scales with experience."],
        [3, "matched"],
      ],
      "run-1",
    ),
  }),
  record("run-2", 1, {
    type: "paper_ledger_update",
    callId: "m1",
    delta: ledgerDelta("m1", [[3, "read", "Methods differ."]], "run-2"),
  }),
  record("run-2", 2, {
    type: "codex_progress",
    itemId: "codex-plan-checklist",
    text: "✓ Inspect\n• Compare",
    steps: [
      { content: "Inspect", status: "completed" },
      { content: "Compare", status: "in_progress" },
    ],
  }),
];

describe("task progress history rebuild", function () {
  const KEY = 640021;
  let loads: string[][] = [];

  beforeEach(function () {
    loads = [];
    setTaskProgressHistoryLoaderForTests(async (runIds) => {
      loads.push([...runIds]);
      return EVENTS.filter((event) => runIds.includes(event.runId));
    });
    chatHistory.set(KEY, conversation());
    loadedConversationKeys.add(KEY);
  });

  afterEach(function () {
    setTaskProgressHistoryLoaderForTests();
    chatHistory.delete(KEY);
    loadedConversationKeys.delete(KEY);
    unfreezeConversationWrites(KEY);
    clearAllTaskProgress();
  });

  it("builds runs by question, keeps the latest Codex plan, and settles", function () {
    const byRun = new Map<string, AgentRunEventRecord[]>();
    for (const event of EVENTS) {
      byRun.set(event.runId, [...(byRun.get(event.runId) || []), event]);
    }
    const history = buildTaskProgressHistory(conversation(), byRun, 1);
    assert.deepEqual(
      history.runs.map((run) => [run.runId, run.turn, run.deltas.length]),
      [
        ["run-1", 1, 1],
        ["run-2", 2, 1],
      ],
    );
    assert.equal(history.latestTurn, 2);
    assert.equal(history.settled, "completed");
    assert.isTrue(history.planSeen, "a Codex plan counts as a plan");
    assert.deepEqual(history.checklist?.steps, [
      { label: "Inspect", status: "completed" },
      { label: "Compare", status: "in_progress" },
    ]);
    const cancelled = conversation();
    cancelled[3].text = "[Cancelled]";
    assert.equal(
      buildTaskProgressHistory(cancelled, byRun, 1).settled,
      "cancelled",
    );
    const failed = conversation();
    failed[3].text = "Error: offline";
    assert.equal(buildTaskProgressHistory(failed, byRun, 1).settled, "failed");
    const waiting = conversation().slice(0, 3);
    assert.isNull(buildTaskProgressHistory(waiting, byRun, 1).settled);
  });

  it("restores counts, states and steps after a restart (store cleared)", async function () {
    ensureTaskProgressHydrated(KEY, 1);
    await waitForTaskProgressHydrationForTests(KEY);
    const record = getTaskProgress(KEY)!;
    assert.isTrue(record.hydrated);
    assert.equal(record.runState, "completed");
    assert.equal(record.turnIndex, 2, "the latest question");
    assert.equal(record.ledger.papers["1:1"].state, "read");
    assert.equal(record.ledger.papers["1:2"].state, "cited");
    assert.equal(record.ledger.papers["1:3"].state, "read");
    assert.equal(record.ledger.papers["1:3"].turns[1].state, "matched");
    assert.equal(record.ledger.papers["1:3"].turns[2].state, "read");
    assert.isTrue(record.planSeen);
    assert.equal(record.checklist?.source, "codex");
    assert.deepEqual(loads, [["run-1", "run-2"]]);
    // Hydrated once: a later sync reads nothing again.
    ensureTaskProgressHydrated(KEY, 1);
    await waitForTaskProgressHydrationForTests(KEY);
    assert.lengthOf(loads, 1);
    // A restart empties the store; the next sync rebuilds it.
    clearTaskProgress(KEY);
    ensureTaskProgressHydrated(KEY, 1);
    await waitForTaskProgressHydrationForTests(KEY);
    assert.lengthOf(loads, 2);
    assert.equal(getTaskProgress(KEY)!.ledger.papers["1:2"].state, "cited");
  });

  it("waits for the conversation's history to load", async function () {
    loadedConversationKeys.delete(KEY);
    ensureTaskProgressHydrated(KEY, 1);
    await waitForTaskProgressHydrationForTests(KEY);
    assert.isNull(getTaskProgress(KEY));
    assert.lengthOf(loads, 0);
  });

  it("never rebuilds a conversation being deleted", async function () {
    freezeConversationWrites(KEY);
    ensureTaskProgressHydrated(KEY, 1);
    await waitForTaskProgressHydrationForTests(KEY);
    assert.isNull(getTaskProgress(KEY), "frozen: nothing is rebuilt");
    assert.lengthOf(loads, 0);
  });

  it("drops a rebuild the conversation was deleted under", async function () {
    let release: () => void = () => undefined;
    setTaskProgressHistoryLoaderForTests(async (runIds) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return EVENTS.filter((event) => runIds.includes(event.runId));
    });
    ensureTaskProgressHydrated(KEY, 1);
    // Deletion lands while the events load: generation bump + store clear.
    bumpConversationWriteGeneration(KEY);
    clearTaskProgress(KEY);
    release();
    await waitForTaskProgressHydrationForTests(KEY);
    assert.isNull(getTaskProgress(KEY));
  });

  it("never rebuilds a retired conversation key", async function () {
    const zotero = globalThis as { Zotero?: unknown };
    const previous = zotero.Zotero;
    zotero.Zotero = { DB: {} };
    try {
      rememberConversationKeyRetired(KEY);
      ensureTaskProgressHydrated(KEY, 1);
      await waitForTaskProgressHydrationForTests(KEY);
      assert.isNull(getTaskProgress(KEY));
      assert.lengthOf(loads, 0);
    } finally {
      zotero.Zotero = previous;
    }
  });
});
