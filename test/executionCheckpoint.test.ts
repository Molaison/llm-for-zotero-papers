import { assert } from "chai";
import {
  collectJournalActionIds,
  createEmptyExecutionCheckpoint,
} from "../src/agent/execution/checkpoint";
import {
  applyOutcomeEvidence,
  declareOutcomes,
} from "../src/agent/loop/outcomes";
import { renderExecutionCheckpointBlock } from "../src/agent/model/messageBuilder";
import { ToolInputRejection } from "../src/agent/tools/execution/failure";
import { createTaskUpdateTool } from "../src/agent/tools/plan/taskUpdate";
import type {
  AgentExecutionContext,
  AgentToolContext,
  ExecutionCheckpoint,
} from "../src/agent/types";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";

const executionContext: AgentExecutionContext = {
  version: 1,
  executionId: "execution-direct-1",
  conversationKey: 41,
  conversationGeneration: 3,
  chatLibraryID: 1,
  permissionOwner: "original_agent",
  workspaceSnapshot: {
    selectedPapers: [],
    selectedCollections: [],
  },
  configuredAccess: { libraryIDs: [1], outputDirectories: [] },
};

const NOTHING_CHANGED =
  "The host marks tasks done from the tools' results; nothing changed.";

function taskId(local: string): string {
  return `execution-direct-1:task:${local}`;
}

describe("ordinary ExecutionCheckpoint", function () {
  it("collects parent and per-item action identities from nested results", function () {
    assert.deepEqual(
      [
        ...collectJournalActionIds({
          actionId: "action-parent",
          result: {
            actionIds: ["action-child-1"],
            notes: [
              { actionId: "action-child-2", status: "created" },
              { actionId: "", status: "error" },
            ],
          },
        }),
      ],
      ["action-parent", "action-child-1", "action-child-2"],
    );
  });

  it("renders only progress and evidence identities into recovery context", function () {
    const declared = declareOutcomes(
      createEmptyExecutionCheckpoint(executionContext, 10),
      [
        {
          taskId: "save",
          description: "Save the finalized synthesis",
          effect: "mutation",
          capability: "zotero.notes",
        },
      ],
      20,
    );
    const checkpoint = applyOutcomeEvidence(
      declared,
      {
        kind: "receipt",
        receipt: {
          version: 2,
          executionAuthority: "external_runtime",
          id: "receipt-1",
          proposalId: "proposal-1",
          proofDomain: "zotero_state",
          capability: "zotero.notes",
          operation: "note_create",
          verification: "verified",
          status: "applied",
          requestedTargets: ["item:7"],
          appliedTargets: ["item:7"],
          alreadySatisfiedTargets: [],
          rejectedTargets: [],
          reasons: [],
          verifiedFacts: ["native_note:9:text_match"],
        },
      },
      30,
    ).checkpoint;
    const request = resolvedAgentRequest({
      conversationKey: 41,
      mode: "agent",
      userText: "Continue",
      libraryID: 1,
      executionContext,
      executionCheckpoint: checkpoint,
    });

    const rendered = renderExecutionCheckpointBlock(request);
    assert.include(rendered, "execution-direct-1:task:save");
    assert.include(rendered, "receipt-1");
    assert.include(rendered, "authority-free progress");
    assert.notInclude(rendered, "proposalId");
    assert.notInclude(rendered, "verifiedFacts");
    assert.notInclude(rendered, "executionAuthority");
  });
});

describe("task_update ordinary declarations", function () {
  let published: ExecutionCheckpoint[];

  beforeEach(function () {
    published = [];
  });

  function context(
    executionCheckpoint?: ExecutionCheckpoint,
  ): AgentToolContext {
    const request = resolvedAgentRequest({
      conversationKey: 41,
      mode: "agent",
      userText: "Summarize this paper and save it as a note",
      libraryID: 1,
      executionContext,
      ...(executionCheckpoint ? { executionCheckpoint } : {}),
    });
    return {
      request,
      runId: "run-1",
      item: null,
      currentAnswerText: "",
      modelName: "test",
      // The runtime's one ledger writer, reduced to its contract.
      updateExecutionCheckpoint: async (apply) => {
        const current =
          request.executionCheckpoint ||
          createEmptyExecutionCheckpoint(executionContext, 10);
        const next = apply(current);
        if (next !== current) {
          request.executionCheckpoint = next;
          published.push(structuredClone(next));
        }
        return next;
      },
    };
  }

  async function call(
    ctx: AgentToolContext,
    args: unknown,
  ): Promise<{ checkpoint: ExecutionCheckpoint; note?: string }> {
    const tool = createTaskUpdateTool();
    const validated = tool.validate(args);
    if (!validated.ok) throw new Error(validated.error);
    return (await tool.execute(validated.value, ctx)) as {
      checkpoint: ExecutionCheckpoint;
      note?: string;
    };
  }

  async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
    try {
      await promise;
    } catch (error) {
      return error as Error;
    }
    throw new Error("expected task_update to refuse the call");
  }

  const declareSave = {
    taskId: "save",
    description: "Save it as a note on the paper",
    status: "pending",
    expectedEffect: "mutation",
    expectedCapability: "zotero.notes",
    targetIds: ["12"],
  };

  it("accepts the legacy task shorthand and the new tasks batch, but not both", function () {
    const tool = createTaskUpdateTool();
    assert.isTrue(
      tool.validate({ task: { taskId: "one", status: "pending" } }).ok,
    );
    assert.isTrue(
      tool.validate({
        tasks: [
          {
            taskId: "one",
            description: "First task",
            status: "pending",
          },
          {
            taskId: "two",
            description: "Second task",
            dependencies: ["one"],
            status: "pending",
          },
        ],
      }).ok,
    );
    const invalid = tool.validate({
      task: { taskId: "one", status: "pending" },
      tasks: [{ taskId: "two", status: "pending" }],
    });
    assert.isFalse(invalid.ok);
  });

  it("declares a new part as a pending model outcome with its effect, capability and targets", async function () {
    const ctx = context();
    const result = await call(ctx, {
      tasks: [
        declareSave,
        {
          taskId: "explain",
          description: "Explain the method",
          status: "pending",
          expectedEffect: "reasoning",
        },
      ],
    });

    assert.lengthOf(published, 1);
    assert.deepEqual(result.checkpoint, published[0]);
    assert.deepEqual(ctx.request.executionCheckpoint, published[0]);
    assert.notProperty(result, "note");
    assert.deepEqual(
      published[0].tasks.map((task) => [
        task.taskId,
        task.status,
        task.origin,
        task.effect,
        task.capability,
        task.targets,
      ]),
      [
        [
          taskId("save"),
          "pending",
          "model",
          "mutation",
          "zotero.notes",
          ["item:12"],
        ],
        [taskId("explain"), "pending", "model", "answer", undefined, undefined],
      ],
    );
  });

  it("ignores an expectedCapability that is not an action capability", async function () {
    const result = await call(context(), {
      task: { ...declareSave, expectedCapability: "zotero.everything" },
    });
    assert.notProperty(result.checkpoint.tasks[0], "capability");
    assert.equal(result.checkpoint.tasks[0].effect, "mutation");
  });

  it("refuses a new part without expectedEffect with the exact message, and publishes nothing", async function () {
    const ctx = context();
    const error = await rejectionOf(
      call(ctx, {
        tasks: [
          {
            taskId: "save",
            description: "Save it as a note",
            status: "pending",
          },
        ],
      }),
    );
    assert.instanceOf(error, ToolInputRejection);
    assert.equal(
      error.message,
      "Give each new task an expectedEffect: read, artifact, mutation, or reasoning.",
    );
    assert.lengthOf(published, 0);
    assert.isUndefined(ctx.request.executionCheckpoint);
  });

  it("answers a request to complete, start or reopen a part with the note and changes nothing", async function () {
    const ctx = context();
    await call(ctx, { task: declareSave });
    const declared = ctx.request.executionCheckpoint;

    for (const status of ["completed", "in_progress", "pending"]) {
      const result = await call(ctx, {
        task: {
          taskId: "save",
          status,
          verifiedReceiptIds: ["receipt-1"],
        },
      });
      assert.equal(result.note, NOTHING_CHANGED, status);
      assert.strictEqual(result.checkpoint, declared);
    }
    assert.lengthOf(published, 1, "only the declaration was published");
    assert.strictEqual(ctx.request.executionCheckpoint, declared);
    assert.equal(declared?.tasks[0].status, "pending");
  });

  it("refuses a skipped part without the reason", async function () {
    const ctx = context();
    await call(ctx, { task: declareSave });
    const error = await rejectionOf(
      call(ctx, { task: { taskId: "save", status: "skipped" } }),
    );
    assert.instanceOf(error, ToolInputRejection);
    assert.equal(
      error.message,
      "A skipped, blocked, or cancelled task needs the reason.",
    );
    assert.lengthOf(published, 1);
    assert.equal(ctx.request.executionCheckpoint?.tasks[0].status, "pending");
  });

  it("marks a part skipped with its reason", async function () {
    const ctx = context();
    await call(ctx, { task: declareSave });
    const result = await call(ctx, {
      task: {
        taskId: "save",
        status: "skipped",
        reason: "The library is read-only",
      },
    });
    assert.notProperty(result, "note");
    assert.lengthOf(published, 2);
    assert.deepEqual(
      [result.checkpoint.tasks[0].status, result.checkpoint.tasks[0].reason],
      ["skipped", "The library is read-only"],
    );
    assert.deepEqual(ctx.request.executionCheckpoint, published[1]);
  });

  it("never takes evidence identities from an ordinary task", async function () {
    const result = await call(context(), {
      task: {
        ...declareSave,
        journalActionIds: ["action-1"],
        verifiedReceiptIds: ["receipt-1"],
        readEvidenceIds: ["read-1"],
        materialRefs: [
          {
            documentId: "document-1",
            documentVersion: 2,
            contentHash: "sha256:material",
          },
        ],
      },
    });
    const [task] = result.checkpoint.tasks;
    assert.equal(task.status, "pending");
    assert.deepEqual(task.journalActionIds, []);
    assert.deepEqual(task.verifiedReceiptIds, []);
    assert.deepEqual(task.readEvidenceIds, []);
    assert.deepEqual(task.materialRefs, []);
  });

  it("applies the declarations of a call before its marks, and publishes one checkpoint", async function () {
    const ctx = context();
    await call(ctx, {
      task: {
        taskId: "read",
        description: "Read the paper",
        status: "pending",
        expectedEffect: "read",
      },
    });
    const result = await call(ctx, {
      tasks: [
        declareSave,
        { taskId: "read", status: "skipped", reason: "The PDF is missing" },
        {
          taskId: "cite",
          description: "Cite it in APA",
          status: "blocked",
          reason: "Needs the citation style",
          expectedEffect: "reasoning",
        },
      ],
    });

    assert.lengthOf(published, 2, "one checkpoint per call");
    assert.notProperty(result, "note");
    assert.deepEqual(
      published[1].tasks.map((task) => [task.taskId, task.status, task.reason]),
      [
        [taskId("read"), "skipped", "The PDF is missing"],
        [taskId("save"), "pending", undefined],
        [taskId("cite"), "blocked", "Needs the citation style"],
      ],
    );
  });

  it("declares a new part pending, with the note, when asked to start or complete it", async function () {
    const result = await call(context(), {
      task: { ...declareSave, status: "completed" },
    });
    assert.equal(result.checkpoint.tasks[0].status, "pending");
    assert.equal(result.note, NOTHING_CHANGED);
    assert.lengthOf(published, 1);
  });

  it("refuses a malformed call as an input rejection: a new description, a repeated id, or an invalid id", async function () {
    const ctx = context();
    await call(ctx, { task: declareSave });
    for (const [args, message] of [
      [
        { task: { ...declareSave, description: "Save somewhere else" } },
        /immutable/,
      ],
      [
        {
          tasks: [
            {
              taskId: "draft",
              description: "Draft the summary",
              status: "pending",
              expectedEffect: "artifact",
            },
            { taskId: "draft", status: "skipped", reason: "No time" },
          ],
        },
        /only once/,
      ],
      [{ task: { ...declareSave, taskId: "save the note" } }, /Task IDs/],
    ] as const) {
      const error = await rejectionOf(call(ctx, args));
      assert.instanceOf(error, ToolInputRejection);
      assert.match(error.message, message);
    }
    assert.lengthOf(published, 1);
  });

  it("refuses a checkpoint another execution owns", async function () {
    const foreign = createEmptyExecutionCheckpoint(
      { ...executionContext, executionId: "execution-other" },
      10,
    );
    const error = await rejectionOf(
      call(context(foreign), { task: declareSave }),
    );
    assert.include(error.message, "belongs to another execution");
    assert.lengthOf(published, 0);
  });
});
