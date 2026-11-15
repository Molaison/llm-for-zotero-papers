import { assert } from "chai";
import { createBuiltInToolRegistry } from "../src/agent/tools";
import { initAgentChangeJournal } from "../src/agent/store/changeJournal";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import type { AgentActionReceipt, AgentToolContext } from "../src/agent/types";
import { ChangeJournalTestDb } from "./helpers/changeJournalTestDb";

/**
 * An item that cannot be filed into a collection, sent in a filing batch.
 *
 * The live run filed 253 papers and then sent an annotation it had found with
 * its own script. Zotero holds only top-level items in collections, and the
 * gateway refuses such an item before writing anything; the receipt used to
 * judge the batch as a whole, so the one refusal made every target
 * "unverified" and blocked the part. These calls run the real library_update,
 * gateway, mutation coordinator and action contract over an in-memory library.
 */

type FakeItem = {
  id: number;
  libraryID: number;
  parentID: number | false;
  collections: number[];
  title: string;
  kind: "regular" | "annotation" | "note" | "attachment";
  saveError?: string;
};

const PAPER = 1;
const SECOND_PAPER = 2;
const PDF = 7;
const ANNOTATION = 8;
const CHILD_NOTE = 13;
const SOURCE = 4;
const TOPIC = 5;

const ANNOTATION_REASON =
  "Item 8 is an annotation inside an attachment; only top-level items can be filed into collections.";

/**
 * A Zotero item as the filing path sees it. Membership changes stay in memory
 * until `saveTx` persists them, and a failed save keeps them only until
 * `reload`, which is how Zotero behaves and what the post-state capture
 * relies on. `FakeItem.collections` is the persisted membership.
 */
function nativeItem(item: FakeItem) {
  let pending = [...item.collections];
  return {
    id: item.id,
    key: `KEY${item.id}`,
    libraryID: item.libraryID,
    parentID: item.parentID,
    deleted: false,
    isRegularItem: () => item.kind === "regular",
    isAnnotation: () => item.kind === "annotation",
    isNote: () => item.kind === "note",
    isAttachment: () => item.kind === "attachment",
    ...(item.kind === "annotation"
      ? {
          annotationType: "highlight",
          annotationText: "the authors claim that representations drift",
          annotationComment: "",
          annotationColor: "#ffd400",
          annotationPageLabel: "3",
          annotationSortIndex: "00002|000120|00300",
          annotationPosition: '{"pageIndex":2,"rects":[[1,2,3,4]]}',
        }
      : {}),
    getDisplayTitle: () => item.title,
    getField: (field: string) => (field === "title" ? item.title : ""),
    getCreators: () => [],
    getTags: () => [],
    getAttachments: () => [],
    getNotes: () => [],
    getCollections: () => [...pending],
    inCollection: (collectionId: number) => pending.includes(collectionId),
    addToCollection: (collectionId: number) => {
      if (!pending.includes(collectionId)) pending.push(collectionId);
    },
    removeFromCollection: (collectionId: number) => {
      pending = pending.filter((id) => id !== collectionId);
    },
    saveTx: async () => {
      if (item.saveError) throw new Error(item.saveError);
      item.collections = [...pending];
      return true;
    },
    reload: async () => {
      pending = [...item.collections];
    },
  };
}

function libraryWith(items: FakeItem[]) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const native = new Map(items.map((item) => [item.id, nativeItem(item)]));
  const folders = new Map([
    [SOURCE, "Inbox"],
    [TOPIC, "Drift"],
  ]);
  const summary = (collectionId: number | undefined) => {
    const name = collectionId ? folders.get(collectionId) : undefined;
    return name && collectionId
      ? { collectionId, libraryID: 1, name, path: name }
      : null;
  };
  const gateway = new ZoteroGateway();
  const overrides = gateway as unknown as Record<string, unknown>;
  overrides.getItem = (itemId: number) => native.get(Number(itemId)) || null;
  overrides.getCollectionSummary = summary;
  overrides.getCollection = (collectionId: number) =>
    summary(collectionId)
      ? {
          id: collectionId,
          name: folders.get(collectionId),
          libraryID: 1,
          parentID: false,
          deleted: false,
          getChildItems: () =>
            items
              .filter((item) => item.collections.includes(collectionId))
              .map((item) => item.id),
          getChildCollections: () => [],
        }
      : null;
  overrides.resolveLibraryID = () => 1;
  overrides.listCollectionSummaries = () =>
    [...folders.keys()].map((collectionId) => summary(collectionId)!);
  return { gateway, byId };
}

function libraryChatContext(): AgentToolContext {
  return {
    request: {
      conversationKey: 1,
      mode: "agent",
      userText: "Sort my unfiled papers into topic folders",
      libraryID: 1,
      executionContext: {
        version: 1,
        executionId: "filing-refusal",
        conversationKey: 1,
        conversationGeneration: 0,
        chatLibraryID: 1,
        permissionOwner: "original_agent",
        workspaceSnapshot: { selectedPapers: [], selectedCollections: [] },
        configuredAccess: { libraryIDs: [1], outputDirectories: [] },
      },
    },
    item: null,
    currentAnswerText: "",
    modelName: "test-model",
    runId: "filing-refusal-run",
  } as never;
}

async function fileItems(
  gateway: ZoteroGateway,
  args: Record<string, unknown>,
): Promise<{ receipts: AgentActionReceipt[]; content: unknown }> {
  const registry = createBuiltInToolRegistry({
    zoteroGateway: gateway,
    pdfService: {} as never,
    pdfPageService: {} as never,
    retrievalService: {} as never,
  });
  let prepared = await registry.prepareExecution(
    {
      id: "call-file",
      name: "library_update",
      arguments: { kind: "collections", action: "add", ...args },
    },
    libraryChatContext(),
  );
  if (prepared.kind === "confirmation")
    prepared = await prepared.execute({ approved: true });
  assert.equal(prepared.kind, "result", "the filing never reached execution");
  if (prepared.kind !== "result") throw new Error("unreachable");
  assert.isTrue(
    prepared.execution.result.ok,
    JSON.stringify(prepared.execution.result.content),
  );
  return {
    receipts: prepared.execution.result.actionReceipts || [],
    content: prepared.execution.result.content,
  };
}

function paper(id: number, collections: number[] = []): FakeItem {
  return {
    id,
    libraryID: 1,
    parentID: false,
    collections,
    title: `Paper ${id}`,
    kind: "regular",
  };
}

const annotation: () => FakeItem = () => ({
  id: ANNOTATION,
  libraryID: 1,
  parentID: PDF,
  collections: [],
  title: "",
  kind: "annotation",
});

describe("filing an item that cannot belong to a collection", function () {
  const originalZotero = globalThis.Zotero;
  beforeEach(async function () {
    globalThis.Zotero = {
      DB: new ChangeJournalTestDb(),
      Prefs: { get: () => "auto" },
      Items: { get: () => null },
      debug: () => undefined,
    } as never;
    await initAgentChangeJournal();
  });
  afterEach(function () {
    globalThis.Zotero = originalZotero;
  });

  it("files the paper and rejects the annotation beside it, with the reason", async function () {
    const { gateway, byId } = libraryWith([paper(PAPER), annotation()]);
    const { receipts } = await fileItems(gateway, {
      assignments: [
        { itemId: PAPER, targetCollectionId: TOPIC },
        { itemId: ANNOTATION, targetCollectionId: TOPIC },
      ],
    });

    assert.deepEqual(byId.get(PAPER)!.collections, [TOPIC]);
    assert.deepEqual(byId.get(ANNOTATION)!.collections, [], "never written");
    assert.lengthOf(receipts, 1);
    const [receipt] = receipts;
    assert.equal(receipt.status, "partial");
    assert.equal(receipt.verification, "verified");
    assert.deepEqual(receipt.requestedTargets, ["item:1", "item:8"]);
    assert.deepEqual(receipt.appliedTargets, ["item:1"]);
    assert.deepEqual(receipt.alreadySatisfiedTargets, []);
    assert.deepEqual(receipt.rejectedTargets, ["item:8"]);
    assert.equal(receipt.reasons[0], ANNOTATION_REASON);
    assert.notInclude(
      receipt.reasons.join(" "),
      "rejected the captured native post-state",
    );
  });

  it("refuses a call that names only the annotation, without calling it unverified", async function () {
    const { gateway, byId } = libraryWith([paper(PAPER), annotation()]);
    const { receipts } = await fileItems(gateway, {
      assignments: [{ itemId: ANNOTATION, targetCollectionId: TOPIC }],
    });

    assert.deepEqual(byId.get(ANNOTATION)!.collections, []);
    assert.lengthOf(receipts, 1);
    const [receipt] = receipts;
    assert.equal(receipt.status, "failed");
    assert.equal(
      receipt.verification,
      "not_applicable",
      "nothing was attempted, so there is nothing to verify",
    );
    assert.deepEqual(receipt.appliedTargets, []);
    assert.deepEqual(receipt.rejectedTargets, ["item:8"]);
    assert.deepEqual(receipt.reasons, [ANNOTATION_REASON]);
  });

  it("refuses child notes and attachments too, naming the item they belong to", async function () {
    const childAttachment: FakeItem = {
      id: PDF,
      libraryID: 1,
      parentID: PAPER,
      collections: [],
      title: "Full Text PDF",
      kind: "attachment",
    };
    const childNote: FakeItem = {
      id: CHILD_NOTE,
      libraryID: 1,
      parentID: PAPER,
      collections: [],
      title: "Reading notes",
      kind: "note",
    };
    const { gateway, byId } = libraryWith([
      paper(PAPER),
      childAttachment,
      childNote,
    ]);
    const { receipts } = await fileItems(gateway, {
      itemIds: [PAPER, PDF, CHILD_NOTE],
      targetCollectionId: TOPIC,
    });

    assert.deepEqual(byId.get(PAPER)!.collections, [TOPIC]);
    assert.deepEqual(byId.get(PDF)!.collections, []);
    assert.deepEqual(byId.get(CHILD_NOTE)!.collections, []);
    const [receipt] = receipts;
    assert.equal(receipt.status, "partial");
    assert.equal(receipt.verification, "verified");
    assert.deepEqual(receipt.appliedTargets, ["item:1"]);
    assert.deepEqual(receipt.rejectedTargets, ["item:7", "item:13"]);
    assert.equal(
      receipt.reasons[0],
      "Items 7 and 13 are child items of item 1; only top-level items can be filed into collections.",
    );
  });

  it("moves the paper out of its folder and leaves the annotation, refused", async function () {
    const { gateway, byId } = libraryWith([
      paper(PAPER, [SOURCE]),
      annotation(),
    ]);
    const { receipts } = await fileItems(gateway, {
      mode: "move",
      from: SOURCE,
      assignments: [
        { itemId: PAPER, targetCollectionId: TOPIC },
        { itemId: ANNOTATION, targetCollectionId: TOPIC },
      ],
    });

    assert.deepEqual(byId.get(PAPER)!.collections, [TOPIC]);
    const [receipt] = receipts;
    assert.equal(receipt.status, "partial");
    assert.equal(receipt.verification, "verified");
    assert.deepEqual(receipt.appliedTargets, ["item:1"]);
    assert.deepEqual(receipt.rejectedTargets, ["item:8"]);
    assert.equal(receipt.reasons[0], ANNOTATION_REASON);
  });

  it("names a paper Zotero did not save as rejected, and keeps the papers it did", async function () {
    const failing = {
      ...paper(SECOND_PAPER, [SOURCE]),
      saveError: "database is locked",
    };
    const { gateway, byId } = libraryWith([paper(PAPER, [SOURCE]), failing]);
    const { receipts } = await fileItems(gateway, {
      mode: "move",
      from: SOURCE,
      itemIds: [PAPER, SECOND_PAPER],
      targetCollectionId: TOPIC,
    });

    assert.deepEqual(byId.get(PAPER)!.collections, [TOPIC]);
    const [receipt] = receipts;
    assert.equal(receipt.status, "partial");
    assert.equal(receipt.verification, "verified");
    assert.deepEqual(receipt.appliedTargets, ["item:1"]);
    assert.deepEqual(receipt.rejectedTargets, ["item:2"]);
    assert.equal(
      receipt.reasons[0],
      "The captured native post-state does not show move_to_collection for item 2.",
    );
  });

  it("keeps a batch none of whose papers changed unverified, since nothing says why", async function () {
    const { gateway } = libraryWith([
      { ...paper(PAPER, [SOURCE]), saveError: "database is locked" },
      { ...paper(SECOND_PAPER, [SOURCE]), saveError: "database is locked" },
    ]);
    const { receipts } = await fileItems(gateway, {
      mode: "move",
      from: SOURCE,
      itemIds: [PAPER, SECOND_PAPER],
      targetCollectionId: TOPIC,
    });

    const [receipt] = receipts;
    assert.equal(receipt.status, "unverified");
    assert.equal(receipt.verification, "unverified");
    assert.deepEqual(receipt.rejectedTargets, ["item:1", "item:2"]);
    assert.equal(
      receipt.reasons[0],
      "The mutation handler rejected the captured native post-state for move_to_collection.",
    );
  });

  it("still verifies a batch that filed every paper", async function () {
    const { gateway } = libraryWith([paper(PAPER), paper(SECOND_PAPER)]);
    const { receipts } = await fileItems(gateway, {
      itemIds: [PAPER, SECOND_PAPER],
      targetCollectionId: TOPIC,
    });

    const [receipt] = receipts;
    assert.equal(receipt.status, "applied");
    assert.equal(receipt.verification, "verified");
    assert.deepEqual(receipt.appliedTargets, ["item:1", "item:2"]);
    assert.deepEqual(receipt.rejectedTargets, []);
    assert.deepEqual(receipt.reasons, []);
  });
});
