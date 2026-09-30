import { assert } from "chai";
import { ActionContractRunSession } from "../src/agent/contracts/actionContractRunSession";
import { PaperEvidenceFrontier } from "../src/agent/context/paperEvidenceFrontier";
import { buildAgentResourceContextPlan } from "../src/agent/context/resourceContextPlan";
import { resolveAgentRuntimeRequest } from "../src/agent/context/resolvedAgentRequest";
import { createAgentExecutionContext } from "../src/agent/execution/context";
import {
  createToolExecution,
  type ToolExecutionDeps,
  type ToolExecutionRecord,
} from "../src/agent/execution/toolExecution";
import { PlanExecutionRunSession } from "../src/agent/plans/runSession";
import { initAgentChangeJournal } from "../src/agent/store/changeJournal";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { stateChangeInvocationPlan } from "../src/agent/authorization/invocationPlan";
import type { AgentPendingReadActivity } from "../src/agent/context/resourceContextPlan";
import type { MaterialRef } from "../src/agent/documents/materialRef";
import type { AgentToolResultHandleRecord } from "../src/agent/store/toolResultHandles";
import type { OutcomeEffect } from "../src/agent/execution/types";
import type {
  AgentEvent,
  AgentModelCapabilities,
  AgentRuntimeRequest,
  AgentToolContext,
  ExecutionCheckpoint,
  ExecutionTaskStatus,
} from "../src/agent/types";
import { classifiedFixture } from "./helpers/semanticIntent";
import { installMockDb } from "./helpers/agentRuntimeMockDb";
import { createTestActionContractService } from "./helpers/actionContractService";

const CAPABILITIES: AgentModelCapabilities = {
  streaming: false,
  toolCalls: true,
  multimodal: false,
};

function registerReadTool(registry: AgentToolRegistry): void {
  registry.register({
    spec: {
      name: "library_search",
      description: "search",
      inputSchema: { type: "object" },
      executionClass: "read",
      workCategory: "retrieval",
    },
    presentation: { label: "Search library" },
    validate: (args: unknown) => ({ ok: true, value: args as never }),
    execute: async () => ({ content: { hits: ["paper-1"] } }),
  } as never);
}

function registerWriteTool(registry: AgentToolRegistry): void {
  registry.register({
    effectOperations: ["note_create"],
    spec: {
      name: "note_write",
      description: "write a note",
      inputSchema: { type: "object" },
      executionClass: "external_effect",
      workCategory: "zotero_action",
      requiresConfirmation: false,
    },
    presentation: { label: "Write note" },
    validate: (args: unknown) => ({ ok: true, value: args as never }),
    planInvocation: async () =>
      stateChangeInvocationPlan({
        reversibility: "full",
        reason: "Test note write.",
      }),
    describeAction: () => [
      {
        id: "note_create:collaborator-test",
        proofDomain: "zotero_state",
        capability: "zotero.notes",
        operation: "note_create",
        source: "zotero_native",
        requestedTargets: [],
        destinationCollectionIds: [],
      },
    ],
    execute: async () => ({
      content: { status: "created", noteId: 700 },
      effect: "applied",
    }),
  } as never);
}

function registerDocumentTool(registry: AgentToolRegistry): void {
  registry.register({
    spec: {
      name: "submit_document",
      description: "submit",
      inputSchema: { type: "object" },
      executionClass: "read",
      workCategory: "generation",
    },
    validate: (args: unknown) => ({ ok: true, value: args as never }),
    execute: async () => ({ content: { documentId: "doc-1" } }),
    resolveTerminalResult: async () => ({
      finalText: "The document is ready.",
      documentId: "doc-1",
      providerTranscript: "tool_only",
    }),
  } as never);
}

/** An ordinary-turn checkpoint holding one declared part per entry. */
function checkpointWith(
  tasks: Array<
    [description: string, status: ExecutionTaskStatus, effect: OutcomeEffect]
  >,
): ExecutionCheckpoint {
  return {
    version: 1,
    executionId: "run-collaborator",
    conversationKey: 970_001,
    conversationGeneration: 0,
    tasks: tasks.map(([description, status, effect], index) => ({
      taskId: `task-${index + 1}`,
      description,
      dependencies: [],
      status,
      effect,
      origin: "model" as const,
      journalActionIds: [],
      verifiedReceiptIds: [],
      readEvidenceIds: [],
      materialRefs: [],
      createdAt: 1,
      updatedAt: 1,
    })),
    createdAt: 1,
    updatedAt: 1,
  };
}

type Harness = {
  deps: ToolExecutionDeps;
  events: AgentEvent[];
  request: AgentRuntimeRequest;
  records: ToolExecutionRecord[];
  reads: AgentPendingReadActivity[];
  answerText: { value: string };
  finalizedMaterial: {
    value: { documentId: string; finalText: string } | null;
  };
  toolResultReadAvailable: { value: boolean };
  workflowSummaries: string[];
};

async function createHarness(registry: AgentToolRegistry): Promise<Harness> {
  const events: AgentEvent[] = [];
  const emit = async (event: AgentEvent) => {
    events.push(event);
  };
  const request = resolveAgentRuntimeRequest(
    {
      classifiedIntent: classifiedFixture(),
      conversationKey: 970_001,
      mode: "agent",
      libraryID: 1,
      userText: "Find it and note it",
      model: "test",
      apiKey: "test",
      apiBase: "https://example.invalid",
    },
    {},
  ) as AgentRuntimeRequest;
  // A turn stamps its execution context before anything runs; it is what
  // tells the contract session this is an ordinary agent turn.
  request.executionContext ||= createAgentExecutionContext(
    request,
    "run-collaborator",
  );
  const answerText = { value: "streamed so far" };
  const finalizedMaterial: Harness["finalizedMaterial"] = { value: null };
  const toolResultReadAvailable = { value: false };
  const records: ToolExecutionRecord[] = [];
  const reads: AgentPendingReadActivity[] = [];
  const workflowSummaries: string[] = [];
  const handles: AgentToolResultHandleRecord[] = [];
  const context = {
    request,
    runId: "run-collaborator",
    item: null,
    currentAnswerText: "",
    modelName: "test",
    signal: undefined,
    checkpointActionProgress: async () => undefined,
    publishPlanEvent: async () => undefined,
    updateExecutionCheckpoint: async (
      apply: (checkpoint: ExecutionCheckpoint) => ExecutionCheckpoint,
    ) => apply(request.executionCheckpoint!),
  } as unknown as AgentToolContext;
  const deps: ToolExecutionDeps = {
    registry,
    now: () => 1_700_000_000_000,
    signal: undefined,
    emit,
    request,
    runId: "run-collaborator",
    context,
    writeAllowed: () => true,
    adapterCapabilities: CAPABILITIES,
    actionContractSession: new ActionContractRunSession({
      request,
      contracts: registry,
      emit,
    }),
    activePlanSession: new PlanExecutionRunSession(request, async () => {}),
    paperEvidenceFrontier: new PaperEvidenceFrontier(),
    resourceContextPlan: buildAgentResourceContextPlan(request),
    persistToolResultHandles: async (written) => {
      handles.push(...written);
    },
    requestActionResolution: async () => {
      throw new Error("no confirmation is expected in this test");
    },
    finalizedMaterialRefs: new Map<string, MaterialRef>(),
    pendingReadActivities: reads,
    preservedTurnHandleRecords: handles,
    toolExecutionRecords: records,
    toolsUsedThisTurn: [],
    workflowSummaries,
    getCurrentAnswerText: () => answerText.value,
    setFinalizedMaterial: (material) => {
      finalizedMaterial.value = material;
    },
    setToolResultReadAvailable: (available) => {
      toolResultReadAvailable.value = available;
    },
  } as ToolExecutionDeps;
  // The turn initializes its contract session before any tool runs; without
  // it no effect is authorized and every write fails closed.
  await deps.actionContractSession.initialize({ checkpoint: null });
  // Only what the collaborator itself publishes is under test here.
  events.length = 0;
  return {
    deps,
    events,
    request,
    records,
    reads,
    answerText,
    finalizedMaterial,
    toolResultReadAvailable,
    workflowSummaries,
  };
}

describe("agent tool execution collaborator", function () {
  it("publishes a read call's stages, events and delivery", async function () {
    const restoreDb = installMockDb();
    try {
      const registry = new AgentToolRegistry(createTestActionContractService());
      registerReadTool(registry);
      const harness = await createHarness(registry);
      const toolExecution = createToolExecution(harness.deps);

      const outcome = await toolExecution.executeToolWorkflow(
        { id: "call-read", name: "library_search", arguments: { q: "brain" } },
        1,
        { modelCallId: "call-read" },
      );

      assert.deepEqual(
        harness.events.map((event) => [
          event.type,
          event.type === "agent_stage" ? event.status : "",
        ]),
        [
          ["agent_stage", "started"],
          ["tool_call", ""],
          ["agent_stage", "completed"],
          ["tool_result", ""],
        ],
        "a read opens its stage, publishes the call, closes the stage, then publishes the result",
      );
      const [started, call, completed, result] = harness.events as [
        Extract<AgentEvent, { type: "agent_stage" }>,
        Extract<AgentEvent, { type: "tool_call" }>,
        Extract<AgentEvent, { type: "agent_stage" }>,
        Extract<AgentEvent, { type: "tool_result" }>,
      ];
      assert.deepEqual(
        [started.stage, started.callId, started.toolLabel],
        ["retrieval", "call-read", "Search library"],
      );
      assert.deepEqual(
        [call.name, call.callId, call.toolLabel, call.workCategory],
        ["library_search", "call-read", "Search library", "retrieval"],
      );
      assert.deepEqual(call.args, { q: "brain" });
      assert.isUndefined(
        completed.receiptIds,
        "a read produces no receipts to carry",
      );
      assert.deepEqual(
        [result.name, result.ok, result.callId],
        ["library_search", true, "call-read"],
      );

      assert.isTrue(outcome.toolResult.ok);
      assert.deepEqual(outcome.toolResult.content, { hits: ["paper-1"] });
      assert.isUndefined(outcome.stopRun);
      assert.deepEqual(outcome.delivery, {
        callId: "call-read",
        name: "library_search",
        content: { hits: ["paper-1"], actionReceipts: [] },
        followupMessages: [],
      });

      assert.deepEqual(
        harness.records.map((record) => [
          record.name,
          record.ok,
          record.mutability,
        ]),
        [["library_search", true, "read"]],
      );
      assert.deepEqual(
        harness.reads.map((read) => [read.toolName, read.toolLabel]),
        [["library_search", "Search library"]],
        "a successful read is queued for the turn's read ledger",
      );
      assert.isNull(
        harness.finalizedMaterial.value,
        "a read finalizes no material",
      );
    } finally {
      restoreDb();
    }
  });

  it("publishes a write call's stages, receipts and delivery", async function () {
    const restoreDb = installMockDb();
    try {
      await initAgentChangeJournal();
      const registry = new AgentToolRegistry(createTestActionContractService());
      registerWriteTool(registry);
      const harness = await createHarness(registry);
      const toolExecution = createToolExecution(harness.deps);

      const outcome = await toolExecution.executeToolWorkflow(
        { id: "call-write", name: "note_write", arguments: { text: "body" } },
        2,
        { modelCallId: "provider-write" },
      );

      assert.deepEqual(
        harness.events.map((event) => [
          event.type,
          event.type === "agent_stage" ? event.status : "",
        ]),
        [
          ["agent_stage", "started"],
          ["tool_call", ""],
          ["agent_stage", "completed"],
          ["tool_result", ""],
        ],
        "a write publishes the same sequence as a read",
      );
      const closing = harness.events[2] as Extract<
        AgentEvent,
        { type: "agent_stage" }
      >;
      const result = harness.events[3] as Extract<
        AgentEvent,
        { type: "tool_result" }
      >;
      assert.equal(closing.stage, "zotero_action");
      assert.isNotEmpty(
        result.actionReceipts || [],
        "a write publishes the receipts it produced",
      );
      assert.deepEqual(
        closing.receiptIds,
        (result.actionReceipts || []).map((receipt) => receipt.id),
        "the closing stage carries the receipts of its own call",
      );
      assert.equal(result.effect, "applied");

      assert.isTrue(outcome.toolResult.ok);
      assert.equal(
        outcome.delivery?.callId,
        "provider-write",
        "the delivery answers the provider's call id, not the host's",
      );
      assert.deepEqual(outcome.delivery?.content, {
        status: "created",
        noteId: 700,
        actionReceipts: outcome.toolResult.actionReceipts,
      });
      assert.deepEqual(outcome.delivery?.followupMessages, []);

      assert.deepEqual(
        harness.records.map((record) => [
          record.name,
          record.ok,
          record.mutability,
        ]),
        [["note_write", true, "write"]],
      );
      assert.deepEqual(
        harness.reads.map((read) => [read.toolName, read.toolLabel]),
        [["note_write", "Write note"]],
        "every successful call, write included, is queued for the turn's activity ledger",
      );
    } finally {
      restoreDb();
    }
  });

  it("publishes a failing call's error and closes its stage as failed", async function () {
    const restoreDb = installMockDb();
    try {
      const registry = new AgentToolRegistry(createTestActionContractService());
      registry.register({
        spec: {
          name: "library_search",
          description: "search",
          inputSchema: { type: "object" },
          executionClass: "read",
          workCategory: "retrieval",
        },
        presentation: { label: "Search library" },
        validate: (args: unknown) => ({ ok: true, value: args as never }),
        execute: async () => {
          throw new Error("index unavailable");
        },
      } as never);
      const harness = await createHarness(registry);
      const toolExecution = createToolExecution(harness.deps);

      const executed = await toolExecution.executePreparedToolCall(
        { id: "call-fail", name: "library_search", arguments: {} },
        1,
      );

      assert.deepEqual(
        harness.events.map((event) => [
          event.type,
          event.type === "agent_stage" ? event.status : "",
        ]),
        [
          ["agent_stage", "started"],
          ["tool_call", ""],
          ["tool_error", ""],
          ["agent_stage", "failed"],
          ["tool_result", ""],
        ],
        "the error is published before the stage closes as failed",
      );
      const error = harness.events[2] as Extract<
        AgentEvent,
        { type: "tool_error" }
      >;
      assert.equal(error.callId, "call-fail");
      assert.equal(error.round, 1);
      assert.include(String(error.error), "index unavailable");
      assert.isFalse(executed.toolResult.ok);
      assert.deepEqual(
        harness.reads,
        [],
        "a failed read is never queued for the read ledger",
      );
    } finally {
      restoreDb();
    }
  });

  it("carries the live answer text and the tool's own follow-up message into a delivery", async function () {
    const restoreDb = installMockDb();
    try {
      const registry = new AgentToolRegistry(createTestActionContractService());
      const seenAnswerText: string[] = [];
      registry.register({
        spec: {
          name: "library_search",
          description: "search",
          inputSchema: { type: "object" },
          executionClass: "read",
          workCategory: "retrieval",
        },
        validate: (args: unknown) => ({ ok: true, value: args as never }),
        execute: async () => ({ content: { hits: [] } }),
        buildFollowupMessage: async (
          _result: unknown,
          context: AgentToolContext,
        ) => {
          seenAnswerText.push(context.currentAnswerText || "");
          return { role: "user", content: "tool-followup" };
        },
      } as never);
      const harness = await createHarness(registry);
      const toolExecution = createToolExecution(harness.deps);
      harness.answerText.value = "the answer as it stands now";

      const delivery = await toolExecution.buildToolDelivery(
        {
          callId: "call-delivery",
          name: "library_search",
          ok: true,
          actionReceipts: [],
          content: { hits: [] },
        },
        "provider-delivery",
        registry.getTool("library_search"),
        { replaced: true },
        [{ role: "user", content: "extra-followup" }],
      );

      assert.deepEqual(
        seenAnswerText,
        ["the answer as it stands now"],
        "the tool reads the answer text as it is now, not as it was at build time",
      );
      assert.deepEqual(delivery, {
        callId: "provider-delivery",
        name: "library_search",
        content: { replaced: true, actionReceipts: [] },
        followupMessages: [
          { role: "user", content: "extra-followup" },
          { role: "user", content: "tool-followup" },
        ],
      });
    } finally {
      restoreDb();
    }
  });

  it("records the material a terminal result finalized and reports the remaining work", async function () {
    const restoreDb = installMockDb();
    try {
      const registry = new AgentToolRegistry(createTestActionContractService());
      registerDocumentTool(registry);
      const harness = await createHarness(registry);
      const toolExecution = createToolExecution(harness.deps);

      const outcome = await toolExecution.executeToolWorkflow(
        { id: "call-submit", name: "submit_document", arguments: {} },
        1,
        { modelCallId: "provider-submit" },
      );

      assert.deepEqual(
        harness.finalizedMaterial.value,
        { documentId: "doc-1", finalText: "The document is ready." },
        "the turn is told which material this call finalized, through the setter",
      );
      // An ordinary agent turn holds no semantic action contract, so the
      // final evaluation cannot accept: the material is kept and the model
      // is told what is left rather than the run stopping here.
      assert.isUndefined(outcome.stopRun);
      assert.isUndefined(outcome.finalText);
      assert.equal(outcome.delivery?.callId, "provider-submit");
      assert.deepEqual(outcome.delivery?.content, {
        content: { documentId: "doc-1" },
        remainingWork:
          "A current semantic action contract is unavailable; no completed action can be claimed.",
        finalizedDocumentId: "doc-1",
        instruction:
          "The material is finalized and preserved. Complete the remaining authorized actions using this finalized payload; do not regenerate the document.",
        actionReceipts: [],
      });
    } finally {
      restoreDb();
    }
  });

  it("hands an accepted document back while declared parts beyond the answer remain open, naming only those", async function () {
    const restoreDb = installMockDb();
    try {
      const registry = new AgentToolRegistry(createTestActionContractService());
      registerDocumentTool(registry);
      const harness = await createHarness(registry);
      // An ordinary turn carries no semantic intent, so both final
      // evaluations accept the document.
      harness.request.classifiedIntent = undefined;
      harness.request.executionCheckpoint = checkpointWith([
        ["Summarize the paper", "pending", "answer"],
        ["Save the summary as a note", "pending", "mutation"],
        ["Tag the paper", "pending", "mutation"],
        ["Read the paper", "completed", "read"],
        ["Ask which collection to use", "blocked", "mutation"],
        ["Check the citation style", "skipped", "artifact"],
      ]);
      const toolExecution = createToolExecution(harness.deps);

      const open = await toolExecution.executeToolWorkflow(
        { id: "call-submit", name: "submit_document", arguments: {} },
        1,
        { modelCallId: "provider-submit" },
      );

      assert.isUndefined(open.stopRun, "open work keeps the turn running");
      assert.deepEqual(open.delivery?.content, {
        content: { documentId: "doc-1" },
        remainingWork: "Save the summary as a note; Tag the paper",
        finalizedDocumentId: "doc-1",
        instruction:
          "The document is finalized and preserved. Complete any remaining requested work with this finalized document, passing its documentId where a tool accepts one; do not regenerate it.",
        actionReceipts: [],
      });

      // The document itself answers a declared reasoning part.
      harness.request.executionCheckpoint = checkpointWith([
        ["Summarize the paper", "pending", "answer"],
        ["Read the paper", "completed", "read"],
        ["Ask which collection to use", "blocked", "mutation"],
      ]);
      const closed = await toolExecution.executeToolWorkflow(
        { id: "call-submit-2", name: "submit_document", arguments: {} },
        1,
        { modelCallId: "provider-submit-2", followingCallCount: 0 },
      );

      assert.isTrue(closed.stopRun, "with nothing open the document ends it");
      assert.equal(closed.finalText, "The document is ready.");
      assert.equal(closed.documentId, "doc-1");
    } finally {
      restoreDb();
    }
  });

  it("refuses to execute once the conversation stops accepting writes", async function () {
    const restoreDb = installMockDb();
    try {
      const registry = new AgentToolRegistry(createTestActionContractService());
      registerReadTool(registry);
      const harness = await createHarness(registry);
      const deps = { ...harness.deps, writeAllowed: () => false };
      const toolExecution = createToolExecution(deps);

      const outcome = await toolExecution.executeToolWorkflow(
        { id: "call-late", name: "library_search", arguments: {} },
        1,
      );

      assert.deepEqual(harness.events, [], "a refused call publishes nothing");
      assert.isTrue(outcome.failed);
      assert.isTrue(outcome.stopRun);
      assert.isFalse(outcome.toolResult.ok);
      assert.equal(
        outcome.finalText,
        "Conversation lifecycle changed before execution.",
      );
      assert.deepEqual(
        (outcome.toolResult.actionReceipts || []).map(
          (receipt) => receipt.verification,
        ),
        ["unverified"],
      );
    } finally {
      restoreDb();
    }
  });
});
