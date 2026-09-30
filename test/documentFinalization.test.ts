import { assert } from "chai";
import { DatabaseSync } from "node:sqlite";
import { createDocumentPlan } from "./helpers/documentPlan";
import { PlanExecutionCoordinator } from "../src/agent/plans/coordinator";
import { DirectDocumentFinalizer } from "../src/agent/documents/directFinalization";
import { deliverPendingPlanDocumentMessage } from "../src/agent/documents/publication";
import {
  initPlanDocumentStore,
  loadPlanDocument,
  loadPlanDocumentOutbox,
} from "../src/agent/documents/store";
import { listTaskEvidence } from "../src/agent/plans/store";
import { initResearchStore } from "../src/agent/research/store";
import type { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import type { AgentRuntimeRequest } from "../src/agent/types";
import { canonicalJson } from "../src/agent/services/libraryMutation/canonicalJson";
import { sha256Text } from "../src/agent/store/journalRecoveryBlobStore";
import { initDormantPlanTables } from "../src/agent/store/dormantPlanTables";

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
    await initDormantPlanTables();
    await initPlanDocumentStore();
    await initResearchStore();
  });
  afterEach(function () {
    globals.Zotero = original;
    db.close();
  });

  it("ignores a read receipt no approved effect names, and still rejects an unmatched write", async function () {
    // A real paper_read full inside an approved plan emits a read_full
    // receipt; treating it as an unauthorized effect crashed the whole run.
    const plan = await createDocumentPlan();
    const taskId = plan.tasks[0].taskId;
    const read = {
      version: 2,
      id: "read_full:fallback",
      proposalId: "read_full:fallback",
      proofDomain: "zotero_state",
      capability: "zotero.read",
      operation: "read_full",
      verification: "verified",
      status: "observed",
      requestedTargets: [],
      appliedTargets: [],
      alreadySatisfiedTargets: [],
      rejectedTargets: [],
      reasons: [],
      verifiedFacts: ["read_mode:full"],
    };
    const coordinator = new PlanExecutionCoordinator();
    const after = await coordinator.attachReceiptEvidence({
      executionId: plan.executionId,
      taskId,
      receipts: [read as never],
    });
    assert.deepEqual(after.tasks, plan.tasks);
    assert.isEmpty(await listTaskEvidence(plan.executionId, taskId));
    let failure = "";
    try {
      await coordinator.attachReceiptEvidence({
        executionId: plan.executionId,
        taskId,
        receipts: [
          {
            ...read,
            id: "note:1",
            proposalId: "note:1",
            capability: "zotero.notes",
            operation: "note_create",
            status: "applied",
          } as never,
        ],
      });
    } catch (error) {
      failure = String(error);
    }
    assert.match(failure, /does not match an active approved effect/);
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
  it("preserves direct document identity, hash, retry and publication", async function () {
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
      new DirectDocumentFinalizer(gateway).finalize({
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
    Zotero.DB.queryAsync = (async (sql: string, params?: unknown[]) => {
      if (sql.includes("INSERT INTO llm_for_zotero_plan_document_outbox"))
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
    const first = await finalize();
    const retried = await finalize();
    assert.equal(retried.document.documentId, first.document.documentId);
    assert.equal(first.document.documentId, "guide-run:document:1");
    assert.equal(retried.document.contentHash, first.document.contentHash);
    assert.equal(first.document.visibleMarkdown, input.markdown);
    assert.equal(first.document.validation.groundingReviewed, "not_run");
    assert.equal(
      first.document.contentHash,
      `sha256:${await sha256Text(canonicalJson({ title: input.title, markdown: input.markdown, citations: first.document.citationBundle, verifiedQuotes: [], assets: [], coverageItems: [], validation: first.document.validation }))}`,
    );
    assert.equal(
      (await loadPlanDocument(first.document.documentId))?.visibleMarkdown,
      input.markdown,
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
  });
});
