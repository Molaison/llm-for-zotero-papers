import { assert } from "chai";
import { ActionContractRunSession } from "../src/agent/contracts/actionContractRunSession";
import { PaperEvidenceFrontier } from "../src/agent/context/paperEvidenceFrontier";
import { buildAgentResourceContextPlan } from "../src/agent/context/resourceContextPlan";
import { resolveAgentRuntimeRequest } from "../src/agent/context/resolvedAgentRequest";
import { createAgentExecutionContext } from "../src/agent/execution/context";
import { createEmptyExecutionCheckpoint } from "../src/agent/execution/checkpoint";
import {
  createToolExecution,
  type ToolExecutionDeps,
} from "../src/agent/execution/toolExecution";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import {
  createTaskUpdateTool,
  type TaskUpdateToolDeps,
} from "../src/agent/tools/control/taskUpdate";
import {
  PAPER_DIGEST_HANDLE_TOOL,
  createZoteroPaperDigestSources,
} from "../src/agent/digests/digestJobHost";
import type { MaterialRef } from "../src/agent/documents/materialRef";
import type { TaskPaperLedgerDelta } from "../src/agent/context/taskPaperLedger";
import {
  clearAgentToolResultHandleStore,
  upsertAgentToolResultHandles,
  type AgentToolResultHandleRecord,
} from "../src/agent/store/toolResultHandles";
import type {
  AgentEvent,
  AgentModelCapabilities,
  AgentRuntimeRequest,
  AgentToolContext,
  ExecutionCheckpoint,
} from "../src/agent/types";
import type { PaperContextRef } from "../src/shared/types";
import type { ChatParams } from "../src/utils/llmClient";
import { installMockDb } from "./helpers/agentRuntimeMockDb";
import { createTestActionContractService } from "./helpers/actionContractService";

/**
 * A declared digest part, run by the host inside `task_update`.
 *
 * The real tool runs through the real tool-execution collaborator; only the
 * paper resolver, the text reader and the model call are scripted.
 */

const CAPABILITIES: AgentModelCapabilities = {
  streaming: false,
  toolCalls: true,
  multimodal: false,
};

const TEXT =
  "# Introduction\nPlace cells drift slowly across days.\n\n## Methods\nWe recorded forty cells over ten days.";

const reply = (summary: string) => ({
  text: JSON.stringify({
    summary,
    contributions: ["Drift is slow."],
    methods: "Two-photon imaging.",
    limitations: "Not stated",
    evidence: [
      { section: "Methods", quote: "We recorded forty cells over ten days." },
    ],
  }),
  completion: { status: "complete" as const },
});

const PAPERS: Record<number, PaperContextRef> = {
  5: {
    libraryID: 1,
    itemId: 5,
    contextItemId: 105,
    title: "Drift A",
    year: "2021",
    firstCreator: "Ziv",
  },
  6: { libraryID: 1, itemId: 6, contextItemId: 106, title: "Drift B" },
  7: { libraryID: 1, itemId: 7, contextItemId: 107, title: "Drift C" },
};

type Harness = {
  deps: ToolExecutionDeps;
  events: AgentEvent[];
  request: AgentRuntimeRequest;
  /** The ledger after each change the tool published. */
  published: ExecutionCheckpoint[];
  handles: AgentToolResultHandleRecord[];
  context: AgentToolContext;
};

const SUMMARIZE = {
  taskId: "summaries",
  description: "Summarize each selected paper",
  expectedEffect: "digest",
  scope: true,
};

let conversationKey = 975_000;

function createHarness(
  digestDeps: TaskUpdateToolDeps["digests"],
  itemIds: number[] = [5, 6, 7],
): Harness {
  conversationKey += 1;
  const registry = new AgentToolRegistry(createTestActionContractService());
  registry.register(createTaskUpdateTool({ digests: digestDeps }));
  const events: AgentEvent[] = [];
  const published: ExecutionCheckpoint[] = [];
  const handles: AgentToolResultHandleRecord[] = [];
  const request = resolveAgentRuntimeRequest(
    {
      conversationKey,
      mode: "agent",
      libraryID: 1,
      userText: "Summarize all papers for me and write a literature review",
      model: "test-model",
      apiKey: "test-key",
      apiBase: "https://example.invalid/v1",
    },
    {},
  ) as AgentRuntimeRequest;
  request.executionContext = createAgentExecutionContext(request, "run-digest");
  request.turnScopePapers = {
    wholeLibrary: false,
    itemIds,
    withText: itemIds.length - 1,
    papers: Object.fromEntries(
      itemIds.map((itemId) => [
        itemId,
        {
          title: PAPERS[itemId]?.title || `Paper ${itemId}`,
          text: itemId === 7 ? "none" : "mineru",
        },
      ]),
    ) as never,
  };
  const emit = async (event: AgentEvent) => {
    events.push(event);
  };
  // The runtime's one ledger writer, reduced to its contract: serialized,
  // and each change that moves the ledger published once.
  let writes: Promise<unknown> = Promise.resolve();
  const context = {
    request,
    runId: "run-digest",
    item: null,
    currentAnswerText: "",
    modelName: "test-model",
    resourceSignature: "scope-1",
    signal: undefined,
    updateExecutionCheckpoint: (
      apply: (checkpoint: ExecutionCheckpoint) => ExecutionCheckpoint,
    ) => {
      const write = writes.then(async () => {
        const current =
          request.executionCheckpoint ||
          createEmptyExecutionCheckpoint(request.executionContext!, 10);
        const next = apply(current);
        if (next !== current) {
          request.executionCheckpoint = next;
          published.push(structuredClone(next));
          await emit({ type: "status", text: "ledger" });
        }
        return next;
      });
      writes = write.catch(() => undefined);
      return write;
    },
  } as unknown as AgentToolContext;
  const deps = {
    registry,
    now: () => 1_700_000_000_000,
    signal: undefined,
    emit,
    request,
    runId: "run-digest",
    context,
    writeAllowed: () => true,
    adapterCapabilities: CAPABILITIES,
    actionContractSession: new ActionContractRunSession(),
    paperEvidenceFrontier: new PaperEvidenceFrontier(),
    resourceContextPlan: buildAgentResourceContextPlan(request),
    persistToolResultHandles: async (
      written: AgentToolResultHandleRecord[],
    ) => {
      handles.push(...written);
      await upsertAgentToolResultHandles(written);
    },
    requestActionResolution: async () => {
      throw new Error("no confirmation is expected in this test");
    },
    finalizedMaterialRefs: new Map<string, MaterialRef>(),
    pendingReadActivities: [],
    preservedTurnHandleRecords: [],
    toolExecutionRecords: [],
    toolsUsedThisTurn: [],
    getCurrentAnswerText: () => "",
    setFinalizedMaterial: () => undefined,
    setToolResultReadAvailable: () => undefined,
  } as unknown as ToolExecutionDeps;
  return { deps, events, request, published, handles, context };
}

/** Scripted resolver and reader: paper 7 has no text. */
function scriptedDigests(
  llmCall: (chat: ChatParams) => Promise<ReturnType<typeof reply>>,
): NonNullable<TaskUpdateToolDeps["digests"]> {
  return {
    resolvePaper: async (_request, itemId) => PAPERS[itemId] || null,
    readText: async (paper) =>
      paper.itemId === 7
        ? null
        : { backend: "mineru", text: TEXT, totalCharacters: TEXT.length },
    llmCall: llmCall as never,
  };
}

async function runCall(
  harness: Harness,
  id: string,
  args: Record<string, unknown>,
) {
  const execution = createToolExecution(harness.deps);
  return execution.executeToolWorkflow(
    { id, name: "task_update", arguments: args },
    1,
    { modelCallId: id },
  );
}

function ledgerDeltas(harness: Harness): TaskPaperLedgerDelta[] {
  return harness.events.flatMap((event) =>
    event.type === "paper_ledger_update"
      ? [(event as { delta: TaskPaperLedgerDelta }).delta]
      : [],
  );
}

describe("task_update runs a declared digest part", function () {
  let restoreDb: () => void;

  beforeEach(function () {
    restoreDb = installMockDb();
    clearAgentToolResultHandleStore();
  });

  afterEach(function () {
    clearAgentToolResultHandleStore();
    restoreDb();
  });

  it("digests each paper with the turn's model, ticking the ledger and the paper rows paper by paper", async function () {
    const chats: ChatParams[] = [];
    const harness = createHarness(
      scriptedDigests(async (chat) => {
        chats.push(chat);
        return reply("Cells drift slowly.");
      }),
    );
    harness.request.runtimeContextBudget = {
      contextWindowTokens: 64_000,
      usedContextTokens: 1_000,
    };

    const outcome = await runCall(harness, "call-digest", {
      tasks: [SUMMARIZE],
    });

    assert.isTrue(outcome.toolResult.ok);
    const answer = outcome.toolResult.content as Record<string, any>;
    assert.deepEqual(answer.parts, [
      {
        taskId: "summaries",
        status: "completed",
        done: 2,
        total: 3,
        exceptions: 1,
        reasons: ["No readable text"],
        scope: true,
      },
    ]);
    assert.isUndefined(answer.note, "a digest declaration is never a no-op");
    assert.include(answer.digests, "### Drift A (item:5)");
    assert.include(answer.digests, "Summary: Cells drift slowly.");
    assert.include(answer.digests, "Not summarized:");
    assert.deepEqual(answer.digestFailures, [
      { itemId: 7, title: "Drift C", reason: "No readable text" },
    ]);
    assert.isUndefined(answer.digestPending);

    // The chat turn's own model and endpoint, never its reasoning setting.
    assert.lengthOf(chats, 2);
    for (const chat of chats) {
      assert.equal(chat.model, "test-model");
      assert.equal(chat.apiBase, "https://example.invalid/v1");
      assert.equal(chat.apiKey, "test-key");
    }

    // One ledger change per paper after the declaration.
    assert.lengthOf(
      harness.published,
      4,
      "the declaration, then one per paper",
    );
    const last = harness.published[3].tasks[0];
    assert.sameMembers(last.doneTargets || [], ["item:5", "item:6"]);

    // One paper-row update per paper, each with its own call id.
    const deltas = ledgerDeltas(harness);
    assert.sameDeepMembers(
      deltas.map((delta) => [
        delta.papers[0].itemId,
        delta.toolName,
        delta.reads[0].granularity,
        Boolean(delta.reads[0].snippet),
      ]),
      [
        [5, "task_update", "digest", true],
        [6, "task_update", "digest", true],
        [7, "task_update", "digest", false],
      ],
    );
    assert.sameMembers(
      deltas.map((delta) => delta.callId),
      [
        "call-digest:digest:5",
        "call-digest:digest:6",
        "call-digest:digest:7:failed",
      ],
    );
    const paper5 = deltas.find((delta) => delta.papers[0].itemId === 5)!;
    assert.include(paper5.papers[0], {
      libraryID: 1,
      contextItemId: 105,
      title: "Drift A",
      year: "2021",
      creator: "Ziv",
    });
    assert.equal(paper5.runId, "run-digest");
    // The rows are updated while the call runs, before its result.
    const resultIndex = harness.events.findIndex(
      (event) => event.type === "tool_result",
    );
    const lastDeltaIndex = harness.events.reduce(
      (at, event, index) => (event.type === "paper_ledger_update" ? index : at),
      -1,
    );
    assert.isAbove(resultIndex, lastDeltaIndex);

    // Each digest is stored for context_read and named by its handle.
    assert.lengthOf(answer.digestHandles, 2);
    assert.sameMembers(
      answer.digestHandles.map((entry: { itemId: number }) => entry.itemId),
      [5, 6],
    );
    const digestRecords = harness.handles.filter(
      (record) => record.toolName === PAPER_DIGEST_HANDLE_TOOL,
    );
    assert.sameMembers(
      digestRecords.map((record) => record.handle),
      answer.digestHandles.map((entry: { handle: string }) => entry.handle),
    );
    assert.isTrue(
      harness.request.metadata?.agentToolResultReadAvailable === true,
      "context_read is offered once a digest is stored",
    );
  });

  it("serves a repeated digest from the handle-store cache without a model call", async function () {
    let calls = 0;
    const digests = scriptedDigests(async () => {
      calls += 1;
      return reply("Cells drift slowly.");
    });
    const first = createHarness(digests, [5]);
    await runCall(first, "call-1", { tasks: [SUMMARIZE] });
    assert.equal(calls, 1);

    // A later turn in the same conversation digests the same paper again.
    const second = createHarness(digests, [5]);
    second.request.conversationKey = first.request.conversationKey;
    const outcome = await runCall(second, "call-2", { tasks: [SUMMARIZE] });
    const answer = outcome.toolResult.content as Record<string, any>;
    assert.equal(calls, 1, "the cached digest is reused");
    assert.include(answer.digests, "Cells drift slowly.");
    assert.lengthOf(answer.digestHandles, 1);
    assert.deepEqual(answer.parts[0].done, 1);
  });

  it("never caches a failure", async function () {
    const harness = createHarness(
      scriptedDigests(async () => reply("unused")),
      [7],
    );
    await runCall(harness, "call-fail", { tasks: [SUMMARIZE] });
    assert.isEmpty(
      harness.handles.filter(
        (record) => record.toolName === PAPER_DIGEST_HANDLE_TOOL,
      ),
    );
  });

  it("on Stop keeps the finished digests, names the papers left, and a repeat continues only those", async function () {
    const controller = new AbortController();
    const asked: string[] = [];
    let resuming = false;
    const harness = createHarness(
      scriptedDigests(async (chat) => {
        const prompt = chat.prompt;
        const title = /Title: (Drift [A-D])/.exec(prompt)?.[1] || "?";
        asked.push(title);
        if (resuming) return reply(`${title} drifts.`);
        if (title === "Drift A") {
          controller.abort();
          return reply("Cells drift slowly.");
        }
        if (!controller.signal.aborted)
          await new Promise((resolve) =>
            controller.signal.addEventListener("abort", resolve),
          );
        throw new Error("The operation was aborted");
      }),
      [5, 6, 8],
    );
    PAPERS[8] = {
      libraryID: 1,
      itemId: 8,
      contextItemId: 108,
      title: "Drift D",
    };
    harness.context.signal = controller.signal;

    const stopped = await runCall(harness, "call-stop", { tasks: [SUMMARIZE] });
    const answer = stopped.toolResult.content as Record<string, any>;
    assert.include(answer.digests, "Cells drift slowly.");
    assert.sameMembers(answer.digestPending, ["item:6", "item:8"]);
    assert.isUndefined(answer.digestFailures);
    assert.deepEqual(answer.parts[0], {
      taskId: "summaries",
      status: "pending",
      done: 1,
      total: 3,
      scope: true,
    });
    assert.deepEqual(
      ledgerDeltas(harness).map((delta) => delta.papers[0].itemId),
      [5],
      "a paper Stop left unfinished gets no row update",
    );

    // Continue: the same part again, without a description.
    harness.context.signal = undefined;
    asked.length = 0;
    resuming = true;
    const resumed = await runCall(harness, "call-resume", {
      tasks: [{ taskId: "summaries" }],
    });
    const again = resumed.toolResult.content as Record<string, any>;
    assert.sameMembers(asked, ["Drift B", "Drift D"]);
    assert.isUndefined(again.note);
    assert.include(again.parts[0], { status: "completed", done: 3, total: 3 });
    assert.isUndefined(again.digestPending);
    delete PAPERS[8];
  });

  it("keeps a large digest result behind a trace handle like any big result", async function () {
    const itemIds = Array.from({ length: 30 }, (_, index) => 200 + index);
    for (const itemId of itemIds)
      PAPERS[itemId] = {
        libraryID: 1,
        itemId,
        contextItemId: itemId + 1000,
        title: `Long paper ${itemId}`,
      };
    try {
      const harness = createHarness(
        scriptedDigests(async () => reply("Long summary. ".repeat(120))),
        itemIds,
      );
      await runCall(harness, "call-big", { tasks: [SUMMARIZE] });
      const result = harness.events.find(
        (event) => event.type === "tool_result",
      ) as Extract<AgentEvent, { type: "tool_result" }>;
      assert.match(String(result.toolResultHandle), /^trh_/);
    } finally {
      for (const itemId of itemIds) delete PAPERS[itemId];
    }
  });

  it("leaves a part of any other effect exactly as before", async function () {
    let calls = 0;
    const harness = createHarness(
      scriptedDigests(async () => {
        calls += 1;
        return reply("x");
      }),
    );
    const outcome = await runCall(harness, "call-read", {
      tasks: [
        {
          taskId: "read-all",
          description: "Read each paper",
          expectedEffect: "read",
          scope: true,
        },
      ],
    });
    const answer = outcome.toolResult.content as Record<string, any>;
    assert.equal(calls, 0);
    assert.deepEqual(Object.keys(answer), ["parts"]);
    assert.isEmpty(ledgerDeltas(harness));
  });
});

describe("Zotero paper sources for a digest", function () {
  it("adds the MinerU directory the gateway's paper ref lacks, from the paper's attachments", async function () {
    const request = resolveAgentRuntimeRequest(
      { conversationKey: 975_900, mode: "agent", libraryID: 1, userText: "x" },
      {},
    ) as AgentRuntimeRequest;
    const sources = createZoteroPaperDigestSources({
      zoteroGateway: {
        resolvePaperContextTarget: ({ itemId }: { itemId?: number }) =>
          itemId === 5 ? { ...PAPERS[5] } : null,
        getAllChildAttachmentInfos: async () => [
          { contextItemId: 999, mineruCacheDir: "/cache/other" },
          { contextItemId: 105, mineruCacheDir: "/cache/105" },
        ],
      } as never,
      pdfService: { getOverviewExcerpt: async () => ({}) } as never,
    });
    const paper = await sources.resolvePaper(request, 5);
    assert.equal(paper?.mineruCacheDir, "/cache/105");
    assert.equal(paper?.contextItemId, 105);
    assert.isNull(await sources.resolvePaper(request, 404));
  });
});
