import { assert } from "chai";
import {
  createEmptyExecutionCheckpoint,
  latestExecutionCheckpoint,
} from "../src/agent/execution/checkpoint";
import {
  ExecutionCheckpointFold,
  executionCheckpointEvent,
} from "../src/agent/execution/checkpointEvents";
import {
  applyOutcomeEvidence,
  declareOutcomes,
  markOutcomes,
  settleOutcomes,
} from "../src/agent/loop/outcomes";
import type {
  AgentActionReceipt,
  AgentEvent,
  AgentExecutionContext,
  AgentRunEventRecord,
  ExecutionCheckpoint,
} from "../src/agent/types";

/**
 * How a run's ledger is persisted: its first publication whole, each later
 * change as a delta from the one before, so the stored events grow with the
 * work done rather than with the scope times the reads. The events fold back
 * to the ledger exactly, which resume after a restart relies on.
 */

const executionContext: AgentExecutionContext = {
  version: 1,
  executionId: "execution-41-3-1790000000000",
  conversationKey: 41,
  conversationGeneration: 3,
  chatLibraryID: 1,
  permissionOwner: "original_agent",
  workspaceSnapshot: { selectedPapers: [], selectedCollections: [] },
  configuredAccess: { libraryIDs: [1], outputDirectories: [] },
};

const PAPERS = 212;
const items = (count: number) =>
  Array.from({ length: count }, (_, index) => `item:${1001 + index}`);
/** A trusted read observation id, as `createTrustedReadObservations` mints them. */
const observation = (index: number) =>
  `sha256:${index.toString(16).padStart(64, "0")}:1`;

function noteReceipt(target: string, index: number): AgentActionReceipt {
  return {
    version: 2,
    id: `receipt-${index}`,
    proposalId: `proposal-${index}`,
    proofDomain: "zotero_state",
    capability: "zotero.notes",
    operation: "note_create",
    verification: "verified",
    status: "applied",
    requestedTargets: [target],
    appliedTargets: [target],
    alreadySatisfiedTargets: [],
    rejectedTargets: [],
    reasons: [],
    verifiedFacts: [],
  };
}

/**
 * Every ledger a long job publishes, in order: a part over 212 papers and a
 * note part over the same papers, one read per paper (every tenth has no
 * text, and one of those is read after all), notes on the first 30 papers,
 * a skipped part, and the settled end.
 */
function jobLedgers(): ExecutionCheckpoint[] {
  const ledgers: ExecutionCheckpoint[] = [];
  let now = 100;
  let ledger = createEmptyExecutionCheckpoint(executionContext, now);
  const publish = (next: ExecutionCheckpoint) => {
    if (next !== ledger) ledgers.push(next);
    ledger = next;
  };
  publish(
    declareOutcomes(
      ledger,
      [
        {
          taskId: "read-all",
          description: "Read each paper in Drift",
          effect: "read",
          targets: items(PAPERS),
          scope: true,
        },
        {
          taskId: "note-all",
          description: "Write a note on each paper in Drift",
          effect: "mutation",
          capability: "zotero.notes",
          targets: items(PAPERS),
          scope: true,
        },
        {
          taskId: "cite",
          description: "Cite them in APA",
          effect: "answer",
        },
      ],
      (now += 1),
    ),
  );
  items(PAPERS).forEach((target, index) => {
    const missing = index % 10 === 9;
    publish(
      applyOutcomeEvidence(
        ledger,
        {
          kind: "read",
          targets: missing ? [] : [target],
          ...(missing ? { noText: [target] } : {}),
          observationIds: [observation(index)],
        },
        (now += 1),
      ).checkpoint,
    );
    // A paper excepted for having no text is read after all.
    if (index === 19)
      publish(
        applyOutcomeEvidence(
          ledger,
          {
            kind: "read",
            targets: [items(PAPERS)[9]],
            observationIds: [observation(10_000)],
          },
          (now += 1),
        ).checkpoint,
      );
  });
  items(30).forEach((target, index) =>
    publish(
      applyOutcomeEvidence(
        ledger,
        { kind: "receipt", receipt: noteReceipt(target, index) },
        (now += 1),
      ).checkpoint,
    ),
  );
  publish(
    markOutcomes(
      ledger,
      [{ taskId: "cite", status: "skipped", reason: "No style was given" }],
      (now += 1),
    ).checkpoint,
  );
  publish(settleOutcomes(ledger, "completed_with_exceptions", (now += 1)));
  return ledgers;
}

/** The events a run publishes for these ledgers, one per change. */
function published(ledgers: ExecutionCheckpoint[]): AgentEvent[] {
  let base: ExecutionCheckpoint | undefined;
  return ledgers.map((ledger) => {
    const event = executionCheckpointEvent(base, ledger);
    base = ledger;
    return event;
  });
}

/** As the trace store returns them: persisted JSON, in sequence order. */
function stored(events: AgentEvent[]): AgentRunEventRecord[] {
  return events.map((event, index) => ({
    runId: "run-1",
    seq: index + 1,
    eventType: event.type,
    payload: JSON.parse(JSON.stringify(event)) as AgentEvent,
    createdAt: index,
  }));
}

function bytes(events: AgentEvent[]): number {
  return events.reduce((sum, event) => sum + JSON.stringify(event).length, 0);
}

describe("execution checkpoint events", function () {
  it("publishes a run's first ledger whole and each later change as a delta", function () {
    const events = published(jobLedgers());
    assert.equal(events[0].type, "execution_checkpoint");
    assert.isTrue(
      events
        .slice(1)
        .every((event) => event.type === "execution_checkpoint_delta"),
    );
    // The frozen papers are stored once, in the declaring event.
    const declaring = JSON.stringify(events[0]);
    assert.include(declaring, `"${items(PAPERS)[PAPERS - 1]}"`);
    for (const event of events.slice(1)) {
      assert.isBelow(
        JSON.stringify(event).length,
        2_000,
        "no later event repeats the scope",
      );
    }
  });

  it("folds back to every ledger exactly, after persistence", function () {
    const ledgers = jobLedgers();
    const events = published(ledgers);
    ledgers.forEach((ledger, index) => {
      assert.deepEqual(
        latestExecutionCheckpoint(stored(events.slice(0, index + 1))),
        JSON.parse(JSON.stringify(ledger)),
        `ledger ${index + 1} of ${ledgers.length}`,
      );
    });
  });

  it("stores bytes in proportion to the work, not to the scope times the reads", function () {
    const ledgers = jobLedgers();
    const before = bytes(
      ledgers.map(
        (checkpoint): AgentEvent => ({
          type: "execution_checkpoint",
          checkpoint,
        }),
      ),
    );
    const after = bytes(published(ledgers));
    // Measured 2026-10-01 for these 246 publications: 4,169,548 bytes as
    // whole ledgers, 96,047 as one whole ledger and deltas.
    assert.isAbove(before, 4_000_000);
    assert.isBelow(after, 100_000);
    assert.isBelow(after * 40, before);
  });

  it("reads an older run, whose every event is whole, as its latest ledger", function () {
    const ledgers = jobLedgers().slice(0, 5);
    const events = ledgers.map(
      (checkpoint): AgentEvent => ({
        type: "execution_checkpoint",
        checkpoint,
      }),
    );
    assert.deepEqual(
      latestExecutionCheckpoint(stored(events)),
      JSON.parse(JSON.stringify(ledgers[4])),
    );
    assert.isUndefined(latestExecutionCheckpoint([]));
  });

  it("publishes whole after a change a delta cannot express", function () {
    const [declared, firstRead] = jobLedgers();
    const resumed = { ...firstRead, executionId: "execution-other" };
    assert.equal(
      executionCheckpointEvent(declared, resumed).type,
      "execution_checkpoint",
    );
    const reordered = { ...firstRead, tasks: [...firstRead.tasks].reverse() };
    assert.equal(
      executionCheckpointEvent(declared, reordered).type,
      "execution_checkpoint",
    );
  });

  it("ignores a delta that does not fit the ledger before it, and every later one, until a whole ledger", function () {
    const ledgers = jobLedgers().slice(0, 6);
    const events = published(ledgers);
    // The second event was lost; the third no longer fits the first.
    const gap = [events[0], ...events.slice(2)];
    assert.deepEqual(
      latestExecutionCheckpoint(stored(gap)),
      JSON.parse(JSON.stringify(ledgers[0])),
      "stays at the last ledger it could prove",
    );
    const healed = [
      ...gap,
      { type: "execution_checkpoint", checkpoint: ledgers[5] },
    ];
    assert.deepEqual(
      latestExecutionCheckpoint(stored(healed as AgentEvent[])),
      JSON.parse(JSON.stringify(ledgers[5])),
    );
  });

  it("folds live, one event at a time, as Task progress receives them", function () {
    const ledgers = jobLedgers().slice(0, 4);
    const fold = new ExecutionCheckpointFold();
    published(ledgers).forEach((event, index) => {
      assert.deepEqual(fold.apply(event), ledgers[index]);
    });
    assert.isUndefined(
      new ExecutionCheckpointFold().apply(published(ledgers)[1]),
      "a delta without the ledger before it shows nothing",
    );
  });
});
