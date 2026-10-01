import { assert } from "chai";
import { DatabaseSync } from "node:sqlite";
import { AgentRuntime } from "../src/agent/runtime";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { createSubmitDocumentTool } from "../src/agent/tools/control/submitDocument";
import { createTaskUpdateTool } from "../src/agent/tools/control/taskUpdate";
import { createNoteWriteTool } from "../src/agent/tools/write/noteWrite";
import { OUTCOME_REASONS } from "../src/agent/loop/outcomes";
import { ExecutionCheckpointFold } from "../src/agent/execution/checkpointEvents";
import { estimateContextMessagesTokens } from "../src/utils/modelInputCap";
import {
  loadAgentTranscriptSegment,
  PORTABLE_TRANSCRIPT_KEY,
} from "../src/agent/store/transcriptStore";

const estimatePrompt = (messages: AgentModelMessage[]) =>
  estimateContextMessagesTokens(messages);
import type { TaskPaperScopeSet } from "../src/agent/context/taskPaperScopeListing";
import { createTestActionContractService } from "./helpers/actionContractService";
import {
  DISCOVER_IMPORT,
  RENAME_DELETE_FOLDER,
} from "./helpers/liveLedgerRuns";
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

/** Receipts the scripted library writes return in turn, before the above. */
let liveReceipts: AgentActionReceipt[] = [];

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
  service.finalize = (async (prepared, params) => {
    if (
      prepared.proposals.some((proposal) => proposal.id === "library-update")
    ) {
      const next = liveReceipts.shift() || libraryUpdateReceipt;
      if (next) return [next];
    }
    return finalize(prepared, params);
  }) as typeof service.finalize;
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
  tools.register({
    spec: {
      name: "library_import",
      description: "Import papers into Zotero",
      inputSchema: { type: "object" },
      executionClass: "external_effect",
    },
    describeAction: () => [
      {
        id: "library-update",
        proofDomain: "zotero_state",
        capability: "zotero.import",
        operation: "import_identifiers",
        source: "library_mutation",
        requestedTargets: [],
        destinationCollectionIds: [],
      },
    ],
    effectOperations: ["import_identifiers"],
    validate: (args: unknown) => ({ ok: true, value: args as never }),
    execute: async () => ({ content: { succeeded: 2 }, effect: "applied" }),
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
  /** Contexts the user attached to the question, and other request fields. */
  attached?: Partial<AgentRuntimeRequestInput>;
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
        // The session restarts and appends in place: keep each step's view.
        prompts.push([...stepParams.messages]);
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

  it("a part declared after its papers were read takes those reads", async function () {
    const turn = await runTurn({
      conversationKey,
      userText: "Read every paper in my library",
      scope: scope([101, 102], 2),
      steps: [
        stepOf(read("read-101", 101)),
        stepOf(declare("declare-1", [readAll]), read("read-102", 102)),
        finalStep("Both papers are read."),
      ],
    });
    assert.deepEqual(
      outcome(checkpoints(turn)[0], "read-all").doneTargets,
      ["item:101"],
      "the read before the declaration ticks its paper at once",
    );
    const ledger = settled(turn);
    assert.equal(outcome(ledger, "read-all").status, "completed");
    assert.deepEqual(ledger.end, { state: "completed" });
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

describe("long jobs in runtime turns", function () {
  let environment: DirectJourneyEnvironment;
  let conversationKey = 995_000;
  const PAPERS = Array.from({ length: 30 }, (_, index) => 2001 + index);
  const READ_ALL = "Read each paper in Drift";

  /** A paper's read: its finding first, sized like its text. */
  function paperText(itemId: number): string {
    const size = itemId <= 2010 ? 4_000 : 10_000;
    const text = `Finding ${itemId}: drift was measured in this paper. `;
    return text + "Representational drift details. ".repeat(size / 31);
  }

  beforeEach(async function () {
    environment = await installDirectJourneyEnvironment();
    libraryUpdateReceipt = undefined;
    conversationKey += 10;
    scriptedPaperRead = (input) => {
      const itemId = Number((input.target as { itemId?: number })?.itemId);
      return {
        mode: "targeted",
        results: [],
        papers: [
          {
            paperContext: {
              itemId,
              contextItemId: itemId + 1000,
              libraryID: 1,
            },
            passages: [
              {
                text: paperText(itemId),
                sectionLabel: "Results",
                pageLabel: "3",
              },
            ],
          },
        ],
      };
    };
  });

  afterEach(function () {
    environment.restore();
    scriptedPaperRead = undefined;
  });

  /** The model: declare the part, then read each page the host names. */
  function pagedModel(): ScriptStep {
    let declared = false;
    const asked = new Set<number>();
    return (messages: AgentModelMessage[]) => {
      if (!declared) {
        declared = true;
        return stepOf(
          declare("declare-1", [
            {
              taskId: "read-all",
              description: READ_ALL,
              expectedEffect: "read",
              scope: true,
            },
          ]),
        );
      }
      const host = [...messages]
        .reverse()
        .map((message) => promptText([message]))
        .find((text) => text.startsWith("Long job"));
      if (!host || host.startsWith("Long job complete"))
        return finalStep("Every paper is summarized from its results.");
      const page = [...host.matchAll(/^- itemId=(\d+)/gm)]
        .map((match) => Number(match[1]))
        .filter((itemId) => !asked.has(itemId))
        .slice(0, 8);
      for (const itemId of page) asked.add(itemId);
      return stepOf(
        ...page.map((itemId) => ({
          id: `read-${itemId}`,
          name: "paper_read",
          arguments: {
            target: { itemId, contextItemId: itemId + 1000, libraryID: 1 },
          },
        })),
      );
    };
  }

  function pageEvents(turn: Turn): Record<string, unknown>[] {
    return turn.events.flatMap((event) =>
      event.type === "provider_event" &&
      event.providerType === "agent_long_job_page"
        ? [event.payload || {}]
        : [],
    );
  }

  /** What the model was sent at the first request of page `number`. */
  function pageStart(turn: Turn, number: number): AgentModelMessage[] {
    const start = turn.prompts.find((messages) =>
      promptText(messages).includes(`Page ${number}:`),
    );
    assert.exists(start, `page ${number} was sent`);
    return start!;
  }

  it("pages a 30-paper job in pages sized from the measured cost, and answers from every paper's digest", async function () {
    const model = pagedModel();
    const turn = await runTurn({
      conversationKey,
      userText: "Read every paper in Drift and summarize each",
      scope: {
        wholeLibrary: false,
        itemIds: PAPERS,
        withText: PAPERS.length,
        papers: Object.fromEntries(
          PAPERS.map((itemId) => [
            itemId,
            { title: `Paper ${itemId}`, text: "pdf" as const },
          ]),
        ),
      },
      attached: {
        selectedCollectionContexts: [
          { collectionId: 9, name: "Drift", libraryID: 1 },
        ],
        advanced: { inputTokenCap: 30_000 },
      },
      steps: Array.from({ length: 40 }, () => model),
    });

    assert.equal(turn.outcome?.kind, "completed", String(turn.error || ""));
    const ledger = settled(turn);
    const part = outcome(ledger, "read-all");
    assert.equal(part.status, "completed");
    assert.lengthOf(part.doneTargets!, 30);

    const pages = pageEvents(turn);
    const sized = pages.filter((page) => typeof page.page === "number");
    assert.isAtLeast(sized.length, 3, JSON.stringify(pages));
    assert.deepEqual(pages[pages.length - 1], {
      complete: true,
      papers: 30,
      digested: (pages[pages.length - 1] as { digested: number }).digested,
    });
    // The first page is sized from the priors, the rest from what the
    // papers measurably cost and how the model read them. Every page holds
    // the smaller of what the room allows and what keeps the job's input
    // least, and is planned from the prompt it starts from.
    assert.include(sized[0], {
      page: 1,
      left: 30,
      measured: false,
      costPerPaper: 12_000,
      papersPerRequest: 3,
      requestsPerPage: 1,
    });
    for (const page of sized) {
      const room = page.room as number;
      const cost = page.costPerPaper as number;
      const R = page.promptTokens as number;
      assert.equal(page.fitBound, Math.floor(room / cost) - 1);
      // Whole requests of m papers, r* = sqrt(2·o·R / (m·c)) of them.
      const m = page.papersPerRequest as number;
      const r = page.readsPerPage as number;
      const best = Math.sqrt(
        (2 * (page.requestsPerPage as number) * R) / (m * cost),
      );
      assert.isAtMost(Math.abs(r - Math.max(1, best)), 0.51);
      assert.isAtMost(
        Math.abs((page.costBound as number) - Math.max(1, m * r)),
        0.51 + 0.01 * r,
      );
      assert.equal(
        page.papers,
        Math.min(
          page.left as number,
          Math.max(
            1,
            Math.min(page.fitBound as number, page.costBound as number),
          ),
        ),
        JSON.stringify(page),
      );
      assert.isBelow(R, page.budgetTokens as number);
      const sent = estimatePrompt(pageStart(turn, page.page as number));
      assert.isAtMost(
        Math.abs(sent - R),
        200,
        `page ${page.page} is planned from the prompt it starts from: ${sent} vs ${R}`,
      );
    }
    assert.isTrue(
      sized.some((page) => page.papers === page.fitBound),
      "on this small window the room decides some pages",
    );
    const measuredCosts = sized
      .filter((page) => page.measured)
      .map((page) => page.costPerPaper as number);
    assert.isAtLeast(measuredCosts.length, 2);
    assert.isAbove(
      Math.max(...measuredCosts),
      Math.min(...measuredCosts),
      "the larger papers raise the measured cost, and the pages shrink",
    );

    // The context stays bounded: what the model saw at the start of the
    // third page differs from the first by no more than the digests.
    const first = estimatePrompt(pageStart(turn, 1));
    const third = estimatePrompt(pageStart(turn, 3));
    const digests = 30 * (sized[2].digestShare as number);
    assert.isBelow(third, 20_250);
    assert.isAtMost(
      Math.abs(third - first),
      digests + 2_400,
      "no more than the digests (at most half the room) and one checkpoint",
    );

    // The final step sees every paper's digest, with its id and anchors.
    const finalPrompt = promptText(turn.prompts[turn.prompts.length - 1]);
    assert.include(finalPrompt, "Long job complete");
    for (const itemId of PAPERS) {
      assert.include(finalPrompt, `itemId=${itemId}`);
      assert.include(finalPrompt, `Finding ${itemId}`);
    }
    assert.include(finalPrompt, "Results, p. 3");

    // Each page's results are persisted with the transcript, each batch
    // with a handle: they outlive the turn, as after Stop or a restart.
    const stored = await loadAgentTranscriptSegment({
      conversationKey,
      compatibilityKey: PORTABLE_TRANSCRIPT_KEY,
    });
    const records = stored.messages.filter(
      (message) =>
        message.role === "user" &&
        message.retainedTool?.name === "long_job_results",
    );
    assert.isAtLeast(records.length, sized.length - 1);
    const recorded = records.map((message) => promptText([message])).join("\n");
    for (const itemId of PAPERS) {
      assert.include(recorded, `itemId=${itemId}`);
      assert.include(recorded, `Finding ${itemId}`);
    }
    const handles = records.map(
      (message) =>
        (message as { retainedTool?: { handle?: string } }).retainedTool
          ?.handle,
    );
    assert.isTrue(handles.every(Boolean), "every batch keeps a handle");
    // The next question sees each batch inline, or by its handle once the
    // older history is compacted.
    const next = await runTurn({
      conversationKey,
      userText: "Which paper measured drift first?",
      steps: [finalStep("Paper 2001 did.")],
    });
    const history = promptText(next.prompts[0]);
    for (const [index, handle] of handles.entries()) {
      assert.isTrue(
        history.includes(handle!) ||
          history.includes(`for this job, batch ${index + 1} `),
        `batch ${index + 1}`,
      );
    }
  });

  it("leaves a job that fits one pass to the model, with no host page", async function () {
    const turn = await runTurn({
      conversationKey,
      userText: "Read these papers",
      scope: {
        wholeLibrary: false,
        itemIds: PAPERS.slice(0, 2),
        withText: 2,
      },
      steps: [
        stepOf(
          declare("declare-1", [
            {
              taskId: "read-all",
              description: READ_ALL,
              expectedEffect: "read",
              scope: true,
            },
          ]),
          ...PAPERS.slice(0, 2).map((itemId) => ({
            id: `read-${itemId}`,
            name: "paper_read",
            arguments: {
              target: { itemId, contextItemId: itemId + 1000, libraryID: 1 },
            },
          })),
        ),
        finalStep("Both papers are read."),
      ],
    });
    assert.deepEqual(pageEvents(turn), []);
    assert.notInclude(promptText(turn.prompts[1]), "Long job");
    assert.deepEqual(settled(turn).end, { state: "completed" });
  });

  describe("how deep a job reads, from each part's declared effect", function () {
    const SORT = "File each paper into its topic folder";
    const TAG = "Tag each paper by its method";
    const NOTE = "Save a note on each paper";

    /** A library chat over `count` papers, each with a PDF. */
    function library(count: number): TaskPaperScopeSet {
      const ids = Array.from({ length: count }, (_, index) => 3001 + index);
      return {
        wholeLibrary: true,
        itemIds: ids,
        withText: ids.length,
        papers: Object.fromEntries(
          ids.map((itemId) => [
            itemId,
            { title: `Paper ${itemId}`, text: "pdf" as const },
          ]),
        ),
      };
    }

    /** The long job's host messages the turn sent, each once. */
    const hostMessages = (turn: Turn) => [
      ...new Set(
        turn.prompts.flatMap((messages) =>
          messages
            .map((message) => promptText([message]))
            .filter((text) => text.startsWith("Long job")),
        ),
      ),
    ];

    const firstPage = (turn: Turn) =>
      pageEvents(turn).find((page) => typeof page.page === "number");

    /**
     * A model that changes papers: it declares one part over the scope, then
     * makes each page's change in one library_update call, whose receipt
     * names the page's papers.
     */
    function changeModel(part: {
      taskId: string;
      description: string;
      capability: "zotero.collections" | "zotero.tags";
      operation: "move_to_collection" | "apply_tags";
    }): ScriptStep {
      const changed = new Set<number>();
      let declared = false;
      return (messages: AgentModelMessage[]) => {
        if (!declared) {
          declared = true;
          return stepOf(
            declare("declare-1", [
              {
                taskId: part.taskId,
                description: part.description,
                expectedEffect: "mutation",
                expectedCapability: part.capability,
                scope: true,
              },
            ]),
          );
        }
        const host = [...messages]
          .reverse()
          .map((message) => promptText([message]))
          .find((text) => text.startsWith("Long job"));
        if (!host || host.startsWith("Long job complete"))
          return finalStep("Every paper is changed as asked.");
        const page = [...host.matchAll(/^- itemId=(\d+)/gm)]
          .map((match) => Number(match[1]))
          .filter((itemId) => !changed.has(itemId));
        for (const itemId of page) changed.add(itemId);
        const targets = page.map((itemId) => `item:${itemId}`);
        liveReceipts.push({
          version: 2,
          id: `${part.operation}:${changed.size}`,
          proposalId: `${part.operation}:0`,
          proofDomain: "zotero_state",
          capability: part.capability,
          operation: part.operation,
          verification: "verified",
          status: "applied",
          requestedTargets: targets,
          appliedTargets: targets,
          alreadySatisfiedTargets: [],
          rejectedTargets: [],
          reasons: [],
          verifiedFacts: [],
        });
        return stepOf({
          id: `${part.taskId}-${changed.size}`,
          name: "library_update",
          arguments: { assignments: page.map((itemId) => ({ itemId })) },
        });
      };
    }

    /** The model declares parts over the scope, then answers at once. */
    const declaredOnly = (parts: Record<string, unknown>[]): ScriptStep[] => [
      stepOf(declare("declare-1", parts)),
      ...Array.from({ length: 4 }, () =>
        finalStep("I stopped before the papers."),
      ),
    ];

    it("sorts sixty papers into folders, then tags the same sixty, from their metadata: priced at their records, never told to read", async function () {
      liveReceipts = [];
      try {
        const scope = library(60);
        const sorting = changeModel({
          taskId: "sort",
          description: SORT,
          capability: "zotero.collections",
          operation: "move_to_collection",
        });
        const sorted = await runTurn({
          conversationKey,
          userText: "Sort my library into topic folders",
          scope,
          attached: { advanced: { inputTokenCap: 30_000 } as never },
          steps: Array.from({ length: 30 }, () => sorting),
        });
        const tagging = changeModel({
          taskId: "tag",
          description: TAG,
          capability: "zotero.tags",
          operation: "apply_tags",
        });
        const tagged = await runTurn({
          conversationKey,
          userText: "Now tag each of them by its method",
          scope,
          attached: { advanced: { inputTokenCap: 30_000 } as never },
          steps: Array.from({ length: 30 }, () => tagging),
        });
        for (const [turn, taskId, description] of [
          [sorted, "sort", SORT],
          [tagged, "tag", TAG],
        ] as const) {
          assert.equal(
            turn.outcome?.kind,
            "completed",
            String(turn.error || ""),
          );
          const part = outcome(settled(turn), taskId);
          assert.equal(part.status, "completed");
          assert.lengthOf(part.doneTargets!, 60);
          assert.deepEqual(settled(turn).end, { state: "completed" });
          // Paged at what a paper's record costs, not its text.
          assert.include(firstPage(turn), {
            page: 1,
            left: 60,
            measured: false,
            costPerPaper: 600,
          });
          const pages = hostMessages(turn).filter((text) =>
            text.includes("in this order:"),
          );
          assert.isAtLeast(pages.length, 2, JSON.stringify(pageEvents(turn)));
          for (const text of pages) {
            assert.include(
              text,
              `Make the change “${description}” for these papers now`,
            );
            assert.include(text, "library_search with include:['abstract']");
          }
          for (const text of hostMessages(turn)) {
            assert.notInclude(text, "paper_read");
            assert.notMatch(text, /\bread\b/i, text);
          }
        }
        assert.include(
          promptText(sorted.prompts[0]),
          "\nPaper scope: whole library — 60 papers, 60 with full text\n",
        );
      } finally {
        liveReceipts = [];
      }
    });

    it("reads for a note on each of fifty papers: priced at their text and told to read", async function () {
      const turn = await runTurn({
        conversationKey,
        userText: "Read each of these papers and save a note on each",
        scope: library(50),
        attached: { advanced: { inputTokenCap: 30_000 } as never },
        steps: declaredOnly([
          {
            taskId: "note-all",
            description: NOTE,
            expectedEffect: "mutation",
            expectedCapability: "zotero.notes",
            scope: true,
          },
        ]),
      });
      assert.include(firstPage(turn), {
        page: 1,
        left: 50,
        measured: false,
        costPerPaper: 12_000,
      });
      const [page] = hostMessages(turn);
      assert.include(page, "Read them with paper_read mode:'overview'");
      assert.include(page, "use mode:'full' only if the user asked");
      assert.include(page, `Then make the change “${NOTE}” for each of them.`);
    });

    it("prices a mixed job, reading each paper and tagging it by its method, as reading", async function () {
      const turn = await runTurn({
        conversationKey,
        userText: "Read each paper and tag it by its method",
        scope: library(60),
        attached: { advanced: { inputTokenCap: 30_000 } as never },
        steps: declaredOnly([
          {
            taskId: "read-all",
            description: READ_ALL,
            expectedEffect: "read",
            scope: true,
          },
          {
            taskId: "tag",
            description: TAG,
            expectedEffect: "mutation",
            expectedCapability: "zotero.tags",
            scope: true,
          },
        ]),
      });
      assert.include(firstPage(turn), {
        page: 1,
        left: 60,
        measured: false,
        costPerPaper: 12_000,
      });
      const [page] = hostMessages(turn);
      assert.include(page, "Read them with paper_read mode:'overview'");
      assert.include(page, `Then make the change “${TAG}” for each of them.`);
      assert.notInclude(page, "library_search");
    });
  });
});

describe("derived limits in runtime turns", function () {
  let environment: DirectJourneyEnvironment;
  let conversationKey = 998_000;
  const BROKEN = "The PDF could not be opened";

  function papers(count: number, from = 4001): number[] {
    return Array.from({ length: count }, (_, index) => from + index);
  }

  function scopeOf(itemIds: number[]): TaskPaperScopeSet {
    return {
      wholeLibrary: false,
      itemIds,
      withText: itemIds.length,
      papers: Object.fromEntries(
        itemIds.map((itemId) => [
          itemId,
          { title: `Paper ${itemId}`, text: "pdf" as const },
        ]),
      ),
    };
  }

  function readCall(itemId: number, id = `read-${itemId}`): AgentToolCall {
    return {
      id,
      name: "paper_read",
      arguments: {
        target: { itemId, contextItemId: itemId + 1000, libraryID: 1 },
      },
    };
  }

  const declareScope = () =>
    stepOf(
      declare("declare-1", [
        {
          taskId: "read-all",
          description: "Read each paper in Drift",
          expectedEffect: "read",
          scope: true,
        },
      ]),
    );

  /** Reads fail for `failing` papers, and return a short text otherwise. */
  function readsFailingFor(failing: ReadonlySet<number>) {
    scriptedPaperRead = (input) => {
      const itemId = Number((input.target as { itemId?: number })?.itemId);
      if (failing.has(itemId)) throw new Error(BROKEN);
      return {
        mode: "targeted",
        results: [],
        papers: [
          {
            paperContext: {
              itemId,
              contextItemId: itemId + 1000,
              libraryID: 1,
            },
            passages: [
              {
                text: `Finding ${itemId}: drift was measured.`,
                sectionLabel: "Results",
              },
            ],
          },
        ],
      };
    };
  }

  function statuses(turn: Turn): string[] {
    return turn.events.flatMap((event) =>
      event.type === "status" ? [event.text] : [],
    );
  }

  beforeEach(async function () {
    environment = await installDirectJourneyEnvironment();
    libraryUpdateReceipt = undefined;
    conversationKey += 10;
  });

  afterEach(function () {
    environment.restore();
    scriptedPaperRead = undefined;
  });

  it("names the round in its status, or the job's page, never a cap", async function () {
    readsFailingFor(new Set());
    const ordinary = await runTurn({
      conversationKey,
      userText: "Read the paper twice",
      steps: [
        stepOf(paperRead("read-1")),
        stepOf(paperRead("read-2")),
        finalStep("Read."),
      ],
    });
    assert.deepEqual(statuses(ordinary), [
      "Running agent",
      "Continuing agent (round 2)",
      "Continuing agent (round 3)",
    ]);

    conversationKey += 10;
    const ids = papers(4);
    let page: number[] = [];
    const job = await runTurn({
      conversationKey,
      userText: "Read every paper in Drift",
      scope: scopeOf(ids),
      attached: { advanced: { inputTokenCap: 30_000 } as never },
      steps: [
        declareScope(),
        ...Array.from({ length: 12 }, () => (messages: AgentModelMessage[]) => {
          const host = [...messages]
            .reverse()
            .map((message) => promptText([message]))
            .find((text) => text.startsWith("Long job"));
          if (!host || host.startsWith("Long job complete"))
            return finalStep("Every paper is read.");
          page = [...host.matchAll(/^- itemId=(\d+)/gm)].map((match) =>
            Number(match[1]),
          );
          return stepOf(...page.map((itemId) => readCall(itemId)));
        }),
      ],
    });
    assert.equal(job.outcome?.kind, "completed", String(job.error || ""));
    const texts = statuses(job);
    assert.include(texts, "Continuing agent (page 1 · 0 of 4)");
    assert.isTrue(
      texts.every((text) => !/\d+\/\d+\)$/.test(text)),
      JSON.stringify(texts),
    );
  });

  it("lets a step read every paper of a job at once, past eight calls", async function () {
    readsFailingFor(new Set());
    const ids = papers(20);
    const turn = await runTurn({
      conversationKey,
      userText: "Read every paper in Drift",
      scope: scopeOf(ids),
      // A window the twenty papers fit in one pass: no page bounds the step.
      attached: { advanced: { inputTokenCap: 1_000_000 } as never },
      steps: [
        declareScope(),
        stepOf(...ids.map((itemId) => readCall(itemId))),
        finalStep("Every paper is read."),
      ],
    });
    assert.equal(turn.outcome?.kind, "completed", String(turn.error || ""));
    assert.isFalse(
      turn.events.some(
        (event) =>
          event.type === "provider_event" &&
          event.providerType === "agent_tool_call_overflow",
      ),
      "twenty reads for twenty papers are one step",
    );
    assert.lengthOf(outcome(settled(turn), "read-all").doneTargets!, 20);
    assert.deepEqual(settled(turn).end, { state: "completed" });
  });

  it("gives up on a paper that fails the same way twice and goes on, even through a segment of only failures", async function () {
    const ids = papers(50);
    // Papers 24 to 35 fail: a whole segment of rounds with no new result.
    const failing = new Set(ids.slice(23, 35));
    readsFailingFor(failing);
    let next = 0;
    let retried = false;
    const model = (messages: AgentModelMessage[]) => {
      const last = messages[messages.length - 1];
      const failed =
        last?.role === "tool" && String(last.content).includes(BROKEN);
      if (failed && !retried) {
        retried = true;
        return stepOf(readCall(ids[next - 1], `retry-${ids[next - 1]}`));
      }
      retried = false;
      if (next >= ids.length) return finalStep("Every paper is read.");
      return stepOf(readCall(ids[next++]));
    };
    const turn = await runTurn({
      conversationKey,
      userText: "Read every paper in Drift",
      scope: scopeOf(ids),
      attached: { advanced: { inputTokenCap: 1_000_000 } as never },
      steps: [declareScope(), ...Array.from({ length: 80 }, () => model)],
    });
    assert.equal(turn.outcome?.kind, "completed", String(turn.error || ""));
    assert.equal(turn.requests, 1 + 23 + 2 * 12 + 15 + 1);
    const part = outcome(settled(turn), "read-all");
    assert.lengthOf(part.doneTargets!, 38);
    assert.deepEqual(part.exceptions, [
      {
        targets: [...failing].map((itemId) => `item:${itemId}`),
        reason: BROKEN,
      },
    ]);
    assert.deepEqual(settled(turn).end, {
      state: "completed_with_exceptions",
    });
  });

  it("stops a job as interrupted when a page's worth of papers fail in a row", async function () {
    const ids = papers(6);
    readsFailingFor(new Set(ids));
    const asked = new Map<number, number>();
    const model = (messages: AgentModelMessage[]) => {
      const host = [...messages]
        .reverse()
        .map((message) => promptText([message]))
        .find((text) => text.startsWith("Long job"));
      const page = host
        ? [...host.matchAll(/^- itemId=(\d+)/gm)].map((match) =>
            Number(match[1]),
          )
        : [];
      const itemId = page.find((id) => (asked.get(id) || 0) < 2);
      if (itemId === undefined) return finalStep("Nothing could be read.");
      asked.set(itemId, (asked.get(itemId) || 0) + 1);
      return stepOf(readCall(itemId, `read-${itemId}-${asked.get(itemId)}`));
    };
    const turn = await runTurn({
      conversationKey,
      userText: "Read every paper in Drift",
      scope: scopeOf(ids),
      attached: { advanced: { inputTokenCap: 30_000 } as never },
      steps: [declareScope(), ...Array.from({ length: 20 }, () => model)],
    });
    assert.equal(turn.outcome?.kind, "completed", String(turn.error || ""));
    assert.equal(stopStatus(turn), "failed");
    const stop = turn.events.find(
      (event) =>
        event.type === "provider_event" &&
        event.providerType === "agent_run_stop",
    );
    assert.equal(
      (stop as { payload?: { rule?: string } }).payload?.rule,
      "page_failed",
    );
    assert.deepEqual(settled(turn).end, { state: "interrupted" });
    if (turn.outcome?.kind === "completed")
      assert.include(turn.outcome.text, "continue");
    // Two papers, each failing twice: a page's worth, and more than one.
    assert.equal(turn.requests, 1 + 4);
  });
});

describe("live runs that made every change, as runtime turns (2026-10-01)", function () {
  let environment: DirectJourneyEnvironment;
  let conversationKey = 996_000;

  beforeEach(async function () {
    environment = await installDirectJourneyEnvironment();
    libraryUpdateReceipt = undefined;
    liveReceipts = [];
    conversationKey += 10;
  });

  afterEach(function () {
    environment.restore();
    liveReceipts = [];
  });

  function call(
    id: string,
    name: string,
    args: Record<string, unknown>,
  ): AgentToolCall {
    return { id, name, arguments: args };
  }

  /** Each outcome as [local id, origin, status]. */
  function parts(ledger: ExecutionCheckpoint): string[][] {
    return ledger.tasks.map((task) => [
      task.taskId.slice(task.taskId.indexOf(":task:") + 6),
      String(task.origin),
      task.status,
    ]);
  }

  it("library.rename_delete_folder ends completed, each folder change closing its own part", async function () {
    liveReceipts = [...RENAME_DELETE_FOLDER.receipts];
    const turn = await runTurn({
      conversationKey,
      userText: RENAME_DELETE_FOLDER.userText,
      steps: [
        stepOf(
          call("declare-1", "task_update", RENAME_DELETE_FOLDER.taskUpdate),
        ),
        stepOf(
          call("rename-1", "library_update", {
            kind: "collection",
            action: "rename",
            collectionId: 11,
            newName: "New name loopmupsn7f0",
          }),
          call("delete-1", "library_update", {
            kind: "collection",
            action: "delete",
            collectionId: 12,
            deleteItems: false,
          }),
        ),
        finalStep("Renamed the folder and deleted the empty one."),
      ],
    });
    assert.equal(turn.outcome?.kind, "completed", String(turn.error || ""));
    const ledger = settled(turn);
    assert.deepEqual(ledger.end, { state: "completed" });
    assert.deepEqual(parts(ledger), [
      ["rename", "model", "completed"],
      ["delete", "model", "completed"],
    ]);
    const [rename, remove] = RENAME_DELETE_FOLDER.receipts;
    assert.deepEqual(outcome(ledger, "rename").verifiedReceiptIds, [rename.id]);
    assert.deepEqual(outcome(ledger, "delete").verifiedReceiptIds, [remove.id]);
  });

  it("library.discover_import ends completed, the import closing the part that asked for it", async function () {
    liveReceipts = [...DISCOVER_IMPORT.receipts];
    const turn = await runTurn({
      conversationKey,
      userText: DISCOVER_IMPORT.userText,
      steps: [
        stepOf(call("declare-1", "task_update", DISCOVER_IMPORT.taskUpdate)),
        // The literature search stands as one read.
        stepOf(
          paperRead("search-1"),
          call("create-1", "library_update", {
            kind: "collection",
            action: "create",
            name: "Drift new loopmupsn7f0",
          }),
        ),
        stepOf(
          call("import-1", "library_import", {
            kind: "identifiers",
            identifiers: [
              "10.1101/2025.02.04.636428",
              "10.1101/2025.10.21.683686",
            ],
            targetCollectionId: 9,
          }),
        ),
        finalStep("Both papers are in the new folder."),
      ],
    });
    assert.equal(turn.outcome?.kind, "completed", String(turn.error || ""));
    const ledger = settled(turn);
    assert.deepEqual(ledger.end, { state: "completed" });
    assert.deepEqual(parts(ledger), [
      ["search", "model", "completed"],
      ["collection", "model", "completed"],
      ["import", "model", "completed"],
    ]);
    const [create, imported] = DISCOVER_IMPORT.receipts;
    assert.deepEqual(outcome(ledger, "collection").verifiedReceiptIds, [
      create.id,
    ]);
    assert.deepEqual(outcome(ledger, "import").verifiedReceiptIds, [
      imported.id,
    ]);
  });
});
