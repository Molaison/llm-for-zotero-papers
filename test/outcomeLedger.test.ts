import { assert } from "chai";
import {
  createEmptyExecutionCheckpoint,
  ordinaryExecutionTaskId,
} from "../src/agent/execution/checkpoint";
import {
  applyOutcomeEvidence,
  declareOutcomes,
  decideRunEnd,
  markOutcomes,
  openDeclaredOutcomes,
  OUTCOME_REASONS,
  outcomeProgressSignature,
  settleOutcomes,
  type OutcomeDeclaration,
  type OutcomeEvidence,
  type OutcomeModelMark,
} from "../src/agent/loop/outcomes";
import type { RunStopRule } from "../src/agent/loop/stopRules";
import type {
  AgentActionProposal,
  AgentActionReceipt,
  AgentExecutionContext,
  ExecutionCheckpoint,
  ExecutionCheckpointTask,
} from "../src/agent/types";

const executionContext: AgentExecutionContext = {
  version: 1,
  executionId: "execution-direct-1",
  conversationKey: 41,
  conversationGeneration: 3,
  chatLibraryID: 1,
  permissionOwner: "original_agent",
  workspaceSnapshot: {
    selectedPapers: [],
    selectedCollections: [],
  },
  configuredAccess: { libraryIDs: [1], outputDirectories: [] },
};

const UNVERIFIED =
  "The change could not be verified; check the current state before retrying.";
const DECLINED = "You declined this change.";
const NOT_DONE = "Not done before the answer.";
const WRITE_FAILED = "The change was not applied.";

function taskId(local: string): string {
  return `execution-direct-1:task:${local}`;
}

/** Freeze a ledger deeply, so any mutation by the evaluator throws. */
function frozen<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) frozen(nested);
  }
  return value;
}

function emptyLedger(): ExecutionCheckpoint {
  return frozen(createEmptyExecutionCheckpoint(executionContext, 10));
}

function ledgerWith(
  ...declarations: OutcomeDeclaration[]
): ExecutionCheckpoint {
  return frozen(declareOutcomes(emptyLedger(), declarations, 20));
}

function withTasks(
  checkpoint: ExecutionCheckpoint,
  ...tasks: ExecutionCheckpointTask[]
): ExecutionCheckpoint {
  return frozen({ ...checkpoint, tasks: [...checkpoint.tasks, ...tasks] });
}

/** A task as the pre-outcome ordinary path wrote it: no effect, no origin. */
function legacyTask(
  local: string,
  overrides: Partial<ExecutionCheckpointTask> = {},
): ExecutionCheckpointTask {
  return {
    taskId: taskId(local),
    description: `Legacy ${local}`,
    dependencies: [],
    status: "pending",
    journalActionIds: [],
    verifiedReceiptIds: [],
    readEvidenceIds: [],
    materialRefs: [],
    createdAt: 5,
    updatedAt: 5,
    ...overrides,
  };
}

function receipt(
  overrides: Partial<AgentActionReceipt> = {},
): AgentActionReceipt {
  return {
    version: 2,
    id: "receipt-1",
    proposalId: "proposal-1",
    proofDomain: "zotero_state",
    capability: "zotero.notes",
    operation: "note_create",
    verification: "verified",
    status: "applied",
    requestedTargets: ["item:1"],
    appliedTargets: ["item:1"],
    alreadySatisfiedTargets: [],
    rejectedTargets: [],
    reasons: [],
    verifiedFacts: [],
    ...overrides,
  };
}

function rejection(
  id: string,
  rejectedTargets: string[],
  reasons: string[],
): AgentActionReceipt {
  return receipt({
    id,
    capability: "zotero.tags",
    operation: "apply_tags",
    verification: "not_applicable",
    status: "failed",
    requestedTargets: rejectedTargets,
    appliedTargets: [],
    rejectedTargets,
    reasons,
  });
}

/** A note write that ran and failed, as `finalizeProposal` stamps it. */
function failedWrite(id: string, reasons: string[]): AgentActionReceipt {
  return receipt({
    id,
    verification: "unverified",
    status: "failed",
    appliedTargets: [],
    reasons,
  });
}

function declined(
  callId: string,
  ...proposals: Pick<
    AgentActionProposal,
    "capability" | "operation" | "requestedTargets"
  >[]
): OutcomeEvidence {
  return { kind: "declined", callId, proposals };
}

function declineNote(callId: string): OutcomeEvidence {
  return declined(callId, {
    capability: "zotero.notes",
    operation: "note_create",
    requestedTargets: ["item:1"],
  });
}

function apply(
  checkpoint: ExecutionCheckpoint,
  evidence: OutcomeEvidence,
  now = 30,
): { checkpoint: ExecutionCheckpoint; changed: boolean } {
  const result = applyOutcomeEvidence(checkpoint, evidence, now);
  frozen(result.checkpoint);
  return result;
}

function find(
  checkpoint: ExecutionCheckpoint,
  local: string,
): ExecutionCheckpointTask {
  const task = checkpoint.tasks.find((entry) => entry.taskId === taskId(local));
  assert.exists(task, `outcome ${local}`);
  return task!;
}

const saveNote: OutcomeDeclaration = {
  taskId: "save",
  description: "Save it as a note on (Smith, 2021)",
  effect: "mutation",
  capability: "zotero.notes",
  targets: ["item:1"],
};

const tagAny: OutcomeDeclaration = {
  taskId: "tag",
  description: "Tag the papers",
  effect: "mutation",
  capability: "zotero.tags",
};

const material = {
  documentId: "document-1",
  documentVersion: 2,
  contentHash: "sha256:material",
};

describe("outcome ledger: model declarations", function () {
  it("creates a pending model outcome with its effect, capability and item targets", function () {
    const ledger = emptyLedger();
    const next = declareOutcomes(
      ledger,
      [
        {
          taskId: "save",
          description: "  Save the summary as a note ",
          effect: "mutation",
          capability: "zotero.notes",
          targets: ["12", "item:13", " 12 ", ""],
        },
        {
          taskId: "explain",
          description: "Explain the method",
          effect: "answer",
        },
      ],
      20,
    );

    assert.deepEqual(next.tasks, [
      {
        taskId: taskId("save"),
        description: "Save the summary as a note",
        dependencies: [],
        status: "pending",
        journalActionIds: [],
        verifiedReceiptIds: [],
        readEvidenceIds: [],
        materialRefs: [],
        createdAt: 20,
        updatedAt: 20,
        effect: "mutation",
        origin: "model",
        capability: "zotero.notes",
        targets: ["item:12", "item:13"],
      },
      {
        taskId: taskId("explain"),
        description: "Explain the method",
        dependencies: [],
        status: "pending",
        journalActionIds: [],
        verifiedReceiptIds: [],
        readEvidenceIds: [],
        materialRefs: [],
        createdAt: 20,
        updatedAt: 20,
        effect: "answer",
        origin: "model",
      },
    ]);
    assert.equal(next.updatedAt, 20);
    assert.equal(next.version, 1);
    assert.lengthOf(ledger.tasks, 0);
  });

  it("refuses a new outcome without an effect and leaves the ledger as it was", function () {
    const ledger = emptyLedger();
    assert.throws(
      () =>
        declareOutcomes(
          ledger,
          [
            {
              taskId: "save",
              description: "Save",
            } as unknown as OutcomeDeclaration,
          ],
          20,
        ),
      /effect/,
    );
    assert.lengthOf(ledger.tasks, 0);
  });

  it("refuses a duplicate or invalid task id, and a changed description for an existing one", function () {
    const ledger = ledgerWith(saveNote);
    assert.throws(
      () =>
        declareOutcomes(
          emptyLedger(),
          [saveNote, { ...saveNote, description: "Save again" }],
          30,
        ),
      /only once/,
    );
    assert.throws(
      () =>
        declareOutcomes(ledger, [{ ...saveNote, taskId: "save the note" }], 30),
      /Task IDs must use/,
    );
    assert.throws(
      () =>
        declareOutcomes(
          ledger,
          [{ ...saveNote, description: "Save somewhere else" }],
          30,
        ),
      /immutable/,
    );
    assert.strictEqual(
      declareOutcomes(ledger, [{ ...saveNote, taskId: taskId("save") }], 30),
      ledger,
      "re-declaring the same outcome changes nothing",
    );
  });

  it("marks a pending, in-progress or blocked outcome skipped, blocked or cancelled with the reason", function () {
    const ledger = withTasks(
      ledgerWith(
        saveNote,
        { taskId: "tag", description: "Tag it", effect: "mutation" },
        { taskId: "read", description: "Read it", effect: "read" },
      ),
      legacyTask("working", { status: "in_progress" }),
    );
    const blocked = apply(ledger, declineNote("call-note")).checkpoint;
    assert.equal(find(blocked, "save").status, "blocked");

    const marks: OutcomeModelMark[] = [
      {
        taskId: "save",
        status: "cancelled",
        reason: "The user chose not to save",
      },
      { taskId: "tag", status: "skipped", reason: " No tags were asked for " },
      { taskId: "working", status: "blocked", reason: "Needs the user's file" },
    ];
    const { checkpoint, ignored } = markOutcomes(blocked, marks, 40);

    assert.deepEqual(ignored, []);
    assert.deepEqual(
      checkpoint.tasks.map((task) => [task.taskId, task.status, task.reason]),
      [
        [taskId("save"), "cancelled", "The user chose not to save"],
        [taskId("tag"), "skipped", "No tags were asked for"],
        [taskId("read"), "pending", undefined],
        [taskId("working"), "blocked", "Needs the user's file"],
      ],
    );
    assert.equal(find(checkpoint, "tag").updatedAt, 40);
    assert.equal(checkpoint.updatedAt, 40);
  });

  it("refuses a skipped, blocked or cancelled mark without a reason", function () {
    const ledger = ledgerWith(saveNote);
    for (const status of ["skipped", "blocked", "cancelled"] as const) {
      assert.throws(
        () =>
          markOutcomes(ledger, [{ taskId: "save", status, reason: "  " }], 30),
        "A skipped, blocked, or cancelled task needs the reason.",
      );
    }
    assert.equal(find(ledger, "save").status, "pending");
  });

  it("ignores any other status and any mark the outcome's status does not allow", function () {
    const ledger = apply(ledgerWith(saveNote), {
      kind: "receipt",
      receipt: receipt(),
    }).checkpoint;
    assert.equal(find(ledger, "save").status, "completed");
    const withOpen = withTasks(ledger, legacyTask("open"));

    for (const status of ["completed", "in_progress", "pending"]) {
      const result = markOutcomes(
        withOpen,
        [
          {
            taskId: "open",
            status,
            reason: "The model says so",
          } as unknown as OutcomeModelMark,
        ],
        40,
      );
      assert.deepEqual(result.ignored, [taskId("open")]);
      assert.strictEqual(result.checkpoint, withOpen);
    }

    const done = markOutcomes(
      withOpen,
      [{ taskId: "save", status: "skipped", reason: "Changed my mind" }],
      40,
    );
    assert.deepEqual(done.ignored, [taskId("save")]);
    assert.strictEqual(done.checkpoint, withOpen);
    assert.throws(
      () =>
        markOutcomes(
          withOpen,
          [{ taskId: "missing", status: "skipped", reason: "Not there" }],
          40,
        ),
      /Unknown task/,
    );
  });

  it("never copies evidence identities or a status from a declaration", function () {
    const next = declareOutcomes(
      emptyLedger(),
      [
        {
          ...saveNote,
          status: "completed",
          journalActionIds: ["action-1"],
          verifiedReceiptIds: ["invented-receipt"],
          readEvidenceIds: ["invented-read"],
          materialRefs: [material],
          doneTargets: ["item:1"],
          receiptIds: ["invented-receipt"],
          origin: "host",
        } as unknown as OutcomeDeclaration,
      ],
      20,
    );
    const task = find(next, "save");
    assert.equal(task.status, "pending");
    assert.equal(task.origin, "model");
    assert.deepEqual(task.journalActionIds, []);
    assert.deepEqual(task.verifiedReceiptIds, []);
    assert.deepEqual(task.readEvidenceIds, []);
    assert.deepEqual(task.materialRefs, []);
    assert.notProperty(task, "doneTargets");
    assert.notProperty(task, "receiptIds");
  });
});

describe("outcome ledger: host evidence binding", function () {
  it("read: completes an untargeted read outcome on the first read", function () {
    const ledger = ledgerWith({
      taskId: "read",
      description: "Read the paper",
      effect: "read",
    });
    const { checkpoint, changed } = apply(ledger, {
      kind: "read",
      targets: ["item:1", "item:2"],
      observationIds: ["obs-1"],
    });

    assert.isTrue(changed);
    const task = find(checkpoint, "read");
    assert.equal(task.status, "completed");
    assert.deepEqual(task.doneTargets, ["item:1", "item:2"]);
    assert.deepEqual(task.readEvidenceIds, ["obs-1"]);
    assert.equal(task.updatedAt, 30);
    assert.equal(checkpoint.updatedAt, 30);
    assert.equal(find(ledger, "read").status, "pending");
  });

  it("read: a targeted read outcome takes only its own targets and completes when all were read", function () {
    const ledger = ledgerWith({
      taskId: "read",
      description: "Read both papers",
      effect: "read",
      targets: ["item:1", "item:2"],
    });
    const unrelated = apply(ledger, {
      kind: "read",
      targets: ["item:9"],
      observationIds: ["obs-9"],
    });
    assert.isFalse(unrelated.changed);
    assert.strictEqual(unrelated.checkpoint, ledger);

    const first = apply(ledger, {
      kind: "read",
      targets: ["item:1", "item:3"],
      observationIds: ["obs-1"],
    });
    assert.isTrue(first.changed);
    assert.equal(find(first.checkpoint, "read").status, "pending");
    assert.deepEqual(find(first.checkpoint, "read").doneTargets, ["item:1"]);

    const second = apply(first.checkpoint, {
      kind: "read",
      targets: ["item:2"],
      observationIds: ["obs-2"],
    });
    const task = find(second.checkpoint, "read");
    assert.equal(task.status, "completed");
    assert.deepEqual(task.doneTargets, ["item:1", "item:2"]);
    assert.deepEqual(task.readEvidenceIds, ["obs-1", "obs-2"]);
  });

  it("read: one read applies to every pending read outcome that covers it", function () {
    const ledger = ledgerWith(
      {
        taskId: "read-a",
        description: "Read Smith 2021",
        effect: "read",
        targets: ["item:1"],
      },
      {
        taskId: "read-b",
        description: "Read Jones 2020 and Lee 2019",
        effect: "read",
        targets: ["item:2", "item:3"],
      },
      {
        taskId: "read-any",
        description: "Read the related work",
        effect: "read",
      },
      {
        taskId: "read-other",
        description: "Read Kim 2018",
        effect: "read",
        targets: ["item:9"],
      },
    );
    const { checkpoint, changed } = apply(ledger, {
      kind: "read",
      targets: ["item:1", "item:2"],
      observationIds: ["obs-1"],
    });

    assert.isTrue(changed);
    assert.deepEqual(
      checkpoint.tasks.map((task) => [
        task.status,
        task.doneTargets ?? [],
        task.readEvidenceIds,
      ]),
      [
        ["completed", ["item:1"], ["obs-1"]],
        ["pending", ["item:2"], ["obs-1"]],
        ["completed", ["item:1", "item:2"], ["obs-1"]],
        ["pending", [], []],
      ],
    );
  });

  it("receipt: completes an untargeted mutation outcome on its first verified receipt", function () {
    const ledger = ledgerWith({
      taskId: "save",
      description: "Save a note",
      effect: "mutation",
      capability: "zotero.notes",
    });
    const { checkpoint, changed } = apply(ledger, {
      kind: "receipt",
      receipt: receipt(),
    });

    assert.isTrue(changed);
    assert.lengthOf(checkpoint.tasks, 1);
    const task = find(checkpoint, "save");
    assert.equal(task.status, "completed");
    assert.deepEqual(task.doneTargets, ["item:1"]);
    assert.deepEqual(task.verifiedReceiptIds, ["receipt-1"]);
    assert.deepEqual(task.receiptIds, ["receipt-1"]);
    assert.deepEqual(task.journalActionIds, []);
    assert.notProperty(task, "exceptions");
    assert.notProperty(task, "reason");
  });

  it("receipt: a targeted mutation outcome completes when every target is done or excepted", function () {
    const ledger = ledgerWith({
      taskId: "tag",
      description: "Tag three papers",
      effect: "mutation",
      capability: "zotero.tags",
      targets: ["item:1", "item:2", "item:3"],
    });
    const first = apply(ledger, {
      kind: "receipt",
      receipt: receipt({
        id: "receipt-tags-1",
        capability: "zotero.tags",
        operation: "apply_tags",
        status: "partial",
        requestedTargets: ["item:1", "item:2"],
        appliedTargets: ["item:1"],
        rejectedTargets: ["item:2"],
        reasons: ["Item is locked"],
      }),
    });
    let task = find(first.checkpoint, "tag");
    assert.equal(task.status, "pending");
    assert.deepEqual(task.doneTargets, ["item:1"]);
    assert.deepEqual(task.exceptions, [
      { targets: ["item:2"], reason: "Item is locked" },
    ]);

    const second = apply(first.checkpoint, {
      kind: "receipt",
      receipt: receipt({
        id: "receipt-tags-2",
        capability: "zotero.tags",
        operation: "apply_tags",
        requestedTargets: ["item:3"],
        appliedTargets: [],
        alreadySatisfiedTargets: ["item:3"],
        status: "already_satisfied",
      }),
    });
    task = find(second.checkpoint, "tag");
    assert.equal(task.status, "completed");
    assert.deepEqual(task.doneTargets, ["item:1", "item:3"]);
    assert.deepEqual(task.verifiedReceiptIds, [
      "receipt-tags-1",
      "receipt-tags-2",
    ]);
    assert.lengthOf(second.checkpoint.tasks, 1);
  });

  it("receipt: a targeted outcome with every target rejected is skipped with its first exception's reason", function () {
    const ledger = ledgerWith({
      taskId: "tag",
      description: "Tag both papers",
      effect: "mutation",
      capability: "zotero.tags",
      targets: ["item:1", "item:2"],
    });
    const { checkpoint } = apply(ledger, {
      kind: "receipt",
      receipt: rejection(
        "rejected-all",
        ["item:1", "item:2"],
        ["In a group library you cannot edit"],
      ),
    });
    const task = find(checkpoint, "tag");
    assert.equal(task.status, "skipped");
    assert.equal(task.reason, "In a group library you cannot edit");
    assert.notProperty(task, "doneTargets");
    assert.equal(
      decideRunEnd(checkpoint, {
        status: "completed",
        stopRule: "final_answer",
      }),
      "completed_with_exceptions",
    );

    const hosted = apply(emptyLedger(), {
      kind: "receipt",
      receipt: rejection("rejected-host", ["item:5"], []),
    }).checkpoint;
    assert.equal(hosted.tasks[0].status, "skipped");
    assert.equal(hosted.tasks[0].reason, "Not applied");
  });

  it("receipt: rejected targets become one exception per distinct reason, and nothing proven keeps the outcome open", function () {
    let { checkpoint } = apply(ledgerWith(tagAny), {
      kind: "receipt",
      receipt: rejection("rejected-1", ["item:1"], ["Item is locked"]),
    });
    ({ checkpoint } = apply(checkpoint, {
      kind: "receipt",
      receipt: rejection(
        "rejected-2",
        ["item:2", "item:1"],
        ["Item is locked"],
      ),
    }));
    ({ checkpoint } = apply(checkpoint, {
      kind: "receipt",
      receipt: rejection("rejected-3", ["item:3"], []),
    }));

    const task = find(checkpoint, "tag");
    assert.equal(task.status, "pending");
    assert.deepEqual(task.exceptions, [
      { targets: ["item:1", "item:2"], reason: "Item is locked" },
      { targets: ["item:3"], reason: "Not applied" },
    ]);
    assert.deepEqual(task.verifiedReceiptIds, []);
    assert.notProperty(task, "doneTargets");
    assert.lengthOf(checkpoint.tasks, 1);
  });

  it("receipt: a failed or cancelled write leaves the status as it was and records why", function () {
    const ledger = ledgerWith(saveNote, tagAny);
    const failed = apply(ledger, {
      kind: "receipt",
      receipt: failedWrite("receipt-failed", [" Note not found "]),
    });
    assert.isTrue(failed.changed);
    const save = find(failed.checkpoint, "save");
    assert.equal(save.status, "pending");
    assert.equal(save.reason, "Note not found");
    assert.deepEqual(save.receiptIds, ["receipt-failed"]);
    assert.deepEqual(save.verifiedReceiptIds, []);

    const cancelled = apply(ledger, {
      kind: "receipt",
      receipt: receipt({
        id: "receipt-cancelled",
        capability: "zotero.tags",
        operation: "apply_tags",
        verification: "not_applicable",
        status: "cancelled",
        requestedTargets: ["item:4"],
        appliedTargets: [],
        rejectedTargets: ["item:4"],
      }),
    }).checkpoint;
    const tag = find(cancelled, "tag");
    assert.equal(tag.status, "pending");
    assert.equal(tag.reason, WRITE_FAILED);
    assert.deepEqual(tag.exceptions, [
      { targets: ["item:4"], reason: "Not applied" },
    ]);

    const blocked = apply(
      ledgerWith(saveNote),
      declineNote("call-1"),
    ).checkpoint;
    const stillBlocked = find(
      apply(blocked, {
        kind: "receipt",
        receipt: failedWrite("receipt-failed", ["Note not found"]),
      }).checkpoint,
      "save",
    );
    assert.equal(stillBlocked.status, "blocked");
    assert.equal(stillBlocked.reason, "Note not found");
  });

  it("receipt: a verified retry completes an outcome an unverified write or a decline blocked, and drops the reason", function () {
    const uncertain = apply(ledgerWith(saveNote), {
      kind: "receipt",
      receipt: receipt({
        id: "receipt-uncertain",
        verification: "unverified",
        status: "unverified",
        appliedTargets: [],
      }),
    }).checkpoint;
    assert.equal(find(uncertain, "save").reason, UNVERIFIED);
    const refused = apply(
      ledgerWith(saveNote),
      declineNote("call-1"),
    ).checkpoint;
    assert.equal(find(refused, "save").reason, DECLINED);

    for (const blocked of [uncertain, refused]) {
      assert.equal(find(blocked, "save").status, "blocked");
      const { checkpoint, changed } = apply(blocked, {
        kind: "receipt",
        receipt: receipt({ id: "receipt-retry" }),
      });
      assert.isTrue(changed);
      assert.lengthOf(checkpoint.tasks, 1, "no host outcome for the retry");
      const task = find(checkpoint, "save");
      assert.equal(task.status, "completed");
      assert.notProperty(task, "reason");
      assert.include(task.verifiedReceiptIds, "receipt-retry");
      assert.equal(
        decideRunEnd(checkpoint, {
          status: "completed",
          stopRule: "final_answer",
        }),
        "completed",
      );
    }
  });

  it("receipt: an execution-only receipt completes the outcome but is never recorded as verified", function () {
    const command = receipt({
      id: "command_execute:abc:unmatched:result",
      capability: "command.execute",
      operation: "command_execute",
      proofDomain: "execution",
      verification: "execution_only",
      status: "observed",
      requestedTargets: [],
      appliedTargets: [],
    });
    const hosted = apply(emptyLedger(), {
      kind: "receipt",
      receipt: command,
    }).checkpoint;
    assert.equal(hosted.tasks[0].status, "completed");
    assert.equal(hosted.tasks[0].description, "Ran command");
    assert.deepEqual(hosted.tasks[0].verifiedReceiptIds, []);
    assert.deepEqual(hosted.tasks[0].receiptIds, [command.id]);
    assert.equal(
      decideRunEnd(hosted, { status: "completed", stopRule: "final_answer" }),
      "completed",
    );

    const declared = apply(
      ledgerWith({
        taskId: "run",
        description: "Run the conversion",
        effect: "mutation",
        capability: "command.execute",
      }),
      { kind: "receipt", receipt: command },
    ).checkpoint;
    assert.equal(find(declared, "run").status, "completed");
    assert.deepEqual(find(declared, "run").verifiedReceiptIds, []);
  });

  it("receipt: binds every matching targeted outcome, before any untargeted one, with its own targets, and ignores targets none of them names", function () {
    const ledger = ledgerWith(
      { ...tagAny, taskId: "tag-any" },
      {
        taskId: "tag-a",
        description: "Tag Smith and Jones",
        effect: "mutation",
        capability: "zotero.tags",
        targets: ["item:1", "item:2"],
      },
      {
        taskId: "tag-b",
        description: "Tag Lee",
        effect: "mutation",
        capability: "zotero.tags",
        targets: ["item:3"],
      },
    );
    const { checkpoint } = apply(ledger, {
      kind: "receipt",
      receipt: receipt({
        id: "receipt-tags",
        capability: "zotero.tags",
        operation: "apply_tags",
        status: "partial",
        requestedTargets: ["item:1", "item:2", "item:3", "item:9"],
        appliedTargets: ["item:1", "item:3", "item:9"],
        rejectedTargets: ["item:2"],
        reasons: ["Item is locked"],
      }),
    });

    assert.lengthOf(checkpoint.tasks, 3, "no outcome for item:9");
    const a = find(checkpoint, "tag-a");
    assert.equal(a.status, "completed");
    assert.deepEqual(a.doneTargets, ["item:1"]);
    assert.deepEqual(a.exceptions, [
      { targets: ["item:2"], reason: "Item is locked" },
    ]);
    assert.deepEqual(a.verifiedReceiptIds, ["receipt-tags"]);
    const b = find(checkpoint, "tag-b");
    assert.equal(b.status, "completed");
    assert.deepEqual(b.doneTargets, ["item:3"]);
    assert.notProperty(b, "exceptions");
    assert.deepEqual(b.verifiedReceiptIds, ["receipt-tags"]);
    assert.equal(find(checkpoint, "tag-any").status, "pending");
  });

  it("receipt: with no targeted match it binds only the first untargeted outcome", function () {
    const ledger = ledgerWith(
      {
        taskId: "tag-a",
        description: "Tag Smith",
        effect: "mutation",
        capability: "zotero.tags",
        targets: ["item:1"],
      },
      { ...tagAny, taskId: "tag-first", description: "Tag one paper" },
      { ...tagAny, taskId: "tag-second", description: "Tag another paper" },
    );
    const { checkpoint } = apply(ledger, {
      kind: "receipt",
      receipt: receipt({
        id: "receipt-tags",
        capability: "zotero.tags",
        operation: "apply_tags",
        requestedTargets: ["item:5"],
        appliedTargets: ["item:5"],
      }),
    });
    assert.deepEqual(
      checkpoint.tasks.map((task) => task.status),
      ["pending", "completed", "pending"],
    );
    assert.deepEqual(find(checkpoint, "tag-first").doneTargets, ["item:5"]);
  });

  it("receipt: with no candidate it appends a host outcome and applies the row to it", function () {
    const rawId = "proposal-1:obligation-1:sha256:abc";
    const { checkpoint, changed } = apply(emptyLedger(), {
      kind: "receipt",
      receipt: receipt({
        id: rawId,
        requestedTargets: ["item:7"],
        appliedTargets: ["item:7"],
      }),
    });

    assert.isTrue(changed);
    assert.lengthOf(checkpoint.tasks, 1);
    const task = checkpoint.tasks[0];
    assert.equal(
      task.taskId,
      taskId("host-proposal-1-obligation-1-sha256-abc"),
    );
    assert.equal(task.origin, "host");
    assert.equal(task.effect, "mutation");
    assert.equal(task.capability, "zotero.notes");
    assert.equal(task.operation, "note_create");
    assert.equal(task.description, "Created note");
    assert.deepEqual(task.targets, ["item:7"]);
    assert.deepEqual(task.doneTargets, ["item:7"]);
    assert.equal(task.status, "completed");
    assert.deepEqual(task.verifiedReceiptIds, [rawId]);
    assert.equal(task.createdAt, 30);
  });

  it("receipt: derives a valid, distinct host task id from any receipt id", function () {
    const ids = [
      "file_write:fallback:/Users/me/My Notes/a b.md",
      "file_write:fallback:/Users/me/My Notes/a:b.md",
      `${"proposal-".repeat(20)}:obligation:sha256:${"f".repeat(64)}`,
      `${"proposal-".repeat(20)}:obligation:sha256:${"e".repeat(64)}`,
    ];
    let checkpoint = emptyLedger();
    for (const id of ids) {
      checkpoint = apply(checkpoint, {
        kind: "receipt",
        receipt: receipt({
          id,
          capability: "file.write",
          operation: "file_write",
          proofDomain: "file_state",
          requestedTargets: [`file:${id}`],
          appliedTargets: [`file:${id}`],
        }),
      }).checkpoint;
    }

    assert.lengthOf(checkpoint.tasks, ids.length);
    assert.lengthOf(
      new Set(checkpoint.tasks.map((task) => task.taskId)),
      ids.length,
    );
    for (const [index, task] of checkpoint.tasks.entries()) {
      assert.strictEqual(
        ordinaryExecutionTaskId("execution-direct-1", task.taskId),
        task.taskId,
      );
      assert.match(task.taskId, /^execution-direct-1:task:host-/);
      assert.deepEqual(task.verifiedReceiptIds, [ids[index]]);
      assert.equal(task.description, "Wrote file");
    }
  });

  it("receipt: a read receipt is not a write, so it binds nothing and creates nothing", function () {
    const ledger = ledgerWith({
      taskId: "write",
      description: "Make the change",
      effect: "mutation",
    });
    const { checkpoint, changed } = apply(ledger, {
      kind: "receipt",
      receipt: receipt({
        id: "read_full:0:unmatched:result",
        capability: "zotero.read",
        operation: "read_full",
        status: "observed",
        requestedTargets: [],
        appliedTargets: [],
        verifiedFacts: ["read_mode:full"],
      }),
    });
    assert.isFalse(changed);
    assert.strictEqual(checkpoint, ledger);
  });

  it("material: completes the first pending artifact outcome", function () {
    const ledger = ledgerWith(
      {
        taskId: "draft",
        description: "Write the synthesis",
        effect: "artifact",
      },
      {
        taskId: "second",
        description: "Write a second draft",
        effect: "artifact",
      },
    );
    const { checkpoint, changed } = apply(ledger, {
      kind: "material",
      materialRef: material,
    });
    assert.isTrue(changed);
    assert.equal(find(checkpoint, "draft").status, "completed");
    assert.deepEqual(find(checkpoint, "draft").materialRefs, [material]);
    assert.equal(find(checkpoint, "second").status, "pending");
  });

  it("material: with no artifact outcome it creates nothing", function () {
    for (const ledger of [emptyLedger(), ledgerWith(saveNote)]) {
      const result = apply(ledger, { kind: "material", materialRef: material });
      assert.isFalse(result.changed);
      assert.strictEqual(result.checkpoint, ledger);
    }
  });

  it("declined: blocks the matching pending or in-progress mutation outcome", function () {
    const inProgress: ExecutionCheckpointTask = {
      ...legacyTask("tag", { status: "in_progress" }),
      effect: "mutation",
      origin: "model",
      capability: "zotero.tags",
    };
    const ledger = withTasks(ledgerWith(saveNote), inProgress);

    const notes = apply(ledger, declineNote("call-note"));
    assert.isTrue(notes.changed);
    const save = find(notes.checkpoint, "save");
    assert.equal(save.status, "blocked");
    assert.equal(save.reason, DECLINED);
    assert.deepEqual(save.receiptIds, ["declined:call-note"]);
    assert.equal(find(notes.checkpoint, "tag").status, "in_progress");

    const tags = apply(
      notes.checkpoint,
      declined("call-tags", {
        capability: "zotero.tags",
        operation: "apply_tags",
        requestedTargets: ["item:4"],
      }),
    );
    assert.equal(find(tags.checkpoint, "tag").status, "blocked");
    assert.equal(find(tags.checkpoint, "tag").reason, DECLINED);
    assert.lengthOf(tags.checkpoint.tasks, 2);
  });

  it("declined: with no candidate it appends a blocked host outcome, numbered in order", function () {
    const first = apply(
      emptyLedger(),
      declined(
        "call-1",
        {
          capability: "zotero.tags",
          operation: "apply_tags",
          requestedTargets: ["item:1", "item:2"],
        },
        {
          capability: "zotero.tags",
          operation: "apply_tags",
          requestedTargets: ["item:2", "item:3"],
        },
      ),
    );
    assert.isTrue(first.changed);
    assert.deepEqual(first.checkpoint.tasks[0], {
      taskId: taskId("host-declined-1"),
      description: "Added tags",
      dependencies: [],
      status: "blocked",
      journalActionIds: [],
      verifiedReceiptIds: [],
      readEvidenceIds: [],
      materialRefs: [],
      createdAt: 30,
      updatedAt: 30,
      effect: "mutation",
      origin: "host",
      capability: "zotero.tags",
      operation: "apply_tags",
      targets: ["item:1", "item:2", "item:3"],
      receiptIds: ["declined:call-1"],
      reason: DECLINED,
    });

    const second = apply(
      first.checkpoint,
      declined("call-2", {
        capability: "zotero.notes",
        operation: "save_note",
        requestedTargets: [],
      }),
    );
    assert.deepEqual(
      second.checkpoint.tasks.map((task) => [task.taskId, task.description]),
      [
        [taskId("host-declined-1"), "Added tags"],
        [taskId("host-declined-2"), "Saved note"],
      ],
    );
    assert.notProperty(second.checkpoint.tasks[1], "targets");
  });

  it("declined: the same call declined again changes nothing", function () {
    const once = apply(ledgerWith(saveNote), declineNote("call-1"));
    const again = apply(once.checkpoint, declineNote("call-1"));
    assert.isFalse(again.changed);
    assert.strictEqual(again.checkpoint, once.checkpoint);

    const tags = {
      capability: "zotero.tags" as const,
      operation: "apply_tags" as const,
      requestedTargets: ["item:4"],
    };
    const hosted = apply(emptyLedger(), declined("call-2", tags)).checkpoint;
    const repeated = apply(hosted, declined("call-2", tags));
    assert.isFalse(repeated.changed);
    assert.strictEqual(repeated.checkpoint, hosted);
    const another = apply(hosted, declined("call-3", tags)).checkpoint;
    assert.deepEqual(
      another.tasks.map((task) => task.receiptIds),
      [["declined:call-2"], ["declined:call-3"]],
    );
  });

  it("answer: completes every pending answer outcome and nothing else", function () {
    const ledger = ledgerWith(
      {
        taskId: "explain",
        description: "Explain the method",
        effect: "answer",
      },
      {
        taskId: "compare",
        description: "Compare the results",
        effect: "answer",
      },
      saveNote,
    );
    const { checkpoint, changed } = apply(ledger, { kind: "answer" });
    assert.isTrue(changed);
    assert.deepEqual(
      checkpoint.tasks.map((task) => task.status),
      ["completed", "completed", "pending"],
    );
    const again = apply(checkpoint, { kind: "answer" });
    assert.isFalse(again.changed);
    assert.strictEqual(again.checkpoint, checkpoint);
  });
});

describe("outcome ledger: final gate inputs", function () {
  it("lists only the model's pending outcomes that need more than the answer", function () {
    let ledger = ledgerWith(
      saveNote,
      { taskId: "read", description: "Read it", effect: "read" },
      { taskId: "explain", description: "Explain it", effect: "answer" },
      { taskId: "draft", description: "Draft it", effect: "artifact" },
      { taskId: "tag", description: "Tag it", effect: "mutation" },
    );
    ledger = apply(ledger, {
      kind: "read",
      targets: ["item:1"],
      observationIds: ["obs-1"],
    }).checkpoint;
    ledger = markOutcomes(
      ledger,
      [{ taskId: "tag", status: "skipped", reason: "Not needed" }],
      40,
    ).checkpoint;
    ledger = apply(
      ledger,
      declined("call-trash", {
        capability: "zotero.trash",
        operation: "trash_items",
        requestedTargets: ["item:5"],
      }),
    ).checkpoint;
    ledger = withTasks(ledger, legacyTask("legacy"));

    assert.deepEqual(
      openDeclaredOutcomes(ledger).map((task) => task.taskId),
      [taskId("save"), taskId("draft")],
    );
    assert.deepEqual(openDeclaredOutcomes(undefined), []);
  });

  it("signs progress as each outcome's id, status and evidence counts", function () {
    const ledger = apply(
      ledgerWith(saveNote, {
        taskId: "read",
        description: "Read it",
        effect: "read",
      }),
      { kind: "read", targets: ["item:1"], observationIds: ["obs-1", "obs-2"] },
    ).checkpoint;
    assert.equal(
      outcomeProgressSignature(ledger),
      JSON.stringify([
        [taskId("save"), "pending", 0, 0, 0, 0, 0],
        [taskId("read"), "completed", 1, 0, 0, 2, 0],
      ]),
    );
    assert.equal(outcomeProgressSignature(undefined), "[]");
  });
});

describe("outcome ledger: run end state", function () {
  const INTERRUPTING: RunStopRule[] = [
    "interrupted_by_error",
    "stream_interrupted_again",
    "incomplete_step_limit",
    "segment_without_progress",
    "repeated_tool_errors",
  ];

  function withProgress(): ExecutionCheckpoint {
    return apply(
      ledgerWith(
        { taskId: "read", description: "Read it", effect: "read" },
        saveNote,
      ),
      { kind: "read", targets: ["item:1"], observationIds: ["obs-1"] },
    ).checkpoint;
  }

  it("a cancelled run ends cancelled and keeps its open outcomes pending", function () {
    const ledger = apply(
      withProgress(),
      declined("call-tags", {
        capability: "zotero.tags",
        operation: "apply_tags",
        requestedTargets: ["item:3"],
      }),
    ).checkpoint;
    for (const stopRule of [
      "cancelled_in_flight",
      "cancelled_before_step",
    ] as RunStopRule[]) {
      assert.equal(
        decideRunEnd(ledger, { status: "cancelled", stopRule }),
        "cancelled",
      );
    }
    const settled = settleOutcomes(ledger, "cancelled", 50);
    assert.deepEqual(settled.end, { state: "cancelled" });
    assert.equal(find(settled, "save").status, "pending");
    assert.isUndefined(find(settled, "save").reason);
    assert.isUndefined(ledger.end);
  });

  it("awaiting clarification, unresolved references, or any blocked outcome end blocked", function () {
    for (const stopRule of [
      "awaiting_clarification",
      "references_unresolved",
    ] as RunStopRule[]) {
      assert.equal(
        decideRunEnd(undefined, { status: "completed", stopRule }),
        "blocked",
      );
    }
    const blocked = apply(
      ledgerWith(saveNote),
      declineNote("call-note"),
    ).checkpoint;
    assert.equal(
      decideRunEnd(blocked, { status: "completed", stopRule: "final_answer" }),
      "blocked",
    );
    assert.equal(
      decideRunEnd(blocked, {
        status: "failed",
        stopRule: "interrupted_by_error",
      }),
      "blocked",
    );
  });

  it("a failed run that made progress under an interrupting rule ends interrupted and keeps its open outcomes pending", function () {
    const ledger = withProgress();
    for (const stopRule of INTERRUPTING) {
      assert.equal(
        decideRunEnd(ledger, { status: "failed", stopRule }),
        "interrupted",
        stopRule,
      );
    }
    const settled = settleOutcomes(ledger, "interrupted", 50);
    assert.deepEqual(settled.end, { state: "interrupted" });
    assert.equal(find(settled, "save").status, "pending");
    assert.equal(find(settled, "read").status, "completed");
  });

  it("any other failed run ends failed", function () {
    assert.equal(
      decideRunEnd(ledgerWith(saveNote), {
        status: "failed",
        stopRule: "interrupted_by_error",
      }),
      "failed",
      "no outcome has evidence",
    );
    assert.equal(
      decideRunEnd(undefined, {
        status: "failed",
        stopRule: "stream_interrupted_again",
      }),
      "failed",
    );
    assert.equal(
      decideRunEnd(withProgress(), {
        status: "failed",
        stopRule: "tool_action_failed",
      }),
      "failed",
      "not an interrupting rule",
    );
  });

  it("a completed run with an open, skipped or excepted outcome ends completed with exceptions", function () {
    const run = { status: "completed", stopRule: "final_answer" } as const;
    const open = withProgress();
    assert.equal(decideRunEnd(open, run), "completed_with_exceptions");

    const skippedRead = markOutcomes(
      ledgerWith(
        { taskId: "read", description: "Read it", effect: "read" },
        { taskId: "explain", description: "Explain it", effect: "answer" },
      ),
      [{ taskId: "read", status: "skipped", reason: "No PDF attached" }],
      40,
    ).checkpoint;
    assert.equal(
      decideRunEnd(apply(skippedRead, { kind: "answer" }).checkpoint, run),
      "completed_with_exceptions",
    );

    const excepted = apply(emptyLedger(), {
      kind: "receipt",
      receipt: receipt({
        id: "receipt-partial",
        status: "partial",
        requestedTargets: ["item:1", "item:2"],
        appliedTargets: ["item:1"],
        rejectedTargets: ["item:2"],
        reasons: ["Item is locked"],
      }),
    }).checkpoint;
    assert.equal(excepted.tasks[0].status, "completed");
    assert.equal(decideRunEnd(excepted, run), "completed_with_exceptions");

    const settled = settleOutcomes(open, "completed_with_exceptions", 50);
    assert.equal(find(settled, "save").status, "skipped");
    assert.equal(find(settled, "save").reason, NOT_DONE);
    assert.equal(find(settled, "save").updatedAt, 50);
    assert.equal(find(settled, "read").status, "completed");
    assert.deepEqual(settled.end, { state: "completed_with_exceptions" });
    assert.equal(settled.updatedAt, 50);
  });

  it("settling as completed with exceptions keeps a pending outcome's own reason", function () {
    const ledger = apply(ledgerWith(saveNote, tagAny), {
      kind: "receipt",
      receipt: failedWrite("receipt-failed", ["Note not found"]),
    }).checkpoint;
    const settled = settleOutcomes(ledger, "completed_with_exceptions", 60);
    assert.deepEqual(
      settled.tasks.map((task) => [task.status, task.reason]),
      [
        ["skipped", "Note not found"],
        ["skipped", NOT_DONE],
      ],
    );
  });

  it("otherwise the run ends completed", function () {
    const run = { status: "completed", stopRule: "final_answer" } as const;
    const done = apply(
      apply(withProgress(), { kind: "receipt", receipt: receipt() }).checkpoint,
      { kind: "answer" },
    ).checkpoint;
    assert.equal(decideRunEnd(done, run), "completed");
    assert.equal(decideRunEnd(undefined, run), "completed");
    assert.equal(decideRunEnd(emptyLedger(), run), "completed");
    const settled = settleOutcomes(emptyLedger(), "completed", 50);
    assert.deepEqual(settled.tasks, []);
    assert.deepEqual(settled.end, { state: "completed" });
  });
});

describe("outcome ledger: host reasons", function () {
  it("exports every reason the host writes as one frozen object", function () {
    assert.isTrue(Object.isFrozen(OUTCOME_REASONS));
    assert.deepEqual(
      { ...OUTCOME_REASONS },
      {
        markReasonRequired:
          "A skipped, blocked, or cancelled task needs the reason.",
        unverified: UNVERIFIED,
        declined: DECLINED,
        notApplied: "Not applied",
        notDone: NOT_DONE,
        writeFailed: WRITE_FAILED,
      },
    );
  });
});

describe("outcome ledger: review cases", function () {
  it("wrong target: a receipt for another item leaves the declared outcome open and adds a host outcome", function () {
    const { checkpoint } = apply(ledgerWith(saveNote), {
      kind: "receipt",
      receipt: receipt({
        id: "receipt-item-2",
        requestedTargets: ["item:2"],
        appliedTargets: ["item:2"],
      }),
    });
    assert.equal(find(checkpoint, "save").status, "pending");
    assert.deepEqual(find(checkpoint, "save").verifiedReceiptIds, []);
    const host = find(checkpoint, "host-receipt-item-2");
    assert.equal(host.status, "completed");
    assert.equal(host.origin, "host");
    assert.deepEqual(host.targets, ["item:2"]);
    assert.deepEqual(openDeclaredOutcomes(checkpoint), [
      find(checkpoint, "save"),
    ]);
  });

  it("partial batch: 8 of 10 applied completes with one exception, and the run ends completed with exceptions", function () {
    const requested = Array.from(
      { length: 10 },
      (_, index) => `item:${index + 1}`,
    );
    const { checkpoint } = apply(emptyLedger(), {
      kind: "receipt",
      receipt: receipt({
        id: "receipt-batch",
        capability: "zotero.metadata",
        operation: "update_metadata",
        status: "partial",
        requestedTargets: requested,
        appliedTargets: requested.slice(0, 8),
        rejectedTargets: requested.slice(8),
        reasons: ["In a group library you cannot edit"],
      }),
    });

    assert.lengthOf(checkpoint.tasks, 1);
    const host = checkpoint.tasks[0];
    assert.equal(host.status, "completed");
    assert.lengthOf(host.targets!, 10);
    assert.deepEqual(host.doneTargets, requested.slice(0, 8));
    assert.deepEqual(host.exceptions, [
      {
        targets: ["item:9", "item:10"],
        reason: "In a group library you cannot edit",
      },
    ]);
    assert.equal(
      decideRunEnd(checkpoint, {
        status: "completed",
        stopRule: "final_answer",
      }),
      "completed_with_exceptions",
    );
  });

  it("capability mismatch: a tags receipt does not close a declared note outcome", function () {
    const { checkpoint } = apply(ledgerWith(saveNote), {
      kind: "receipt",
      receipt: receipt({
        id: "receipt-tags",
        capability: "zotero.tags",
        operation: "apply_tags",
      }),
    });
    assert.equal(find(checkpoint, "save").status, "pending");
    assert.equal(
      find(checkpoint, "host-receipt-tags").description,
      "Added tags",
    );
  });

  it("unverified receipt: only a possibly applied change blocks, and the run ends blocked even when it completed", function () {
    const ledger = ledgerWith(saveNote);
    for (const verification of ["unverified", "verified"] as const) {
      const { checkpoint } = apply(ledger, {
        kind: "receipt",
        receipt: receipt({
          verification,
          status: "unverified",
          appliedTargets: [],
          rejectedTargets: ["item:1"],
          reasons: ["This note_create write could not be verified."],
        }),
      });
      const task = find(checkpoint, "save");
      assert.equal(task.status, "blocked");
      assert.equal(task.reason, UNVERIFIED);
      assert.deepEqual(task.doneTargets ?? [], []);
      assert.deepEqual(task.verifiedReceiptIds, []);
      assert.deepEqual(task.exceptions, [
        {
          targets: ["item:1"],
          reason: "This note_create write could not be verified.",
        },
      ]);
      assert.equal(
        decideRunEnd(checkpoint, {
          status: "completed",
          stopRule: "final_answer",
        }),
        "blocked",
      );
    }
    const failed = apply(ledger, {
      kind: "receipt",
      receipt: failedWrite("receipt-failed", ["Note not found"]),
    }).checkpoint;
    assert.equal(find(failed, "save").status, "pending", "a failure is not");
  });

  it("idempotence: the same receipt, read or material applied twice changes nothing the second time", function () {
    const declaredReceipt = apply(ledgerWith(saveNote), {
      kind: "receipt",
      receipt: receipt(),
    }).checkpoint;
    const repeated = apply(declaredReceipt, {
      kind: "receipt",
      receipt: receipt(),
    });
    assert.isFalse(repeated.changed);
    assert.strictEqual(repeated.checkpoint, declaredReceipt);

    const unverified = receipt({
      id: "receipt-unverified",
      verification: "unverified",
      status: "unverified",
      appliedTargets: [],
    });
    const blocked = apply(ledgerWith(saveNote), {
      kind: "receipt",
      receipt: unverified,
    }).checkpoint;
    const blockedAgain = apply(blocked, {
      kind: "receipt",
      receipt: unverified,
    });
    assert.isFalse(blockedAgain.changed, "no host outcome for a bound receipt");
    assert.lengthOf(blockedAgain.checkpoint.tasks, 1);

    const hosted = apply(emptyLedger(), {
      kind: "receipt",
      receipt: receipt(),
    }).checkpoint;
    const hostedAgain = apply(hosted, { kind: "receipt", receipt: receipt() });
    assert.isFalse(hostedAgain.changed);
    assert.lengthOf(hostedAgain.checkpoint.tasks, 1);

    const read: OutcomeEvidence = {
      kind: "read",
      targets: ["item:1"],
      observationIds: ["obs-1"],
    };
    const readOnce = apply(
      ledgerWith({ taskId: "read-1", description: "Read one", effect: "read" }),
      read,
    ).checkpoint;
    const later = frozen(
      declareOutcomes(
        readOnce,
        [{ taskId: "read-2", description: "Read another", effect: "read" }],
        40,
      ),
    );
    const readAgain = apply(later, read);
    assert.isFalse(readAgain.changed);
    assert.strictEqual(readAgain.checkpoint, later);
    assert.equal(find(readAgain.checkpoint, "read-2").status, "pending");

    const drafts = ledgerWith(
      { taskId: "draft-1", description: "Draft one", effect: "artifact" },
      { taskId: "draft-2", description: "Draft another", effect: "artifact" },
    );
    const materialOnce = apply(drafts, {
      kind: "material",
      materialRef: material,
    }).checkpoint;
    const materialAgain = apply(materialOnce, {
      kind: "material",
      materialRef: { ...material },
    });
    assert.isFalse(materialAgain.changed);
    assert.equal(find(materialAgain.checkpoint, "draft-2").status, "pending");
  });

  it("settling as completed with exceptions marks a still-pending outcome not done before the answer", function () {
    const ledger = apply(
      ledgerWith(saveNote, {
        taskId: "explain",
        description: "Explain it",
        effect: "answer",
      }),
      { kind: "answer" },
    ).checkpoint;
    const end = decideRunEnd(ledger, {
      status: "completed",
      stopRule: "final_answer",
    });
    assert.equal(end, "completed_with_exceptions");
    const settled = settleOutcomes(ledger, end, 60);
    assert.deepEqual(
      settled.tasks.map((task) => [task.status, task.reason]),
      [
        ["skipped", NOT_DONE],
        ["completed", undefined],
      ],
    );
    assert.equal(find(ledger, "save").status, "pending");
  });

  it("a restored task without an effect completes on the answer", function () {
    const ledger = withTasks(
      emptyLedger(),
      legacyTask("summary"),
      legacyTask("saved", {
        status: "completed",
        verifiedReceiptIds: ["receipt-old"],
      }),
    );
    const { checkpoint, changed } = apply(ledger, { kind: "answer" });
    assert.isTrue(changed);
    assert.equal(find(checkpoint, "summary").status, "completed");
    assert.equal(find(checkpoint, "saved").updatedAt, 5);
    assert.equal(
      decideRunEnd(checkpoint, {
        status: "completed",
        stopRule: "final_answer",
      }),
      "completed",
    );
  });

  it("the progress signature changes when a receipt binds, not when an unrelated read arrives", function () {
    const ledger = ledgerWith(saveNote);
    const before = outcomeProgressSignature(ledger);

    const read = apply(ledger, {
      kind: "read",
      targets: ["item:1"],
      observationIds: ["obs-1"],
    });
    assert.isFalse(read.changed);
    assert.equal(outcomeProgressSignature(read.checkpoint), before);

    const bound = apply(ledger, { kind: "receipt", receipt: receipt() });
    assert.notEqual(outcomeProgressSignature(bound.checkpoint), before);
  });
});
