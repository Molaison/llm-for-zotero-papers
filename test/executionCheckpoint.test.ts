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
import {
  applyOrdinaryTaskUpdates,
  createTaskUpdateTool,
} from "../src/agent/tools/control/taskUpdate";
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
  "Nothing changed: the host marks parts done from the tools' results, so progress needs no task_update call. Continue the work, or answer when it is done.";

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

  it("states a job's progress and the papers it has left, with counts for a part over papers", function () {
    const declared = declareOutcomes(
      createEmptyExecutionCheckpoint(executionContext, 10),
      [
        {
          taskId: "note-all",
          description: "Save a note on each paper",
          effect: "mutation",
          capability: "zotero.notes",
          targets: ["item:7", "item:8", "item:9"],
          scope: true,
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
          id: "receipt-7",
          proposalId: "proposal-7",
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
          verifiedFacts: [],
        },
      },
      30,
    ).checkpoint;
    const rendered = renderExecutionCheckpointBlock(
      resolvedAgentRequest({
        conversationKey: 41,
        mode: "agent",
        userText: "continue",
        libraryID: 1,
        executionContext,
        executionCheckpoint: checkpoint,
      }),
    );
    assert.include(rendered, "execution-direct-1:task:note-all");
    assert.include(rendered, '"done":1,"total":3');
    assert.notInclude(
      rendered,
      "receipt-7",
      "a part over papers is counted, not listed id by id",
    );
    assert.include(
      rendered,
      "\nLong job to resume: “Save a note on each paper” 1 of 3 done. The 2 papers left, in order: 8, 9.",
    );
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

  /** What the model reads back: each part, compact. */
  type Answer = { parts: Record<string, unknown>[]; note?: string };

  async function call(ctx: AgentToolContext, args: unknown): Promise<Answer> {
    const tool = createTaskUpdateTool();
    const validated = tool.validate(args);
    if (!validated.ok) throw new Error(validated.error);
    return (await tool.execute(validated.value, ctx)) as Answer;
  }

  /** The ledger the host keeps, after the latest call. */
  const ledgerOf = (ctx: AgentToolContext): ExecutionCheckpoint =>
    ctx.request.executionCheckpoint!;

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
    expectedEffect: "mutation",
    expectedCapability: "zotero.notes",
    targetIds: ["12"],
  };

  it("takes declarations in tasks and exceptions in skipped, blocked or cancelled", function () {
    const tool = createTaskUpdateTool();
    assert.isTrue(tool.validate({ tasks: [declareSave] }).ok);
    for (const exception of ["skipped", "blocked", "cancelled"])
      assert.isTrue(
        tool.validate({
          [exception]: [{ taskId: "save", reason: "Not possible" }],
        }).ok,
        exception,
      );
    assert.isTrue(
      tool.validate({
        tasks: [declareSave],
        skipped: [{ taskId: "read", reason: "The PDF is missing" }],
      }).ok,
    );
    for (const args of [{ task: declareSave }, {}, { tasks: [] }])
      assert.isFalse(tool.validate(args).ok, JSON.stringify(args));
  });

  it("has no status for the model to report progress with", function () {
    const tool = createTaskUpdateTool();
    const schema = tool.spec.inputSchema as {
      properties: Record<string, { items?: { properties: object } }>;
    };
    assert.notProperty(schema.properties, "task");
    assert.notProperty(schema.properties.tasks.items!.properties, "status");
    for (const status of ["completed", "in_progress", "pending", "skipped"]) {
      const parsed = tool.validate({ tasks: [{ ...declareSave, status }] });
      assert.isFalse(parsed.ok, status);
      if (!parsed.ok) assert.include(parsed.error, "host marks parts done");
    }
  });

  it("declares a new part as a pending model outcome with its effect, capability and targets", async function () {
    const ctx = context();
    const result = await call(ctx, {
      tasks: [
        declareSave,
        {
          taskId: "explain",
          description: "Explain the method",
          expectedEffect: "reasoning",
        },
      ],
    });

    assert.lengthOf(published, 1);
    assert.deepEqual(result, {
      parts: [
        { taskId: "save", status: "pending", done: 0, total: 1 },
        { taskId: "explain", status: "pending" },
      ],
    });
    assert.deepEqual(ctx.request.executionCheckpoint, published[0]);
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
    await call(context(), {
      tasks: [{ ...declareSave, expectedCapability: "zotero.everything" }],
    });
    assert.notProperty(published[0].tasks[0], "capability");
    assert.equal(published[0].tasks[0].effect, "mutation");
  });

  it("refuses a new part without expectedEffect with the exact message, and publishes nothing", async function () {
    const ctx = context();
    const error = await rejectionOf(
      call(ctx, {
        tasks: [{ taskId: "save", description: "Save it as a note" }],
      }),
    );
    assert.instanceOf(error, ToolInputRejection);
    assert.equal(
      error.message,
      "Give each new task an expectedEffect: read, artifact, mutation, reasoning, or digest (one host-made summary per paper).",
    );
    assert.lengthOf(published, 0);
    assert.isUndefined(ctx.request.executionCheckpoint);
  });

  it("answers a repeated declaration with the note and changes nothing", async function () {
    const ctx = context();
    await call(ctx, { tasks: [declareSave] });
    const declared = ctx.request.executionCheckpoint;

    for (const repeat of [declareSave, { taskId: "save" }]) {
      const result = await call(ctx, { tasks: [repeat] });
      assert.deepEqual(
        result,
        {
          parts: [{ taskId: "save", status: "pending", done: 0, total: 1 }],
          note: NOTHING_CHANGED,
        },
        JSON.stringify(repeat),
      );
    }
    assert.lengthOf(published, 1, "only the declaration was published");
    assert.strictEqual(ctx.request.executionCheckpoint, declared);
    assert.equal(declared?.tasks[0].status, "pending");
  });

  it("refuses a skipped part without the reason", async function () {
    const ctx = context();
    await call(ctx, { tasks: [declareSave] });
    const error = await rejectionOf(
      call(ctx, { skipped: [{ taskId: "save" }] }),
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
    await call(ctx, { tasks: [declareSave] });
    const result = await call(ctx, {
      skipped: [{ taskId: "save", reason: "The library is read-only" }],
    });
    assert.deepEqual(result, {
      parts: [
        {
          taskId: "save",
          status: "skipped",
          done: 0,
          total: 1,
          reason: "The library is read-only",
        },
      ],
    });
    assert.lengthOf(published, 2);
    assert.deepEqual(
      [published[1].tasks[0].status, published[1].tasks[0].reason],
      ["skipped", "The library is read-only"],
    );
    assert.deepEqual(ctx.request.executionCheckpoint, published[1]);
  });

  it("never takes evidence identities from an ordinary task", async function () {
    await call(context(), {
      tasks: [
        {
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
      ],
    });
    const [task] = published[0].tasks;
    assert.equal(task.status, "pending");
    assert.deepEqual(task.journalActionIds, []);
    assert.deepEqual(task.verifiedReceiptIds, []);
    assert.deepEqual(task.readEvidenceIds, []);
    assert.deepEqual(task.materialRefs, []);
  });

  it("applies the declarations of a call before its marks, and publishes one checkpoint", async function () {
    const ctx = context();
    await call(ctx, {
      tasks: [
        {
          taskId: "read",
          description: "Read the paper",
          expectedEffect: "read",
        },
      ],
    });
    const result = await call(ctx, {
      tasks: [
        declareSave,
        {
          taskId: "cite",
          description: "Cite it in APA",
          expectedEffect: "reasoning",
        },
      ],
      skipped: [{ taskId: "read", reason: "The PDF is missing" }],
      blocked: [{ taskId: "cite", reason: "Needs the citation style" }],
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

  it("refuses a malformed call as an input rejection: a new description, a repeated id, or an invalid id", async function () {
    const ctx = context();
    await call(ctx, { tasks: [declareSave] });
    const draft = {
      taskId: "draft",
      description: "Draft the summary",
      expectedEffect: "artifact",
    };
    for (const [args, message] of [
      [
        { tasks: [{ ...declareSave, description: "Save somewhere else" }] },
        /immutable/,
      ],
      [{ tasks: [draft, draft] }, /only once/],
      [
        {
          skipped: [{ taskId: "save", reason: "No time" }],
          blocked: [{ taskId: "save", reason: "Needs a choice" }],
        },
        /only once/,
      ],
      [{ tasks: [{ ...declareSave, taskId: "save the note" }] }, /Task IDs/],
    ] as const) {
      const error = await rejectionOf(call(ctx, args));
      assert.instanceOf(error, ToolInputRejection);
      assert.match(error.message, message);
    }
    assert.lengthOf(published, 1);
  });

  describe("a part over the turn's paper scope", function () {
    const readAll = {
      taskId: "read-all",
      description: "Read each paper in Drift",
      expectedEffect: "read",
      scope: true,
    };

    function scoped(itemIds: number[]): AgentToolContext {
      const ctx = context();
      ctx.request.turnScopePapers = {
        wholeLibrary: false,
        itemIds,
        withText: itemIds.length,
      };
      return ctx;
    }

    it("freezes every paper of the turn's scope into the part, in scope order", async function () {
      const ctx = scoped([30, 10, 20]);
      await call(ctx, { tasks: [readAll] });
      const [task] = ledgerOf(ctx).tasks;
      assert.deepEqual(task.targets, ["item:30", "item:10", "item:20"]);
      assert.isTrue(task.scope);
      assert.equal(task.effect, "read");
      assert.equal(task.status, "pending");
    });

    it("keeps the frozen papers when the scope changes after the declaration", async function () {
      const ctx = scoped([30, 10, 20]);
      await call(ctx, { tasks: [readAll] });
      ctx.request.turnScopePapers = {
        wholeLibrary: false,
        itemIds: [10, 40],
        withText: 2,
      };
      const repeated = await call(ctx, { tasks: [readAll] });
      assert.equal(repeated.note, NOTHING_CHANGED);
      assert.deepEqual(ledgerOf(ctx).tasks[0].targets, [
        "item:30",
        "item:10",
        "item:20",
      ]);
      // A part declared after the change takes the scope as it is now.
      await call(ctx, {
        tasks: [
          {
            taskId: "note-all",
            description: "Write a note on each paper",
            expectedEffect: "mutation",
            expectedCapability: "zotero.notes",
            scope: true,
          },
        ],
      });
      assert.deepEqual(
        ledgerOf(ctx).tasks.map((task) => task.targets),
        [
          ["item:30", "item:10", "item:20"],
          ["item:10", "item:40"],
        ],
      );
    });

    it("takes the named targetIds when a part also asks for scope:true", async function () {
      // The live run declared one annotation this way and was refused, which
      // cost a turn for nothing: the named papers say exactly what is meant.
      for (const ctx of [scoped([10, 20]), context()]) {
        published.length = 0;
        const result = await call(ctx, {
          tasks: [{ ...readAll, targetIds: ["30"] }],
        });
        const [task] = ledgerOf(ctx).tasks;
        assert.deepEqual(task.targets, ["item:30"]);
        assert.notProperty(task, "scope", "the part is not the turn's scope");
        assert.deepEqual(result, {
          parts: [{ taskId: "read-all", status: "pending", done: 0, total: 1 }],
        });
        assert.lengthOf(published, 1);
      }
    });

    it("refuses scope without papers in the scope, and publishes nothing", async function () {
      for (const [ctx, args, message] of [
        [
          context(),
          { tasks: [readAll] },
          "This turn states no paper scope to cover; name the part's papers in targetIds.",
        ],
        [
          scoped([]),
          { tasks: [readAll] },
          "This turn states no paper scope to cover; name the part's papers in targetIds.",
        ],
      ] as const) {
        const error = await rejectionOf(call(ctx, args));
        assert.instanceOf(error, ToolInputRejection);
        assert.equal(error.message, message);
      }
      assert.lengthOf(published, 0);
    });

    it("answers with each part's counts and never its frozen papers", async function () {
      const ctx = scoped(
        Array.from({ length: 212 }, (_, index) => 1001 + index),
      );
      const result = await call(ctx, { tasks: [readAll] });
      assert.deepEqual(result, {
        parts: [
          {
            taskId: "read-all",
            status: "pending",
            done: 0,
            total: 212,
            scope: true,
          },
        ],
      });
      assert.notInclude(JSON.stringify(result), "item:");
      assert.lengthOf(
        ledgerOf(ctx).tasks[0].targets!,
        212,
        "the host keeps them",
      );
    });

    it("counts a part's exceptions and names at most three of their reasons", async function () {
      const ledger = declareOutcomes(
        createEmptyExecutionCheckpoint(executionContext, 10),
        [
          {
            taskId: "tag",
            description: "Tag the papers",
            effect: "mutation",
            capability: "zotero.tags",
            targets: ["item:1", "item:2", "item:3", "item:4", "item:5"],
          },
        ],
        20,
      );
      const excepted: ExecutionCheckpoint = {
        ...ledger,
        tasks: [
          {
            ...ledger.tasks[0],
            doneTargets: ["item:1"],
            exceptions: [
              { targets: ["item:2"], reason: "Read-only library" },
              { targets: ["item:3"], reason: "Item in trash" },
              { targets: ["item:4"], reason: "Locked" },
              { targets: ["item:5"], reason: "Not applied" },
            ],
          },
        ],
      };
      const result = await call(context(excepted), {
        tasks: [
          {
            taskId: "explain",
            description: "Explain what changed",
            expectedEffect: "reasoning",
          },
        ],
      });
      assert.deepEqual(result.parts[0], {
        taskId: "tag",
        status: "pending",
        done: 1,
        total: 5,
        exceptions: 4,
        reasons: ["Read-only library", "Item in trash", "Locked"],
      });
    });

    it("takes scope as true or false only", function () {
      const tool = createTaskUpdateTool();
      assert.isTrue(
        tool.validate({ tasks: [{ ...readAll, scope: false }] }).ok,
      );
      const parsed = tool.validate({ tasks: [{ ...readAll, scope: "all" }] });
      assert.isFalse(parsed.ok);
      if (!parsed.ok)
        assert.equal(
          parsed.error,
          "task_update.tasks[0].scope must be true or false",
        );
    });

    describe("a digest part", function () {
      const summaries = {
        taskId: "summaries",
        description: "Summarize each paper",
        expectedEffect: "digest",
      };

      it("declares a digest part over the scope and refuses one without papers", async function () {
        const ctx = scoped([5, 6]);
        const error = await rejectionOf(call(ctx, { tasks: [summaries] }));
        assert.instanceOf(error, ToolInputRejection);
        assert.include(error.message, "A digest part names the papers");
        assert.lengthOf(published, 0);
        const answer = await call(ctx, {
          tasks: [{ ...summaries, scope: true }],
        });
        assert.deepEqual(answer.parts[0], {
          taskId: "summaries",
          status: "pending",
          done: 0,
          total: 2,
          scope: true,
        });
        assert.equal(ledgerOf(ctx).tasks[0].effect, "digest");
        assert.deepEqual(ledgerOf(ctx).tasks[0].targets, ["item:5", "item:6"]);
      });

      it("lists digest in the schema's expectedEffect enum and in the description", function () {
        const tool = createTaskUpdateTool();
        const schema = tool.spec.inputSchema as any;
        assert.include(
          schema.properties.tasks.items.properties.expectedEffect.enum,
          "digest",
        );
        assert.include(tool.spec.description, "expectedEffect 'digest'");
        assert.isTrue(
          tool.validate({ tasks: [{ ...summaries, targetIds: ["5"] }] }).ok,
        );
      });

      it("names digest in the message for a part without an effect", async function () {
        const error = await rejectionOf(
          call(scoped([5]), {
            tasks: [{ taskId: "x", description: "Do it", scope: true }],
          }),
        );
        assert.include(error.message, "or digest");
      });

      it("a repeated digest part is a request to run it, not an ignored repeat", async function () {
        const ctx = scoped([5, 6]);
        await call(ctx, { tasks: [{ ...summaries, scope: true }] });
        const repeated = await call(ctx, {
          tasks: [{ taskId: "summaries" }],
        });
        assert.isUndefined(repeated.note);
      });

      it("returns the digest parts to run and their papers", function () {
        const scope = { wholeLibrary: false, itemIds: [5, 6, 7], withText: 3 };
        const input = (tasks: unknown[]) => {
          const parsed = createTaskUpdateTool().validate({ tasks });
          if (!parsed.ok) throw new Error(parsed.error);
          return parsed.value;
        };
        const declared = applyOrdinaryTaskUpdates(
          createEmptyExecutionCheckpoint(executionContext, 10),
          input([{ ...summaries, scope: true }, declareSave]),
          20,
          scope,
        );
        assert.deepEqual(declared.digestParts, [
          {
            taskId: "execution-direct-1:task:summaries",
            targets: ["item:5", "item:6", "item:7"],
          },
        ]);
        const progressed = applyOutcomeEvidence(
          declared.checkpoint,
          {
            kind: "digest",
            taskId: "execution-direct-1:task:summaries",
            done: ["item:5"],
            failed: [],
          },
          30,
        ).checkpoint;
        // A repeat without targetIds resumes the papers not done.
        assert.deepEqual(
          applyOrdinaryTaskUpdates(
            progressed,
            input([{ taskId: "summaries" }]),
            40,
            scope,
          ).digestParts,
          [
            {
              taskId: "execution-direct-1:task:summaries",
              targets: ["item:6", "item:7"],
            },
          ],
        );
        // targetIds narrow it to the part's own papers, in either id form.
        assert.deepEqual(
          applyOrdinaryTaskUpdates(
            progressed,
            input([{ taskId: "summaries", targetIds: ["7", "item:5", "99"] }]),
            40,
            scope,
          ).digestParts,
          [
            {
              taskId: "execution-direct-1:task:summaries",
              targets: ["item:5", "item:7"],
            },
          ],
        );
        // A part the same call cancels runs nothing.
        const cancelled = applyOrdinaryTaskUpdates(
          progressed,
          {
            ...input([{ taskId: "summaries" }]),
            cancelled: [{ taskId: "summaries", reason: "User changed mind" }],
          },
          40,
          scope,
        );
        assert.deepEqual(cancelled.digestParts, []);
      });

      it("a digest part that names a write capability is a write and runs no digest", function () {
        const parsed = createTaskUpdateTool().validate({
          tasks: [
            {
              ...summaries,
              expectedCapability: "zotero.notes",
              targetIds: ["5"],
            },
          ],
        });
        if (!parsed.ok) throw new Error(parsed.error);
        const applied = applyOrdinaryTaskUpdates(
          createEmptyExecutionCheckpoint(executionContext, 10),
          parsed.value,
          20,
          undefined,
        );
        assert.equal(applied.checkpoint.tasks[0].effect, "mutation");
        assert.deepEqual(applied.digestParts, []);
      });
    });
  });

  it("refuses a checkpoint another execution owns", async function () {
    const foreign = createEmptyExecutionCheckpoint(
      { ...executionContext, executionId: "execution-other" },
      10,
    );
    const error = await rejectionOf(
      call(context(foreign), { tasks: [declareSave] }),
    );
    assert.include(error.message, "belongs to another execution");
    assert.lengthOf(published, 0);
  });
});
