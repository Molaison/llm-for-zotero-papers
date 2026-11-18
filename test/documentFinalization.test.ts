import { assert } from "chai";
import { DatabaseSync } from "node:sqlite";
import { DirectDocumentFinalizer } from "../src/agent/documents/directFinalization";
import {
  deliverPendingPlanDocumentMessage,
  deliverPendingPlanDocumentMessageWithinWriteLock,
  documentMessageLead,
} from "../src/agent/documents/publication";
import {
  initPlanDocumentStore,
  loadPlanDocument,
  loadPlanDocumentOutbox,
} from "../src/agent/documents/store";
import { subscribeDocumentPublication } from "../src/agent/documents/publicationEvents";
import {
  bumpConversationWriteGeneration,
  freezeConversationWrites,
  resetConversationWriteFenceForTests,
  withConversationWriteLock,
} from "../src/shared/conversationWriteFence";
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
    resetConversationWriteFenceForTests();
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
  async function pendingPublication() {
    const { document } = await new DirectDocumentFinalizer(
      {} as ZoteroGateway,
    ).finalize({
      request: { conversationKey: 42 } as AgentRuntimeRequest,
      runId: "late-publication",
      input: {
        title: "Review",
        markdown: "# Review",
        citations: [],
        quotes: [],
        assets: [],
        groundingReviewed: "passed",
        groundingIssues: [],
        documentKind: "guide",
        integrityPolicy: "authored",
      },
      now: 4,
    });
    return {
      conversationKey: 42,
      documentId: document.documentId,
      visibleMarkdown: document.visibleMarkdown,
      messageTimestamp: 5,
    };
  }

  for (const boundary of [
    "list",
    "document",
    "mark read",
    "transaction",
    "announcement",
  ]) {
    for (const invalidation of ["clear", "delete"]) {
      it(`rejects ${invalidation} invalidation at the ${boundary} publication boundary`, async function () {
        const params = await pendingPublication();
        const invalidate = () =>
          invalidation === "clear"
            ? bumpConversationWriteGeneration(42)
            : freezeConversationWrites(42);
        const originalQuery = Zotero.DB.queryAsync;
        const originalTransaction = Zotero.DB.executeTransaction;
        let invalidated = false;
        let announced = 0;
        let notified = 0;
        const unsubscribe = subscribeDocumentPublication(
          params.documentId,
          () => notified++,
        );
        Zotero.DB.queryAsync = (async (sql: string, args?: unknown[]) => {
          const result = await originalQuery(sql, args);
          const target =
            boundary === "list"
              ? /WHERE conversation_key = \? ORDER BY created_at DESC/
              : boundary === "document"
                ? /FROM llm_for_zotero_plan_documents\s+WHERE document_id/
                : boundary === "mark read"
                  ? /FROM llm_for_zotero_plan_document_outbox\s+WHERE document_id/
                  : /never-match/;
          if (!invalidated && target.test(sql)) {
            invalidated = true;
            invalidate();
          }
          return result;
        }) as typeof Zotero.DB.queryAsync;
        Zotero.DB.executeTransaction = (async (
          task: () => Promise<unknown>,
        ) => {
          if (boundary === "transaction") {
            invalidated = true;
            invalidate();
          }
          return originalTransaction(task);
        }) as typeof Zotero.DB.executeTransaction;
        try {
          const result = await deliverPendingPlanDocumentMessage({
            ...params,
            beforeDelivered: async () => {
              announced++;
              if (boundary === "announcement") {
                invalidated = true;
                invalidate();
              }
            },
          });
          assert.isTrue(invalidated, "the intended async boundary was reached");
          assert.isNull(result);
          assert.equal(
            (await loadPlanDocumentOutbox(params.documentId))?.status,
            "pending",
          );
          assert.equal(notified, 0);
          if (["list", "document"].includes(boundary))
            assert.equal(announced, 0);
        } finally {
          Zotero.DB.queryAsync = originalQuery;
          Zotero.DB.executeTransaction = originalTransaction;
          unsubscribe();
        }
      });
    }
  }

  it("serializes duplicate delivery and announces/notifies only once", async function () {
    const params = await pendingPublication();
    let announced = 0;
    let notified = 0;
    const unsubscribe = subscribeDocumentPublication(
      params.documentId,
      () => notified++,
    );
    try {
      const delivery = () =>
        deliverPendingPlanDocumentMessage({
          ...params,
          beforeDelivered: async () => {
            announced++;
          },
        });
      await Promise.all([delivery(), delivery()]);
      await delivery();
      assert.equal(announced, 1);
      assert.equal(notified, 1);
      assert.equal(
        (await loadPlanDocumentOutbox(params.documentId))?.attemptCount,
        1,
      );
    } finally {
      unsubscribe();
    }
  });

  it("captures generation before waiting for the publication lock", async function () {
    const params = await pendingPublication();
    let resolve!: () => void;
    const gate = new Promise<void>((r) => {
      resolve = r;
    });
    const owner = withConversationWriteLock(42, () => gate);
    const pending = deliverPendingPlanDocumentMessage(params);
    bumpConversationWriteGeneration(42);
    resolve();
    await owner;
    assert.isNull(await pending);
    assert.equal(
      (await loadPlanDocumentOutbox(params.documentId))?.status,
      "pending",
    );
  });

  it("publishes through an already-held lock without reacquiring it", async function () {
    const params = await pendingPublication();
    const result = await withConversationWriteLock(42, () =>
      deliverPendingPlanDocumentMessageWithinWriteLock(params),
    );
    assert.equal(result?.documentId, params.documentId);
  });

  it("rolls back a mark dispatched before its generation became stale", async function () {
    const params = await pendingPublication();
    const originalQuery = Zotero.DB.queryAsync;
    Zotero.DB.queryAsync = (async (sql: string, args?: unknown[]) => {
      const result = await originalQuery(sql, args);
      if (/UPDATE llm_for_zotero_plan_document_outbox/.test(sql))
        bumpConversationWriteGeneration(42);
      return result;
    }) as typeof Zotero.DB.queryAsync;
    try {
      assert.isNull(await deliverPendingPlanDocumentMessage(params));
      assert.equal(
        (await loadPlanDocumentOutbox(params.documentId))?.status,
        "pending",
      );
    } finally {
      Zotero.DB.queryAsync = originalQuery;
    }
  });

  it("checks the caller's captured instance fence after awaits", async function () {
    const params = await pendingPublication();
    const originalQuery = Zotero.DB.queryAsync;
    let liveInstance = true;
    Zotero.DB.queryAsync = (async (sql: string, args?: unknown[]) => {
      const result = await originalQuery(sql, args);
      if (/WHERE conversation_key = \? ORDER BY created_at DESC/.test(sql))
        liveInstance = false;
      return result;
    }) as typeof Zotero.DB.queryAsync;
    try {
      assert.isNull(
        await deliverPendingPlanDocumentMessage({
          ...params,
          isCurrent: () => liveInstance,
          beforeDelivered: async () =>
            assert.fail("retired instance announced"),
        }),
      );
      assert.equal(
        (await loadPlanDocumentOutbox(params.documentId))?.status,
        "pending",
      );
    } finally {
      Zotero.DB.queryAsync = originalQuery;
    }
  });

  it("rejects an outbox owner replaced before the mark read", async function () {
    const params = await pendingPublication();
    assert.isNull(
      await deliverPendingPlanDocumentMessage({
        ...params,
        beforeDelivered: async () => {
          const outbox = await loadPlanDocumentOutbox(params.documentId);
          await Zotero.DB.queryAsync(
            "UPDATE llm_for_zotero_plan_document_outbox SET conversation_key = ?, payload_json = ? WHERE document_id = ?",
            [
              43,
              JSON.stringify({ ...outbox, conversationKey: 43 }),
              params.documentId,
            ],
          );
        },
      }),
    );
    assert.equal(
      (await loadPlanDocumentOutbox(params.documentId))?.status,
      "pending",
    );
  });

  it("lets queued clear drain publication before deleting its durable rows", async function () {
    const params = await pendingPublication();
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((r) => {
      enter = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const delivery = deliverPendingPlanDocumentMessage({
      ...params,
      beforeDelivered: async () => {
        enter();
        await gate;
      },
    });
    await entered;
    bumpConversationWriteGeneration(42);
    let cleared = false;
    const clear = withConversationWriteLock(42, async () => {
      await Zotero.DB.queryAsync(
        "DELETE FROM llm_for_zotero_plan_document_outbox WHERE conversation_key = ?",
        [42],
      );
      cleared = true;
    });
    try {
      assert.isFalse(cleared);
    } finally {
      release();
    }
    assert.isNull(await delivery);
    await clear;
    assert.isNull(await loadPlanDocumentOutbox(params.documentId));
  });

  it("delivers a document whose chat message leads with text written before the tool call", async function () {
    const markdown = "# Review\n\nThe papers agree.";
    const { document } = await new DirectDocumentFinalizer(
      {} as ZoteroGateway,
    ).finalize({
      request: { conversationKey: 42 } as AgentRuntimeRequest,
      runId: "review-run",
      input: {
        title: "Review",
        markdown,
        citations: [],
        quotes: [],
        assets: [],
        groundingReviewed: "passed" as const,
        groundingIssues: [],
        documentKind: "guide",
        integrityPolicy: "authored",
      },
      now: 4,
    });
    const messageText = `## Per-paper summaries\n\n**1. Smith (2021)**\n\nDrift grows.\n\n${document.visibleMarkdown}`;
    // Without the document's id, a prefixed message is not proof of delivery.
    assert.isNull(
      await deliverPendingPlanDocumentMessage({
        conversationKey: 42,
        visibleMarkdown: messageText,
        messageTimestamp: 5,
      }),
    );
    // A message that does not end with the document never delivers it.
    assert.isNull(
      await deliverPendingPlanDocumentMessage({
        conversationKey: 42,
        documentId: document.documentId,
        visibleMarkdown: `${document.visibleMarkdown}\n\nMore.`,
        messageTimestamp: 5,
      }),
    );
    const delivered = await deliverPendingPlanDocumentMessage({
      conversationKey: 42,
      documentId: document.documentId,
      visibleMarkdown: messageText,
      messageTimestamp: 5,
    });
    assert.equal(delivered?.documentId, document.documentId);
    assert.equal(
      (await loadPlanDocumentOutbox(document.documentId))?.status,
      "delivered",
    );
    // The chat shows the lead above the card; Copy, Export and Save Note
    // deliver the stored document, which is the message's suffix alone.
    assert.equal(
      documentMessageLead(messageText, delivered!.visibleMarkdown),
      "## Per-paper summaries\n\n**1. Smith (2021)**\n\nDrift grows.",
    );
    assert.equal(
      (await loadPlanDocument(document.documentId))?.visibleMarkdown,
      document.visibleMarkdown,
    );
    assert.equal(
      documentMessageLead(document.visibleMarkdown, document.visibleMarkdown),
      "",
    );
    assert.isUndefined(
      documentMessageLead(
        `${document.visibleMarkdown}\n\nMore.`,
        document.visibleMarkdown,
      ),
    );
  });
  it("leaves the outbox entry pending when the announcement fails", async function () {
    const { document } = await new DirectDocumentFinalizer(
      {} as ZoteroGateway,
    ).finalize({
      request: { conversationKey: 42 } as AgentRuntimeRequest,
      runId: "announce-run",
      input: {
        title: "Review",
        markdown: "# Review\n\nThe papers agree.",
        citations: [],
        quotes: [],
        assets: [],
        groundingReviewed: "passed" as const,
        groundingIssues: [],
        documentKind: "guide",
        integrityPolicy: "authored",
      },
      now: 4,
    });
    const params = {
      conversationKey: 42,
      documentId: document.documentId,
      visibleMarkdown: document.visibleMarkdown,
      messageTimestamp: 5,
    };
    let thrown: unknown;
    try {
      await deliverPendingPlanDocumentMessage({
        ...params,
        beforeDelivered: async () => {
          throw new Error("trace write failed");
        },
      });
    } catch (error) {
      thrown = error;
    }
    assert.match(String(thrown), /trace write failed/);
    assert.equal(
      (await loadPlanDocumentOutbox(document.documentId))?.status,
      "pending",
    );
    let announced = 0;
    const delivered = await deliverPendingPlanDocumentMessage({
      ...params,
      beforeDelivered: async () => {
        announced += 1;
      },
    });
    assert.equal(delivered?.documentId, document.documentId);
    assert.equal(announced, 1);
    assert.equal(
      (await loadPlanDocumentOutbox(document.documentId))?.status,
      "delivered",
    );
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
