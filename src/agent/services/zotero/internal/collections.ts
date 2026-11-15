/**
 * Collection lookup, membership and the path strings the model reads.
 *
 * `getCollectionSummary` prefers the library index snapshot when one is
 * already warm and falls back to walking the collection tree, so a summary
 * costs nothing on the common path and is still correct on a cold one.
 */

import { libraryIndexService } from "../../../../services/libraryIndexService";
import { normalizeText } from "./normalize";
import type { CollectionSummary } from "./types";

/** The collection behind an id, or null for anything that is not one. */
export function getCollection(
  collectionId: number | undefined,
): Zotero.Collection | null {
  if (!Number.isFinite(collectionId) || !collectionId || collectionId <= 0) {
    return null;
  }
  return Zotero.Collections.get(Math.floor(collectionId)) || null;
}

export function getCollectionIDs(
  item: Zotero.Item | null | undefined,
): number[] {
  if (!item) return [];
  try {
    return item
      .getCollections()
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id) && id > 0)
      .map((id) => Math.floor(id));
  } catch (_error) {
    void _error;
    return [];
  }
}

export function listLibraryCollections(libraryID: number): Zotero.Collection[] {
  if (!Number.isFinite(libraryID) || libraryID <= 0) return [];
  try {
    return Zotero.Collections.getByLibrary(Math.floor(libraryID), true) || [];
  } catch (_error) {
    void _error;
    return [];
  }
}

export function buildCollectionPathMap(
  collections: Zotero.Collection[],
): Map<number, string> {
  const byId = new Map<number, Zotero.Collection>();
  const pathById = new Map<number, string>();
  for (const collection of collections) {
    byId.set(collection.id, collection);
  }
  const resolvePath = (collectionId: number): string => {
    const cached = pathById.get(collectionId);
    if (cached) return cached;
    const collection = byId.get(collectionId);
    if (!collection) return "";
    const name =
      normalizeText(collection.name) || `Collection ${collection.id}`;
    const parentId = Number(collection.parentID);
    if (!Number.isFinite(parentId) || parentId <= 0 || !byId.has(parentId)) {
      pathById.set(collectionId, name);
      return name;
    }
    const path = `${resolvePath(Math.floor(parentId))} / ${name}`;
    pathById.set(collectionId, path);
    return path;
  };
  for (const collection of collections) {
    resolvePath(collection.id);
  }
  return pathById;
}

/** Name, library and full path of a collection, for reporting it back. */
export function getCollectionSummary(
  collectionId: number | undefined,
): CollectionSummary | null {
  const collection = getCollection(collectionId);
  if (!collection) return null;
  const libraryID = Number(collection.libraryID) || 0;
  const snapshot = libraryIndexService.peekSnapshot(libraryID);
  const indexed = snapshot?.collectionById.get(collection.id);
  if (indexed) {
    return {
      collectionId: indexed.collectionId,
      name: indexed.name,
      libraryID: indexed.libraryID,
      path:
        snapshot?.collectionPathById.get(indexed.collectionId) || indexed.name,
    };
  }
  const pathMap = buildCollectionPathMap(listLibraryCollections(libraryID));
  return {
    collectionId: collection.id,
    name: normalizeText(collection.name) || `Collection ${collection.id}`,
    libraryID,
    path:
      pathMap.get(collection.id) ||
      normalizeText(collection.name) ||
      `Collection ${collection.id}`,
  };
}
