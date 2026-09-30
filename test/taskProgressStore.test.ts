import { assert } from "chai";
import type { PlanExecutionLedger } from "../src/agent/plans/types";
import {
  TASK_PROGRESS_MAX_CONVERSATIONS,
  applyTaskPaperUpdate,
  beginTaskRun,
  clearAllTaskProgress,
  clearTaskProgress,
  completeTaskRun,
  getTaskProgressViewMemo,
  rememberTaskProgressView,
  endTaskRun,
  beginTaskAction,
  endTaskAction,
  getTaskProgress,
  hydrateTaskProgress,
  listTaskProgressConversations,
  setTaskActionStep,
  setTaskActionSummary,
  setTaskChecklist,
  markTaskAnswering,
  setTaskPlan,
  setTaskScope,
  subscribeTaskProgress,
  taskTurnIndexFor,
} from "../src/modules/contextPanel/taskProgress/store";
import { ledgerDelta, quoteCitation } from "./helpers/taskProgressFixtures";

describe("task progress store", function () {
  afterEach(function () {
    clearAllTaskProgress();
  });

  it("applies ledger deltas once, however often they replay", function () {
    let notified = 0;
    const unsubscribe = subscribeTaskProgress(() => notified++);
    try {
      beginTaskRun(7, { runId: "run-a" });
      const delta = ledgerDelta("c1", [
        [1, "matched"],
        [2, "read", "Drift grows with time."],
      ]);
      applyTaskPaperUpdate(7, delta, "run-a");
      const version = getTaskProgress(7)!.version;
      applyTaskPaperUpdate(7, delta, "run-a");
      applyTaskPaperUpdate(7, JSON.parse(JSON.stringify(delta)), "run-a");
      const record = getTaskProgress(7)!;
      assert.equal(record.version, version, "a replay changes nothing");
      assert.equal(record.ledger.papers["1:2"].turns[1].reads.length, 1);
      assert.equal(record.ledger.papers["1:1"].state, "matched");
      assert.equal(notified, 2, "one start and one delta");
    } finally {
      unsubscribe();
    }
  });

  it("numbers turns by run order and files late deltas under their own run", function () {
    beginTaskRun(7);
    assert.equal(getTaskProgress(7)!.turnIndex, 1);
    assert.equal(getTaskProgress(7)!.runState, "working");
    beginTaskRun(7, { runId: "run-a" });
    assert.equal(getTaskProgress(7)!.runId, "run-a", "the runtime names it");
    assert.equal(getTaskProgress(7)!.turnIndex, 1);
    completeTaskRun(7, { runId: "run-a" });
    beginTaskRun(7, { runId: "run-b" });
    assert.equal(getTaskProgress(7)!.turnIndex, 2);
    applyTaskPaperUpdate(7, ledgerDelta("late", [[3, "read"]]), "run-a");
    applyTaskPaperUpdate(7, ledgerDelta("now", [[4, "read"]]), "run-b");
    const ledger = getTaskProgress(7)!.ledger;
    assert.deepEqual(Object.keys(ledger.papers["1:3"].turns), ["1"]);
    assert.deepEqual(Object.keys(ledger.papers["1:4"].turns), ["2"]);
    // A replayed start of an earlier run never restarts it.
    beginTaskRun(7, { runId: "run-a" });
    assert.equal(getTaskProgress(7)!.runId, "run-b");
  });

  it("takes the question number from the conversation when given", function () {
    beginTaskRun(9, { runId: "retry", turnIndex: 4 });
    applyTaskPaperUpdate(9, ledgerDelta("c", [[1, "read"]]));
    assert.deepEqual(
      Object.keys(getTaskProgress(9)!.ledger.papers["1:1"].turns),
      ["4"],
    );
    const user = { role: "user" };
    const history = [
      { role: "user" },
      { role: "assistant" },
      { role: "user", compactMarker: true },
      user,
      { role: "assistant" },
    ];
    assert.equal(taskTurnIndexFor(history, user), 2);
    assert.equal(taskTurnIndexFor(history), 2);
    assert.equal(taskTurnIndexFor([], user), 0);
  });

  it("moves working → answering once and asks overlays to collapse", function () {
    beginTaskRun(7, { runId: "run-a" });
    assert.isTrue(markTaskAnswering(7, "run-a"));
    assert.isFalse(markTaskAnswering(7, "run-a"));
    assert.isFalse(markTaskAnswering(7, "other-run"));
    const record = getTaskProgress(7)!;
    assert.equal(record.runState, "answering");
    assert.equal(record.collapseSeq, 1);
  });

  it("marks final citations and completes the run idempotently", function () {
    beginTaskRun(7, { runId: "run-a" });
    applyTaskPaperUpdate(
      7,
      ledgerDelta("c1", [
        [1, "read", "One"],
        [2, "read", "Two"],
      ]),
      "run-a",
    );
    const citations = [quoteCitation("q1", 1)];
    completeTaskRun(7, { runId: "run-a", quoteCitations: citations });
    completeTaskRun(7, { runId: "run-a", quoteCitations: citations });
    const record = getTaskProgress(7)!;
    assert.equal(record.runState, "completed");
    assert.equal(record.ledger.papers["1:1"].state, "cited");
    assert.equal(record.ledger.papers["1:2"].state, "read");
    assert.lengthOf(record.ledger.papers["1:1"].turns[1].citations, 1);
  });

  it("keeps the partial ledger when a run fails or is cancelled", function () {
    beginTaskRun(7, { runId: "run-a" });
    applyTaskPaperUpdate(7, ledgerDelta("c1", [[1, "read"]]), "run-a");
    endTaskRun(7, "failed", "run-a");
    assert.equal(getTaskProgress(7)!.runState, "failed");
    assert.equal(getTaskProgress(7)!.ledger.papers["1:1"].state, "read");
    endTaskRun(7, "cancelled", "run-a");
    assert.equal(getTaskProgress(7)!.runState, "failed", "only live runs end");
    beginTaskRun(8, { runId: "run-b" });
    endTaskRun(8, "cancelled");
    assert.equal(getTaskProgress(8)!.runState, "cancelled");
    completeTaskRun(9, { runId: "x" });
    endTaskRun(9, "failed", "x");
    assert.equal(getTaskProgress(9)!.runState, "completed");
  });

  it("keeps at most six conversations, evicting idle ones first", function () {
    beginTaskRun(1, { runId: "live" });
    for (let key = 2; key <= TASK_PROGRESS_MAX_CONVERSATIONS + 2; key++) {
      completeTaskRun(key, { runId: `r${key}` });
    }
    const kept = listTaskProgressConversations();
    assert.lengthOf(kept, TASK_PROGRESS_MAX_CONVERSATIONS);
    assert.include(kept, 1, "a live run is kept");
    assert.notInclude(kept, 2);
    assert.notInclude(kept, 3);
    assert.include(kept, TASK_PROGRESS_MAX_CONVERSATIONS + 2);
    clearTaskProgress(1);
    assert.isNull(getTaskProgress(1));
  });

  it("never evicts the conversation it makes room for, even when every other one is live", function () {
    // Six runs that never reported an end (a full workflow suite leaves such
    // records behind) must not keep a new conversation from ever showing.
    for (let key = 1; key <= TASK_PROGRESS_MAX_CONVERSATIONS; key++) {
      beginTaskRun(key, { runId: `live${key}` });
    }
    const newcomer = TASK_PROGRESS_MAX_CONVERSATIONS + 1;
    completeTaskRun(newcomer, { runId: "new" });
    assert.isNotNull(getTaskProgress(newcomer));
    const kept = listTaskProgressConversations();
    assert.lengthOf(kept, TASK_PROGRESS_MAX_CONVERSATIONS);
    assert.notInclude(kept, 1, "the oldest record makes room");
  });

  it("remembers that a plan ran after its steps are gone", function () {
    const ledger = {
      executionId: "e1",
      status: "running",
      tasks: [],
    } as unknown as PlanExecutionLedger;
    setTaskPlan(7, { ledger });
    const version = getTaskProgress(7)!.version;
    setTaskPlan(7, { ledger });
    assert.equal(getTaskProgress(7)!.version, version, "same ledger, no work");
    setTaskPlan(7, null);
    assert.isNull(getTaskProgress(7)!.plan);
    assert.isTrue(getTaskProgress(7)!.planSeen);
    setTaskPlan(8, null);
    assert.isNull(getTaskProgress(8), "clearing nothing creates nothing");
  });

  it("keeps a scope listing until the attached scope changes", function () {
    const listing = {
      libraryID: 1,
      wholeLibrary: false,
      entries: [],
      totalItems: 0,
      listedItems: 0,
      truncated: false,
    };
    setTaskScope(7, {
      signature: "a",
      libraryID: 1,
      contexts: {},
      label: "Drift",
      listing,
    });
    setTaskScope(7, {
      signature: "a",
      libraryID: 1,
      contexts: {},
      label: "Drift",
    });
    assert.strictEqual(getTaskProgress(7)!.scope!.listing, listing);
    setTaskScope(7, { signature: "b", libraryID: 1, contexts: {}, label: "" });
    assert.isNull(getTaskProgress(7)!.scope!.listing);
  });

  it("runs an action as the conversation's steps without renumbering questions", function () {
    beginTaskRun(7, { runId: "q1", turnIndex: 1 });
    completeTaskRun(7, { runId: "q1" });
    beginTaskAction(7, { runId: "action-1", title: "Auto Tag" });
    let record = getTaskProgress(7)!;
    assert.equal(record.runState, "working");
    assert.equal(record.turnIndex, 1, "an action is not a question");
    assert.isTrue(record.planSeen, "the row stays once an action ran");
    assert.equal(record.checklist?.source, "action");
    setTaskActionStep(7, "action-1", {
      step: "Reading papers",
      index: 1,
      total: 3,
    });
    setTaskActionSummary(7, "action-1", "Read 4 papers");
    setTaskActionStep(7, "action-1", {
      step: "Proposing tags",
      index: 2,
      total: 3,
    });
    record = getTaskProgress(7)!;
    assert.deepEqual(
      record.checklist!.steps.map((step) => [step.label, step.status]),
      [
        ["Reading papers", "completed"],
        ["Proposing tags", "in_progress"],
      ],
    );
    assert.equal(record.checklist!.total, 3);
    assert.equal(
      record.checklist!.summary,
      "",
      "a new step clears the summary",
    );
    endTaskAction(7, "action-1", "failed", "Auto Tag failed: offline");
    record = getTaskProgress(7)!;
    assert.equal(record.runState, "failed");
    assert.equal(record.checklist!.outcome, "failed");
    assert.equal(record.checklist!.detail, "Auto Tag failed: offline");
    // A later question starts fresh steps.
    beginTaskRun(7, { runId: "q2", turnIndex: 2 });
    assert.isNull(getTaskProgress(7)!.checklist);
    assert.isTrue(getTaskProgress(7)!.planSeen);
  });

  it("never takes over a live question with an action", function () {
    beginTaskRun(7, { runId: "q1", turnIndex: 1 });
    beginTaskAction(7, { runId: "action-1", title: "Auto Tag" });
    assert.equal(getTaskProgress(7)!.runId, "q1");
    endTaskAction(7, "action-1", "completed", "Done");
    assert.equal(
      getTaskProgress(7)!.runState,
      "working",
      "the question runs on",
    );
    assert.equal(getTaskProgress(7)!.checklist!.outcome, "completed");
  });

  it("keeps a Codex plan as the run's steps", function () {
    beginTaskRun(7, { runId: "codex-1", turnIndex: 1 });
    setTaskChecklist(7, {
      source: "codex",
      runId: "codex-1",
      steps: [
        { label: "Inspect the scope", status: "completed" },
        { label: "Read the methods", status: "in_progress" },
      ],
    });
    const version = getTaskProgress(7)!.version;
    setTaskChecklist(7, {
      source: "codex",
      runId: "codex-1",
      steps: [
        { label: "Inspect the scope", status: "completed" },
        { label: "Read the methods", status: "in_progress" },
      ],
    });
    assert.equal(getTaskProgress(7)!.version, version, "same steps, no work");
    assert.isTrue(getTaskProgress(7)!.planSeen);
    assert.equal(getTaskProgress(7)!.checklist!.total, 2);
    assert.equal(getTaskProgress(7)!.checklist!.done, 1);
  });

  it("hydrates from history without disturbing a live run", function () {
    hydrateTaskProgress(7, {
      runs: [
        {
          runId: "r1",
          turn: 1,
          deltas: [ledgerDelta("c1", [[1, "read", "One"]], "r1")],
          quoteCitations: [quoteCitation("q1", 1)],
        },
        {
          runId: "r2",
          turn: 2,
          deltas: [ledgerDelta("c2", [[2, "skimmed"]], "r2")],
        },
      ],
      latestTurn: 2,
      settled: "completed",
      planSeen: true,
      checklist: null,
      libraryID: 1,
    });
    let record = getTaskProgress(7)!;
    assert.isTrue(record.hydrated);
    assert.equal(record.runState, "completed");
    assert.equal(record.turnIndex, 2);
    assert.equal(record.runId, "r2");
    assert.equal(record.ledger.papers["1:1"].state, "cited");
    assert.equal(record.ledger.papers["1:2"].turns[2].state, "skimmed");
    assert.isTrue(record.planSeen);
    // Hydrating again (a reopened panel) changes nothing.
    const snapshot = JSON.stringify(record.ledger);
    hydrateTaskProgress(7, {
      runs: [
        {
          runId: "r1",
          turn: 1,
          deltas: [ledgerDelta("c1", [[1, "read", "One"]], "r1")],
          quoteCitations: [quoteCitation("q1", 1)],
        },
      ],
      latestTurn: 2,
      settled: "completed",
      planSeen: false,
      checklist: null,
      libraryID: 1,
    });
    assert.equal(JSON.stringify(getTaskProgress(7)!.ledger), snapshot);
    // A live run keeps its state; its own turn's citations wait for final.
    beginTaskRun(8, { runId: "live", turnIndex: 3 });
    hydrateTaskProgress(8, {
      runs: [
        {
          runId: "live",
          turn: 3,
          live: true,
          deltas: [ledgerDelta("c3", [[3, "read"]], "live")],
          quoteCitations: [quoteCitation("q3", 3)],
        },
      ],
      latestTurn: 3,
      settled: "completed",
      planSeen: false,
      checklist: null,
      libraryID: 1,
    });
    record = getTaskProgress(8)!;
    assert.equal(record.runState, "working");
    assert.equal(record.ledger.papers["1:3"].state, "read");
  });

  it("repaints nothing when history adds nothing to a live run", function () {
    beginTaskRun(7, { runId: "live", turnIndex: 2 });
    const version = getTaskProgress(7)!.version;
    const changed = hydrateTaskProgress(7, {
      runs: [{ runId: "live", turn: 2, live: true, deltas: [] }],
      latestTurn: 2,
      settled: null,
      planSeen: false,
      checklist: null,
    });
    assert.isFalse(changed);
    assert.equal(getTaskProgress(7)!.version, version);
    assert.isTrue(getTaskProgress(7)!.hydrated);
  });

  it("clearing a conversation forgets its hydration", function () {
    hydrateTaskProgress(7, {
      runs: [],
      latestTurn: 1,
      settled: "completed",
      planSeen: false,
      checklist: null,
    });
    const epoch = getTaskProgress(7)!.epoch;
    clearTaskProgress(7);
    assert.isNull(getTaskProgress(7));
    beginTaskRun(7);
    assert.isFalse(getTaskProgress(7)!.hydrated);
    assert.notEqual(getTaskProgress(7)!.epoch, epoch);
  });

  it("keeps a conversation's card state only as long as its record", function () {
    rememberTaskProgressView(3, { open: true });
    assert.isNull(getTaskProgressViewMemo(3), "no record, nothing to remember");
    beginTaskRun(3, { runId: "run-a" });
    rememberTaskProgressView(3, { open: true, expanded: ["1:2"] });
    rememberTaskProgressView(3, { scrollTop: 120 });
    assert.deepInclude(getTaskProgressViewMemo(3), {
      open: true,
      expanded: ["1:2"],
      scrollTop: 120,
    });
    const copy = getTaskProgressViewMemo(3)!;
    copy.expanded.push("1:9");
    assert.deepEqual(getTaskProgressViewMemo(3)!.expanded, ["1:2"], "a copy");
    clearTaskProgress(3);
    assert.isNull(getTaskProgressViewMemo(3), "cleared with its record");
    beginTaskRun(4, { runId: "run-b" });
    rememberTaskProgressView(4, { open: true });
    clearAllTaskProgress();
    assert.isNull(getTaskProgressViewMemo(4), "cleared with every record");
    // An evicted record takes its card state with it.
    beginTaskRun(100, { runId: "run-evicted" });
    completeTaskRun(100, { runId: "run-evicted" });
    rememberTaskProgressView(100, { open: true });
    for (let key = 101; key <= 100 + TASK_PROGRESS_MAX_CONVERSATIONS; key++) {
      beginTaskRun(key, { runId: `run-${key}` });
    }
    assert.isNull(getTaskProgress(100));
    assert.isNull(getTaskProgressViewMemo(100), "evicted with its record");
  });
});
