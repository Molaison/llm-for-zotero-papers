import type { ActionExecutionContext } from "../../src/agent/actions";
import { autoTagAction } from "../../src/agent/actions/autoTag";
import {
  initAgentChangeJournal,
  listJournalActions,
  type JournalActionWithSteps,
} from "../../src/agent/store/changeJournal";
import { createBuiltInToolRegistry } from "../../src/agent/tools";
import { createUndoLastActionTool } from "../../src/agent/tools/write/undoLastAction";
import type { AgentToolContext } from "../../src/agent/types";
import { ChangeJournalTestDb } from "./changeJournalTestDb";

/**
 * A batch action driven end to end through the production tool registry, a
 * durable journal, and an in-memory tag store standing in for Zotero.
 *
 * The seam is the gateway: it owns every item's tags, so what the forward
 * write and the undo do is observable as plain tag lists.
 */

const CONVERSATION_KEY = 5_150;

export type BatchTagGateway = {
  tagsOf(itemId: number): string[];
  conversationKey: number;
  zoteroGateway: Record<string, unknown>;
};

function createTagGateway(itemIds: number[]): BatchTagGateway {
  const tags = new Map<number, string[]>(itemIds.map((id) => [id, []]));
  const target = (itemId: number) => ({
    itemId,
    itemType: "journalArticle",
    title: `Batch Paper ${itemId}`,
    firstCreator: "Alice Example",
    year: "2024",
    attachments: [],
    tags: [...(tags.get(itemId) || [])],
    collectionIds: [],
  });
  const item = (itemId: number) =>
    tags.has(itemId)
      ? {
          id: itemId,
          libraryID: 1,
          key: `ITEM${itemId}`,
          itemType: "journalArticle",
          isRegularItem: () => true,
          isNote: () => false,
          isAttachment: () => false,
          isAnnotation: () => false,
          deleted: false,
          getField: (field: string) =>
            field === "title" ? `Batch Paper ${itemId}` : "",
          getTags: () => (tags.get(itemId) || []).map((tag) => ({ tag })),
          getCollections: () => [],
        }
      : null;
  const zoteroGateway: Record<string, unknown> = {
    getItem: item,
    getBibliographicItemTargetsByItemIds: (ids: number[]) =>
      ids.filter((id) => tags.has(id)).map(target),
    getPaperTargetsByItemIds: (ids: number[]) =>
      ids.filter((id) => tags.has(id)).map(target),
    getEditableArticleMetadata: () => ({
      fields: { abstractNote: "An abstract about memory consolidation." },
      creators: [],
    }),
    listLibraryTagNames: async () => [],
    applyTagAssignments: async (params: {
      assignments: Array<{ itemId: number; tags: string[] }>;
    }) => {
      const items = params.assignments.map((assignment) => {
        const current = tags.get(assignment.itemId) || [];
        const addedTags = assignment.tags.filter(
          (tag) => !current.includes(tag),
        );
        tags.set(assignment.itemId, [...current, ...addedTags]);
        return {
          itemId: assignment.itemId,
          status: addedTags.length ? "updated" : "skipped",
          addedTags,
          skippedTags: assignment.tags.filter((tag) => current.includes(tag)),
        };
      });
      const updatedCount = items.filter(
        (row) => row.status === "updated",
      ).length;
      return {
        updatedCount,
        skippedCount: items.length - updatedCount,
        items,
      };
    },
    removeTagsFromItem: async (params: { itemId: number; tags: string[] }) => {
      const current = tags.get(params.itemId) || [];
      const removed = current.filter((tag) => params.tags.includes(tag));
      tags.set(
        params.itemId,
        current.filter((tag) => !params.tags.includes(tag)),
      );
      return { removed };
    },
    setItemTags: async (params: {
      assignments: Array<{ itemId: number; tags: string[] }>;
    }) => {
      const items = params.assignments.map((assignment) => {
        const previousTags = tags.get(assignment.itemId) || [];
        tags.set(assignment.itemId, [...assignment.tags]);
        return {
          itemId: assignment.itemId,
          status: "updated",
          previousTags,
          tags: [...assignment.tags],
        };
      });
      return { updatedCount: items.length, skippedCount: 0, items };
    },
  };
  return {
    tagsOf: (itemId) => [...(tags.get(itemId) || [])],
    conversationKey: CONVERSATION_KEY,
    zoteroGateway,
  };
}

let installedDb: ChangeJournalTestDb | null = null;

/** Installs a fresh durable journal behind a minimal Zotero global. */
export async function installBatchJournal(): Promise<() => void> {
  const originalZotero = globalThis.Zotero;
  installedDb = new ChangeJournalTestDb();
  globalThis.Zotero = {
    DB: installedDb,
    Prefs: { get: () => "auto" },
    Items: { get: () => null },
    debug: () => undefined,
  } as never;
  await initAgentChangeJournal();
  return () => {
    globalThis.Zotero = originalZotero;
    installedDb = null;
  };
}

/**
 * Runs the auto-tag batch action over `items` papers through the built-in
 * registry and returns the one journal action it wrote.
 *
 * `legacyJournalToolName` rewrites that action's stored tool name, the way a
 * journal written by an older build (before batch actions called facades)
 * sits in a user's database.
 */
export async function runAutoTagFixture(options: {
  items: number;
  legacyJournalToolName?: string;
}): Promise<{ journal: JournalActionWithSteps; gateway: BatchTagGateway }> {
  if (!installedDb) {
    throw new Error("Call installBatchJournal() before runAutoTagFixture()");
  }
  const itemIds = Array.from(
    { length: options.items },
    (_, index) => index + 1,
  );
  const gateway = createTagGateway(itemIds);
  const registry = createBuiltInToolRegistry({
    zoteroGateway: gateway.zoteroGateway as never,
    pdfService: {} as never,
    pdfPageService: {} as never,
    retrievalService: {} as never,
  });
  const ctx: ActionExecutionContext = {
    registry,
    zoteroGateway: gateway.zoteroGateway as never,
    libraryID: 1,
    conversationKey: gateway.conversationKey,
    confirmationMode: "native_ui",
    onProgress: () => undefined,
    requestConfirmation: async () => ({ approved: true }),
  };
  const result = await autoTagAction.execute({ itemIds }, ctx);
  if (!result.ok) {
    throw new Error(`auto_tag failed: ${JSON.stringify(result)}`);
  }
  const actions = await listJournalActions({
    conversationKey: gateway.conversationKey,
  });
  if (actions.length !== 1) {
    throw new Error(`Expected one journal action, found ${actions.length}`);
  }
  let journal = actions[0];
  if (options.legacyJournalToolName) {
    const row = installedDb.actions.get(journal.actionId);
    if (!row) throw new Error("journal action row missing");
    row.tool_name = options.legacyJournalToolName;
    journal = (
      await listJournalActions({ conversationKey: gateway.conversationKey })
    )[0];
  }
  return { journal, gateway };
}

/** Undoes the newest reversible action in the fixture's conversation. */
export async function undoLastActionFixture(
  gateway: BatchTagGateway,
): Promise<Record<string, unknown>> {
  const tool = createUndoLastActionTool(gateway.zoteroGateway as never);
  const input = tool.validate({});
  if (!input.ok) throw new Error(input.error);
  const context = {
    request: { conversationKey: gateway.conversationKey, libraryID: 1 },
    item: null,
    currentAnswerText: "",
    modelName: "test-model",
  } as AgentToolContext;
  const result = await tool.execute(input.value, context);
  return result.content as Record<string, unknown>;
}
