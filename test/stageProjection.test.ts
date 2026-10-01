import { assert } from "chai";
import { readFileSync } from "node:fs";
import { AgentRuntime } from "../src/agent/runtime";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { initAgentChangeJournal } from "../src/agent/store/changeJournal";
import { stateChangeInvocationPlan } from "../src/agent/authorization/invocationPlan";
import { projectStageEvents } from "../src/modules/contextPanel/agentTrace/stageProjection";
import { buildAgentStageEvent } from "../src/agent/stageEvents";
import { mapCodexNativeItemToEvents } from "../src/codexAppServer/nativeActivityStages";
import { createCodexNativeActivityTraceControllerForTests } from "../src/modules/contextPanel/codexNativeTrace/controller";
import { classifiedFixture } from "./helpers/semanticIntent";
import { createTestActionContractService } from "./helpers/actionContractService";
import { installMockDb } from "./helpers/agentRuntimeMockDb";
import type {
  AgentEvent,
  AgentModelCapabilities,
  AgentModelStep,
  AgentRunEventRecord,
  AgentRuntimeRequest,
  AgentToolContext,
} from "../src/agent/types";
import type {
  AgentModelAdapter,
  AgentStepParams,
} from "../src/agent/model/adapter";

type StageEvent = Extract<AgentEvent, { type: "agent_stage" }>;

class ScriptedAdapter implements AgentModelAdapter {
  private stepIndex = 0;

  constructor(
    private readonly steps: AgentModelStep[],
    private readonly capabilities: AgentModelCapabilities,
  ) {}

  getCapabilities(_request: AgentRuntimeRequest): AgentModelCapabilities {
    return this.capabilities;
  }

  supportsTools(_request: AgentRuntimeRequest): boolean {
    return this.capabilities.toolCalls;
  }

  async runStep(_params: AgentStepParams): Promise<AgentModelStep> {
    const step = this.steps[this.stepIndex];
    this.stepIndex += 1;
    return step;
  }
}

function toolCallStep(id: string, name: string): AgentModelStep {
  const call = { id, name, arguments: {} };
  return {
    kind: "tool_calls",
    calls: [call],
    assistantMessage: { role: "assistant", content: "", tool_calls: [call] },
  };
}

function finalStep(text: string): AgentModelStep {
  return {
    kind: "final",
    text,
    assistantMessage: { role: "assistant", content: text },
  };
}

const MATERIAL_REF = {
  documentId: "doc-guide-1",
  documentVersion: 2,
  contentHash: "sha256:guide",
};

const BATCH_ITEM_REF = {
  documentId: "doc-batch-1",
  documentVersion: 1,
  contentHash: "sha256:batch",
};

/** An old plan artifact, as plan mode stored it in its events. */
function planArtifact(status: "drafting" | "awaiting_approval") {
  return {
    version: 1,
    planId: "plan-1",
    conversationKey: 991_201,
    provider: "agent",
    revision: status === "drafting" ? 1 : 2,
    digest: `sha256:plan-${status}`,
    status,
    steps: [],
    createdAt: 1,
    updatedAt: 2,
  };
}

/** The tools of the live run whose events the projection has to reproduce. */
function registerJourneyTools(registry: AgentToolRegistry): void {
  registry.register({
    spec: {
      name: "library_search",
      description: "search",
      inputSchema: { type: "object" },
      executionClass: "read",
      workCategory: "retrieval",
    },
    presentation: { label: "Search library" },
    validate: (args) => ({ ok: true, value: args as never }),
    execute: async () => ({ content: { hits: [] } }),
  } as never);
  registry.register({
    spec: {
      name: "paper_read",
      description: "read",
      inputSchema: { type: "object" },
      executionClass: "read",
      workCategory: "retrieval",
    },
    presentation: { label: "Read paper" },
    validate: (args) => ({ ok: true, value: args as never }),
    execute: async () => {
      throw new Error("the paper is unavailable");
    },
  } as never);
  registry.register({
    spec: {
      name: "plan_draft",
      description: "draft a plan",
      inputSchema: { type: "object" },
      executionClass: "read",
      workCategory: "planning",
    },
    presentation: { label: "Draft plan" },
    validate: (args) => ({ ok: true, value: args as never }),
    execute: async (_input: unknown, context: AgentToolContext) => {
      await context.publishPlanEvent?.({
        type: "plan_updated",
        artifact: planArtifact("drafting"),
      });
      await context.publishPlanEvent?.({
        type: "plan_ready",
        artifact: planArtifact("awaiting_approval"),
      });
      return { content: { status: "planned" } };
    },
  } as never);
  registry.register({
    spec: {
      name: "submit_document",
      description: "finalize material",
      inputSchema: { type: "object" },
      executionClass: "read",
      workCategory: "generation",
    },
    presentation: { label: "Submit document" },
    validate: (args) => ({ ok: true, value: args as never }),
    execute: async () => ({
      content: { status: "finalized" },
      materialRef: MATERIAL_REF,
      materialKind: "guide",
      materialTitle: "Representational drift",
    }),
  } as never);
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
    validate: (args) => ({ ok: true, value: args as never }),
    planInvocation: async () =>
      stateChangeInvocationPlan({
        reversibility: "full",
        reason: "Test note write.",
      }),
    describeAction: () => [
      {
        id: "note_create:projection-test",
        proofDomain: "zotero_state",
        capability: "zotero.notes",
        operation: "note_create",
        source: "zotero_native",
        requestedTargets: [],
        destinationCollectionIds: [],
      },
    ],
    execute: async () => ({
      content: { status: "created", noteId: 900 },
      effect: "applied",
    }),
  } as never);
  registry.register({
    spec: {
      name: "note_write_batch",
      description: "write notes in a batch",
      inputSchema: { type: "object" },
      executionClass: "read",
      workCategory: "zotero_action",
    },
    presentation: { label: "Write notes" },
    validate: (args) => ({ ok: true, value: args as never }),
    execute: async () => ({
      content: { status: "done" },
      batchItems: [
        {
          batchId: "batch-1",
          itemKey: "item:1",
          materialRef: BATCH_ITEM_REF,
          status: "saved",
          written: true,
          noteId: 501,
        },
        {
          batchId: "batch-1",
          itemKey: "item:2",
          status: "failed",
          written: false,
          error: "Zotero refused the note write",
        },
        {
          batchId: "batch-1",
          itemKey: "item:3",
          status: "pending",
          written: false,
        },
      ],
    }),
  } as never);
}

/** One live run through every event the projection has a rule for. */
async function runLiveJourney(): Promise<AgentEvent[]> {
  const restoreDb = installMockDb();
  try {
    await initAgentChangeJournal();
    const registry = new AgentToolRegistry(createTestActionContractService());
    registerJourneyTools(registry);
    const events: AgentEvent[] = [];
    const runtime = new AgentRuntime({
      registry,
      adapterFactory: () =>
        new ScriptedAdapter(
          [
            toolCallStep("read-1", "library_search"),
            toolCallStep("read-2", "paper_read"),
            toolCallStep("plan-1", "plan_draft"),
            toolCallStep("doc-1", "submit_document"),
            toolCallStep("write-1", "note_write"),
            toolCallStep("batch-1", "note_write_batch"),
            finalStep("Done."),
          ],
          { streaming: false, toolCalls: true, multimodal: false },
        ),
    });
    const outcome = await runtime.runTurn({
      request: {
        classifiedIntent: classifiedFixture(),
        conversationKey: 991_201,
        mode: "agent",
        libraryID: 1,
        userText: "Find it, write it up and note it",
        model: "test",
        apiKey: "test",
        apiBase: "https://example.invalid",
      },
      onEvent: (event) => events.push(event),
    });
    assert.equal(outcome.kind, "completed");
    return events;
  } finally {
    restoreDb();
  }
}

function records(events: AgentEvent[]): AgentRunEventRecord[] {
  return events.map((payload, index) => ({
    runId: "run-projection",
    seq: index + 1,
    eventType: payload.type,
    payload,
    createdAt: 1_700_000_000_000 + index,
  }));
}

/** How a record reads in a sequence assertion: type, plus a stage's outcome. */
function shape(entry: AgentRunEventRecord): string {
  return entry.payload.type === "agent_stage"
    ? `agent_stage:${entry.payload.stage}:${entry.payload.status}`
    : entry.payload.type;
}

function stagePayloads(entries: AgentRunEventRecord[]): StageEvent[] {
  return entries
    .map((entry) => entry.payload)
    .filter((payload): payload is StageEvent => payload.type === "agent_stage");
}

/** A projected stage without the marker that says it was projected. */
function withoutProjectionMarkers(stage: StageEvent): StageEvent {
  const copy = { ...stage } as Record<string, unknown>;
  delete copy.projected;
  delete copy.undifferentiated;
  return copy as StageEvent;
}

describe("agent trace stage projection", function () {
  describe("a Phase 3 trace, against the live run it came from", function () {
    let live: AgentEvent[] = [];

    before(async function () {
      live = await runLiveJourney();
    });

    it("synthesizes the stage events the runtime emitted, in place", function () {
      const legacy = records(
        live.filter((event) => event.type !== "agent_stage"),
      );
      const projected = projectStageEvents(legacy);
      assert.deepEqual(
        projected.map(shape),
        records(live).map(shape),
        "a projected trace interleaves exactly like the live run",
      );
      assert.deepEqual(
        stagePayloads(projected).map(withoutProjectionMarkers),
        live.filter(
          (event): event is StageEvent => event.type === "agent_stage",
        ),
        "every projected stage carries the fields the live stage carried",
      );
    });

    it("marks every synthesized stage as projected", function () {
      const legacy = records(
        live.filter((event) => event.type !== "agent_stage"),
      );
      const projected = projectStageEvents(legacy);
      const stages = stagePayloads(projected);
      assert.isNotEmpty(stages);
      assert.isTrue(
        stages.every((stage) => stage.projected === true),
        "a reader must be able to tell a reconstructed stage from a recorded one",
      );
      assert.isTrue(
        stages.every((stage) => stage.undifferentiated === undefined),
        "a trace that declared its categories is never undifferentiated",
      );
    });

    it("keeps the projected stages ordered and inside the original order", function () {
      const legacy = records(
        live.filter((event) => event.type !== "agent_stage"),
      );
      const projected = projectStageEvents(legacy);
      const seqs = projected.map((entry) => entry.seq);
      assert.deepEqual(
        seqs.slice().sort((left, right) => left - right),
        seqs,
        "sequence numbers stay ascending once stages are interleaved",
      );
      assert.deepEqual(
        projected
          .filter((entry) => entry.payload.type !== "agent_stage")
          .map((entry) => entry.seq),
        legacy.map((entry) => entry.seq),
        "an original event keeps its own sequence number",
      );
      assert.deepEqual(
        projected
          .filter((entry) => entry.payload.type !== "agent_stage")
          .map((entry) => entry.payload),
        legacy.map((entry) => entry.payload),
        "an original event is carried through untouched",
      );
    });

    it("is idempotent", function () {
      const legacy = records(
        live.filter((event) => event.type !== "agent_stage"),
      );
      const once = projectStageEvents(legacy);
      const twice = projectStageEvents(once);
      assert.strictEqual(twice, once, "a projected trace is returned as it is");
    });
  });

  it("returns a trace that already has stage events by reference", async function () {
    const legacy = records(await runLiveJourney());
    assert.strictEqual(projectStageEvents(legacy), legacy);
  });

  it("has nothing to do for a run the Codex bridge staged itself", function () {
    // The bridge now emits the stages this projection used to synthesize, so
    // a new native run must pass through untouched -- and the stages it
    // emitted must be the ones the projection would have written, or a run
    // recorded today and one recorded last month would read differently.
    const message: {
      role: "assistant";
      text: string;
      timestamp: number;
      runMode: "agent";
      pendingAgentTraceEvents?: AgentRunEventRecord[];
    } = { role: "assistant", text: "", timestamp: 1, runMode: "agent" };
    const controller = createCodexNativeActivityTraceControllerForTests(
      message as never,
      () => undefined,
    );
    controller.appendItemStatus(
      { id: "ws-1", type: "web_search", query: "drift" },
      "started",
    );
    controller.appendItemStatus(
      { id: "ws-1", type: "web_search", query: "drift" },
      "completed",
    );
    controller.noteMcpToolActivity({
      requestId: "jsonrpc:3",
      phase: "completed",
      toolName: "write_note",
      toolLabel: "Write note",
      serverName: "llm_for_zotero",
      workCategory: "zotero_action",
      ok: true,
    });
    const live = message.pendingAgentTraceEvents || [];
    assert.deepEqual(live.map(shape), [
      "agent_stage:retrieval:completed",
      "codex_tool_activity",
      "agent_stage:zotero_action:completed",
      "codex_tool_activity",
    ]);
    assert.strictEqual(projectStageEvents(live), live);

    // The same trace without its stages projects to the same sequence.
    const withoutStages = live.filter(
      (entry) => entry.payload.type !== "agent_stage",
    );
    assert.deepEqual(
      projectStageEvents(withoutStages).map(shape),
      live.map(shape),
    );
  });

  it("projects a pre-Phase-0 trace to one undifferentiated stage", function () {
    const legacy: AgentRunEventRecord[] = [
      {
        runId: "run-old",
        seq: 1,
        eventType: "status",
        payload: { type: "status", text: "Working" },
        createdAt: 10,
      },
      {
        runId: "run-old",
        seq: 2,
        eventType: "tool_call",
        payload: {
          type: "tool_call",
          callId: "call-1",
          name: "library_search",
          args: {},
        },
        createdAt: 11,
      },
      {
        runId: "run-old",
        seq: 3,
        eventType: "tool_result",
        payload: {
          type: "tool_result",
          callId: "call-1",
          name: "library_search",
          ok: true,
          actionReceipts: [],
          content: {},
        },
        createdAt: 12,
      },
      {
        runId: "run-old",
        seq: 4,
        eventType: "final",
        payload: { type: "final", text: "Done." },
        createdAt: 13,
      },
    ];
    const projected = projectStageEvents(legacy);
    const stages = stagePayloads(projected);
    assert.lengthOf(stages, 1, "one stage stands for the whole run");
    assert.deepEqual(stages[0], {
      type: "agent_stage",
      stage: "retrieval",
      status: "started",
      projected: true,
      undifferentiated: true,
    });
    assert.deepEqual(
      projected.map(shape),
      [
        "status",
        "agent_stage:retrieval:started",
        "tool_call",
        "tool_result",
        "final",
      ],
      "the one stage opens before the first work it stands for",
    );
    assert.strictEqual(
      projectStageEvents(projected),
      projected,
      "projecting an already projected legacy trace changes nothing",
    );
  });

  it("never guesses a category from a tool name", function () {
    const legacy: AgentRunEventRecord[] = [
      {
        runId: "run-old",
        seq: 1,
        eventType: "tool_call",
        payload: {
          type: "tool_call",
          callId: "call-1",
          name: "note_write",
          args: {},
        },
        createdAt: 1,
      },
      {
        runId: "run-old",
        seq: 2,
        eventType: "tool_result",
        payload: {
          type: "tool_result",
          callId: "call-1",
          name: "note_write",
          ok: true,
          actionReceipts: [],
          content: {},
        },
        createdAt: 2,
      },
    ];
    const stages = stagePayloads(projectStageEvents(legacy));
    assert.deepEqual(
      stages.map((stage) => [stage.stage, stage.status]),
      [["retrieval", "started"]],
      "a write tool with no declared category stays undifferentiated",
    );
    assert.isTrue(stages[0].undifferentiated);
  });

  it("leaves a trace with no tool work alone", function () {
    const legacy: AgentRunEventRecord[] = [
      {
        runId: "run-empty",
        seq: 1,
        eventType: "message_delta",
        payload: { type: "message_delta", text: "Hello" },
        createdAt: 1,
      },
      {
        runId: "run-empty",
        seq: 2,
        eventType: "final",
        payload: { type: "final", text: "Hello" },
        createdAt: 2,
      },
    ];
    assert.strictEqual(
      projectStageEvents(legacy),
      legacy,
      "a run with nothing to group gets no empty group",
    );
  });

  it("closes a stage at a tool error no result ever answered", function () {
    const legacy: AgentRunEventRecord[] = [
      {
        runId: "run-cut",
        seq: 1,
        eventType: "tool_call",
        payload: {
          type: "tool_call",
          callId: "call-1",
          name: "library_search",
          args: {},
          toolLabel: "Search library",
          workCategory: "retrieval",
        },
        createdAt: 1,
      },
      {
        runId: "run-cut",
        seq: 2,
        eventType: "tool_error",
        payload: {
          type: "tool_error",
          callId: "call-1",
          name: "library_search",
          error: "the library is unavailable",
          round: 1,
          toolLabel: "Search library",
          workCategory: "retrieval",
        },
        createdAt: 2,
      },
    ];
    const projected = projectStageEvents(legacy);
    assert.deepEqual(projected.map(shape), [
      "agent_stage:retrieval:started",
      "tool_call",
      "tool_error",
      "agent_stage:retrieval:failed",
    ]);
  });

  it("opens planning on a draft and closes it on a reviewable plan", function () {
    const legacy: AgentRunEventRecord[] = [
      {
        runId: "run-plan",
        seq: 1,
        eventType: "plan_updated",
        payload: { type: "plan_updated", artifact: planArtifact("drafting") },
        createdAt: 1,
      },
      {
        runId: "run-plan",
        seq: 2,
        eventType: "plan_execution_updated",
        payload: {
          type: "plan_execution_updated",
          ledger: { executionId: "exec-1" },
        } as never,
        createdAt: 2,
      },
      {
        runId: "run-plan",
        seq: 3,
        eventType: "plan_ready",
        payload: {
          type: "plan_ready",
          artifact: planArtifact("awaiting_approval"),
        },
        createdAt: 3,
      },
    ];
    const projected = projectStageEvents(legacy);
    assert.deepEqual(
      projected.map(shape),
      [
        "agent_stage:planning:started",
        "plan_updated",
        "plan_execution_updated",
        "agent_stage:planning:completed",
        "plan_ready",
      ],
      "an execution ledger reports work inside the stage, not a transition of it",
    );
    assert.deepEqual(stagePayloads(projected)[0], {
      type: "agent_stage",
      stage: "planning",
      status: "started",
      projected: true,
    });
  });

  it("brackets connected-runtime activity with its declared stage", function () {
    const legacy: AgentRunEventRecord[] = [
      {
        runId: "run-codex",
        seq: 1,
        eventType: "codex_tool_activity",
        payload: {
          type: "codex_tool_activity",
          itemId: "item-1",
          phase: "started",
          toolName: "library_search",
          toolLabel: "Search library",
          workCategory: "retrieval",
        },
        createdAt: 1,
      },
      {
        runId: "run-codex",
        seq: 2,
        eventType: "codex_tool_activity",
        payload: {
          type: "codex_tool_activity",
          itemId: "item-1",
          phase: "completed",
          toolName: "library_search",
          toolLabel: "Search library",
          workCategory: "retrieval",
          ok: true,
        },
        createdAt: 2,
      },
      {
        runId: "run-codex",
        seq: 3,
        eventType: "codex_tool_activity",
        payload: {
          type: "codex_tool_activity",
          itemId: "item-2",
          phase: "completed",
          toolName: "note_write",
          toolLabel: "Write note",
          workCategory: "zotero_action",
          ok: false,
          actionReceipts: [],
        },
        createdAt: 3,
      },
    ];
    const projected = projectStageEvents(legacy);
    assert.deepEqual(projected.map(shape), [
      "agent_stage:retrieval:started",
      "codex_tool_activity",
      "agent_stage:retrieval:completed",
      "codex_tool_activity",
      "agent_stage:zotero_action:failed",
      "codex_tool_activity",
    ]);
  });

  it("is wired into the canonical trace reducer", function () {
    const source = readFileSync(
      "src/modules/contextPanel/agentTrace/render.ts",
      "utf8",
    );
    const reducer = source.slice(
      source.indexOf("function buildAgentTraceDisplayItemsCanonical("),
    );
    assert.isAtLeast(
      reducer.length,
      1,
      "the canonical reducer must still exist for this guard to mean anything",
    );
    assert.match(
      reducer.slice(0, reducer.indexOf("\n}\n")),
      /projectStageEvents\(/,
      "the canonical reducer projects legacy traces before it reduces them",
    );
    assert.lengthOf(
      source.match(/projectStageEvents\(/g) || [],
      1,
      "the projection runs once per trace, at the top of the reducer",
    );
  });

  it("builds a stage the same way wherever one is produced", function () {
    // Three producers emit stage events -- the runtime's tool execution, the
    // Codex bridge and this projection -- and one trace can hold events from
    // any of them. They share one builder so "the same stage" is the same
    // object, and so an undefined-valued key never survives into a trace the
    // store would drop it from.
    const sources = [
      readFileSync("src/agent/execution/toolExecution.ts", "utf8"),
      readFileSync(
        "src/modules/contextPanel/agentTrace/stageProjection.ts",
        "utf8",
      ),
      readFileSync("src/codexAppServer/nativeActivityStages.ts", "utf8"),
    ];
    for (const source of sources) {
      assert.notMatch(
        source,
        /\{\s*type:\s*"agent_stage"\s*,\s*\.\.\.fields\s*\}/,
        "a second copy of the stage builder is back",
      );
      assert.match(
        source,
        /from "(\.\.\/)*(\.\/)?(agent\/)?stageEvents"/,
        "every stage producer builds its event through the shared owner",
      );
    }

    const fields = {
      stage: "retrieval" as const,
      status: "completed" as const,
      toolName: "library_search",
      toolLabel: undefined,
      receiptIds: undefined,
    };
    // The runtime's own path, the bridge's, and this projection's.
    const fromRuntime = buildAgentStageEvent(fields);
    const fromBridge = mapCodexNativeItemToEvents(
      { id: "ws-1", type: "web_search", query: "x" },
      "completed",
    )?.stage;
    const fromProjection = projectStageEvents([
      {
        runId: "run-shared",
        seq: 1,
        eventType: "codex_tool_activity",
        payload: {
          type: "codex_tool_activity",
          itemId: "item-1",
          phase: "completed",
          toolName: "codex_web_search",
          toolLabel: "Web search",
          workCategory: "retrieval",
        },
        createdAt: 1,
      },
    ])[0].payload as Extract<AgentEvent, { type: "agent_stage" }>;

    for (const event of [fromRuntime, fromBridge, fromProjection]) {
      assert.isDefined(event);
      assert.equal(event!.type, "agent_stage");
      for (const [key, value] of Object.entries(event!)) {
        assert.notStrictEqual(
          value,
          undefined,
          `${key} survived as an undefined key the store would drop`,
        );
      }
    }
    // The bridge and the projection describe the same work identically apart
    // from the flag that says one of them reconstructed it.
    const { projected, ...projectedRest } = fromProjection;
    assert.isTrue(projected);
    assert.deepEqual(projectedRest, fromBridge as never);
  });

  it("says when it can be deleted", function () {
    const source = readFileSync(
      "src/modules/contextPanel/agentTrace/stageProjection.ts",
      "utf8",
    );
    assert.include(source, "2027-03-31");
    assert.include(
      source,
      "delete when no persisted trace older than Phase 4 needs rendering",
    );
  });
});
