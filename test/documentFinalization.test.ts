import { assert } from "chai";
import { DatabaseSync } from "node:sqlite";
import { DirectDocumentFinalizer } from "../src/agent/documents/directFinalization";
import { deliverPendingPlanDocumentMessage } from "../src/agent/documents/publication";
import {
  initPlanDocumentStore,
  loadPlanDocument,
  loadPlanDocumentOutbox,
} from "../src/agent/documents/store";
import type { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import type { AgentRuntimeRequest } from "../src/agent/types";
import { canonicalJson } from "../src/agent/services/libraryMutation/canonicalJson";
import { sha256Text } from "../src/agent/store/journalRecoveryBlobStore";
import { initDormantPlanTables } from "../src/agent/store/dormantPlanTables";
import { initDormantResearchTables } from "../src/agent/store/dormantResearchTables";

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
    await initDormantResearchTables();
  });
  afterEach(function () {
    globals.Zotero = original;
    db.close();
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
        request: { conversationKey: 41 } as AgentRuntimeRequest,
        runId: "guide-run",
        input: { ...input, documentKind: "guide", integrityPolicy: "authored" },
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
