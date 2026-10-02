import { assert } from "chai";
import { DatabaseSync } from "node:sqlite";
import { createEmptyExecutionCheckpoint } from "../src/agent/execution/checkpoint";
import { journaledNoteReceipts } from "../src/agent/execution/journalReceipts";
import {
  applyOutcomeEvidence,
  declareOutcomes,
  reconcileJournaledReceipts,
} from "../src/agent/loop/outcomes";
import { createNoteWriteBatchTool } from "../src/agent/tools/write/noteWriteBatch";
import { initAgentChangeJournal } from "../src/agent/store/changeJournal";
import { initPlanDocumentStore } from "../src/agent/documents/store";
import { initAgentBatchItemStore } from "../src/agent/store/batchItemStore";
import { initAgentBatchJobStore } from "../src/agent/store/batchJobStore";
import type {
  AgentActionReceipt,
  AgentExecutionContext,
  AgentToolContext,
  ExecutionCheckpoint,
} from "../src/agent/types";
import { installNativeNoteStore } from "./helpers/nativeNoteStore";

const PAPERS = [1, 2, 3, 4, 5, 6];

const executionContext: AgentExecutionContext = {
  version: 1,
  executionId: "execution-journal-1",
  conversationKey: 51,
  conversationGeneration: 0,
  chatLibraryID: 1,
  permissionOwner: "original_agent",
  workspaceSnapshot: { selectedPapers: [], selectedCollections: [] },
  configuredAccess: { libraryIDs: [1], outputDirectories: [] },
};

/** A ledger whose note part names six papers, as a stopped job left it. */
function noteLedger(): ExecutionCheckpoint {
  return declareOutcomes(
    createEmptyExecutionCheckpoint(executionContext, 10),
    [
      {
        taskId: "note-all",
        description: "Save a note on each paper",
        effect: "mutation",
        capability: "zotero.notes",
        targets: PAPERS.map(String),
      },
    ],
    20,
  );
}

function noteReceipt(id: string, paper: number): AgentActionReceipt {
  return {
    version: 2,
    id,
    proposalId: id,
    proofDomain: "zotero_state",
    capability: "zotero.notes",
    operation: "note_create",
    verification: "verified",
    status: "applied",
    requestedTargets: [`item:${paper}`],
    appliedTargets: [`item:${paper}`],
    alreadySatisfiedTargets: [],
    rejectedTargets: [],
    reasons: [],
    verifiedFacts: [],
  };
}

describe("resume reconciliation with the change journal", function () {
  it("applies the journaled receipts the ledger lacks, and nothing twice", function () {
    // Paper 1's note reached the ledger in the stopped run; 2 and 3 did not.
    const held = applyOutcomeEvidence(
      noteLedger(),
      { kind: "receipt", receipt: noteReceipt("in-run-1", 1) },
      30,
    ).checkpoint;
    const journaled = [
      noteReceipt("journal:a:1", 1),
      noteReceipt("journal:a:2", 2),
      noteReceipt("journal:a:3", 3),
      // A paper no part asks for gets no part of its own.
      noteReceipt("journal:b:1", 9),
    ];

    const first = reconcileJournaledReceipts(held, journaled, 40);
    assert.isTrue(first.changed);
    assert.lengthOf(first.checkpoint.tasks, 1, "no host part is added");
    const [part] = first.checkpoint.tasks;
    assert.equal(part.status, "pending");
    assert.deepEqual(part.doneTargets, ["item:1", "item:2", "item:3"]);
    assert.deepEqual(part.receiptIds, [
      "in-run-1",
      "journal:a:2",
      "journal:a:3",
    ]);

    const again = reconcileJournaledReceipts(first.checkpoint, journaled, 50);
    assert.isFalse(again.changed);
    assert.strictEqual(again.checkpoint, first.checkpoint);
  });

  it("gives each journaled note the ledger lacks to the next part that owes its paper one", function () {
    // Two notes a paper, a part for each: paper 1's summary reached the
    // ledger in the stopped run; its methods note and paper 2's summary did
    // not.
    const parts = declareOutcomes(
      createEmptyExecutionCheckpoint(executionContext, 10),
      ["summary", "methods"].map((kind) => ({
        taskId: `${kind}-all`,
        description: `Save a ${kind} note on each paper`,
        effect: "mutation" as const,
        capability: "zotero.notes" as const,
        targets: PAPERS.map(String),
      })),
      20,
    );
    const held = applyOutcomeEvidence(
      parts,
      { kind: "receipt", receipt: noteReceipt("in-run-1", 1) },
      30,
    ).checkpoint;
    const journaled = [
      noteReceipt("journal:a:1", 1),
      noteReceipt("journal:a:2", 1),
      noteReceipt("journal:a:3", 2),
    ];

    const first = reconcileJournaledReceipts(held, journaled, 40);
    assert.isTrue(first.changed);
    const [summary, methods] = first.checkpoint.tasks;
    assert.deepEqual(summary.doneTargets, ["item:1", "item:2"]);
    assert.deepEqual(summary.receiptIds, ["in-run-1", "journal:a:3"]);
    assert.deepEqual(methods.doneTargets, ["item:1"]);
    assert.deepEqual(methods.receiptIds, ["journal:a:2"]);

    const again = reconcileJournaledReceipts(first.checkpoint, journaled, 50);
    assert.isFalse(again.changed);
  });

  it("leaves a part the journal does not name, and a settled ledger, alone", function () {
    const journaled = [noteReceipt("journal:a:1", 1)];
    const tags = declareOutcomes(
      createEmptyExecutionCheckpoint(executionContext, 10),
      [
        {
          taskId: "tag-all",
          description: "Tag each paper",
          effect: "mutation",
          capability: "zotero.tags",
          targets: PAPERS.map(String),
        },
      ],
      20,
    );
    const result = reconcileJournaledReceipts(tags, journaled, 30);
    assert.isFalse(result.changed);
    assert.strictEqual(result.checkpoint, tags);
  });
});

describe("journaled note receipts", function () {
  const globalScope = globalThis as typeof globalThis & { Zotero?: unknown };
  let db: DatabaseSync;
  let native: ReturnType<typeof installNativeNoteStore>;
  let originalZotero: unknown;
  let stop: AbortController;
  let saves = 0;

  function libraryItem(id: number) {
    return {
      id,
      libraryID: 1,
      parentID: false,
      deleted: false,
      version: 1,
      dateModified: "2026-09-11 10:00:00",
      getDisplayTitle: () => `Paper ${id}`,
      getField: () => "",
      getTags: () => [],
      getCollections: () => [],
      isNote: () => false,
      isAttachment: () => false,
      isRegularItem: () => true,
      getAttachments: () => [],
      getNotes: () => [],
      async reload() {},
    };
  }
  const papers = new Map(PAPERS.map((id) => [id, libraryItem(id)]));
  const getItem = (id: number) =>
    (papers.get(id) || native.notes.get(id) || null) as Zotero.Item | null;

  function context(): AgentToolContext {
    return {
      request: {
        conversationKey: 51,
        libraryID: 1,
        metadata: { sourceMessageTimestamp: 100 },
      },
      runId: "run-stopped-1",
      item: null,
      currentAnswerText: "",
      modelName: "test-model",
      signal: stop.signal,
    } as unknown as AgentToolContext;
  }

  beforeEach(async function () {
    originalZotero = globalScope.Zotero;
    stop = new AbortController();
    saves = 0;
    db = new DatabaseSync(":memory:");
    globalScope.Zotero = {
      DB: {
        queryAsync: async (sql: string, params?: unknown[]) => {
          const statement = db.prepare(sql);
          const values = (params || []).map((value) =>
            value === undefined ? null : value,
          ) as never[];
          if (/^\s*(SELECT|PRAGMA|WITH)/i.test(sql))
            return statement.all(...values);
          statement.run(...values);
          return [];
        },
        executeTransaction: async (task: () => Promise<unknown>) => task(),
      },
      debug: () => undefined,
    } as unknown as typeof Zotero;
    native = installNativeNoteStore({
      startId: 500,
      onSave: () => {
        saves += 1;
        if (saves === 3) stop.abort();
      },
    });
    await initPlanDocumentStore();
    await initAgentBatchJobStore();
    await initAgentBatchItemStore();
    await initAgentChangeJournal();
    // The stopped run: a batch over six papers, stopped at its third note.
    const tool = createNoteWriteBatchTool({
      resolveLibraryID: () => 1,
      getItem,
    } as never);
    const validation = tool.validate({
      notes: PAPERS.map((id) => ({
        targetItemId: id,
        content: `Note on paper ${id}.`,
      })),
    });
    if (!validation.ok) throw new Error("validation failed");
    await tool.planInvocation(validation.value, context());
    await tool.execute(validation.value, context());
  });

  afterEach(function () {
    native.restore();
    globalScope.Zotero = originalZotero as typeof Zotero;
    db.close();
  });

  it("reads one receipt per note the run wrote, proved by the live note", async function () {
    const receipts = await journaledNoteReceipts({
      runId: "run-stopped-1",
      conversationKey: 51,
      getItem,
    });

    assert.deepEqual(
      receipts.map((receipt) => receipt.appliedTargets),
      [["item:1"], ["item:2"], ["item:3"]],
    );
    const noteIds = [...native.notes.keys()];
    for (const [index, receipt] of receipts.entries()) {
      assert.equal(receipt.capability, "zotero.notes");
      assert.equal(receipt.operation, "note_create");
      assert.equal(receipt.verification, "verified");
      assert.equal(receipt.status, "applied");
      assert.match(receipt.id, /^journal:/);
      assert.include(
        receipt.verifiedFacts,
        `created_note:item:${noteIds[index]}`,
      );
    }
    assert.lengthOf(new Set(receipts.map((receipt) => receipt.id)), 3);
  });

  it("names no note that is no longer live, and no other run's", async function () {
    const [first] = [...native.notes.values()];
    first.deleted = true;

    const receipts = await journaledNoteReceipts({
      runId: "run-stopped-1",
      conversationKey: 51,
      getItem,
    });
    assert.deepEqual(
      receipts.map((receipt) => receipt.appliedTargets),
      [["item:2"], ["item:3"]],
    );
    assert.isEmpty(
      await journaledNoteReceipts({
        runId: "run-other",
        conversationKey: 51,
        getItem,
      }),
    );
    assert.isEmpty(
      await journaledNoteReceipts({
        runId: "run-stopped-1",
        conversationKey: 52,
        getItem,
      }),
    );
  });
});
