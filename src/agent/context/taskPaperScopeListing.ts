/**
 * The papers a task's scope covers, as the Task progress view lists them.
 *
 * Computed from the turn's attached papers, folders and tags plus the library
 * index snapshot, with the same union `ZoteroGateway.resolveLibraryScopeItemIds`
 * gives retrieval: explicit papers first, then each collection's direct items
 * (subcollections are not expanded, exactly as retrieval does not), then each
 * tag's items; only live regular items; each paper once, in first-seen order.
 * With nothing attached the whole library is listed, capped.
 *
 * Pure: reads only the snapshot object it is given.
 */
import type {
  LibraryIndexItem,
  LibraryIndexSnapshot,
} from "../../services/libraryIndex/contracts";
import { normalizeLibraryIndexTagIdentity } from "../../services/libraryIndex/projection";
import { taskPaperKey } from "./taskPaperLedger";

/** The snapshot fields scope listing reads. */
export type TaskPaperScopeSnapshot = Pick<
  LibraryIndexSnapshot,
  | "libraryID"
  | "itemById"
  | "topLevelItemOrder"
  | "collectionById"
  | "directItemIdsByCollectionId"
  | "collectionPathById"
  | "tagByNormalizedName"
  | "childAttachmentIdsByItemId"
  | "attachmentById"
  | "pdfCapableItemIds"
>;

export type TaskPaperScopeContexts = {
  /** Papers the user removed from the task: left out of the listing. */
  excludedItemIds?: readonly number[];
  papers?: ReadonlyArray<{ itemId: number; libraryID?: number }>;
  collections?: ReadonlyArray<{ collectionId: number; libraryID?: number }>;
  tags?: ReadonlyArray<{
    name: string;
    normalizedName?: string;
    libraryID?: number;
    scope?: "allTagged" | "untagged";
    includeAutomatic?: boolean;
  }>;
};

export type TaskPaperScopeTextHint = "pdf" | "none" | "unknown";

export type TaskPaperScopeEntry = {
  key: string;
  libraryID: number;
  itemId: number;
  title: string;
  year: string;
  firstCreator: string;
  collectionPaths: string[];
  /** Manual tags first, at most `TASK_PAPER_SCOPE_MAX_TAGS`. */
  tags: string[];
  text: TaskPaperScopeTextHint;
};

export type TaskPaperScopeListing = {
  libraryID: number;
  /** True when nothing was attached and the whole library is listed. */
  wholeLibrary: boolean;
  entries: TaskPaperScopeEntry[];
  /** Papers the scope covers, before any cap. */
  totalItems: number;
  listedItems: number;
  truncated: boolean;
};

export const TASK_PAPER_SCOPE_WHOLE_LIBRARY_CAP = 2000;
export const TASK_PAPER_SCOPE_MAX_TAGS = 6;

function isScopePaper(item: LibraryIndexItem | undefined): boolean {
  return Boolean(item && item.kind === "regular" && !item.deleted);
}

// The three helpers below restate `services/zotero/internal/libraryIndex`
// (the layer rules keep agent/context from importing it). The unit test that
// compares this listing with `resolveLibraryScopeItemIds` guards the copy.

function matchesAggregateTagScope(
  item: LibraryIndexItem,
  scope: "allTagged" | "untagged",
  includeAutomatic: boolean,
): boolean {
  const tagged =
    item.tags.length > 0 || (includeAutomatic && item.automaticTags.length > 0);
  return scope === "allTagged" ? tagged : !tagged;
}

function liveRegularItemIds(snapshot: TaskPaperScopeSnapshot): number[] {
  return snapshot.topLevelItemOrder.filter((itemId) =>
    isScopePaper(snapshot.itemById.get(itemId)),
  );
}

function hasPdfAttachment(
  snapshot: TaskPaperScopeSnapshot,
  itemId: number,
): boolean {
  return (snapshot.childAttachmentIdsByItemId.get(itemId) || []).some(
    (attachmentId) => snapshot.attachmentById.get(attachmentId)?.isPdf,
  );
}

function tagItemIds(
  snapshot: TaskPaperScopeSnapshot,
  tag: NonNullable<TaskPaperScopeContexts["tags"]>[number],
): Iterable<number> {
  const includeAutomatic = tag.includeAutomatic === true;
  if (tag.scope === "allTagged" || tag.scope === "untagged") {
    const scope = tag.scope;
    return snapshot.topLevelItemOrder.filter((itemId) => {
      const item = snapshot.itemById.get(itemId);
      return Boolean(
        item && matchesAggregateTagScope(item, scope, includeAutomatic),
      );
    });
  }
  const entry = snapshot.tagByNormalizedName.get(
    normalizeLibraryIndexTagIdentity(tag.name || tag.normalizedName || ""),
  );
  if (!entry) return [];
  return new Set([
    ...entry.manualItemIds,
    ...(includeAutomatic ? entry.automaticItemIds : []),
  ]);
}

/** Item ids in the scope, in the order retrieval's union produces them. */
export function resolveTaskPaperScopeItemIds(
  snapshot: TaskPaperScopeSnapshot,
  contexts: TaskPaperScopeContexts,
): number[] {
  const libraryID = snapshot.libraryID;
  const excluded = new Set(contexts.excludedItemIds || []);
  const union = new Set<number>();
  const add = (ids: Iterable<number>) => {
    for (const id of ids) {
      if (excluded.has(id)) continue;
      if (isScopePaper(snapshot.itemById.get(id))) union.add(id);
    }
  };
  // Zotero item ids are unique across libraries, so a paper from another
  // library is simply absent from this snapshot.
  add((contexts.papers || []).map((paper) => paper.itemId));
  for (const context of contexts.collections || []) {
    const collection = snapshot.collectionById.get(context.collectionId);
    if (!collection || collection.libraryID !== libraryID) continue;
    add(snapshot.directItemIdsByCollectionId.get(context.collectionId) || []);
  }
  for (const tag of contexts.tags || []) {
    add(tagItemIds(snapshot, tag));
  }
  return [...union];
}

function hasScopeContexts(contexts: TaskPaperScopeContexts): boolean {
  return Boolean(
    contexts.papers?.length ||
    contexts.collections?.length ||
    contexts.tags?.length,
  );
}

function textHint(
  snapshot: TaskPaperScopeSnapshot,
  itemId: number,
): TaskPaperScopeTextHint {
  if (
    snapshot.pdfCapableItemIds.has(itemId) ||
    hasPdfAttachment(snapshot, itemId)
  ) {
    return "pdf";
  }
  return "none";
}

function scopeEntry(
  snapshot: TaskPaperScopeSnapshot,
  itemId: number,
): TaskPaperScopeEntry | null {
  const item = snapshot.itemById.get(itemId);
  if (!item) return null;
  const tags = [...item.tags, ...item.automaticTags];
  return {
    key: taskPaperKey(snapshot.libraryID, itemId),
    libraryID: snapshot.libraryID,
    itemId,
    title: item.title,
    year: item.year,
    firstCreator: item.firstCreator,
    collectionPaths: item.collectionIds.flatMap((collectionId) => {
      const path =
        snapshot.collectionPathById.get(collectionId) ||
        snapshot.collectionById.get(collectionId)?.name;
      return path ? [path] : [];
    }),
    tags: [...new Set(tags)].slice(0, TASK_PAPER_SCOPE_MAX_TAGS),
    text: textHint(snapshot, itemId),
  };
}

/**
 * The ordered papers in a turn's scope. `wholeLibraryCap` bounds only the
 * whole-library listing; an attached scope is always listed in full.
 */
export function listTaskPaperScope(
  snapshot: TaskPaperScopeSnapshot,
  contexts: TaskPaperScopeContexts,
  options: { wholeLibraryCap?: number } = {},
): TaskPaperScopeListing {
  const wholeLibrary = !hasScopeContexts(contexts);
  const ids = wholeLibrary
    ? liveRegularItemIds(snapshot)
    : resolveTaskPaperScopeItemIds(snapshot, contexts);
  const cap = wholeLibrary
    ? Math.max(
        0,
        Math.floor(
          options.wholeLibraryCap ?? TASK_PAPER_SCOPE_WHOLE_LIBRARY_CAP,
        ),
      )
    : ids.length;
  const entries = ids
    .slice(0, cap)
    .map((itemId) => scopeEntry(snapshot, itemId))
    .filter((entry): entry is TaskPaperScopeEntry => Boolean(entry));
  return {
    libraryID: snapshot.libraryID,
    wholeLibrary,
    entries,
    totalItems: ids.length,
    listedItems: entries.length,
    truncated: entries.length < ids.length,
  };
}
