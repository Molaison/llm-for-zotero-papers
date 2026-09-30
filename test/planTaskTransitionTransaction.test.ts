import { initDormantPlanTables } from "../src/agent/store/dormantPlanTables";
import {
  semanticContractFixture,
  classifiedFixture,
} from "./helpers/semanticIntent";
import type { ActionConstraint } from "../src/agent/authorization/types";
const noExecution: ActionConstraint[] = [
  {
    kind: "deny_mechanisms",
    mechanisms: ["shell", "zotero_script"],
    description: "Do not execute commands or scripts.",
  },
];
const noZoteroWrites: ActionConstraint = {
  kind: "deny_effects",
  domains: ["zotero_library"],
  effects: ["create", "modify", "delete"],
  description: "Do not modify Zotero.",
};
const noExternalWrites: ActionConstraint = {
  kind: "deny_effects",
  domains: ["filesystem"],
  effects: ["create", "modify", "delete"],
  description: "Do not write external files.",
};
import { assert } from "chai";
import { DatabaseSync } from "node:sqlite";
import { PlanExecutionCoordinator } from "../src/agent/plans/coordinator";
import { initPlanDocumentStore } from "../src/agent/documents/store";
import {
  loadPlanExecutionLedger,
  savePlanExecutionLedger,
  saveTaskEvidence,
} from "../src/agent/plans/store";
import type {
  ExecutionTask,
  PlanExecutionLedger,
  TaskEvidence,
} from "../src/agent/plans/types";
import { initResearchStore } from "../src/agent/research/store";
import { announceFinalizedMaterialForRunForTests } from "../src/modules/contextPanel/chat";
import {
  initAgentTraceStore,
  getAgentRunTrace,
  createAgentRun,
  appendAgentRunEvent,
} from "../src/agent/store/traceStore";
import type { AgentEvent } from "../src/agent/types";
import { ensureConversationKeyLedgerEntry } from "../src/shared/conversationKeyLedger";

const globalScope = globalThis as typeof globalThis & { Zotero?: unknown };

function reasoningTask(): ExecutionTask {
  return {
    version: 2,
    taskId: "execution-1:task-1",
    executionId: "execution-1",
    planStepId: "step-1",
    kind: "required_step",
    content: "Synthesize the evidence",
    activeForm: "Synthesizing the evidence",
    acceptanceCriteria: [
      {
        criterionId: "criterion-1",
        description: "A bounded conclusion is recorded",
        verifier: "bounded_reasoning",
      },
    ],
    expectedEffect: "reasoning",
    completionRequirements: [
      {
        requirementId: "requirement-1",
        kind: "bounded_reasoning",
        criterionIds: ["criterion-1"],
        contractDigest: "sha256:contract",
      },
    ],
    obligationIds: [],
    status: "in_progress",
    attemptCount: 1,
    evidenceIds: [],
    failureReasons: [],
    createdAt: 1,
    updatedAt: 1,
    startedAt: 1,
  };
}

function execution(): PlanExecutionLedger {
  return {
    version: 2,
    executionId: "execution-1",
    planId: "plan-1",
    revision: 1,
    planDigest: "sha256:plan",
    conversationKey: 41,
    attempt: 1,
    provider: "original",
    grant: {
      version: 1,
      planId: "plan-1",
      revision: 1,
      planDigest: "sha256:plan",
      conversationKey: 41,
      conversationGeneration: 1,
      approvedAt: 1,
    },
    status: "running",
    activeTaskId: "execution-1:task-1",
    tasks: [reasoningTask()],
    createdAt: 1,
    updatedAt: 1,
  };
}

function reasoningEvidence(): TaskEvidence {
  return {
    version: 3,
    evidenceId: "evidence-1",
    executionId: "execution-1",
    taskId: "execution-1:task-1",
    kind: "reasoning_assertion",
    verified: true,
    requirementId: "requirement-1",
    criterionIds: ["criterion-1"],
    contractDigest: "sha256:contract",
    payload: {
      type: "bounded_reasoning",
      assertion: "The evidence supports the bounded conclusion.",
    },
    summary: "The evidence supports the bounded conclusion.",
    createdAt: 2,
  };
}

function hostVerifiedResearchExecution(): PlanExecutionLedger {
  const makeTask = (params: {
    suffix: string;
    content: string;
    status: ExecutionTask["status"];
    requirementKind:
      | "verified_read"
      | "research_coverage"
      | "document_integrity";
  }): ExecutionTask => ({
    version: 2,
    taskId: `execution-1:task-${params.suffix}`,
    executionId: "execution-1",
    planStepId: `step-${params.suffix}`,
    kind: "required_step",
    content: params.content,
    activeForm: params.content,
    acceptanceCriteria: [
      {
        criterionId: `criterion-${params.suffix}`,
        description: params.content,
        verifier: params.requirementKind,
      },
    ],
    expectedEffect:
      params.requirementKind === "document_integrity" ? "artifact" : "read",
    completionRequirements: [
      {
        requirementId: `requirement-${params.suffix}`,
        kind: params.requirementKind,
        criterionIds: [`criterion-${params.suffix}`],
        contractDigest: "sha256:contract",
      },
    ],
    obligationIds: [],
    status: params.status,
    attemptCount: params.status === "in_progress" ? 1 : 0,
    evidenceIds: [],
    failureReasons: [],
    createdAt: 1,
    updatedAt: 1,
    startedAt: params.status === "in_progress" ? 1 : undefined,
  });
  return {
    ...execution(),
    activeTaskId: "execution-1:task-1",
    tasks: [
      makeTask({
        suffix: "1",
        content: "Understand every paper",
        status: "in_progress",
        requirementKind: "verified_read",
      }),
      makeTask({
        suffix: "2",
        content: "Synthesize relationships",
        status: "pending",
        requirementKind: "research_coverage",
      }),
      makeTask({
        suffix: "3",
        content: "Publish the document",
        status: "pending",
        requirementKind: "document_integrity",
      }),
    ],
  };
}

function hostVerifiedResearchEvidence(): TaskEvidence[] {
  return [
    {
      version: 3,
      evidenceId: "evidence-read",
      executionId: "execution-1",
      taskId: "execution-1:task-1",
      kind: "verified_read",
      verified: true,
      requirementId: "requirement-1",
      criterionIds: ["criterion-1"],
      contractDigest: "sha256:contract",
      payload: {
        type: "verified_read",
        reference: "read-1",
        observations: [
          {
            version: 1,
            observationId: "observation-1",
            issuer: "zotero_host",
            toolName: "paper_read",
            callDigest: "sha256:call",
            inputDigest: "sha256:input",
            resultDigest: "sha256:result",
            libraryID: 1,
            itemKey: "AAAA1111",
            capabilities: ["body"],
            certificateDigest: "sha256:certificate",
          },
        ],
      },
      createdAt: 2,
    },
    {
      version: 3,
      evidenceId: "evidence-coverage",
      executionId: "execution-1",
      taskId: "execution-1:task-2",
      kind: "research_coverage",
      verified: true,
      requirementId: "requirement-2",
      criterionIds: ["criterion-2"],
      contractDigest: "sha256:contract",
      payload: {
        type: "research_coverage",
        researchJobId: "research-1",
        coverageStatus: "complete",
        totalItems: 1,
        screenedItems: 1,
        candidateItems: 1,
        deepReadCompleted: 1,
      },
      createdAt: 3,
    },
  ];
}
describe("transactional Plan task transitions", function () {
  let originalZotero: unknown;
  let db: DatabaseSync;
  let failTransitionInsert = false;

  before(function () {
    originalZotero = globalScope.Zotero;
  });
  beforeEach(async function () {
    failTransitionInsert = false;
    db = new DatabaseSync(":memory:");
    const bindable = (params: unknown[] | undefined) =>
      (params || []).map((value) => (value === undefined ? null : value));
    globalScope.Zotero = {
      DB: {
        queryAsync: async (sql: string, params?: unknown[]) => {
          if (
            failTransitionInsert &&
            sql.includes("INSERT INTO llm_for_zotero_plan_task_transitions")
          ) {
            throw new Error("injected transition write failure");
          }
          const statement = db.prepare(sql);
          const normalized = sql.trimStart().toUpperCase();
          if (
            normalized.startsWith("SELECT") ||
            normalized.startsWith("PRAGMA") ||
            normalized.startsWith("WITH")
          ) {
            return statement.all(...(bindable(params) as never[]));
          }
          statement.run(...(bindable(params) as never[]));
          return [];
        },
        executeTransaction: async (task: () => Promise<unknown>) => {
          db.exec("BEGIN");
          try {
            const result = await task();
            db.exec("COMMIT");
            return result;
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
        },
      },
    } as unknown as typeof Zotero;
    await initDormantPlanTables();
    await initPlanDocumentStore();
    await initResearchStore();
    await initAgentTraceStore();
    await savePlanExecutionLedger(execution());
  });
  it("round-trips a stage event through the real trace store", async function () {
    // The store has no event-type whitelist by design, so a stage event must
    // survive a real write and read with every field intact.
    const runId = "stage-round-trip";
    await ensureConversationKeyLedgerEntry({
      conversationKey: 41,
      instanceID: "stage-instance",
      conversationID: "stage-conversation",
      system: "upstream",
      kind: "paper",
      profileSignature: "stage-profile",
      libraryID: 1,
      paperItemID: 41,
      issuedAt: 1,
    });
    await createAgentRun({
      runId,
      conversationKey: 41,
      mode: "agent",
      status: "running",
      createdAt: 1,
    });
    const stage: AgentEvent = {
      type: "agent_stage",
      stage: "zotero_action",
      status: "completed",
      callId: "call-1",
      toolName: "note_write",
      toolLabel: "Write note",
      receiptIds: ["receipt-1", "receipt-2"],
      materialRef: {
        documentId: "run:document:1",
        documentVersion: 1,
        contentHash: "sha256:note",
      },
      batchId: "batch-1",
      itemKey: "item:1",
    };
    await appendAgentRunEvent(runId, 1, stage);
    const trace = await getAgentRunTrace(runId);
    assert.deepEqual(
      trace.events.map((entry) => entry.eventType),
      ["agent_stage"],
    );
    assert.deepEqual(trace.events[0].payload, stage);
  });

  it("brackets a host-announced material with its own generation stage", async function () {
    // A native run's only material is the one the host announces after the
    // document is delivered. The run already carries stages the bridge
    // emitted, so the compatibility projection will not touch it -- this
    // append has to bracket itself, exactly as the runtime does.
    const runId = "material-stage-append";
    await ensureConversationKeyLedgerEntry({
      conversationKey: 41,
      instanceID: "material-instance",
      conversationID: "material-conversation",
      system: "upstream",
      kind: "paper",
      profileSignature: "material-profile",
      libraryID: 1,
      paperItemID: 41,
      issuedAt: 1,
    });
    await createAgentRun({
      runId,
      conversationKey: 41,
      mode: "agent",
      status: "running",
      createdAt: 1,
    });
    await appendAgentRunEvent(runId, 1, {
      type: "agent_stage",
      stage: "retrieval",
      status: "completed",
    });
    await announceFinalizedMaterialForRunForTests(runId, {
      documentId: "run:document:9",
      documentVersion: 3,
      contentHash: "sha256:report",
      title: "The report",
      version: 2,
      documentKind: "report",
    } as never);
    const trace = await getAgentRunTrace(runId);
    assert.deepEqual(
      trace.events.map((entry) => entry.eventType),
      ["agent_stage", "agent_stage", "material_finalized"],
    );
    assert.deepEqual(trace.events[1].payload, {
      type: "agent_stage",
      stage: "generation",
      status: "completed",
      materialRef: {
        documentId: "run:document:9",
        documentVersion: 3,
        contentHash: "sha256:report",
      },
    });
  });
  afterEach(function () {
    db.close();
    globalScope.Zotero = originalZotero;
  });
  it("commits bounded evidence and completion together", async function () {
    const coordinator = new PlanExecutionCoordinator();
    const updated = await coordinator.requestTransitionWithEvidence({
      request: {
        executionId: "execution-1",
        taskId: "execution-1:task-1",
        toStatus: "completed",
        requestedBy: "original",
      },
      evidence: reasoningEvidence(),
      now: 2,
    });

    assert.equal(updated.tasks[0].status, "completed");
    assert.deepEqual(updated.tasks[0].evidenceIds, ["evidence-1"]);
    assert.equal(
      Number(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM llm_for_zotero_plan_task_evidence",
          )
          .get()?.count,
      ),
      1,
    );
  });

  it("advances sequential host-verified research tasks without model bookkeeping", async function () {
    await savePlanExecutionLedger(hostVerifiedResearchExecution());
    for (const evidence of hostVerifiedResearchEvidence()) {
      await saveTaskEvidence(evidence);
    }

    const updated = await new PlanExecutionCoordinator().advanceVerifiedTasks({
      executionId: "execution-1",
      requirementKinds: ["verified_read", "research_coverage"],
      now: 4,
    });

    assert.deepEqual(
      updated.tasks.map((task) => task.status),
      ["completed", "completed", "in_progress"],
    );
    assert.equal(updated.activeTaskId, "execution-1:task-3");
  });
  it("rolls back an entire Plan transition batch when a later transition is invalid", async function () {
    const first = reasoningTask();
    const second: ExecutionTask = {
      ...reasoningTask(),
      taskId: "execution-1:task-2",
      planStepId: "step-2",
      content: "Write a second bounded conclusion",
      activeForm: "Writing a second bounded conclusion",
      status: "pending",
      attemptCount: 0,
      startedAt: undefined,
    };
    await savePlanExecutionLedger({
      ...execution(),
      tasks: [first, second],
    });

    let failure = "";
    try {
      await new PlanExecutionCoordinator().requestTransitionBatch(
        [
          {
            request: {
              executionId: "execution-1",
              taskId: first.taskId,
              toStatus: "completed",
              requestedBy: "original",
            },
            evidence: reasoningEvidence(),
          },
          {
            request: {
              executionId: "execution-1",
              taskId: second.taskId,
              toStatus: "skipped",
              requestedBy: "original",
            },
          },
        ],
        2,
      );
    } catch (error) {
      failure = String(error);
    }

    assert.match(failure, /only the user may skip/i);
    const persisted = await loadPlanExecutionLedger("execution-1");
    assert.deepEqual(
      persisted?.tasks.map((task) => task.status),
      ["in_progress", "pending"],
    );
    assert.equal(
      Number(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM llm_for_zotero_plan_task_evidence",
          )
          .get()?.count,
      ),
      0,
    );
  });
  it("rolls back evidence and progress when the transition write fails", async function () {
    const coordinator = new PlanExecutionCoordinator();
    failTransitionInsert = true;
    let failure = "";
    try {
      await coordinator.requestTransitionWithEvidence({
        request: {
          executionId: "execution-1",
          taskId: "execution-1:task-1",
          toStatus: "completed",
          requestedBy: "original",
        },
        evidence: reasoningEvidence(),
        now: 2,
      });
    } catch (error) {
      failure = String(error);
    }

    assert.match(failure, /injected transition write failure/);
    assert.equal(
      Number(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM llm_for_zotero_plan_task_evidence",
          )
          .get()?.count,
      ),
      0,
    );
    const persisted = await loadPlanExecutionLedger("execution-1");
    assert.equal(persisted?.tasks[0].status, "in_progress");
    assert.deepEqual(persisted?.tasks[0].evidenceIds, []);
  });

  for (const attachment of ["evidence", "receipts"] as const) {
    it(`rolls back ${attachment} when saving its task ledger fails, then retries once`, async function () {
      const coordinator = new PlanExecutionCoordinator();
      const attach = () =>
        attachment === "evidence"
          ? coordinator.attachEvidence(reasoningEvidence())
          : coordinator.attachReceiptEvidence({
              executionId: "execution-1",
              taskId: "execution-1:task-1",
              now: 2,
              receipts: [
                {
                  version: 2,
                  id: "receipt-1",
                  obligationId: "obligation-1",
                  proposalId: "proposal-1",
                  proofDomain: "zotero_state",
                  capability: "zotero.metadata",
                  operation: "update_metadata",
                  verification: "verified",
                  status: "applied",
                  requestedTargets: ["1"],
                  appliedTargets: ["1"],
                  alreadySatisfiedTargets: [],
                  rejectedTargets: [],
                  reasons: [],
                  verifiedFacts: ["target 1 re-read"],
                },
              ],
            });
      const before = await loadPlanExecutionLedger("execution-1");
      const originalQuery = Zotero.DB.queryAsync;
      Zotero.DB.queryAsync = (async (sql: string, params?: unknown[]) => {
        if (
          sql.includes(
            "INSERT OR REPLACE INTO llm_for_zotero_plan_execution_tasks",
          )
        )
          throw new Error("injected ledger write failure");
        return originalQuery(sql, params);
      }) as typeof Zotero.DB.queryAsync;
      let failure = "";
      try {
        await attach();
      } catch (error) {
        failure = String(error);
      } finally {
        Zotero.DB.queryAsync = originalQuery;
      }
      assert.match(failure, /injected ledger write failure/);
      const rows = () =>
        Number(
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM llm_for_zotero_plan_task_evidence",
            )
            .get()?.count,
        );
      assert.equal(rows(), 0);
      assert.deepEqual(await loadPlanExecutionLedger("execution-1"), before);
      await attach();
      await attach();
      assert.equal(rows(), 1);
      const persisted = await loadPlanExecutionLedger("execution-1");
      assert.lengthOf(persisted!.tasks[0].evidenceIds, 1);
    });
  }

  it("uses the same transition state with preattached or simultaneous evidence", async function () {
    const coordinator = new PlanExecutionCoordinator();
    const request = {
      executionId: "execution-1",
      taskId: "execution-1:task-1",
      toStatus: "completed",
      requestedBy: "original",
    } as const;
    await coordinator.attachEvidence(reasoningEvidence());
    const separate = await coordinator.requestTransition(request, 3);
    await savePlanExecutionLedger(execution());
    const together = await coordinator.requestTransitionWithEvidence({
      request,
      evidence: reasoningEvidence(),
      now: 3,
    });
    assert.deepEqual(together, separate);
  });
});
