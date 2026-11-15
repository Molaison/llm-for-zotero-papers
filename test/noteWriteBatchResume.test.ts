import { assert } from "chai";
import { rejects } from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createNoteWriteBatchTool } from "../src/agent/tools/write/noteWriteBatch";
import {
  initAgentChangeJournal,
  listJournalActions,
} from "../src/agent/store/changeJournal";
import {
  initPlanDocumentStore,
  loadPlanDocument,
} from "../src/agent/documents/store";
import {
  createBatchItems,
  initAgentBatchItemStore,
  listBatchItems,
  listResumableBatches,
} from "../src/agent/store/batchItemStore";
import {
  createBatchJob,
  initAgentBatchJobStore,
} from "../src/agent/store/batchJobStore";
import type { AgentToolContext } from "../src/agent/types";
import { installNativeNoteStore } from "./helpers/nativeNoteStore";

const globalScope = globalThis as typeof globalThis & { Zotero?: unknown };

/**
 * Continuing a batch of notes at the item that did not land.
 *
 * The durable rows say which of fifty notes were written; without a way to
 * hand the batch back to the tool, that record bought nothing -- the model
 * still had to author every body again to write the two that failed.
 */
describe("note batch resume", function () {
  let db: DatabaseSync;
  let native: ReturnType<typeof installNativeNoteStore>;
  let originalZotero: unknown;
  const failOnParents = new Set<number>();
  let unavailableTarget: number | undefined;
  /** Zotero goes away only once this many notes have landed. */
  let unavailableAfterNotes = 0;

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

  const targets = new Map([1, 2, 3].map((id) => [id, libraryItem(id)]));

  const gateway = {
    resolveLibraryID: () => 1,
    getItem: (id: number) => {
      if (
        unavailableTarget === id &&
        native.notes.size >= unavailableAfterNotes
      )
        throw new Error("Zotero is unavailable");
      return targets.get(id) || native.notes.get(id) || null;
    },
    trashItems: async ({ itemIds }: { itemIds: number[] }) => ({
      trashedCount: itemIds.length,
      items: itemIds.map((itemId) => ({ itemId, status: "trashed" })),
    }),
    formatStructuredCitations: () => ({
      styleId: "apa",
      styleTitle: "APA",
      locale: "en-US",
      clusters: [],
      bibliographyEntries: [],
    }),
  } as never;

  function context(runId = "run-batch-1"): AgentToolContext {
    return {
      request: {
        conversationKey: 8801,
        libraryID: 1,
        metadata: { sourceMessageTimestamp: 100 },
      },
      runId,
      item: null,
      currentAnswerText: "",
      modelName: "test-model",
    } as unknown as AgentToolContext;
  }

  function notes() {
    return [
      { targetItemId: 1, content: "Summary of paper one." },
      { targetItemId: 2, content: "## Findings\n\nSummary of paper two." },
      { targetItemId: 3, content: "Summary of paper three." },
    ];
  }

  beforeEach(async function () {
    originalZotero = globalScope.Zotero;
    failOnParents.clear();
    unavailableTarget = undefined;
    unavailableAfterNotes = 0;
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
      onSave: (note: { parentID?: number }) => {
        if (note.parentID !== undefined && failOnParents.has(note.parentID))
          throw new Error("Zotero refused the note write");
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

  function tool() {
    return createNoteWriteBatchTool(gateway);
  }

  type Tool = ReturnType<typeof createNoteWriteBatchTool>;

  /** Validate, prepare and run one call the way the host would. */
  async function run(
    instance: Tool,
    args: Record<string, unknown>,
    ctx = context(),
  ) {
    const validated = instance.validate(args);
    assert.isTrue(
      validated.ok,
      `validation failed for ${JSON.stringify(args)}`,
    );
    if (!validated.ok) throw new Error("unreachable");
    await instance.planInvocation(validated.value, ctx);
    return instance.execute(validated.value, ctx);
  }

  /** Every stored column of every batch row, for byte-identity assertions. */
  function rawItemRows(): unknown[] {
    return db
      .prepare(
        `SELECT * FROM llm_for_zotero_agent_batch_items ORDER BY batch_id, position`,
      )
      .all() as unknown[];
  }

  function documentCount(): number {
    const rows = db
      .prepare(`SELECT COUNT(*) AS total FROM llm_for_zotero_plan_documents`)
      .all() as Array<{ total: number }>;
    return Number(rows[0].total);
  }

  /**
   * A batch interrupted after one note: A written, B refused by Zotero, C
   * never attempted because the library became unreachable mid-batch.
   */
  async function interruptedBatch(instance: Tool): Promise<string> {
    const validated = instance.validate({ notes: notes() });
    assert.isTrue(validated.ok);
    if (!validated.ok) throw new Error("unreachable");
    await instance.planInvocation(validated.value, context());
    failOnParents.add(2);
    // The library becomes unreachable only after the first note has landed,
    // which is how a real interruption leaves later items never attempted.
    unavailableTarget = 3;
    unavailableAfterNotes = 1;
    await rejects(instance.execute(validated.value, context()));
    failOnParents.clear();
    unavailableTarget = undefined;
    unavailableAfterNotes = 0;
    const [batch] = await listResumableBatches(8801);
    assert.exists(batch, "the interrupted batch must be resumable");
    return batch.batchId;
  }

  it("continues at the items that did not land, writing nothing again", async function () {
    const instance = tool();
    const batchId = await interruptedBatch(instance);
    const before = await listBatchItems(batchId);
    assert.deepEqual(
      before.map((row) => row.status),
      ["saved", "failed", "pending"],
    );
    const savedNoteId = before[0].noteId!;
    const savedHtml = native.notes.get(savedNoteId).stored;
    const documentsBefore = documentCount();

    const output = await run(instance, { resumeBatchId: batchId });

    assert.equal(
      documentCount(),
      documentsBefore,
      "a resume finalizes nothing: every body is already stored",
    );
    const after = await listBatchItems(batchId);
    assert.deepEqual(
      after.map((row) => row.status),
      ["saved", "saved", "saved"],
    );
    assert.deepEqual(
      after.map((row) => row.materialRef),
      before.map((row) => row.materialRef),
      "the frozen material identities are unchanged",
    );
    assert.equal(after[0].noteId, savedNoteId, "the written note is untouched");
    assert.equal(native.notes.get(savedNoteId).stored, savedHtml);
    assert.equal(native.notes.size, 3, "exactly the two unwritten notes land");

    for (const row of after.slice(1)) {
      const document = await loadPlanDocument(row.materialRef!.documentId);
      assert.equal(
        native.notes.get(row.noteId!).stored,
        document!.visibleHtml,
        "each note carries exactly the material frozen before the interruption",
      );
    }
    assert.isEmpty(
      await listResumableBatches(8801),
      "a batch with every item written is no longer offered",
    );
    const payload = (
      output.content as { result: { result: Record<string, unknown> } }
    ).result.result;
    assert.equal(payload.createdCount, 2);
    assert.deepEqual(
      (output.batchItems || []).map((entry) => entry.status),
      ["saved", "saved", "saved"],
    );
    // All three rows are saved, but only two of them were saved by this call.
    // Anything presenting these as "what just happened" has to tell them apart.
    assert.deepEqual(
      (output.batchItems || []).map((entry) => entry.written),
      [false, true, true],
    );
  });

  it("continues the batch's own journal action while it is still open", async function () {
    const instance = tool();
    const batchId = await interruptedBatch(instance);
    const opened = (await listBatchItems(batchId))[0].actionId;
    assert.isString(opened);

    await run(instance, { resumeBatchId: batchId });

    const rows = await listBatchItems(batchId);
    assert.deepEqual(
      rows.map((row) => row.actionId),
      [opened, opened, opened],
      "every note of the batch stays one undoable action",
    );
    const actions = await listJournalActions({ conversationKey: 8801 });
    assert.deepEqual(
      actions.map((action) => action.actionId),
      [opened],
      "a resume opens no second action beside the batch's own",
    );
    // The action keeps the failed step of the first attempt beside the step
    // that finally wrote that note, so it is partially applied as a matter of
    // record even though every note now exists. The status describes the
    // action's steps; whether the batch still owes work is the rows' answer,
    // and they say it does not.
    assert.equal(actions[0].status, "partially_applied");
    assert.equal(actions[0].affectedCount, 3);
    assert.deepEqual(
      actions[0].steps.map((step) => step.sequence).sort(),
      [1, 2, 3, 4],
      "resumed steps continue the action's sequence instead of colliding",
    );
    assert.isEmpty(
      await listResumableBatches(8801),
      "the batch itself is finished, whatever its action's history says",
    );
  });

  it("never records the action as applied while an item can never be written", async function () {
    const instance = tool();
    const validated = instance.validate({
      notes: [
        { targetItemId: 1, content: "A fine note." },
        { targetItemId: 2, content: "Another fine note." },
        // Too large to finalize, so this item is seeded failed with no
        // material and never reaches a journal step at all.
        { targetItemId: 3, content: "x".repeat(2 * 1024 * 1024 + 16) },
      ],
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) throw new Error("unreachable");
    await instance.planInvocation(validated.value, context());
    failOnParents.add(2);
    await instance.execute(validated.value, context());
    failOnParents.clear();
    const batchId = (await listResumableBatches(8801))[0].batchId;
    assert.deepEqual(
      (await listBatchItems(batchId)).map((row) => row.status),
      ["saved", "failed", "failed"],
    );
    const opened = (await listBatchItems(batchId))[0].actionId!;

    // The resume writes item 2 and nothing else. Summarising only this call's
    // steps would rewrite the action as fully applied, while item 3 will
    // never be written and item 2's first attempt is still a failed step.
    await run(instance, { resumeBatchId: batchId });

    const rows = await listBatchItems(batchId);
    assert.deepEqual(
      rows.map((row) => row.status),
      ["saved", "saved", "failed"],
    );
    const [action] = await listJournalActions({ actionId: opened });
    assert.equal(action.status, "partially_applied");
    assert.equal(action.affectedCount, 2);
    assert.deepEqual(
      (await listResumableBatches(8801)).map((entry) => entry.batchId),
      [batchId],
      "an item nothing can write keeps the batch on offer",
    );
  });

  it("never records the action as applied while the user unchecks an item it still owes", async function () {
    const instance = tool();
    // An interruption that leaves no failed step of its own: note one landed
    // and the library became unreachable before note two was attempted, so
    // every step the action holds is applied.
    const validated = instance.validate({ notes: notes() });
    assert.isTrue(validated.ok);
    if (!validated.ok) throw new Error("unreachable");
    await instance.planInvocation(validated.value, context());
    unavailableTarget = 2;
    unavailableAfterNotes = 1;
    await rejects(instance.execute(validated.value, context()));
    unavailableTarget = undefined;
    unavailableAfterNotes = 0;
    const batchId = (await listResumableBatches(8801))[0].batchId;
    const before = await listBatchItems(batchId);
    assert.deepEqual(
      before.map((row) => row.status),
      ["saved", "pending", "pending"],
    );
    const opened = before[0].actionId!;
    assert.deepEqual(
      (await listJournalActions({ actionId: opened }))[0].steps.map(
        (step) => step.status,
      ),
      ["applied"],
      "no failed step is left to speak for the work the batch still owes",
    );

    // The resume card offers both outstanding notes; the user keeps one.
    const resumed = instance.validate({ resumeBatchId: batchId });
    assert.isTrue(resumed.ok);
    if (!resumed.ok) throw new Error("unreachable");
    await instance.planInvocation(resumed.value, context());
    const confirmed = instance.applyConfirmation?.(resumed.value, {
      writeNotesChecklist: ["2"],
    });
    assert.isTrue(confirmed?.ok);
    if (!confirmed?.ok) throw new Error("unreachable");
    await instance.execute(confirmed.value, context());

    const rows = await listBatchItems(batchId);
    assert.deepEqual(
      rows.map((row) => row.status),
      ["saved", "saved", "pending"],
      "the unchecked item keeps owing a note",
    );
    const [action] = await listJournalActions({ actionId: opened });
    // The rows still owe a note that this action would own. Recording it as
    // fully applied would tell every later reader the batch is finished.
    assert.equal(action.status, "partially_applied");
    assert.deepEqual(
      (await listResumableBatches(8801)).map((entry) => entry.batchId),
      [batchId],
      "the batch is still on offer, whatever the action says",
    );
  });

  it("keeps the action's applied work when the resume writes nothing", async function () {
    const instance = tool();
    const batchId = await interruptedBatch(instance);
    const opened = (await listBatchItems(batchId))[0].actionId!;

    // Zotero refuses both remaining notes, so each item fails on its own and
    // the call still completes.
    failOnParents.add(2).add(3);
    const output = await run(instance, { resumeBatchId: batchId });
    failOnParents.clear();

    assert.equal(
      output.effect,
      "none",
      "the result says what this call changed, which is nothing",
    );
    const [action] = await listJournalActions({ actionId: opened });
    // The action still holds the note the first attempt wrote. Recording it as
    // no_effect would put it beyond the reach of undo.
    assert.equal(action.status, "partially_applied");
    assert.equal(action.affectedCount, 1);
    assert.deepEqual(
      (await listBatchItems(batchId)).map((row) => row.status),
      ["saved", "failed", "failed"],
    );
  });

  it("opens a new action when the batch's action is no longer open", async function () {
    const instance = tool();
    const batchId = await interruptedBatch(instance);
    const opened = (await listBatchItems(batchId))[0].actionId!;
    // An undone batch's action is history: continuing it would hide the new
    // notes inside an action the journal has already marked reverted.
    db.prepare(
      `UPDATE llm_for_zotero_agent_journal_actions_v2 SET status = 'reverted' WHERE action_id = ?`,
    ).run(opened);

    await run(instance, { resumeBatchId: batchId });

    const rows = await listBatchItems(batchId);
    assert.equal(rows[0].actionId, opened, "the written note keeps its action");
    assert.notEqual(rows[1].actionId, opened);
    assert.equal(rows[1].actionId, rows[2].actionId);
    const actions = await listJournalActions({ conversationKey: 8801 });
    assert.lengthOf(actions, 2);
  });

  it("keeps the shape of the operation the batch was approved as", async function () {
    const instance = tool();
    const validated = instance.validate({
      target: "standalone",
      notes: [
        { targetItemId: 1, content: "Standalone one.", collections: [77] },
        { targetItemId: 2, content: "Standalone two.", collections: [88] },
      ],
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) throw new Error("unreachable");
    await instance.planInvocation(validated.value, context());
    unavailableTarget = 2;
    unavailableAfterNotes = 1;
    await rejects(instance.execute(validated.value, context()));
    unavailableTarget = undefined;
    unavailableAfterNotes = 0;
    const [batch] = await listResumableBatches(8801);

    await run(instance, { resumeBatchId: batch.batchId });

    const rows = await listBatchItems(batch.batchId);
    const note = native.notes.get(rows[1].noteId!);
    // A standalone note's collections are not in the frozen body; without the
    // job row remembering them, a resume would file the note nowhere.
    assert.isUndefined(note.parentID, "a standalone note has no parent");
    assert.deepEqual(note.collections, [88]);
  });

  it("writes a saved item again when its note no longer exists", async function () {
    const instance = tool();
    await run(instance, { notes: notes() });
    const [batchId] = [...new Set((await listJobIds()).values())];
    const before = await listBatchItems(batchId);
    assert.deepEqual(
      before.map((row) => row.status),
      ["saved", "saved", "saved"],
    );
    // The user deleted the note outside the agent. The row still claimed it.
    native.notes.delete(before[0].noteId!);

    const output = await run(instance, { resumeBatchId: batchId });

    const after = await listBatchItems(batchId);
    assert.notEqual(after[0].noteId, before[0].noteId, "the note is rewritten");
    assert.equal(after[0].status, "saved");
    assert.deepEqual(
      after.slice(1).map((row) => row.noteId),
      before.slice(1).map((row) => row.noteId),
      "the notes that still exist are left alone",
    );
    const document = await loadPlanDocument(after[0].materialRef!.documentId);
    assert.equal(
      native.notes.get(after[0].noteId!).stored,
      document!.visibleHtml,
    );
    const resume = (output.content as { resume: Record<string, unknown> })
      .resume;
    assert.deepEqual(resume.rewrittenItemKeys, ["item:1"]);
    assert.deepEqual(resume.skippedItemKeys, ["item:2", "item:3"]);
  });

  it("changes no durable row until the resume is authorized", async function () {
    const instance = tool();
    await run(instance, { notes: notes() });
    const [batchId] = [...new Set((await listJobIds()).values())];
    const before = await listBatchItems(batchId);
    native.notes.delete(before[0].noteId!);
    const rawBefore = rawItemRows();

    // Preparation is what builds the confirmation card. The user may still
    // cancel it, so nothing it discovers may be written to the rows yet.
    const validated = instance.validate({ resumeBatchId: batchId });
    assert.isTrue(validated.ok);
    if (!validated.ok) throw new Error("unreachable");
    await instance.planInvocation(validated.value, context());
    instance.createPendingAction?.(validated.value, context());

    assert.deepEqual(
      rawItemRows(),
      rawBefore,
      "a cancelled resume leaves the batch exactly as it was",
    );

    await instance.execute(validated.value, context());
    assert.notDeepEqual(
      rawItemRows(),
      rawBefore,
      "executing it is what corrects the row whose note is gone",
    );
  });

  it("never writes a pending item that has no finalized body", async function () {
    await createBatchJob({
      jobId: "batch-corrupt",
      conversationKey: 8801,
      action: "note_write_batch",
      input: {
        target: "item",
        notes: [
          { itemKey: "item:1", targetItemId: 1 },
          { itemKey: "item:2", targetItemId: 2 },
        ],
      },
      totalCount: 2,
      now: 1000,
    });
    await createBatchItems(
      "batch-corrupt",
      [
        {
          itemKey: "item:1",
          position: 1,
          materialRef: {
            documentId: "run-x:document:1",
            documentVersion: 1,
            contentHash: "sha256:gone",
          },
        },
        // A pending row with no material promises a body the batch cannot
        // produce. It must never reach a note write.
        { itemKey: "item:2", position: 2 },
      ],
      1000,
    );

    const instance = tool();
    const validated = instance.validate({ resumeBatchId: "batch-corrupt" });
    assert.isTrue(validated.ok);
    if (!validated.ok) throw new Error("unreachable");
    const rawBefore = rawItemRows();
    await instance.planInvocation(validated.value, context());
    // Every row is blocked, so this call needs no confirmation -- which is
    // exactly why preparation must not have written the failures already.
    assert.deepEqual(rawItemRows(), rawBefore);

    const output = await instance.execute(validated.value, context());

    assert.equal(native.notes.size, 0, "no note may be written");
    const rows = await listBatchItems("batch-corrupt");
    assert.deepEqual(
      rows.map((row) => row.status),
      ["failed", "failed"],
    );
    const resume = (
      output.content as {
        resume: { blocked: Array<{ itemKey: string; reason: string }> };
      }
    ).resume;
    assert.deepEqual(
      resume.blocked.map((entry) => entry.itemKey),
      ["item:1", "item:2"],
    );
    assert.include(resume.blocked[1].reason, "no finalized note body");
    assert.equal(output.effect, "none");
  });

  it("has nothing to continue once every item is written", async function () {
    const instance = tool();
    await run(instance, { notes: notes() });
    const [batchId] = [...new Set((await listJobIds()).values())];
    const before = await listBatchItems(batchId);

    const output = await run(instance, { resumeBatchId: batchId });

    assert.equal(native.notes.size, 3, "no note is written a second time");
    assert.deepEqual(
      (await listBatchItems(batchId)).map((row) => row.noteId),
      before.map((row) => row.noteId),
    );
    assert.equal(output.effect, "none");
  });

  it("refuses a batch it cannot safely continue", async function () {
    const instance = tool();
    await rejects(
      run(instance, { resumeBatchId: "batch-missing" }),
      /was not found/,
    );
    await createBatchJob({
      jobId: "batch-elsewhere",
      conversationKey: 9999,
      action: "note_write_batch",
      input: { target: "item", notes: [] },
      totalCount: 1,
      now: 1000,
    });
    await rejects(
      run(instance, { resumeBatchId: "batch-elsewhere" }),
      /another conversation/,
    );
    await createBatchJob({
      jobId: "batch-tagging",
      conversationKey: 8801,
      action: "auto_tag",
      input: {},
      totalCount: 1,
      now: 1000,
    });
    await rejects(
      run(instance, { resumeBatchId: "batch-tagging" }),
      /not a note batch/,
    );
  });

  it("asks for no note bodies when it is given a batch to continue", function () {
    const instance = tool();
    const resumed = instance.validate({ resumeBatchId: " batch-1 " });
    assert.isTrue(resumed.ok);
    if (resumed.ok) {
      assert.equal(resumed.value.resumeBatchId, "batch-1");
      assert.isUndefined(resumed.value.operation);
    }
    // Silently dropping fifty authored bodies is worse than refusing the call.
    const both = instance.validate({
      resumeBatchId: "batch-1",
      notes: notes(),
    });
    assert.isFalse(both.ok);
    assert.isFalse(instance.validate({}).ok);
  });

  async function listJobIds(): Promise<Set<string>> {
    const rows = db
      .prepare(`SELECT job_id AS jobId FROM llm_for_zotero_agent_batch_jobs`)
      .all() as Array<{ jobId: string }>;
    return new Set(rows.map((row) => row.jobId));
  }
});
