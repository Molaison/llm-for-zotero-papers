import { assert } from "chai";
import { DatabaseSync } from "node:sqlite";
import {
  appendMessage,
  createPaperConversation,
  initChatStore,
  loadConversation,
  replaceConversationMessages,
  restoreConversationMessages,
  hasConversationRestorePoint,
  clearConversation,
  deletePaperConversation,
  deleteUpstreamConversationLocalRows,
} from "../src/utils/chatStore";
import {
  replaceCurrentPaperChat,
  restoreCurrentPaperChat,
} from "../src/modules/contextPanel/chat";
import {
  createPaperPortalItem,
  resolveConversationBaseItem,
} from "../src/modules/contextPanel/portalScope";
import {
  chatHistory,
  draftInputCache,
  loadedConversationKeys,
  selectedPaperContextCache,
} from "../src/modules/contextPanel/state";
import {
  getConversationWriteGeneration,
  bumpConversationWriteGeneration,
  resetConversationWriteFenceForTests,
  withConversationWriteLock,
} from "../src/shared/conversationWriteFence";
import { resetConversationRegistryStoreInitForTests } from "../src/shared/conversationRegistry";
import { resetRecentlyDeletedConversationsForTests } from "../src/core/conversations/recentlyDeletedConversations";
import { resetPendingDeletionStoreForTests } from "../src/core/conversations/pendingDeletionStore";
import { prepareCprPaperRequest } from "../src/utils/cprPapers";

import { collectAndDeleteUnreferencedBlobs } from "../src/utils/attachmentRefStore";
import { MAX_CONVERSATION_RESTORE_BYTES } from "../src/utils/conversationRestorePoint";

const originalZotero = globalThis.Zotero;
const table = "llm_for_zotero_chat_messages";
const remote = [
  { role: "user" as const, text: "Remote question", timestamp: 1700000000000 },
  { role: "assistant" as const, text: "Remote answer", timestamp: null },
];
describe("CPR conversation snapshot replacement", function () {
  let db: DatabaseSync;
  let key: number;
  let portal: Zotero.Item;
  let body: Element;
  let prefs: Map<string, unknown>;
  let failCommit = false;
  let onQuery: ((sql: string) => void) | undefined;
  let depth = 0;
  const rows = () =>
    db
      .prepare(
        `SELECT * FROM ${table} WHERE conversation_key=? ORDER BY timestamp,id`,
      )
      .all(key);
  const options = () => ({
    expectedGeneration: getConversationWriteGeneration(key),
    isCurrent: () => true,
  });
  const replacePanel = (isCurrent = () => true) =>
    replaceCurrentPaperChat({
      body,
      item: portal,
      conversationKey: key,
      expectedGeneration: getConversationWriteGeneration(key),
      messages: remote.map((message) => ({
        role: message.role,
        text: message.text,
        created_at: message.timestamp,
      })),
      isCurrent,
    });
  beforeEach(async function () {
    resetPendingDeletionStoreForTests();
    resetConversationWriteFenceForTests();
    resetConversationRegistryStoreInitForTests();
    resetRecentlyDeletedConversationsForTests();
    db = new DatabaseSync(":memory:");
    prefs = new Map();
    failCommit = false;
    onQuery = undefined;
    depth = 0;
    const paper = {
      id: 7,
      key: "PAPER7",
      libraryID: 1,
      isRegularItem: () => true,
      isAttachment: () => false,
      isNote: () => false,
      getField: (field: string) =>
        field === "DOI" ? "10.1234/snapshot" : "Paper title",
    } as unknown as Zotero.Item;
    globalThis.Zotero = {
      ...originalZotero,
      Profile: { dir: "/tmp/cpr-snapshot-test" },
      Libraries: { userLibraryID: 1 },
      Items: { get: (id: number) => (id === paper.id ? paper : false) },
      Prefs: {
        get: (name: string) => prefs.get(name),
        set: (name: string, value: unknown) => prefs.set(name, value),
        clear: (name: string) => prefs.delete(name),
      },
      debug: () => {},
      DB: {
        queryAsync: async (sql: string, params: unknown[] = []) => {
          onQuery?.(sql);
          const stmt = db.prepare(sql),
            bound = params.map((value) =>
              value === undefined ? null : value,
            ) as never[];
          if (/^\s*(SELECT|PRAGMA|WITH)\b/i.test(sql)) {
            return stmt.all(...bound).map(
              (row) =>
                new Proxy(row, {
                  get(target, prop) {
                    if (typeof prop === "string" && !(prop in target))
                      throw new Error("Missing selected column " + prop);
                    return Reflect.get(target, prop);
                  },
                }),
            );
          }
          stmt.run(...bound);
          return [];
        },
        executeTransaction: async <T>(task: () => Promise<T>): Promise<T> => {
          if (depth) return task();
          db.exec("BEGIN IMMEDIATE");
          depth++;
          try {
            const result = await task();
            if (failCommit) throw new Error("forced persistence failure");
            db.exec("COMMIT");
            return result;
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          } finally {
            depth--;
          }
        },
      },
    } as unknown as typeof Zotero;
    await initChatStore();
    const conversation = await createPaperConversation(1, paper.id);
    assert.isNotNull(conversation);
    key = conversation!.conversationKey;
    assert.notEqual(key, paper.id);
    portal = createPaperPortalItem(paper, key, 1);
    body = {
      querySelector: (selector: string) =>
        selector === "#llm-main" ? { dataset: { itemId: String(key) } } : null,
    } as unknown as Element;
  });
  afterEach(function () {
    chatHistory.delete(key);
    loadedConversationKeys.delete(key);
    draftInputCache.delete(key);
    selectedPaperContextCache.delete(key);
    db.close();
    resetPendingDeletionStoreForTests();
    resetConversationRegistryStoreInitForTests();
    resetRecentlyDeletedConversationsForTests();
    globalThis.Zotero = originalZotero;
  });

  it("imports into the portal conversation, preserves its identity and reloads the exact remote sequence", async function () {
    const identity = db
      .prepare(
        "SELECT conversation_id,conversation_instance_id,paper_item_id,session_version FROM llm_for_zotero_paper_conversations WHERE conversation_key=?",
      )
      .get(key);
    const result = await replaceConversationMessages(key, remote, options());
    assert.deepEqual(
      result.map(({ role, text }) => ({ role, text })),
      remote.map(({ role, text }) => ({ role, text })),
    );
    assert.deepEqual(await loadConversation(key, 200), result);
    assert.deepEqual(
      db
        .prepare(
          "SELECT conversation_id,conversation_instance_id,paper_item_id,session_version FROM llm_for_zotero_paper_conversations WHERE conversation_key=?",
        )
        .get(key),
      identity,
    );
    assert.equal(
      db
        .prepare(`SELECT count(*) n FROM ${table} WHERE conversation_key=7`)
        .get()!.n,
      0,
    );
  });

  it("replaces local-only and failed turns, repeats without accumulation, and saves timestamp fallbacks", async function () {
    await appendMessage(key, {
      role: "assistant",
      text: "Local failed partial",
      timestamp: 100,
      interrupted: true,
    });
    const untimed = remote.map((message) => ({ ...message, timestamp: null }));
    const first = await replaceConversationMessages(key, untimed, options());
    const second = await replaceConversationMessages(key, untimed, options());
    assert.lengthOf(rows(), 2);
    assert.deepEqual(
      second.map((message) => message.timestamp),
      first.map((message) => message.timestamp),
    );
    assert.deepEqual(
      second.map((message) => message.text),
      ["Remote question", "Remote answer"],
    );
    await replaceConversationMessages(
      key,
      [{ ...remote[0], text: "Updated remote body" }],
      options(),
    );
    assert.deepEqual(
      (await loadConversation(key, 200)).map((message) => message.text),
      ["Updated remote body"],
    );
    await replaceConversationMessages(key, [], options());
    assert.isEmpty(await loadConversation(key, 200));
  });

  it("rolls back a failed commit and leaves in-memory chat and the current draft unchanged", async function () {
    await appendMessage(key, {
      role: "user",
      text: "Local question",
      timestamp: 100,
    });
    const local = [
      { role: "user" as const, text: "Local question", timestamp: 100 },
    ];
    chatHistory.set(key, local);
    draftInputCache.set(key, "Unsent draft");
    const before = rows();
    failCommit = true;
    let error: unknown;
    try {
      await replacePanel();
    } catch (caught) {
      error = caught;
    }
    assert.include(String(error), "forced persistence failure");
    assert.deepEqual(rows(), before);
    assert.strictEqual(chatHistory.get(key), local);
    assert.equal(draftInputCache.get(key), "Unsent draft");
  });

  it("refreshes committed messages without changing draft, compose context or selected model, then sends only the next question", async function () {
    draftInputCache.set(key, "Keep my draft");
    const contexts = [{ itemId: 7, contextItemId: 7, title: "Draft paper" }];
    selectedPaperContextCache.set(key, contexts);
    prefs.set("selected-model-fixture", "papers/gpt-5.6-sol");
    await replacePanel();
    assert.deepEqual(
      chatHistory.get(key)?.map((message) => message.text),
      ["Remote question", "Remote answer"],
    );
    assert.equal(draftInputCache.get(key), "Keep my draft");
    assert.strictEqual(selectedPaperContextCache.get(key), contexts);
    assert.equal(prefs.get("selected-model-fixture"), "papers/gpt-5.6-sol");
    const request = await prepareCprPaperRequest({
      itemId: resolveConversationBaseItem(portal)?.id,
      apiBase: "https://cpr.example/v1",
      apiKey: "fixture",
      model: "papers/gpt-5.6-sol",
      prompt: "Only my next question",
      readBytes: async () => {
        throw new Error("Must not reload the registered PDF");
      },
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            status: "completed",
            output: [
              {
                content: [
                  {
                    type: "output_text",
                    text: JSON.stringify({
                      paper_id: "doi:10.1234/snapshot",
                      thread_id: "same-server-thread",
                      status: "ready",
                      upload_required: false,
                    }),
                  },
                ],
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        ),
    });
    assert.equal(request.payload.prompt_cache_key, "same-server-thread");
    assert.deepEqual(request.payload.input[0].content, [
      { type: "input_text", text: "Only my next question" },
    ]);
    assert.notInclude(JSON.stringify(request.payload), "Remote answer");
  });

  it("rejects cancellation while waiting for the write lock and rolls back cancellation during insertion", async function () {
    await appendMessage(key, {
      role: "user",
      text: "Keep before cancellation",
      timestamp: 100,
    });
    const before = rows();
    let release!: () => void,
      current = true;
    const held = withConversationWriteLock(
      key,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await Promise.resolve();
    const pending = replaceConversationMessages(key, remote, {
      ...options(),
      isCurrent: () => current,
    }).catch((error) => error);
    current = false;
    release();
    await held;
    assert.equal((await pending).name, "AbortError");
    assert.deepEqual(rows(), before);
    current = true;
    onQuery = (sql) => {
      if (sql.includes("INSERT INTO " + table)) current = false;
    };
    let error: unknown;
    try {
      await replaceConversationMessages(key, remote, {
        ...options(),
        isCurrent: () => current,
      });
    } catch (caught) {
      error = caught;
    }
    assert.equal((error as Error).name, "AbortError");
    assert.deepEqual(rows(), before);
  });

  it("honors generation retirement and drops a panel result whose current target changed", async function () {
    await appendMessage(key, {
      role: "user",
      text: "Keep live conversation",
      timestamp: 100,
    });
    const before = rows(),
      captured = options();
    bumpConversationWriteGeneration(key);
    let error: unknown;
    try {
      await replaceConversationMessages(key, remote, captured);
    } catch (caught) {
      error = caught;
    }
    assert.equal((error as Error).name, "AbortError");
    await replacePanel(() => false);
    assert.deepEqual(rows(), before);
    db.prepare(
      "UPDATE llm_for_zotero_paper_conversations SET conversation_instance_id='different-instance' WHERE conversation_key=?",
    ).run(key);
    try {
      await replaceConversationMessages(key, remote, options());
      assert.fail("expected retired identity rejection");
    } catch (caught) {
      assert.notEqual((caught as Error).name, "AssertionError");
    }
    assert.deepEqual(rows(), before);
  });
  it("restores exact raw rich messages and attachment refs after repeated sync, restart and GC", async function () {
    const hash = "a".repeat(64);
    db.exec(`CREATE TABLE llm_for_zotero_attachment_blobs (hash TEXT PRIMARY KEY, path TEXT UNIQUE, size_bytes INTEGER, created_at INTEGER);
      CREATE TABLE llm_for_zotero_attachment_refs (owner_type TEXT, owner_id INTEGER, blob_hash TEXT, updated_at INTEGER,
      PRIMARY KEY(owner_type,owner_id,blob_hash));`);
    db.prepare(
      "INSERT INTO llm_for_zotero_attachment_blobs VALUES (?,?,?,?)",
    ).run(hash, "/tmp/local-image.png", 123, 1);
    db.prepare(
      "INSERT INTO llm_for_zotero_attachment_refs VALUES ('conversation',?,?,?)",
    ).run(key, hash, 456);
    await appendMessage(key, {
      role: "user",
      text: "Local rich turn",
      timestamp: 100,
      attachments: [
        {
          id: "image-a",
          name: "image.png",
          mimeType: "image/png",
          sizeBytes: 123,
          category: "image",
          storedPath: "/tmp/local-image.png",
          contentHash: hash,
        },
      ],
      modelAttachments: [],
      selectedText: "Local excerpt",
      paperContexts: [{ itemId: 7, title: "Paper title" }],
      modelName: "original-model",
      modelEntryId: "entry-a",
      modelProviderLabel: "Local provider",
    });
    await appendMessage(key, {
      role: "assistant",
      text: "Interrupted local response",
      timestamp: 101,
      interrupted: true,
      completionStatus: "incomplete",
      completionReason: "output_limit",
      reasoningSummary: "Saved reasoning",
      reasoningDetails: "Long reasoning",
      documentId: "doc-a",
      contextTokens: 88,
      contextWindow: 1024,
    });
    const before = rows();
    const identity = db
      .prepare(
        "SELECT * FROM llm_for_zotero_paper_conversations WHERE conversation_key=?",
      )
      .get(key);
    await replaceConversationMessages(key, remote, options());
    await replaceConversationMessages(key, [], options());
    assert.equal(
      db
        .prepare(
          "SELECT count(*) n FROM llm_for_zotero_conversation_restore_points",
        )
        .get()!.n,
      1,
    );
    assert.equal(
      db.prepare("SELECT count(*) n FROM llm_for_zotero_attachment_refs").get()!
        .n,
      0,
    );
    await collectAndDeleteUnreferencedBlobs(0);
    assert.equal(
      db
        .prepare("SELECT count(*) n FROM llm_for_zotero_attachment_blobs")
        .get()!.n,
      1,
    );
    resetConversationWriteFenceForTests();
    resetConversationRegistryStoreInitForTests();
    await initChatStore();
    assert.isTrue(await hasConversationRestorePoint(key));
    const restored = await restoreConversationMessages(key, options());
    assert.lengthOf(restored, 2);
    assert.deepEqual(rows(), before);
    assert.deepEqual(
      db
        .prepare(
          "SELECT * FROM llm_for_zotero_paper_conversations WHERE conversation_key=?",
        )
        .get(key),
      identity,
    );
    assert.deepEqual(
      db
        .prepare(
          "SELECT blob_hash,updated_at FROM llm_for_zotero_attachment_refs WHERE owner_id=?",
        )
        .get(key),
      { blob_hash: hash, updated_at: 456 },
    );
    assert.isFalse(await hasConversationRestorePoint(key));
    assert.equal(
      db
        .prepare(
          "SELECT count(*) n FROM llm_for_zotero_conversation_restore_refs",
        )
        .get()!.n,
      0,
    );
  });

  it("rolls back snapshot creation with a failed sync and preserves a restore point after a failed restore", async function () {
    await appendMessage(key, {
      role: "user",
      text: "Original local",
      timestamp: 100,
    });
    failCommit = true;
    try {
      await replaceConversationMessages(key, remote, options());
      assert.fail("expected failure");
    } catch (error) {
      assert.include(String(error), "forced persistence failure");
    }
    assert.isFalse(await hasConversationRestorePoint(key));
    failCommit = false;
    await replaceConversationMessages(key, remote, options());
    const synced = rows();
    const generation = getConversationWriteGeneration(key);
    failCommit = true;
    try {
      await restoreConversationMessages(key, options());
      assert.fail("expected failure");
    } catch (error) {
      assert.include(String(error), "forced persistence failure");
    }
    assert.deepEqual(rows(), synced);
    assert.isTrue(await hasConversationRestorePoint(key));
    assert.equal(getConversationWriteGeneration(key), generation);
    failCommit = false;
    assert.equal(
      (await restoreConversationMessages(key, options()))[0].text,
      "Original local",
    );
  });

  it("refuses oversized snapshots before replacing any local content", async function () {
    this.timeout(10000);
    await appendMessage(key, {
      role: "user",
      text: "x".repeat(MAX_CONVERSATION_RESTORE_BYTES),
      timestamp: 100,
    });
    const before = rows();
    try {
      await replaceConversationMessages(key, remote, options());
      assert.fail("expected size guard");
    } catch (error) {
      assert.include(String(error), "16 MiB restore limit");
    }
    assert.deepEqual(rows(), before);
    assert.isFalse(await hasConversationRestorePoint(key));
  });

  it("serializes concurrent replacement and recovery and rejects stale queued operations", async function () {
    await appendMessage(key, {
      role: "user",
      text: "Original local",
      timestamp: 100,
    });
    const captured = options();
    const outcomes = await Promise.allSettled([
      replaceConversationMessages(key, remote, captured),
      replaceConversationMessages(key, [], captured),
    ]);
    assert.equal(outcomes[0].status, "fulfilled");
    assert.equal(outcomes[1].status, "rejected");
    assert.equal(
      (outcomes[1] as PromiseRejectedResult).reason.name,
      "AbortError",
    );
    const restoreOptions = options();
    const restores = await Promise.allSettled([
      restoreConversationMessages(key, restoreOptions),
      restoreConversationMessages(key, restoreOptions),
    ]);
    assert.equal(restores[0].status, "fulfilled");
    assert.equal(
      (restores[1] as PromiseRejectedResult).reason.name,
      "AbortError",
    );
    assert.equal(rows()[0].text, "Original local");
  });

  it("rolls back cancellation during recovery and refuses another conversation or profile's restore point", async function () {
    await appendMessage(key, {
      role: "user",
      text: "Original local",
      timestamp: 100,
    });
    await replaceConversationMessages(key, remote, options());
    const synced = rows();
    let current = true;
    onQuery = (sql) => {
      if (sql.includes("INSERT INTO " + table)) current = false;
    };
    try {
      await restoreConversationMessages(key, {
        ...options(),
        isCurrent: () => current,
      });
      assert.fail("expected cancellation");
    } catch (error) {
      assert.equal((error as Error).name, "AbortError");
    }
    onQuery = undefined;
    assert.deepEqual(rows(), synced);
    assert.isTrue(await hasConversationRestorePoint(key));
    for (const column of [
      "conversation_instance_id",
      "profile_signature",
      "conversation_id",
    ]) {
      const point = db
        .prepare(
          `SELECT ${column} FROM llm_for_zotero_conversation_restore_points WHERE conversation_key=?`,
        )
        .get(key)!;
      db.prepare(
        `UPDATE llm_for_zotero_conversation_restore_points SET ${column}='wrong' WHERE conversation_key=?`,
      ).run(key);
      assert.isFalse(await hasConversationRestorePoint(key));
      try {
        await restoreConversationMessages(key, options());
        assert.fail("expected identity rejection");
      } catch (error) {
        assert.include(String(error), "scope no longer matches");
      }
      assert.deepEqual(rows(), synced);
      db.prepare(
        `UPDATE llm_for_zotero_conversation_restore_points SET ${column}=? WHERE conversation_key=?`,
      ).run(point[column] as string, key);
    }
  });

  it("clears recovery data with explicit Clear and conversation deletion", async function () {
    await appendMessage(key, {
      role: "user",
      text: "Original local",
      timestamp: 100,
    });
    await replaceConversationMessages(key, remote, options());
    await clearConversation(key);
    assert.isFalse(await hasConversationRestorePoint(key));
    await replaceConversationMessages(key, remote, options());
    await deletePaperConversation(key);
    assert.equal(
      db
        .prepare(
          "SELECT count(*) n FROM llm_for_zotero_conversation_restore_points",
        )
        .get()!.n,
      0,
    );
    assert.equal(
      db
        .prepare(
          "SELECT count(*) n FROM llm_for_zotero_conversation_restore_refs",
        )
        .get()!.n,
      0,
    );
  });

  it("keeps an empty original snapshot recoverable and reports missing recovery without mutation", async function () {
    try {
      await restoreConversationMessages(key, options());
      assert.fail("expected missing snapshot");
    } catch (error) {
      assert.include(String(error), "No saved local history");
    }
    await replaceConversationMessages(key, remote, options());
    assert.isEmpty(await restoreConversationMessages(key, options()));
    assert.isEmpty(rows());
  });
  it("advances the single restore point for local edits made after a sync", async function () {
    await replaceConversationMessages(key, remote, options());
    await appendMessage(key, {
      role: "user",
      text: "Added locally after sync",
      timestamp: 1700000000100,
    });
    const local = rows();
    await replaceConversationMessages(key, remote, options());
    await replaceConversationMessages(key, [], options());
    await restoreConversationMessages(key, options());
    assert.deepEqual(rows(), local);
    assert.equal(
      db
        .prepare(
          "SELECT count(*) n FROM llm_for_zotero_conversation_restore_points",
        )
        .get()!.n,
      0,
    );
  });
  it("refreshes recovered panel messages only after commit and keeps the unsent draft/context", async function () {
    await appendMessage(key, {
      role: "user",
      text: "Original local",
      timestamp: 100,
    });
    await replacePanel();
    draftInputCache.set(key, "Keep recovery draft");
    const contexts = [{ itemId: 7, title: "Draft context" }];
    selectedPaperContextCache.set(key, contexts);
    const before = chatHistory.get(key);
    const restorePanel = (isCurrent = () => true) =>
      restoreCurrentPaperChat({
        body,
        item: portal,
        conversationKey: key,
        expectedGeneration: getConversationWriteGeneration(key),
        isCurrent,
      });
    await restorePanel(() => false);
    assert.strictEqual(chatHistory.get(key), before);
    failCommit = true;
    try {
      await restorePanel();
      assert.fail("expected commit failure");
    } catch (error) {
      assert.include(String(error), "forced persistence failure");
    }
    assert.strictEqual(chatHistory.get(key), before);
    failCommit = false;
    await restorePanel();
    assert.deepEqual(
      chatHistory.get(key)?.map((message) => message.text),
      ["Original local"],
    );
    assert.equal(draftInputCache.get(key), "Keep recovery draft");
    assert.strictEqual(selectedPaperContextCache.get(key), contexts);
  });

  it("removes the restore point inside identity-bound deletion and rolls it back on failure", async function () {
    await replaceConversationMessages(key, remote, options());
    failCommit = true;
    try {
      await deleteUpstreamConversationLocalRows(key, "paper");
      assert.fail("expected commit failure");
    } catch (error) {
      assert.include(String(error), "forced persistence failure");
    }
    assert.isTrue(await hasConversationRestorePoint(key));
    failCommit = false;
    await deleteUpstreamConversationLocalRows(key, "paper");
    assert.isFalse(await hasConversationRestorePoint(key));
    assert.isEmpty(rows());
  });
});
