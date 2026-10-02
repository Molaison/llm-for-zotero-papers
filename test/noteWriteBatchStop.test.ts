import { assert } from "chai";
import { DatabaseSync } from "node:sqlite";
import { createNoteWriteBatchTool } from "../src/agent/tools/write/noteWriteBatch";
import {
  initAgentChangeJournal,
  listJournalActions,
} from "../src/agent/store/changeJournal";
import { initPlanDocumentStore } from "../src/agent/documents/store";
import {
  initAgentBatchItemStore,
  listBatchItems,
  listResumableBatches,
} from "../src/agent/store/batchItemStore";
import {
  getBatchJob,
  initAgentBatchJobStore,
} from "../src/agent/store/batchJobStore";
import type { AgentToolContext } from "../src/agent/types";
import { createTestActionContractService } from "./helpers/actionContractService";
import { installNativeNoteStore } from "./helpers/nativeNoteStore";

const globalScope = globalThis as typeof globalThis & { Zotero?: unknown };

const PAPERS = [1, 2, 3, 4, 5, 6];

/**
 * Stop between the notes of a batch.
 *
 * A batch writes its notes one at a time, each a journal step of its own, so
 * the user's Stop can take effect between two of them: the note in flight
 * lands, no further note starts, and what landed is proved by the call's
 * receipt.
 */
describe("note batch stopped by the user", function () {
  let db: DatabaseSync;
  let native: ReturnType<typeof installNativeNoteStore>;
  let originalZotero: unknown;
  let stop: AbortController;
  let saves: number;
  let stopAfterSaves: number | undefined;

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

  const gateway = {
    resolveLibraryID: () => 1,
    getItem,
    trashItems: async ({ itemIds }: { itemIds: number[] }) => ({
      trashedCount: itemIds.length,
      items: itemIds.map((itemId) => ({ itemId, status: "trashed" })),
    }),
  } as never;

  function context(): AgentToolContext {
    return {
      request: {
        conversationKey: 8901,
        libraryID: 1,
        metadata: { sourceMessageTimestamp: 100 },
      },
      runId: "run-batch-stop",
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
    stopAfterSaves = undefined;
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
      // The user presses Stop while this note is being written.
      onSave: () => {
        saves += 1;
        if (saves === stopAfterSaves) stop.abort();
      },
    });
    await initPlanDocumentStore();
    await initAgentBatchJobStore();
    await initAgentBatchItemStore();
    await initAgentChangeJournal();
  });

  afterEach(function () {
    native.restore();
    globalScope.Zotero = originalZotero as typeof Zotero;
    db.close();
  });

  async function preparedBatch(
    tool: ReturnType<typeof createNoteWriteBatchTool>,
  ) {
    const validation = tool.validate({
      notes: PAPERS.map((id) => ({
        targetItemId: id,
        content: `# Paper ${id}\n\nNote on paper ${id}.`,
      })),
    });
    assert.isTrue(validation.ok);
    if (!validation.ok) throw new Error("validation failed");
    await tool.planInvocation(validation.value, context());
    return validation.value;
  }

  it("starts no note after Stop: the note in flight lands and the rest stay resumable", async function () {
    const tool = createNoteWriteBatchTool(gateway);
    const input = await preparedBatch(tool);
    stopAfterSaves = 3;

    const output = await tool.execute(input, context());

    assert.equal(native.notes.size, 3, "three notes were written");
    assert.deepEqual(
      [...native.notes.values()].map((note) => note.parentID).sort(),
      [1, 2, 3],
    );
    assert.equal(output.effect, "partial");
    const payload = (
      output.content as { result: { result: Record<string, unknown> } }
    ).result.result;
    assert.equal(payload.createdCount, 3);
    assert.deepEqual(payload.stopped, { after: 3, of: 6 });
    assert.include(
      String((output.content as { stopped?: unknown }).stopped),
      "stopped this batch after 3 of 6 notes",
    );

    const batchId = output.batchItems![0].batchId;
    assert.deepEqual(
      (await listBatchItems(batchId)).map((row) => row.status),
      ["saved", "saved", "saved", "pending", "pending", "pending"],
      "the notes never started stay owed",
    );
    assert.deepEqual(
      (await listResumableBatches(8901)).map((entry) => entry.batchId),
      [batchId],
    );
    assert.equal((await getBatchJob(batchId))?.status, "cancelled");
    const [action] = await listJournalActions({ conversationKey: 8901 });
    assert.equal(action.status, "partially_applied");
    assert.deepEqual(
      action.steps.map((step) => step.status),
      ["applied", "applied", "applied"],
      "one journal step per note written, and none for a note never started",
    );
  });

  it("proves exactly the notes written with its receipt, and claims nothing for the rest", async function () {
    const tool = createNoteWriteBatchTool(gateway);
    const input = await preparedBatch(tool);
    const contracts = createTestActionContractService(getItem);
    const prepared = await contracts.prepare(tool, input, context());
    stopAfterSaves = 3;

    const output = await tool.execute(input, context());
    const receipts = await contracts.finalize(prepared, {
      ok: true,
      effect: output.effect,
      content: output.content,
      actionEvidence: output.actionEvidence,
    });

    assert.lengthOf(receipts, 1, "the batch is one proposal");
    const [receipt] = receipts;
    assert.equal(receipt.verification, "verified");
    assert.equal(receipt.status, "partial");
    assert.deepEqual(
      receipt.requestedTargets,
      PAPERS.map((id) => `item:${id}`),
    );
    assert.deepEqual(receipt.appliedTargets, ["item:1", "item:2", "item:3"]);
    assert.deepEqual(receipt.rejectedTargets, [], "nothing was refused");
    const noteIds = [...native.notes.keys()];
    assert.deepEqual(
      receipt.verifiedFacts.filter((fact) => fact.startsWith("created_note:")),
      noteIds.map((noteId) => `created_note:item:${noteId}`),
      "one created-note fact for each note written",
    );
    assert.lengthOf(
      receipt.verifiedFacts.filter((fact) => fact.startsWith("native_note:")),
      3,
      "one native read-back for each note written",
    );
    assert.include(
      receipt.reasons.join(" "),
      "Stopped by the user after 3 of 6",
    );
  });

  it("writes nothing when Stop came before its first note", async function () {
    const tool = createNoteWriteBatchTool(gateway);
    const input = await preparedBatch(tool);
    const contracts = createTestActionContractService(getItem);
    const prepared = await contracts.prepare(tool, input, context());
    stop.abort();

    const output = await tool.execute(input, context());
    const [receipt] = await contracts.finalize(prepared, {
      ok: true,
      effect: output.effect,
      content: output.content,
      actionEvidence: output.actionEvidence,
    });

    assert.equal(native.notes.size, 0);
    assert.equal(output.effect, "none");
    assert.deepEqual(receipt.appliedTargets, []);
    assert.deepEqual(receipt.rejectedTargets, []);
    assert.notEqual(receipt.status, "unverified");
  });
});
