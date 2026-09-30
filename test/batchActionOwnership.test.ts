import { assert } from "chai";
import { rejects } from "node:assert/strict";
import { MutationNoEffectError } from "../src/agent/services/externalMutationCoordinator";
import { LibraryMutationService } from "../src/agent/services/libraryMutationService";
import { executeLibraryMutationAction } from "../src/agent/services/mutationCoordinator";
import { initAgentChangeJournal } from "../src/agent/store/changeJournal";
import { createUndoTool } from "../src/agent/tools/write/undo";
import {
  getActiveMutationActionId,
  withActiveMutationAction,
} from "../src/services/mutationActionContext";
import type { AgentToolContext } from "../src/agent/types";
import { ChangeJournalTestDb } from "./helpers/changeJournalTestDb";
import { installNativeNoteStore } from "./helpers/nativeNoteStore";

/** Fail fast instead of hanging mocha when the native write queue deadlocks. */
async function withDeadline<T>(work: Promise<T>, reason: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(reason)), 100);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe("native mutation window ownership", function () {
  it("runs a nested acquire by the owning action inline", async function () {
    const order: string[] = [];
    const composite = withActiveMutationAction("action-owner", async () => {
      order.push("outer-start");
      await withActiveMutationAction("action-owner", async () => {
        order.push(`inner:${getActiveMutationActionId()}`);
      });
      order.push("outer-end");
    });

    await withDeadline(
      composite,
      "a nested acquire by the owning action deadlocked",
    );

    assert.deepEqual(order, ["outer-start", "inner:action-owner", "outer-end"]);
  });

  it("still serializes an acquire from a different owner", async function () {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = withActiveMutationAction("action-first", async () => {
      order.push("first-start");
      await gate;
      order.push("first-end");
    });
    const second = withActiveMutationAction("action-second", async () => {
      order.push("second");
    });

    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(order, ["first-start"]);

    release();
    await Promise.all([first, second]);
    assert.deepEqual(order, ["first-start", "first-end", "second"]);
  });

  it("does not treat an unowned acquire as reentrant", async function () {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = withActiveMutationAction(null, async () => {
      order.push("first-start");
      await gate;
      order.push("first-end");
    });
    const second = withActiveMutationAction(null, async () => {
      order.push("second");
    });

    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(order, ["first-start"]);

    release();
    await Promise.all([first, second]);
    assert.deepEqual(order, ["first-start", "first-end", "second"]);
  });
});

describe("note batch journal ownership", function () {
  const originalZotero = globalThis.Zotero;
  let db: ChangeJournalTestDb;
  let native: ReturnType<typeof installNativeNoteStore>;
  let trashed: number[][];

  const context = {
    request: { conversationKey: 77, libraryID: 1 },
    runId: "run-batch",
    item: null,
    currentAnswerText: "",
    modelName: "test-model",
  } as AgentToolContext;

  function target(id: number) {
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

  const targets = new Map([1, 2, 3].map((id) => [id, target(id)]));

  function gateway() {
    return {
      resolveLibraryID: () => 1,
      getItem: (id: number) => targets.get(id) || native.notes.get(id) || null,
      trashItems: async ({ itemIds }: { itemIds: number[] }) => {
        trashed.push([...itemIds]);
        for (const itemId of itemIds) {
          const note = native.notes.get(itemId);
          if (note) note.deleted = true;
        }
        return {
          trashedCount: itemIds.length,
          items: itemIds.map((itemId) => ({ itemId, status: "trashed" })),
        };
      },
    };
  }

  function notesBatch(count: number) {
    return {
      type: "save_notes_batch" as const,
      notes: Array.from({ length: count }, (_, index) => ({
        targetItemId: index + 1,
        content: `Summary ${index + 1}`,
      })),
    };
  }

  function orderedSteps() {
    return [...db.steps.values()].sort(
      (left, right) => Number(left.sequence_no) - Number(right.sequence_no),
    );
  }

  function inverseItemIds(step: Record<string, unknown>): number[][] {
    const inverse = step.inverse_json
      ? (JSON.parse(String(step.inverse_json)) as {
          operations?: Array<{ itemIds?: number[] }>;
        })
      : null;
    return (inverse?.operations || []).map((operation) => [
      ...(operation.itemIds || []),
    ]);
  }

  function install(onSave?: (note: { parentID?: number }) => void) {
    db = new ChangeJournalTestDb();
    globalThis.Zotero = { DB: db, debug: () => undefined } as never;
    native = installNativeNoteStore({ startId: 500, onSave });
    trashed = [];
    return initAgentChangeJournal();
  }

  afterEach(function () {
    globalThis.Zotero = originalZotero;
  });

  it("records one action with one step per note", async function () {
    await install();
    const service = new LibraryMutationService(gateway() as never);

    const outcome = await withDeadline(
      executeLibraryMutationAction({
        service,
        operations: [notesBatch(3)],
        context,
        facadeToolName: "note_write_batch",
      }),
      "the note batch deadlocked on the native write queue",
    );

    assert.equal(outcome.effect, "applied");
    assert.lengthOf([...db.actions.values()], 1);
    const action = [...db.actions.values()][0];
    assert.equal(action.tool_name, "note_write_batch");
    assert.equal(action.status, "applied");
    assert.equal(action.reversibility, "full");
    assert.equal(action.affected_count, 3);

    const steps = orderedSteps();
    assert.lengthOf(steps, 3);
    assert.deepEqual(
      steps.map((step) => step.action_id),
      [action.action_id, action.action_id, action.action_id],
    );
    assert.deepEqual(
      steps.map((step) => Number(step.sequence_no)),
      [1, 2, 3],
    );
    assert.deepEqual(
      steps.map((step) => step.operation),
      ["create_note", "create_note", "create_note"],
    );
    assert.deepEqual(
      steps.map((step) => step.status),
      ["applied", "applied", "applied"],
    );
    // One inverse per note, and no whole-batch inverse anywhere.
    assert.deepEqual(steps.map(inverseItemIds), [[[500]], [[501]], [[502]]]);
    assert.equal(outcome.results[0]?.result?.createdCount, 3);
  });

  it("records a failed note as a failed step and the batch as partially applied", async function () {
    await install((note) => {
      if (note.parentID === 2) throw new Error("native note save failed");
    });
    const service = new LibraryMutationService(gateway() as never);

    const outcome = await withDeadline(
      executeLibraryMutationAction({
        service,
        operations: [notesBatch(3)],
        context,
        facadeToolName: "note_write_batch",
      }),
      "the note batch deadlocked on the native write queue",
    );

    assert.equal(outcome.effect, "partial");
    const action = [...db.actions.values()][0];
    assert.equal(action.status, "partially_applied");

    const steps = orderedSteps();
    assert.lengthOf(steps, 3);
    assert.deepEqual(
      steps.map((step) => step.status),
      ["applied", "failed", "applied"],
    );
    assert.match(String(steps[1].error_text), /native note save failed/);
    assert.deepEqual(inverseItemIds(steps[0]), [[500]]);
    assert.deepEqual(inverseItemIds(steps[2]), [[502]]);
    assert.equal(outcome.results[0]?.result?.createdCount, 2);
    assert.equal(outcome.results[0]?.result?.failedCount, 1);
  });

  it("undoes every note of the batch and finds nothing on a second undo", async function () {
    await install();
    const service = new LibraryMutationService(gateway() as never);
    await executeLibraryMutationAction({
      service,
      operations: [notesBatch(3)],
      context,
      facadeToolName: "note_write_batch",
    });
    const actionId = String([...db.actions.values()][0].action_id);

    const tool = createUndoTool(gateway() as never);
    const undone = await tool.execute!({}, context);

    assert.equal(
      (undone.content as { status?: string; actionId?: string }).status,
      "undone",
    );
    assert.equal((undone.content as { actionId?: string }).actionId, actionId);
    // Steps are reverted newest-first, one durable inverse each.
    assert.deepEqual(trashed, [[502], [501], [500]]);
    assert.equal(db.actions.get(actionId)?.status, "reverted");

    const again = await tool.execute!({}, context);
    assert.equal(
      (again.content as { status?: string }).status,
      "nothing_reversible",
    );
  });

  it("keeps the notes that landed on the action when the batch itself throws", async function () {
    await install();
    // A library read that fails between two notes sits outside the per-note
    // guard, so the whole operation throws after the first note committed.
    // It reads cleanly while the batch is still being planned.
    const failing = {
      ...gateway(),
      getItem: (id: number) => {
        if (id === 2 && native.notes.size > 0)
          throw new Error("the library read failed");
        return targets.get(id) || native.notes.get(id) || null;
      },
    };
    const service = new LibraryMutationService(failing as never);

    await rejects(
      executeLibraryMutationAction({
        service,
        operations: [notesBatch(3)],
        context,
        facadeToolName: "note_write_batch",
      }),
      /the library read failed/,
    );

    const action = [...db.actions.values()][0];
    const actionId = String(action.action_id);
    assert.equal(action.status, "partially_applied");
    assert.equal(action.affected_count, 1);
    const steps = orderedSteps();
    assert.lengthOf(steps, 1);
    assert.equal(steps[0].status, "applied");
    assert.deepEqual(inverseItemIds(steps[0]), [[500]]);

    // The note that did land is still undoable from the batch action.
    const tool = createUndoTool(gateway() as never);
    await tool.execute!({}, context);
    assert.deepEqual(trashed, [[500]]);
    assert.equal(db.actions.get(actionId)?.status, "reverted");
  });

  it("keeps a provably empty batch failed rather than uncertain", async function () {
    await install();
    const service = {
      planOperation: async () => ({
        effect: "write" as const,
        reversibility: "full" as const,
        description: "write notes",
      }),
      executeOperation: async () => {
        throw new MutationNoEffectError("no note target was writable");
      },
      captureOperationState: async () => ({
        version: 1,
        operation: "save_notes_batch",
      }),
    };

    await rejects(
      executeLibraryMutationAction({
        service: service as never,
        operations: [notesBatch(1)],
        context,
        facadeToolName: "note_write_batch",
      }),
      (error: unknown) =>
        error instanceof MutationNoEffectError &&
        /no note target was writable/.test(error.message),
    );

    assert.equal([...db.actions.values()][0].status, "failed");
  });
});
