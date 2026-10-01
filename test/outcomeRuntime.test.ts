import { assert } from "chai";
import { DatabaseSync } from "node:sqlite";
import { AgentRuntime } from "../src/agent/runtime";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { createSubmitDocumentTool } from "../src/agent/tools/control/submitDocument";
import { createTaskUpdateTool } from "../src/agent/tools/control/taskUpdate";
import { createNoteWriteTool } from "../src/agent/tools/write/noteWrite";
import { OUTCOME_REASONS } from "../src/agent/loop/outcomes";
import { ExecutionCheckpointFold } from "../src/agent/execution/checkpointEvents";
import type { TaskPaperScopeSet } from "../src/agent/context/taskPaperScopeListing";
import { createTestActionContractService } from "./helpers/actionContractService";
import {
  PARENT_ITEM_ID,
  finalStep,
  installDirectJourneyEnvironment,
  toolCallStep,
  type DirectJourneyEnvironment,
} from "./helpers/materialJourneys";
import type { AgentStepParams } from "../src/agent/model/adapter";
import type { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import type {
  AgentActionReceipt,
  AgentEvent,
  AgentModelMessage,
  AgentModelStep,
  AgentRuntimeOutcome,
  AgentRuntimeRequest,
  AgentRuntimeRequestInput,
  AgentToolCall,
  ExecutionCheckpoint,
  ExecutionCheckpointTask,
} from "../src/agent/types";

/**
 * The outcome ledger inside real turns.
 *
 * Each case scripts the model's steps against the runtime, the note tool and
 * the action-contract service, and reads what the run published: the
 * `execution_checkpoint` events, the settled end state, and how many model
 * requests the turn cost.
 */

const SAVE = "Save the summary as a note on the paper";
const SUMMARY = "# Summary\n\nA complete summary of the paper.";
const TEN_ITEMS = Array.from({ length: 10 }, (_, index) => `item:${index + 1}`);

const submitDocumentGateway = {
  formatStructuredCitations: () => ({
    styleId: "apa",
    styleTitle: "APA",
    locale: "en-US",
    clusters: [],
    bibliographyEntries: [],
  }),
} as unknown as ZoteroGateway;

type ScriptStep =
  | AgentModelStep
  | ((messages: AgentModelMessage[]) => AgentModelStep);

type Turn = {
  outcome?: AgentRuntimeOutcome;
  error?: unknown;
  events: AgentEvent[];
  prompts: AgentModelMessage[][];
  request?: AgentRuntimeRequest;
  /** Model requests the turn made. */
  requests: number;
  /** The ledger the turn held when its first model request was sent. */
  initialCheckpoint?: ExecutionCheckpoint;
};

/** The receipt the scripted `library_update` call is finalized with. */
let libraryUpdateReceipt: AgentActionReceipt | undefined;

/** What the scripted `paper_read` returns, when a case scripts it. */
let scriptedPaperRead:
  | ((input: Record<string, unknown>) => unknown)
  | undefined;

function stepOf(...calls: AgentToolCall[]): AgentModelStep {
  return {
    kind: "tool_calls",
    calls,
    assistantMessage: { role: "assistant", content: "", tool_calls: calls },
  };
}

function declare(id: string, tasks: Record<string, unknown>[]): AgentToolCall {
  return { id, name: "task_update", arguments: { tasks } };
}

const saveDeclaration = {
  taskId: "save",
  description: SAVE,
  expectedEffect: "mutation",
  expectedCapability: "zotero.notes",
  targetIds: [String(PARENT_ITEM_ID)],
};

function noteWrite(id: string): AgentToolCall {
  return {
    id,
    name: "note_write",
    arguments: {
      mode: "create",
      content: SUMMARY,
      targetItemId: PARENT_ITEM_ID,
    },
  };
}

function paperRead(id: string): AgentToolCall {
  return { id, name: "paper_read", arguments: { itemId: PARENT_ITEM_ID } };
}

function registry(): AgentToolRegistry {
  const service = createTestActionContractService(
    (itemId) => (globalThis.Zotero as any).Items.get(itemId) || null,
  );
  const finalize = service.finalize.bind(service);
  service.finalize = (async (prepared, params) =>
    libraryUpdateReceipt &&
    prepared.proposals.some((proposal) => proposal.id === "library-update")
      ? [libraryUpdateReceipt]
      : finalize(prepared, params)) as typeof service.finalize;
  const tools = new AgentToolRegistry(service);
  tools.register(createSubmitDocumentTool(submitDocumentGateway));
  tools.register(
    createNoteWriteTool({
      getItem: (itemId: number) => (globalThis.Zotero as any).Items.get(itemId),
      getCollectionSummary: () => null,
    } as unknown as ZoteroGateway),
  );
  tools.register(createTaskUpdateTool());
  tools.register({
    spec: {
      name: "paper_read",
      description: "Read one paper",
      inputSchema: { type: "object" },
      executionClass: "read",
      workCategory: "retrieval",
    },
    validate: (args: unknown) => ({ ok: true, value: args as never }),
    execute: async (input: Record<string, unknown>) =>
      scriptedPaperRead?.(input) ?? {
        mode: "targeted",
        results: [],
        papers: [
          {
            paperContext: {
              itemId: PARENT_ITEM_ID,
              contextItemId: PARENT_ITEM_ID,
              libraryID: 1,
            },
            passages: [{ text: "Place cells drift.", sectionLabel: "Results" }],
          },
        ],
      },
  } as never);
  tools.register({
    spec: {
      name: "run_command",
      description: "Run a shell command",
      inputSchema: { type: "object" },
      executionClass: "external_effect",
    },
    describeAction: () => [
      {
        id: "command_execute:fnv1a32:00000001",
        proofDomain: "execution",
        capability: "command.execute",
        operation: "command_execute",
        source: "command",
        requestedTargets: [],
        destinationCollectionIds: [],
      },
    ],
    effectOperations: ["command_execute"],
    validate: (args: unknown) => ({ ok: true, value: args as never }),
    execute: async () => ({
      content: { stdout: "converted", exitCode: 0 },
      effect: "applied",
    }),
  } as never);
  tools.register({
    spec: {
      name: "library_update",
      description: "Update Zotero items",
      inputSchema: { type: "object" },
      executionClass: "external_effect",
    },
    describeAction: () => [
      {
        id: "library-update",
        proofDomain: "zotero_state",
        capability: "zotero.metadata",
        operation: "update_metadata",
        source: "library_mutation",
        requestedTargets: TEN_ITEMS,
        destinationCollectionIds: [],
      },
    ],
    effectOperations: ["update_metadata"],
    validate: (args: unknown) => ({ ok: true, value: args as never }),
    execute: async () => ({
      content: { updated: 8, failed: 2 },
      effect: "partial",
    }),
  } as never);
  return tools;
}

function libraryReceipt(
  overrides: Partial<AgentActionReceipt>,
): AgentActionReceipt {
  return {
    version: 2,
    id: "library-update:receipt",
    proposalId: "library-update",
    proofDomain: "zotero_state",
    capability: "zotero.metadata",
    operation: "update_metadata",
    verification: "verified",
    status: "partial",
    requestedTargets: TEN_ITEMS,
    appliedTargets: TEN_ITEMS.slice(0, 8),
    alreadySatisfiedTargets: [],
    rejectedTargets: TEN_ITEMS.slice(8),
    reasons: ["In a group library you cannot edit"],
    verifiedFacts: [],
    ...overrides,
  };
}

let timestamp = 0;

async function runTurn(params: {
  conversationKey: number;
  userText: string;
  steps: ScriptStep[];
  approve?: boolean;
  signal?: AbortSignal;
  /** The papers the host resolves for the turn's scope. */
  scope?: TaskPaperScopeSet;
  /** Counts each time the host resolves the scope. */
  onResolveScope?: () => void;
  /** Contexts the user attached to the question. */
  attached?: Pick<
    AgentRuntimeRequestInput,
    "selectedPaperContexts" | "selectedCollectionContexts"
  >;
}): Promise<Turn> {
  const events: AgentEvent[] = [];
  const prompts: AgentModelMessage[][] = [];
  let request: AgentRuntimeRequest | undefined;
  let initialCheckpoint: ExecutionCheckpoint | undefined;
  let requests = 0;
  const runtime = new AgentRuntime({
    ...(params.scope
      ? {
          resolveTurnScopePapers: async () => {
            params.onResolveScope?.();
            return params.scope;
          },
        }
      : {}),
    registry: registry(),
    adapterFactory: (resolved) => ({
      getCapabilities: () => ({
        streaming: false,
        toolCalls: true,
        multimodal: false,
      }),
      supportsTools: () => true,
      async runStep(stepParams: AgentStepParams): Promise<AgentModelStep> {
        request = resolved;
        if (requests === 0 && resolved.executionCheckpoint)
          initialCheckpoint = structuredClone(resolved.executionCheckpoint);
        prompts.push(stepParams.messages);
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
        conversationKey: params.conversationKey,
        mode: "agent",
        userText: params.userText,
        libraryID: 1,
        model: "test",
        apiKey: "test",
        apiBase: "https://example.invalid",
        metadata: { sourceMessageTimestamp: timestamp },
        ...params.attached,
      },
      signal: params.signal,
      onEvent: (event) => {
        events.push(event);
        if (event.type === "confirmation_required")
          runtime.resolveConfirmation(
            event.requestId,
            params.approve !== false,
          );
      },
    });
  } catch (caught) {
    error = caught;
  }
  return {
    outcome,
    error,
    events,
    prompts,
    request,
    requests,
    initialCheckpoint,
  };
}

/** The ledger after each of the run's ledger events, whole or delta. */
function checkpoints(turn: Turn): ExecutionCheckpoint[] {
  const fold = new ExecutionCheckpointFold();
  return turn.events.flatMap((event) => {
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

function settled(turn: Turn): ExecutionCheckpoint {
  const all = checkpoints(turn);
  assert.isNotEmpty(all, "the run published its ledger");
  const last = all[all.length - 1];
  assert.exists(last.end, "the last checkpoint carries the end state");
  return last;
}

function outcome(
  checkpoint: ExecutionCheckpoint | undefined,
  local: string,
): ExecutionCheckpointTask {
  const task = checkpoint?.tasks.find(
    (entry) => entry.taskId === `${checkpoint.executionId}:task:${local}`,
  );
  assert.exists(task, `outcome ${local}`);
  return task!;
}

function stopIndex(turn: Turn): number {
  return turn.events.findIndex(
    (event) =>
      event.type === "provider_event" &&
      event.providerType === "agent_run_stop",
  );
}

function stopStatus(turn: Turn): unknown {
  const stop = turn.events[stopIndex(turn)];
  return stop?.type === "provider_event" ? stop.payload?.status : undefined;
}

function receiptIdsOf(turn: Turn, toolName: string): string[] {
  return turn.events.flatMap((event) =>
    event.type === "tool_result" && event.name === toolName
      ? (event.actionReceipts || []).map((receipt) => receipt.id)
      : [],
  );
}

function promptText(messages: AgentModelMessage[]): string {
  return messages
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content),
    )
    .join("\n");
}

describe("outcome ledger in runtime turns", function () {
  let environment: DirectJourneyEnvironment;
  let conversationKey = 993_000;

  beforeEach(async function () {
    environment = await installDirectJourneyEnvironment();
    libraryUpdateReceipt = undefined;
    scriptedPaperRead = undefined;
    conversationKey += 10;
  });

  afterEach(function () {
    environment.restore();
  });

  it("summarize-and-save: the declared save completes from the note's receipt, in three requests", async function () {
    const turn = await runTurn({
      conversationKey,
      userText: "Summarize this paper and save it as a note",
      steps: [
        stepOf(declare("declare-1", [saveDeclaration]), paperRead("read-1")),
        stepOf(noteWrite("note-1")),
        finalStep("I summarized the paper and saved it as a note."),
      ],
    });

    assert.equal(turn.outcome?.kind, "completed");
    assert.equal(turn.requests, 3);
    const ledger = settled(turn);
    assert.deepEqual(ledger.end, { state: "completed" });
    const save = outcome(ledger, "save");
    assert.equal(save.status, "completed");
    assert.deepEqual(save.verifiedReceiptIds, receiptIdsOf(turn, "note_write"));
    const lastCheckpoint = turn.events.findLastIndex(
      (event) => event.type === "execution_checkpoint",
    );
    assert.isAbove(lastCheckpoint, -1);
    assert.isAbove(
      stopIndex(turn),
      lastCheckpoint,
      "the settled ledger is published before the stop rule",
    );
  });

  it("a declared reasoning part completes when the final answer is accepted", async function () {
    const turn = await runTurn({
      conversationKey,
      userText: "Explain how drift was measured in this paper",
      steps: [
        stepOf(
          declare("declare-1", [
            {
              taskId: "explain",
              description: "Explain how drift was measured",
              expectedEffect: "reasoning",
            },
          ]),
          paperRead("read-1"),
        ),
        finalStep("Drift was measured as the change in place-field centres."),
      ],
    });

    assert.equal(turn.requests, 2, "no correction: the answer is the part");
    const ledger = settled(turn);
    assert.deepEqual(ledger.end, { state: "completed" });
    assert.equal(outcome(ledger, "explain").status, "completed");
  });

  it("false save claim: one correction names the open save, then the run ends completed with exceptions", async function () {
    const turn = await runTurn({
      conversationKey,
      userText: "Summarize this paper and save it as a note",
      steps: [
        stepOf(declare("declare-1", [saveDeclaration])),
        finalStep("Saved."),
        finalStep("Saved."),
      ],
    });

    assert.equal(turn.outcome?.kind, "completed");
    assert.equal(turn.requests, 3);
    assert.include(
      promptText(turn.prompts[2]),
      `Before answering, finish the parts of this request you declared that are still open: “${SAVE}”.`,
    );
    const ledger = settled(turn);
    assert.deepEqual(ledger.end, { state: "completed_with_exceptions" });
    assert.deepEqual(
      [outcome(ledger, "save").status, outcome(ledger, "save").reason],
      ["skipped", OUTCOME_REASONS.notDone],
    );
  });

  it("does not repeat the correction when no new evidence arrived; it accepts and settles instead", async function () {
    const turn = await runTurn({
      conversationKey,
      userText: "Summarize this paper and save it as a note",
      steps: [
        stepOf(declare("declare-1", [saveDeclaration])),
        finalStep("Saved."),
        stepOf(paperRead("read-1")),
        finalStep("Saved."),
      ],
    });

    // A second correction would ask for a fifth step the script does not have.
    assert.equal(turn.outcome?.kind, "completed");
    assert.equal(turn.requests, 4);
    assert.equal(
      promptText(turn.prompts[3]).split("Before answering, finish the parts")
        .length - 1,
      1,
      "the correction was sent once",
    );
    assert.deepEqual(settled(turn).end, { state: "completed_with_exceptions" });
    assert.lengthOf(
      checkpoints(turn),
      2,
      "one event per change: the declaration and the settled end, not the read or the answer that moved nothing",
    );
  });

  it("partial batch without a declaration: a host outcome with one exception ends completed with exceptions", async function () {
    libraryUpdateReceipt = libraryReceipt({});
    const turn = await runTurn({
      conversationKey,
      userText: "Set the year on these ten papers",
      steps: [
        stepOf({ id: "update-1", name: "library_update", arguments: {} }),
        finalStep("Updated eight of the ten papers."),
      ],
    });

    const ledger = settled(turn);
    assert.deepEqual(ledger.end, { state: "completed_with_exceptions" });
    assert.lengthOf(ledger.tasks, 1);
    const [host] = ledger.tasks;
    assert.equal(host.origin, "host");
    assert.equal(host.status, "completed");
    assert.lengthOf(host.doneTargets!, 8);
    assert.deepEqual(host.exceptions, [
      {
        targets: ["item:9", "item:10"],
        reason: "In a group library you cannot edit",
      },
    ]);
  });

  it("an unverified receipt ends the run blocked", async function () {
    libraryUpdateReceipt = libraryReceipt({
      verification: "unverified",
      status: "unverified",
      appliedTargets: [],
      rejectedTargets: TEN_ITEMS,
      reasons: ["The captured post-state could not be read back."],
    });
    const turn = await runTurn({
      conversationKey,
      userText: "Set the year on these ten papers",
      steps: [
        stepOf({ id: "update-1", name: "library_update", arguments: {} }),
        finalStep("Updated the papers."),
      ],
    });

    const ledger = settled(turn);
    assert.deepEqual(ledger.end, { state: "blocked" });
    assert.equal(ledger.tasks[0].status, "blocked");
    assert.equal(ledger.tasks[0].reason, OUTCOME_REASONS.unverified);
  });

  it("a run the user stops ends cancelled and keeps its open outcome pending", async function () {
    const controller = new AbortController();
    const turn = await runTurn({
      conversationKey,
      userText: "Summarize this paper and save it as a note",
      signal: controller.signal,
      steps: [
        stepOf(declare("declare-1", [saveDeclaration])),
        () => {
          controller.abort();
          throw new Error("The request was aborted.");
        },
      ],
    });

    assert.equal(stopStatus(turn), "cancelled");
    const ledger = settled(turn);
    assert.deepEqual(ledger.end, { state: "cancelled" });
    assert.equal(outcome(ledger, "save").status, "pending");
  });

  it("a provider error after progress ends interrupted; 'continue' resumes the ledger and saves the note", async function () {
    const interrupted = await runTurn({
      conversationKey,
      userText: "Read this paper and save a summary as a note",
      steps: [
        stepOf(
          declare("declare-1", [
            {
              taskId: "read",
              description: "Read the paper",
              expectedEffect: "read",
              targetIds: [String(PARENT_ITEM_ID)],
            },
            saveDeclaration,
          ]),
          paperRead("read-1"),
        ),
        () => {
          throw new Error("provider interrupted");
        },
      ],
    });
    assert.equal(stopStatus(interrupted), "failed");
    const before = settled(interrupted);
    assert.deepEqual(before.end, { state: "interrupted" });
    assert.equal(outcome(before, "read").status, "completed");
    assert.equal(outcome(before, "save").status, "pending");

    const resumed = await runTurn({
      conversationKey,
      userText: "continue",
      steps: [stepOf(noteWrite("note-1")), finalStep("Saved the summary.")],
    });
    const adopted = resumed.initialCheckpoint;
    assert.exists(adopted, "the interrupted ledger was adopted");
    assert.equal(adopted!.executionId, before.executionId);
    assert.notProperty(adopted!, "end");
    assert.deepEqual(
      adopted!.tasks.map((task) => task.status),
      ["completed", "pending"],
    );
    assert.include(
      promptText(resumed.prompts[0]),
      outcome(before, "save").taskId,
      "the model sees the open parts",
    );
    const after = settled(resumed);
    assert.deepEqual(after.end, { state: "completed" });
    assert.equal(outcome(after, "save").status, "completed");
  });

  it("any other message after an interrupted run starts with no ledger", async function () {
    await runTurn({
      conversationKey,
      userText: "Read this paper and save a summary as a note",
      steps: [
        stepOf(
          declare("declare-1", [
            {
              taskId: "read",
              description: "Read the paper",
              expectedEffect: "read",
              targetIds: [String(PARENT_ITEM_ID)],
            },
            saveDeclaration,
          ]),
          paperRead("read-1"),
        ),
        () => {
          throw new Error("provider interrupted");
        },
      ],
    });
    const fresh = await runTurn({
      conversationKey,
      userText: "What is drift?",
      steps: [finalStep("Drift is a gradual change in a representation.")],
    });
    assert.isUndefined(fresh.initialCheckpoint);
    assert.notInclude(
      promptText(fresh.prompts[0]),
      "HOST-PERSISTED ORDINARY WORK CHECKPOINT",
    );
    assert.isEmpty(checkpoints(fresh));
    assert.equal(fresh.requests, 1);
  });

  it("continue after a run that settled any other way starts with no ledger", async function () {
    await runTurn({
      conversationKey,
      userText: "Summarize this paper and save it as a note",
      steps: [
        stepOf(declare("declare-1", [saveDeclaration])),
        finalStep("Saved."),
        finalStep("Saved."),
      ],
    });
    const next = await runTurn({
      conversationKey,
      userText: "continue",
      steps: [finalStep("There is nothing left to continue.")],
    });
    assert.isUndefined(next.initialCheckpoint);
    assert.isEmpty(checkpoints(next));
  });

  it("a plain question publishes no ledger at all, in one request", async function () {
    const turn = await runTurn({
      conversationKey,
      userText: "What is representational drift?",
      steps: [finalStep("A gradual change in a neural representation.")],
    });
    assert.equal(turn.outcome?.kind, "completed");
    assert.equal(turn.requests, 1);
    assert.isEmpty(checkpoints(turn));
  });

  it("a verified retry after a failed note write completes the declared save", async function () {
    environment.library.failNextNativeSave(true);
    const turn = await runTurn({
      conversationKey,
      userText: "Summarize this paper and save it as a note",
      steps: [
        stepOf(declare("declare-1", [saveDeclaration]), noteWrite("note-1")),
        () => {
          environment.library.failNextNativeSave(false);
          return stepOf(noteWrite("note-2"));
        },
        finalStep("Saved the summary on the second try."),
      ],
    });

    assert.equal(turn.requests, 3);
    assert.equal(environment.library.nativeSaves(), 1);
    const ledger = settled(turn);
    assert.deepEqual(ledger.end, { state: "completed" });
    const save = outcome(ledger, "save");
    assert.equal(save.status, "completed");
    assert.notProperty(save, "reason");
  });

  it("a command's execution-only receipt completes its host outcome", async function () {
    const turn = await runTurn({
      conversationKey,
      userText: "Convert the exported file",
      steps: [
        stepOf({ id: "command-1", name: "run_command", arguments: {} }),
        finalStep("Converted the file."),
      ],
    });

    const ledger = settled(turn);
    assert.deepEqual(ledger.end, { state: "completed" });
    assert.lengthOf(ledger.tasks, 1);
    assert.equal(ledger.tasks[0].description, "Ran command");
    assert.equal(ledger.tasks[0].status, "completed");
    assert.deepEqual(ledger.tasks[0].verifiedReceiptIds, []);
  });

  it("a write the user declines ends the run blocked", async function () {
    const turn = await runTurn({
      conversationKey,
      userText: "Summarize this paper and save it as a note",
      approve: false,
      steps: [
        stepOf(declare("declare-1", [saveDeclaration])),
        stepOf(noteWrite("note-1")),
        finalStep("I did not save the note."),
      ],
    });

    assert.equal(turn.requests, 3);
    assert.equal(environment.library.nativeSaves(), 0);
    const ledger = settled(turn);
    assert.deepEqual(ledger.end, { state: "blocked" });
    const save = outcome(ledger, "save");
    assert.equal(save.status, "blocked");
    assert.equal(save.reason, OUTCOME_REASONS.declined);
    assert.include(save.receiptIds, "declined:note-1");
  });
});

/** The Plan tables on a real in-memory SQLite, beside the mock run store. */
function installPlanSqlite(): () => void {
  const zotero = globalThis as typeof globalThis & { Zotero: typeof Zotero };
  const base = zotero.Zotero.DB;
  const db = new DatabaseSync(":memory:");
  zotero.Zotero.DB = {
    ...base,
    queryAsync: async (sql: string, params: unknown[] = []) => {
      if (
        !sql.includes("llm_for_zotero_plan_") &&
        !sql.includes("llm_for_zotero_research")
      )
        return base.queryAsync(sql, params);
      const statement = db.prepare(sql);
      const values = params.map((value) =>
        value === undefined ? null : value,
      ) as never[];
      if (/^\s*(SELECT|PRAGMA|WITH)/i.test(sql))
        return statement.all(...values);
      statement.run(...values);
      return [];
    },
  } as unknown as typeof Zotero.DB;
  return () => {
    zotero.Zotero.DB = base;
    db.close();
  };
}

describe("parts over the turn's paper scope in runtime turns", function () {
  let environment: DirectJourneyEnvironment;
  let conversationKey = 994_000;
  const READ_ALL = "Read each paper in Drift";

  /** A paper's context, as paper_read rows name it. */
  const paperOf = (itemId: number) => ({
    itemId,
    contextItemId: itemId + 1000,
    libraryID: 1,
  });

  /** Body passages for a targeted read, an outline, or no text at all. */
  function paperReadPayload(input: Record<string, unknown>): unknown {
    const itemId = Number((input.target as { itemId?: number })?.itemId);
    if (input.mode === "outline")
      return {
        mode: "outline",
        papers: [
          {
            paperContext: paperOf(itemId),
            outline: { sections: [{ title: "Introduction" }] },
          },
        ],
      };
    if (input.mode === "overview")
      return {
        mode: "overview",
        results: [
          {
            backend: "zotero_metadata",
            sourceKind: "zotero_metadata",
            coverage: "metadata_only",
            text: "Title: A paper without a PDF",
            paperContext: paperOf(itemId),
          },
        ],
      };
    return {
      mode: "targeted",
      results: [],
      papers: [
        {
          paperContext: paperOf(itemId),
          passages: [{ text: "Place cells drift.", sectionLabel: "Results" }],
        },
      ],
    };
  }

  function read(id: string, itemId: number, mode?: string): AgentToolCall {
    return {
      id,
      name: "paper_read",
      arguments: { target: paperOf(itemId), ...(mode ? { mode } : {}) },
    };
  }

  const readAll = {
    taskId: "read-all",
    description: READ_ALL,
    expectedEffect: "read",
    scope: true,
  };

  function scope(itemIds: number[], withText: number): TaskPaperScopeSet {
    return { wholeLibrary: true, itemIds, withText };
  }

  beforeEach(async function () {
    environment = await installDirectJourneyEnvironment();
    libraryUpdateReceipt = undefined;
    scriptedPaperRead = paperReadPayload;
    conversationKey += 10;
  });

  afterEach(function () {
    environment.restore();
    scriptedPaperRead = undefined;
  });

  it("states the scope, freezes it at declaration, and ticks only papers whose text was read", async function () {
    const turn = await runTurn({
      conversationKey,
      userText: "Read every paper in my library and summarize each",
      scope: scope([101, 102, 103], 2),
      steps: [
        stepOf(
          declare("declare-1", [readAll]),
          read("read-101", 101),
          read("read-102", 102, "outline"),
          read("read-103", 103, "overview"),
        ),
        finalStep("I read the papers."),
        stepOf(read("read-102-text", 102)),
        finalStep("Each paper, summarized."),
      ],
    });

    assert.include(
      promptText(turn.prompts[0]),
      "\nPaper scope: whole library — 3 papers, 2 with full text\n",
    );
    const declared = checkpoints(turn)[0];
    assert.deepEqual(outcome(declared, "read-all").targets, [
      "item:101",
      "item:102",
      "item:103",
    ]);
    assert.isTrue(outcome(declared, "read-all").scope);
    // The model reads the part back as counts; the papers stay with the host.
    assert.include(
      promptText(turn.prompts[1]),
      '"parts":[{"taskId":"read-all","status":"pending","done":0,"total":3,"scope":true}]',
    );
    assert.notInclude(promptText(turn.prompts[1]), '"item:10');
    // The ledger is published whole once, then as deltas.
    const ledgerEvents = turn.events.filter(
      (event) =>
        event.type === "execution_checkpoint" ||
        event.type === "execution_checkpoint_delta",
    );
    assert.deepEqual(
      ledgerEvents.map((event) => event.type),
      [
        "execution_checkpoint",
        ...Array(ledgerEvents.length - 1).fill("execution_checkpoint_delta"),
      ],
    );
    // Each change is published once; the outline read changed nothing.
    assert.deepEqual(
      checkpoints(turn).map((checkpoint) => {
        const part = outcome(checkpoint, "read-all");
        return [
          part.status,
          part.doneTargets ?? [],
          (part.exceptions ?? []).flatMap((entry) => entry.targets),
        ];
      }),
      [
        ["pending", [], []],
        ["pending", ["item:101"], []],
        ["pending", ["item:101"], ["item:103"]],
        ["completed", ["item:101", "item:102"], ["item:103"]],
        ["completed", ["item:101", "item:102"], ["item:103"]],
      ],
    );
    assert.include(
      promptText(turn.prompts[2]),
      `Before answering, finish the parts of this request you declared that are still open: “${READ_ALL}”.`,
    );
    const ledger = settled(turn);
    const task = outcome(ledger, "read-all");
    assert.equal(task.status, "completed");
    assert.deepEqual(task.doneTargets, ["item:101", "item:102"]);
    assert.deepEqual(task.exceptions, [
      { targets: ["item:103"], reason: OUTCOME_REASONS.noText },
    ]);
    assert.deepEqual(ledger.end, { state: "completed_with_exceptions" });
  });

  it("states and resolves no scope for one paper, and does for two", async function () {
    const paper = (itemId: number) => ({
      itemId,
      contextItemId: itemId + 1000,
      title: `Paper ${itemId}`,
      libraryID: 1,
    });
    let resolved = 0;
    const one = await runTurn({
      conversationKey,
      userText: "Summarize this paper",
      scope: scope([101], 1),
      onResolveScope: () => (resolved += 1),
      attached: { selectedPaperContexts: [paper(101)] },
      steps: [finalStep("A summary.")],
    });
    assert.equal(resolved, 0, "a one-paper chat waits for no snapshot");
    assert.notInclude(promptText(one.prompts[0]), "Paper scope:");
    assert.isUndefined(one.request?.turnScopePapers);

    const two = await runTurn({
      conversationKey: conversationKey + 1,
      userText: "Compare these papers",
      scope: { wholeLibrary: false, itemIds: [101, 102], withText: 2 },
      onResolveScope: () => (resolved += 1),
      attached: { selectedPaperContexts: [paper(101), paper(102)] },
      steps: [finalStep("A comparison.")],
    });
    assert.equal(resolved, 1);
    assert.include(
      promptText(two.prompts[0]),
      "\nPaper scope: listed papers — 2 papers, 2 with full text\n",
    );
  });

  it("an abstract-depth read alone leaves the part open and the answer is corrected once", async function () {
    const turn = await runTurn({
      conversationKey,
      userText: "Read every paper in my library",
      scope: scope([101], 1),
      steps: [
        stepOf(declare("declare-1", [readAll]), read("read-1", 101, "outline")),
        finalStep("I read it."),
        finalStep("I read it."),
      ],
    });
    const ledger = settled(turn);
    assert.equal(turn.requests, 3, "one correction for the open part");
    assert.isUndefined(outcome(ledger, "read-all").doneTargets);
    assert.deepEqual(ledger.end, { state: "completed_with_exceptions" });
  });

  it("a scope that changes later keeps the frozen papers, through an interruption and 'continue'", async function () {
    const interrupted = await runTurn({
      conversationKey,
      userText: "Read every paper in my library and summarize each",
      scope: scope([101, 102], 2),
      steps: [
        stepOf(declare("declare-1", [readAll]), read("read-101", 101)),
        () => {
          throw new Error("provider interrupted");
        },
      ],
    });
    const before = settled(interrupted);
    assert.deepEqual(before.end, { state: "interrupted" });
    assert.deepEqual(outcome(before, "read-all").doneTargets, ["item:101"]);

    const resumed = await runTurn({
      conversationKey,
      userText: "continue",
      // A paper joined the scope since the part was declared.
      scope: scope([101, 102, 104], 3),
      steps: [
        stepOf(declare("declare-2", [readAll]), read("read-102", 102)),
        finalStep("Every paper is summarized."),
      ],
    });
    assert.include(
      promptText(resumed.prompts[0]),
      "\nPaper scope: whole library — 3 papers, 3 with full text\n",
    );
    assert.deepEqual(outcome(resumed.initialCheckpoint, "read-all").targets, [
      "item:101",
      "item:102",
    ]);
    const after = settled(resumed);
    const task = outcome(after, "read-all");
    assert.deepEqual(task.targets, ["item:101", "item:102"]);
    assert.equal(task.status, "completed");
    assert.deepEqual(after.end, { state: "completed" });
  });
});
