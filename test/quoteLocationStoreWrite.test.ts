import { assert } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import * as upstream from "../src/utils/chatStore";
import * as claude from "../src/claudeCode/store";
import * as codex from "../src/codexAppServer/store";
import type { StoredChatMessage } from "../src/utils/chatStore";
import { updateStoredAssistantQuoteLocations } from "../src/modules/contextPanel/chat";
import {
  bumpConversationWriteGeneration,
  freezeConversationWrites,
  getConversationWriteGeneration,
} from "../src/shared/conversationWriteFence";
import { buildQuoteCitation } from "../src/services/quotes/quoteCitations";
import type {
  QuoteCitationWithFileState,
  QuoteLocationWrite,
} from "../src/services/quotes/quoteLocationPersistence";
import type { QuoteCitation } from "../src/shared/types";
import {
  FIXED_STORE_CLOCK_MS,
  installFixedClock,
  installSqliteZotero,
  resetConversationStoreProcessStateForTests,
  type SqliteHarness,
} from "./helpers/conversationStoreDb";

/**
 * The quote-location write-back changes one column of one assistant row:
 * `quote_citations_json`. Every other column, every other row, and the
 * conversation catalog stay exactly as they were.
 */

const LIBRARY_ID = 1;
const QUOTE =
  "Noise correlation changed more favorably for neuron pairs with high signal correlation.";
const OTHER =
  "Place cells in CA1 remapped across days when the animals explored a novel environment.";
const FILE = { size: 1234, mtime: 1_700_000_000_000 };

function at(offsetSeconds: number): number {
  return FIXED_STORE_CLOCK_MS + offsetSeconds * 1000;
}

function record(quoteText: string): QuoteCitation {
  return buildQuoteCitation({
    quoteText,
    citationLabel: "(Eppler et al., 2026)",
    sourceMatchKind: "exact",
    sourceMatchSource: "context-text",
    contextItemId: 5001,
    itemId: 55001,
    sourceFingerprint: "fnv1a32-deadbeef",
  })!;
}

function locationWrite(citation: QuoteCitation): QuoteLocationWrite {
  return {
    id: citation.id,
    contextItemId: 5001,
    location: {
      sourceMatchSource: "pdf-page-text",
      sourceMatchText: citation.quoteText,
      sourceMatchKind: "exact",
      sourceFingerprint: "page-text:5akwys",
      pageHintIndex: 3,
      pageHintLabel: "4",
      sourceMatchPageOccurrence: 0,
    },
    sourceFileState: FILE,
  };
}

type StoreCase = {
  name: string;
  messagesTable: string;
  catalogTables: string[];
  create(): Promise<number>;
  append(key: number, message: StoredChatMessage): Promise<void>;
  load(key: number): Promise<StoredChatMessage[]>;
  update(
    key: number,
    target: { timestamp: number; messageId?: number },
    writes: QuoteLocationWrite[],
  ): Promise<boolean>;
};

const STORES: StoreCase[] = [
  {
    name: "upstream",
    messagesTable: "llm_for_zotero_chat_messages",
    catalogTables: [
      "llm_for_zotero_global_conversations",
      "llm_for_zotero_paper_conversations",
    ],
    create: async () => {
      await upstream.initChatStore();
      return upstream.createGlobalConversation(LIBRARY_ID);
    },
    append: (key, message) => upstream.appendMessage(key, message),
    load: (key) => upstream.loadConversation(key, 50),
    update: (key, target, writes) =>
      upstream.updateAssistantMessageQuoteLocations(key, target, writes),
  },
  {
    name: "claude_code",
    messagesTable: "llm_for_zotero_claude_messages",
    catalogTables: ["llm_for_zotero_claude_conversations"],
    create: async () => {
      await claude.initClaudeCodeStore();
      return (await claude.createClaudeGlobalConversation(LIBRARY_ID))!
        .conversationKey;
    },
    append: (key, message) => claude.appendClaudeMessage(key, message),
    load: (key) => claude.loadClaudeConversation(key, 50),
    update: (key, target, writes) =>
      claude.updateClaudeAssistantMessageQuoteLocations(key, target, writes),
  },
  {
    name: "codex",
    messagesTable: "llm_for_zotero_codex_messages",
    catalogTables: ["llm_for_zotero_codex_conversations"],
    create: async () => {
      await codex.initCodexAppServerStore();
      return (await codex.createCodexGlobalConversation(LIBRARY_ID))!
        .conversationKey;
    },
    append: (key, message) => codex.appendCodexMessage(key, message),
    load: (key) => codex.loadCodexConversation(key, 50),
    update: (key, target, writes) =>
      codex.updateCodexAssistantMessageQuoteLocations(key, target, writes),
  },
];

describe("quote location write-back to stored assistant rows", function () {
  const globalScope = globalThis as typeof globalThis & {
    Zotero?: Record<string, unknown>;
  };
  const originalZotero = globalScope.Zotero;
  let harness: SqliteHarness;
  let restoreClock: () => void;

  beforeEach(function () {
    resetConversationStoreProcessStateForTests();
    harness = installSqliteZotero({
      baseZotero: originalZotero,
      realTransactions: true,
    });
    restoreClock = installFixedClock();
  });

  afterEach(function () {
    restoreClock();
    harness.db.close();
    globalScope.Zotero = originalZotero;
    resetConversationStoreProcessStateForTests();
  });

  async function seed(store: StoreCase): Promise<{
    key: number;
    first: QuoteCitation;
    second: QuoteCitation;
  }> {
    const key = await store.create();
    const first = record(QUOTE);
    const second = record(OTHER);
    await store.append(key, {
      role: "user",
      text: "u1",
      timestamp: at(1),
    } as StoredChatMessage);
    await store.append(key, {
      role: "assistant",
      text: `Claim.\n\n[[quote:${first.id}]]\n\n[[quote:${second.id}]]`,
      timestamp: at(2),
      quoteCitations: [first, second],
      modelName: "model-a",
      reasoningSummary: "thought",
      contextTokens: 1200,
      contextWindow: 200000,
    } as StoredChatMessage);
    await store.append(key, {
      role: "user",
      text: "u2",
      timestamp: at(3),
    } as StoredChatMessage);
    await store.append(key, {
      role: "assistant",
      text: `Later. [[quote:${first.id}]]`,
      timestamp: at(4),
      quoteCitations: [first],
    } as StoredChatMessage);
    return { key, first, second };
  }

  function rows(table: string): Array<Record<string, unknown>> {
    return harness.all(`SELECT * FROM ${table} ORDER BY rowid`);
  }

  for (const store of STORES) {
    describe(store.name, function () {
      it("rewrites only quote_citations_json of the one target row, in a transaction", async function () {
        const { key, first, second } = await seed(store);
        const before = rows(store.messagesTable);
        const catalogsBefore = store.catalogTables.map(rows);
        const from = harness.statements.length;

        const written = await store.update(key, { timestamp: at(2) }, [
          locationWrite(first),
        ]);

        assert.isTrue(written);
        const after = rows(store.messagesTable);
        assert.lengthOf(after, before.length);
        for (let index = 0; index < before.length; index += 1) {
          const { quote_citations_json: beforeJson, ...beforeRest } =
            before[index];
          const { quote_citations_json: afterJson, ...afterRest } =
            after[index];
          assert.deepEqual(afterRest, beforeRest, `row ${index} columns`);
          if (before[index].timestamp !== at(2)) {
            assert.equal(afterJson, beforeJson, `row ${index} citations`);
            continue;
          }
          const parsed = JSON.parse(String(afterJson));
          assert.deepEqual(
            parsed[1],
            JSON.parse(String(beforeJson))[1],
            "the other record is unchanged",
          );
          assert.equal(parsed[0].id, first.id);
          assert.equal(parsed[0].sourceMatchPageOccurrence, 0);
          assert.equal(parsed[0].pageHintIndex, 3);
          assert.equal(parsed[0].sourceFingerprint, "page-text:5akwys");
          assert.deepEqual(parsed[0].sourceFileState, FILE);
          assert.equal(parsed[0].quoteText, first.quoteText);
          assert.equal(parsed[1].id, second.id);
        }
        assert.deepEqual(
          store.catalogTables.map(rows),
          catalogsBefore,
          "the catalog is not touched",
        );
        const writes = harness.statements
          .slice(from)
          .filter((statement) => /^\s*UPDATE\b/i.test(statement.sql));
        assert.lengthOf(writes, 1, "one UPDATE statement");
        assert.match(
          writes[0].sql.replace(/\s+/g, " "),
          new RegExp(
            `^ ?UPDATE ${store.messagesTable} SET quote_citations_json = \\? WHERE id = \\?`,
          ),
        );
        assert.isTrue(writes[0].inTransaction);
      });

      it("loads the saved location with its file state", async function () {
        const { key, first } = await seed(store);
        await store.update(key, { timestamp: at(2) }, [locationWrite(first)]);

        const loaded = await store.load(key);
        const assistant = loaded.find((message) => message.timestamp === at(2));
        const citation = assistant?.quoteCitations?.find(
          (entry) => entry.id === first.id,
        ) as QuoteCitationWithFileState | undefined;
        assert.equal(citation?.sourceMatchPageOccurrence, 0);
        assert.deepEqual(citation?.sourceFileState, FILE);
        const later = loaded.find((message) => message.timestamp === at(4));
        assert.isUndefined(
          (later?.quoteCitations?.[0] as QuoteCitationWithFileState)
            .sourceFileState,
          "the other row keeps its record as stored",
        );
      });

      it("writes nothing when no row, or no record, matches", async function () {
        const { key, first } = await seed(store);
        const before = rows(store.messagesTable);

        assert.isFalse(
          await store.update(key, { timestamp: at(9) }, [locationWrite(first)]),
          "no row at that timestamp",
        );
        assert.isFalse(
          await store.update(key, { timestamp: at(2), messageId: 999_999 }, [
            locationWrite(first),
          ]),
          "the row id does not match",
        );
        assert.isFalse(
          await store.update(key, { timestamp: at(2) }, [
            { ...locationWrite(first), id: "Q_unknown" },
          ]),
          "no record has the id",
        );
        assert.isFalse(
          await store.update(key, { timestamp: at(1) }, [locationWrite(first)]),
          "a user row is never written",
        );
        assert.deepEqual(rows(store.messagesTable), before);
      });

      it("writes nothing the second time the same location arrives", async function () {
        const { key, first } = await seed(store);
        assert.isTrue(
          await store.update(key, { timestamp: at(2) }, [locationWrite(first)]),
        );
        const from = harness.statements.length;
        assert.isFalse(
          await store.update(key, { timestamp: at(2) }, [locationWrite(first)]),
        );
        assert.deepEqual(
          harness.statements
            .slice(from)
            .filter((statement) => /^\s*UPDATE\b/i.test(statement.sql)),
          [],
        );
      });
    });
  }

  describe("routing from the panel", function () {
    it("writes through the conversation's own store", async function () {
      for (const store of STORES) {
        const { key, first } = await seed(store);
        const written = await updateStoredAssistantQuoteLocations({
          conversationKey: key,
          expectedGeneration: getConversationWriteGeneration(key),
          timestamp: at(2),
          writes: [locationWrite(first)],
        });
        assert.isTrue(written, store.name);
        const loaded = await store.load(key);
        assert.equal(
          loaded.find((message) => message.timestamp === at(2))
            ?.quoteCitations?.[0].sourceMatchPageOccurrence,
          0,
          store.name,
        );
      }
    });

    it("never writes to a frozen conversation", async function () {
      const store = STORES[0];
      const { key, first } = await seed(store);
      const before = rows(store.messagesTable);
      freezeConversationWrites(key);
      assert.isFalse(
        await updateStoredAssistantQuoteLocations({
          conversationKey: key,
          expectedGeneration: getConversationWriteGeneration(key),
          timestamp: at(2),
          writes: [locationWrite(first)],
        }),
      );
      assert.deepEqual(rows(store.messagesTable), before);
    });

    it("never writes after the conversation's write generation moved", async function () {
      const store = STORES[1];
      const { key, first } = await seed(store);
      const before = rows(store.messagesTable);
      const generation = getConversationWriteGeneration(key);
      bumpConversationWriteGeneration(key);
      assert.isFalse(
        await updateStoredAssistantQuoteLocations({
          conversationKey: key,
          expectedGeneration: generation,
          timestamp: at(2),
          writes: [locationWrite(first)],
        }),
      );
      assert.deepEqual(rows(store.messagesTable), before);
    });

    it("never writes a row that was deleted", async function () {
      const store = STORES[2];
      const { key, first } = await seed(store);
      await codex.deleteCodexTurnMessages(key, at(1), at(2));
      const before = rows(store.messagesTable);
      assert.isFalse(
        await updateStoredAssistantQuoteLocations({
          conversationKey: key,
          expectedGeneration: getConversationWriteGeneration(key),
          timestamp: at(2),
          writes: [locationWrite(first)],
        }),
      );
      assert.deepEqual(rows(store.messagesTable), before);
    });
  });
});
