import { assert } from "chai";
import { DatabaseSync } from "node:sqlite";
import { createDocumentPlan } from "./helpers/documentPlan";
import { PlanExecutionCoordinator } from "../src/agent/plans/coordinator";
import { PlanDocumentFinalizer } from "../src/agent/documents/planFinalization";
import { DirectDocumentFinalizer } from "../src/agent/documents/directFinalization";
import { deliverPendingPlanDocumentMessage } from "../src/agent/documents/publication";
import {
  initPlanDocumentStore,
  loadPlanDocument,
  loadPlanDocumentOutbox,
} from "../src/agent/documents/store";
import {
  initAgentPlanStore,
  listTaskEvidence,
  loadPlanExecutionLedger,
  savePlanExecutionLedger,
} from "../src/agent/plans/store";
import { buildApprovedPlanExecutionInstructions } from "../src/agent/plans/executionInstructions";
import { ToolInputRejection } from "../src/agent/tools/execution/failure";
import { initResearchStore } from "../src/agent/research/store";
import type { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import type { AgentRuntimeRequest } from "../src/agent/types";
import { canonicalJson } from "../src/agent/services/libraryMutation/canonicalJson";
import { sha256Text } from "../src/agent/store/journalRecoveryBlobStore";

describe("document finalization persistence", function () {
  const globals = globalThis as typeof globalThis & { Zotero?: unknown };
  let original: unknown;
  let db: DatabaseSync;
  beforeEach(async function () {
    original = globals.Zotero;
    db = new DatabaseSync(":memory:");
    globals.Zotero = {
      DB: {
        queryAsync: async (sql: string, params: unknown[] = []) => {
          const statement = db.prepare(sql);
          const values = params.map((value) =>
            value === undefined ? null : value,
          ) as never[];
          if (/^\s*(SELECT|PRAGMA|WITH)/i.test(sql))
            return statement.all(...values);
          statement.run(...values);
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
    };
    await initAgentPlanStore();
    await initPlanDocumentStore();
    await initResearchStore();
  });
  afterEach(function () {
    globals.Zotero = original;
    db.close();
  });

  it("rejects a draft step whose material no later save consumes, before approval", async function () {
    // A live literature-review plan added such a step; its material_integrity
    // could never be satisfied, so publication waited on it forever.
    const spec = {
      kind: "literature_review" as const,
      title: "Review",
      requiredSections: ["Review"],
      requiresReferences: false,
      requiresCoverageSection: false,
      allowFigures: false,
      citationStyle: {
        styleId: "http://www.zotero.org/styles/apa",
        styleTitle: "APA",
        locale: "en-US",
      },
    };
    let failure = "";
    try {
      await new PlanExecutionCoordinator().updateDraft({
        planId: "draft-material-plan",
        conversationKey: 41,
        provider: "original",
        revision: 1,
        ready: true,
        now: 1,
        contract: { deliverable: { kind: "document", spec } },
        steps: [
          {
            content: "Draft the review",
            expectedEffect: "artifact",
            materialOutputId: "review-draft",
            acceptanceCriteria: [
              {
                criterionId: "draft",
                description: "The draft is stored",
                verifier: "material_integrity",
              },
            ],
          },
          {
            content: "Publish the review",
            expectedEffect: "artifact",
            acceptanceCriteria: [
              {
                criterionId: "integrity",
                description: "The review is complete",
                verifier: "document_integrity",
              },
              {
                criterionId: "published",
                description: "The review is published",
                verifier: "document_published",
              },
            ],
          },
        ],
      });
    } catch (error) {
      failure = String(error);
    }
    assert.match(failure, /material_integrity is only for an artifact step/);
  });

  it("does not direct final publication through the intermediate material route", async function () {
    const plan = await createDocumentPlan();
    plan.tasks[0].materialOutputId = "final-document";
    assert.notInclude(
      buildApprovedPlanExecutionInstructions(plan),
      "Generate materialOutputId=final-document",
    );
    plan.tasks[0].completionRequirements = [];
    assert.include(
      buildApprovedPlanExecutionInstructions(plan),
      "Generate materialOutputId=final-document",
    );
  });

  it("returns recoverable guidance without publishing during prerequisite work", async function () {
    const plan = await createDocumentPlan();
    plan.tasks[0].content = "Verify the paper evidence";
    plan.tasks[0].completionRequirements = [];
    await savePlanExecutionLedger(plan);
    let failure: unknown;
    try {
      await new PlanDocumentFinalizer({} as ZoteroGateway).finalize({
        executionId: plan.executionId,
        activeTaskId: plan.activeTaskId!,
        input: {
          title: "Guide",
          markdown: "# Guide\n\nA premature draft.",
          citations: [],
          quotes: [],
          assets: [],
          groundingReviewed: "passed",
          groundingIssues: [],
        },
        now: 4,
      });
    } catch (error) {
      failure = error;
    }
    assert.instanceOf(failure, ToolInputRejection);
    assert.include(String(failure), "Verify the paper evidence");
    assert.include(String(failure), "research_update next_work");
    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS count FROM llm_for_zotero_plan_documents")
        .get()?.count,
      0,
    );
  });

  for (const origin of ["planned", "planned-material", "direct"] as const) {
    it(`preserves ${origin} document identity, hash, retry and publication`, async function () {
      const plan = origin !== "direct" ? await createDocumentPlan() : undefined;
      if (plan && origin === "planned-material") {
        const task = plan.tasks[0];
        task.materialOutputId = "review";
        task.completionRequirements!.push({
          requirementId: "review-material",
          kind: "material_integrity",
          criterionIds: ["review-content"],
          contractDigest: task.completionRequirements![0].contractDigest,
        });
        await savePlanExecutionLedger(plan);
      }
      const input = {
        title: "Guide",
        markdown: "# Guide\n\nAn exact saved guide.",
        citations: [],
        quotes: [],
        assets: [],
        groundingReviewed: "passed" as const,
        groundingIssues: [],
      };
      const gateway = {} as ZoteroGateway;
      const finalize = () =>
        plan
          ? new PlanDocumentFinalizer(gateway).finalize({
              executionId: plan.executionId,
              activeTaskId: plan.activeTaskId!,
              input,
              now: 4,
            })
          : new DirectDocumentFinalizer(gateway).finalize({
              request: {
                conversationKey: 41,
                documentOutcomePolicy: {
                  required: true,
                  documentKind: "guide",
                  integrityPolicy: "authored",
                  trigger: "document_intent",
                },
              } as AgentRuntimeRequest,
              runId: "guide-run",
              input,
              now: 4,
            });
      const originalQuery = Zotero.DB.queryAsync;
      const failedWrite = plan
        ? "INSERT OR REPLACE INTO llm_for_zotero_plan_execution_tasks"
        : "INSERT INTO llm_for_zotero_plan_document_outbox";
      Zotero.DB.queryAsync = (async (sql: string, params?: unknown[]) => {
        if (sql.includes(failedWrite))
          throw new Error("injected finalization write failure");
        return originalQuery(sql, params);
      }) as typeof Zotero.DB.queryAsync;
      let failure = "";
      try {
        await finalize();
      } catch (error) {
        failure = String(error);
      } finally {
        Zotero.DB.queryAsync = originalQuery;
      }
      assert.include(failure, "injected finalization write failure");
      for (const table of [
        "llm_for_zotero_plan_documents",
        "llm_for_zotero_plan_document_outbox",
        "llm_for_zotero_plan_task_evidence",
      ]) {
        assert.equal(
          Number(
            db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count,
          ),
          0,
          `${table} rolls back with the failed finalization`,
        );
      }
      if (plan)
        assert.deepEqual(
          (await loadPlanExecutionLedger(plan.executionId))!.tasks[0]
            .evidenceIds,
          [],
        );
      const first = await finalize();
      const retried = await finalize();
      assert.equal(retried.document.documentId, first.document.documentId);
      assert.equal(
        first.document.documentId,
        plan ? `${plan.planId}:r1:document:1` : "guide-run:document:1",
      );
      assert.equal(retried.document.contentHash, first.document.contentHash);
      assert.equal(first.document.visibleMarkdown, input.markdown);
      assert.equal(
        first.document.validation.groundingReviewed,
        plan ? "passed" : "not_run",
      );
      assert.equal(
        first.document.contentHash,
        `sha256:${await sha256Text(canonicalJson({ title: input.title, markdown: input.markdown, citations: first.document.citationBundle, verifiedQuotes: [], assets: [], coverageItems: [], validation: first.document.validation }))}`,
      );
      assert.equal(
        (await loadPlanDocument(first.document.documentId))?.visibleMarkdown,
        input.markdown,
      );
      if (plan)
        assert.lengthOf(
          await listTaskEvidence(plan.executionId, plan.activeTaskId!),
          origin === "planned-material" ? 2 : 1,
        );
      await deliverPendingPlanDocumentMessage({
        conversationKey: 41,
        documentId: first.document.documentId,
        visibleMarkdown: input.markdown,
        messageTimestamp: 5,
      });
      assert.equal(
        (await loadPlanDocumentOutbox(first.document.documentId))?.status,
        "delivered",
      );
      if (plan)
        assert.equal(
          (await loadPlanExecutionLedger(plan.executionId))?.status,
          "completed",
        );
      if (plan && origin === "planned-material") {
        // The reported native run saved and delivered its document, but its
        // missing material evidence left publication interrupted on recovery.
        db.exec(
          "DELETE FROM llm_for_zotero_plan_task_evidence WHERE kind = 'material_integrity'",
        );
        const interrupted = (await loadPlanExecutionLedger(plan.executionId))!;
        interrupted.status = "interrupted";
        interrupted.activeTaskId = undefined;
        interrupted.tasks[0].status = "interrupted";
        interrupted.tasks[0].evidenceIds =
          interrupted.tasks[0].evidenceIds.filter(
            (id) => !id.endsWith(":material"),
          );
        await savePlanExecutionLedger(interrupted);
        await deliverPendingPlanDocumentMessage({
          conversationKey: 41,
          documentId: first.document.documentId,
          visibleMarkdown: input.markdown,
          messageTimestamp: 5,
        });
        assert.equal(
          (await loadPlanExecutionLedger(plan.executionId))?.status,
          "completed",
        );
      }
      if (plan) {
        const historical = (await loadPlanExecutionLedger(plan.executionId))!;
        historical.status = "superseded";
        await savePlanExecutionLedger(historical);
        const reopened = await deliverPendingPlanDocumentMessage({
          conversationKey: 41,
          documentId: first.document.documentId,
          visibleMarkdown: input.markdown,
          messageTimestamp: 5,
        });
        assert.equal(reopened?.contentHash, first.document.contentHash);
        assert.deepEqual(
          await loadPlanExecutionLedger(plan.executionId),
          historical,
        );
      }
    });
  }
});
