import { assert } from "chai";
import { AgentRuntime } from "../src/agent/runtime";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { createTaskUpdateTool } from "../src/agent/tools/control/taskUpdate";
import { createNoteWriteBatchTool } from "../src/agent/tools/write/noteWriteBatch";
import { ExecutionCheckpointFold } from "../src/agent/execution/checkpointEvents";
import { createEmptyExecutionCheckpoint } from "../src/agent/execution/checkpoint";
import { declareOutcomes } from "../src/agent/loop/outcomes";
import {
  appendAgentRunEvent,
  createAgentRun,
  INTERRUPTED_AGENT_RUN_MARKER,
} from "../src/agent/store/traceStore";
import { getConversationWriteGeneration } from "../src/shared/conversationWriteFence";
import { initPlanDocumentStore } from "../src/agent/documents/store";
import { clearAgentTranscriptStore } from "../src/agent/store/transcriptStore";
import { initAgentChangeJournal } from "../src/agent/store/changeJournal";
import {
  initAgentBatchItemStore,
  listResumableBatches,
} from "../src/agent/store/batchItemStore";
import { initAgentBatchJobStore } from "../src/agent/store/batchJobStore";
import {
  getOriginalAgentPermissionMode,
  setOriginalAgentPermissionMode,
} from "../src/agent/originalAgentPermissionMode";
import {
  installAgentStoreSqlite,
  installMockDb,
} from "./helpers/agentRuntimeMockDb";
import { installNativeNoteStore } from "./helpers/nativeNoteStore";
import { createTestActionContractService } from "./helpers/actionContractService";
import type { AgentStepParams } from "../src/agent/model/adapter";
import type { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import type {
  AgentEvent,
  AgentModelMessage,
  AgentModelStep,
  AgentRuntimeOutcome,
  AgentToolCall,
  ExecutionCheckpoint,
  ExecutionCheckpointTask,
} from "../src/agent/types";

/**
 * A note batch the user stopped, across the run that stopped and the
 * "continue" after it: what the batch wrote reaches the ledger before the
 * run settles, and "continue" writes only the rest.
 */

const PAPERS = [1, 2, 3, 4, 5, 6];
const NOTE_ALL = "Save a note on each paper";

type Turn = {
  outcome?: AgentRuntimeOutcome;
  error?: unknown;
  events: AgentEvent[];
  /** The ledger the turn held when its first model request was sent. */
  initialCheckpoint?: ExecutionCheckpoint;
};

function stepOf(...calls: AgentToolCall[]): AgentModelStep {
  return {
    kind: "tool_calls",
    calls,
    assistantMessage: { role: "assistant", content: "", tool_calls: calls },
  };
}

function finalStep(text: string): AgentModelStep {
  return {
    kind: "final",
    text,
    assistantMessage: { role: "assistant", content: text },
  };
}

const declareNotes: AgentToolCall = {
  id: "declare-1",
  name: "task_update",
  arguments: {
    tasks: [
      {
        taskId: "note-all",
        description: NOTE_ALL,
        expectedEffect: "mutation",
        expectedCapability: "zotero.notes",
        targetIds: PAPERS.map(String),
      },
    ],
  },
};

function batchOf(id: string, papers: number[]): AgentToolCall {
  return {
    id,
    name: "note_write_batch",
    arguments: {
      notes: papers.map((paper) => ({
        targetItemId: paper,
        content: `# Paper ${paper}\n\nNote on paper ${paper}.`,
      })),
    },
  };
}

function checkpoints(events: readonly AgentEvent[]): ExecutionCheckpoint[] {
  const fold = new ExecutionCheckpointFold();
  return events.flatMap((event) => {
    if (
      event.type !== "execution_checkpoint" &&
      event.type !== "execution_checkpoint_delta"
    )
      return [];
    const checkpoint = fold.apply(event);
    assert.exists(checkpoint, "every ledger event folds onto the one before");
    return [checkpoint!];
  });
}

function lastCheckpoint(turn: Turn): ExecutionCheckpoint {
  const all = checkpoints(turn.events);
  assert.isNotEmpty(all, "the run published its ledger");
  return all[all.length - 1];
}

function notePart(checkpoint: ExecutionCheckpoint): ExecutionCheckpointTask {
  const task = checkpoint.tasks.find(
    (entry) => entry.taskId === `${checkpoint.executionId}:task:note-all`,
  );
  assert.exists(task, "the declared note part");
  return task!;
}

function stopStatus(turn: Turn): unknown {
  const stop = turn.events.find(
    (event) =>
      event.type === "provider_event" &&
      event.providerType === "agent_run_stop",
  );
  return stop?.type === "provider_event" ? stop.payload?.status : undefined;
}

describe("a note batch the user stopped, in runtime turns", function () {
  let restoreDb: () => void;
  let restoreStores: () => void;
  let native: ReturnType<typeof installNativeNoteStore>;
  let originalToolkit: unknown;
  let previousMode: ReturnType<typeof getOriginalAgentPermissionMode>;
  let conversationKey = 997_000;
  let stop: AbortController | undefined;
  let saves = 0;
  let stopAfterSaves: number | undefined;
  let stopWhilePreparing = false;
  let timestamp = 0;

  const papers = new Map(
    PAPERS.map((id) => [
      id,
      {
        id,
        key: `PAPER${id}`,
        libraryID: 1,
        parentID: false,
        deleted: false,
        version: 1,
        dateModified: "2026-09-11 10:00:00",
        isRegularItem: () => true,
        isNote: () => false,
        isAttachment: () => false,
        getDisplayTitle: () => `Paper ${id}`,
        getField: () => "",
        getTags: () => [],
        getCollections: () => [],
        getAttachments: () => [],
        getNotes: () => [],
        async reload() {},
      },
    ]),
  );
  const getItem = (id: number) =>
    (papers.get(id) || native.notes.get(id) || null) as Zotero.Item | null;

  function registry(): AgentToolRegistry {
    const tools = new AgentToolRegistry(
      createTestActionContractService(getItem),
    );
    tools.register(
      createNoteWriteBatchTool({
        resolveLibraryID: () => 1,
        getItem: (id: number) => {
          // The user presses Stop while the batch is still being prepared.
          if (stopWhilePreparing) stop?.abort();
          return getItem(id);
        },
        getCollectionSummary: () => null,
      } as unknown as ZoteroGateway),
    );
    tools.register(createTaskUpdateTool());
    return tools;
  }

  async function runTurn(params: {
    userText: string;
    steps: Array<
      AgentModelStep | ((messages: AgentModelMessage[]) => AgentModelStep)
    >;
    signal?: AbortSignal;
  }): Promise<Turn> {
    const events: AgentEvent[] = [];
    let initialCheckpoint: ExecutionCheckpoint | undefined;
    let requests = 0;
    const runtime = new AgentRuntime({
      registry: registry(),
      adapterFactory: () => ({
        getCapabilities: () => ({
          streaming: false,
          toolCalls: true,
          multimodal: false,
        }),
        supportsTools: () => true,
        async runStep(stepParams: AgentStepParams): Promise<AgentModelStep> {
          if (requests === 0 && stepParams.request.executionCheckpoint)
            initialCheckpoint = structuredClone(
              stepParams.request.executionCheckpoint,
            );
          const step = params.steps[requests];
          requests += 1;
          if (!step)
            throw new Error(
              `The script ends at ${params.steps.length} steps; the model was asked for step ${requests}.`,
            );
          return typeof step === "function" ? step(stepParams.messages) : step;
        },
      }),
    });
    let outcome: AgentRuntimeOutcome | undefined;
    let error: unknown;
    timestamp += 100;
    try {
      outcome = await runtime.runTurn({
        request: {
          conversationKey,
          mode: "agent",
          userText: params.userText,
          libraryID: 1,
          model: "test",
          apiKey: "test",
          apiBase: "https://example.invalid",
          metadata: { sourceMessageTimestamp: timestamp },
        },
        signal: params.signal,
        onEvent: (event) => {
          events.push(event);
        },
      });
    } catch (caught) {
      error = caught;
    }
    return { outcome, error, events, initialCheckpoint };
  }

  /** Turn 1: declare the part, then one batch over every paper, stopped. */
  async function stoppedBatch(afterNotes: number): Promise<Turn> {
    stop = new AbortController();
    stopAfterSaves = afterNotes;
    return runTurn({
      userText: "Save a short note on each of these six papers",
      signal: stop.signal,
      steps: [stepOf(declareNotes), stepOf(batchOf("batch-1", PAPERS))],
    });
  }

  beforeEach(async function () {
    conversationKey += 10;
    saves = 0;
    stopAfterSaves = undefined;
    stopWhilePreparing = false;
    clearAgentTranscriptStore();
    restoreDb = installMockDb();
    restoreStores = installAgentStoreSqlite();
    native = installNativeNoteStore({
      startId: 500,
      // The user presses Stop while this note is being written.
      onSave: () => {
        saves += 1;
        if (saves === stopAfterSaves) stop?.abort();
      },
    });
    const zotero = globalThis.Zotero as unknown as Record<string, any>;
    zotero.Items = {
      get: (id: number) => getItem(id),
      getByLibraryAndKey: (libraryID: number, key: string) =>
        [...papers.values(), ...native.notes.values()].find(
          (entry: any) => entry.libraryID === libraryID && entry.key === key,
        ) || null,
    };
    zotero.Libraries = { userLibraryID: 1 };
    originalToolkit = (globalThis as any).ztoolkit;
    (globalThis as any).ztoolkit = { log: () => undefined };
    previousMode = getOriginalAgentPermissionMode();
    setOriginalAgentPermissionMode("auto");
    await initPlanDocumentStore();
    await initAgentBatchJobStore();
    await initAgentBatchItemStore();
    await initAgentChangeJournal();
  });

  afterEach(function () {
    setOriginalAgentPermissionMode(previousMode);
    (globalThis as any).ztoolkit = originalToolkit;
    native.restore();
    restoreStores();
    restoreDb();
  });

  it("records what the batch wrote before the run ends: the part shows 3 done", async function () {
    const turn = await stoppedBatch(3);

    assert.equal(stopStatus(turn), "cancelled", String(turn.error));
    assert.equal(
      native.notes.size,
      3,
      "the batch stopped after its third note",
    );
    const result = turn.events.find(
      (event) =>
        event.type === "tool_result" && event.name === "note_write_batch",
    );
    assert.exists(result, "the stopped batch's result is announced");
    if (result?.type === "tool_result") {
      assert.isTrue(result.ok);
      const [receipt] = result.actionReceipts || [];
      assert.equal(receipt?.status, "partial");
      assert.deepEqual(receipt?.appliedTargets, ["item:1", "item:2", "item:3"]);
    }
    const ledger = lastCheckpoint(turn);
    assert.deepEqual(ledger.end, { state: "cancelled" });
    const part = notePart(ledger);
    assert.equal(part.status, "pending");
    assert.deepEqual(part.doneTargets, ["item:1", "item:2", "item:3"]);
    assert.notProperty(part, "exceptions", "nothing was refused");
  });

  it("records nothing for a batch Stop kept from starting: no note, and no paper excepted", async function () {
    stop = new AbortController();
    stopWhilePreparing = true;
    const turn = await runTurn({
      userText: "Save a short note on each of these six papers",
      signal: stop.signal,
      steps: [stepOf(declareNotes), stepOf(batchOf("batch-1", PAPERS))],
    });

    assert.equal(stopStatus(turn), "cancelled", String(turn.error));
    assert.equal(native.notes.size, 0, "the batch never started");
    assert.notExists(
      turn.events.find(
        (event) =>
          event.type === "tool_result" && event.name === "note_write_batch",
      ),
      "a call that never ran announces no result",
    );
    const part = notePart(lastCheckpoint(turn));
    assert.equal(part.status, "pending", "the part stays owed");
    assert.notProperty(part, "doneTargets");
    assert.notProperty(
      part,
      "exceptions",
      "no paper is excepted for a write that never ran",
    );
  });

  it("continues with only the rest: nothing applied twice, the resumed batch writes three notes", async function () {
    await stoppedBatch(3);
    const [batch] = await listResumableBatches(conversationKey);
    assert.exists(batch, "the stopped batch is resumable");
    assert.equal(batch.pending, 3);
    const batchId = batch.batchId;

    const resumed = await runTurn({
      userText: "continue",
      steps: [
        stepOf({
          id: "batch-2",
          name: "note_write_batch",
          arguments: { resumeBatchId: batchId },
        }),
        finalStep("Every paper has its note."),
      ],
    });

    assert.equal(resumed.outcome?.kind, "completed", String(resumed.error));
    // The ledger the turn resumed already held the three notes; the journal
    // that also records them added nothing to it.
    const initial = resumed.initialCheckpoint;
    assert.exists(initial, "continue resumed the stopped ledger");
    const restored = notePart(initial!);
    assert.deepEqual(restored.doneTargets, ["item:1", "item:2", "item:3"]);
    assert.lengthOf(restored.receiptIds || [], 1, "one receipt, applied once");
    assert.lengthOf(initial!.tasks, 1, "no host part for a known write");

    assert.equal(native.notes.size, 6, "one note a paper, none twice");
    const ledger = lastCheckpoint(resumed);
    assert.deepEqual(ledger.end, { state: "completed" });
    const part = notePart(ledger);
    assert.equal(part.status, "completed");
    assert.deepEqual(
      [...(part.doneTargets || [])].sort(),
      PAPERS.map((id) => `item:${id}`).sort(),
    );
  });

  it("after Zotero quit mid-batch, the resumed ledger takes the notes the journal records, once", async function () {
    // What a quit leaves: a run still marked running at exit (the startup
    // sweep then marks it interrupted), its ledger as last published, with
    // no receipt for the notes the batch had written, and those notes in
    // the change journal.
    const runId = "run-quit-1";
    const ledger = declareOutcomes(
      createEmptyExecutionCheckpoint(
        {
          executionId: runId,
          conversationKey,
          conversationGeneration:
            getConversationWriteGeneration(conversationKey),
        } as never,
        1,
      ),
      [
        {
          taskId: "note-all",
          description: NOTE_ALL,
          effect: "mutation",
          capability: "zotero.notes",
          targets: PAPERS.map(String),
        },
      ],
      2,
    );
    await createAgentRun({
      runId,
      conversationKey,
      mode: "agent",
      model: "test",
      status: "failed",
      createdAt: 1,
      completedAt: 2,
      finalText: INTERRUPTED_AGENT_RUN_MARKER,
    });
    await appendAgentRunEvent(runId, 1, {
      type: "execution_checkpoint",
      checkpoint: ledger,
    });
    stop = new AbortController();
    stopAfterSaves = 3;
    const batch = registry().getTool("note_write_batch")!;
    const call = batch.validate({
      notes: PAPERS.map((paper) => ({
        targetItemId: paper,
        content: `# Paper ${paper}\n\nNote on paper ${paper}.`,
      })),
    });
    if (!call.ok) throw new Error("validation failed");
    const batchContext = {
      request: {
        conversationKey,
        libraryID: 1,
        metadata: { sourceMessageTimestamp: 1 },
      },
      runId,
      item: null,
      currentAnswerText: "",
      modelName: "test",
      signal: stop.signal,
    } as never;
    await batch.planInvocation!(call.value, batchContext);
    await batch.execute(call.value, batchContext);
    assert.equal(native.notes.size, 3);
    const [stopped] = await listResumableBatches(conversationKey);

    const resumed = await runTurn({
      userText: "continue",
      steps: [
        stepOf({
          id: "batch-2",
          name: "note_write_batch",
          arguments: { resumeBatchId: stopped.batchId },
        }),
        finalStep("Every paper has its note."),
      ],
    });

    assert.equal(resumed.outcome?.kind, "completed", String(resumed.error));
    const initial = resumed.initialCheckpoint;
    assert.exists(initial, "the interrupted ledger was restored");
    const restored = notePart(initial!);
    assert.deepEqual(restored.doneTargets, ["item:1", "item:2", "item:3"]);
    assert.lengthOf(restored.receiptIds || [], 3, "one receipt per note");
    for (const id of restored.receiptIds || []) assert.match(id, /^journal:/);
    assert.lengthOf(initial!.tasks, 1);

    assert.equal(native.notes.size, 6, "the resume wrote only the rest");
    const settled = lastCheckpoint(resumed);
    assert.deepEqual(settled.end, { state: "completed" });
    assert.equal(notePart(settled).status, "completed");
  });
});
