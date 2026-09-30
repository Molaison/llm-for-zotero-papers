/**
 * When the Task progress row shows, and what scope a turn covers.
 *
 * The row shows for library chat, for any turn that attached a folder or a
 * tag, for a paper chat over five papers or more, and for the rest of a
 * conversation once a plan ran in it. It never shows in WebChat or in a note
 * chat. Everything here is pure.
 */
import type { TaskPaperScopeContexts } from "../../../agent/context/taskPaperScopeListing";
import type {
  CollectionContextRef,
  PaperContextRef,
  TagContextRef,
} from "../../../shared/types";

/** A paper chat shows the row from this many papers (its own included). */
export const TASK_PROGRESS_PAPER_THRESHOLD = 5;

export type TaskProgressVisibilityInput = {
  conversationKind: "global" | "paper" | "";
  isWebChat: boolean;
  isNoteSession: boolean;
  collectionCount: number;
  tagCount: number;
  paperCount: number;
  /** A plan ran in this conversation. */
  planSeen: boolean;
};

export function shouldShowTaskProgress(
  input: TaskProgressVisibilityInput,
): boolean {
  if (input.isWebChat || input.isNoteSession) return false;
  if (input.conversationKind !== "global" && input.conversationKind !== "paper")
    return false;
  if (input.planSeen) return true;
  if (input.conversationKind === "global") return true;
  return (
    input.collectionCount > 0 ||
    input.tagCount > 0 ||
    input.paperCount >= TASK_PROGRESS_PAPER_THRESHOLD
  );
}

/** The contexts a user message attached, as the turn scope reads them. */
export type TaskProgressTurnContexts = {
  paperContexts?: readonly PaperContextRef[];
  fullTextPaperContexts?: readonly PaperContextRef[];
  pdfPaperContexts?: readonly PaperContextRef[];
  selectedCollectionContexts?: readonly CollectionContextRef[];
  selectedTagContexts?: readonly TagContextRef[];
};

export type TaskProgressTurnScope = {
  libraryID: number;
  contexts: TaskPaperScopeContexts;
  /** Distinct papers named, the paper chat's own paper included. */
  paperCount: number;
  collectionCount: number;
  tagCount: number;
  /** Folder and tag names, "Drift + Learning"; empty when none. */
  label: string;
  /** Identity of the contexts, stable across re-renders of the same turn. */
  signature: string;
};

/**
 * The scope of a turn: the paper chat's own paper first, then the papers,
 * folders and tags the user message attached. Library chat with nothing
 * attached is the whole library (empty contexts).
 */
export function resolveTaskProgressTurnScope(params: {
  message: TaskProgressTurnContexts | null | undefined;
  conversationKind: "global" | "paper" | "";
  libraryID: number;
  basePaperItemId?: number;
}): TaskProgressTurnScope {
  const message = params.message || {};
  const papers: Array<{ itemId: number; libraryID?: number }> = [];
  const seenPapers = new Set<number>();
  const addPaper = (itemId: unknown, libraryID?: number) => {
    const id = Math.floor(Number(itemId));
    if (!Number.isFinite(id) || id <= 0 || seenPapers.has(id)) return;
    seenPapers.add(id);
    papers.push(libraryID ? { itemId: id, libraryID } : { itemId: id });
  };
  if (params.conversationKind === "paper") {
    addPaper(params.basePaperItemId, params.libraryID);
  }
  for (const list of [
    message.paperContexts,
    message.fullTextPaperContexts,
    message.pdfPaperContexts,
  ]) {
    for (const paper of list || []) addPaper(paper.itemId, paper.libraryID);
  }
  const collections: Array<{ collectionId: number; libraryID?: number }> = [];
  const names: string[] = [];
  const seenCollections = new Set<number>();
  for (const collection of message.selectedCollectionContexts || []) {
    const id = Math.floor(Number(collection.collectionId));
    if (!Number.isFinite(id) || id <= 0 || seenCollections.has(id)) continue;
    seenCollections.add(id);
    collections.push({ collectionId: id, libraryID: collection.libraryID });
    if (collection.name) names.push(collection.name);
  }
  const tags: Array<NonNullable<TaskPaperScopeContexts["tags"]>[number]> = [];
  const seenTags = new Set<string>();
  for (const tag of message.selectedTagContexts || []) {
    const identity = `${tag.scope || ""}\u0000${tag.normalizedName || tag.name}`;
    if (seenTags.has(identity)) continue;
    seenTags.add(identity);
    tags.push({
      name: tag.name,
      normalizedName: tag.normalizedName,
      libraryID: tag.libraryID,
      scope: tag.scope,
      includeAutomatic: tag.includeAutomatic,
    });
    if (tag.name) names.push(`#${tag.name}`);
  }
  const excludedItemIds = [
    ...new Set(
      [
        ...(message.selectedCollectionContexts || []),
        ...(message.selectedTagContexts || []),
      ].flatMap((context) => context.excludedItemIds || []),
    ),
  ].sort((a, b) => a - b);
  const contexts: TaskPaperScopeContexts = {};
  if (excludedItemIds.length) contexts.excludedItemIds = excludedItemIds;
  if (papers.length) contexts.papers = papers;
  if (collections.length) contexts.collections = collections;
  if (tags.length) contexts.tags = tags;
  return {
    libraryID: params.libraryID,
    contexts,
    paperCount: papers.length,
    collectionCount: collections.length,
    tagCount: tags.length,
    label: names.join(" + "),
    signature: JSON.stringify([
      params.libraryID,
      papers.map((paper) => paper.itemId),
      collections.map((collection) => collection.collectionId),
      tags.map((tag) => [
        tag.scope || "",
        tag.normalizedName || tag.name,
        tag.includeAutomatic === true,
      ]),
      excludedItemIds,
    ]),
  };
}
