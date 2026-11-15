import type { ActionCardResolvers } from "./actionCardModel";

/**
 * Read the library, and say nothing when it cannot be read.
 *
 * The card is drawn in contexts where Zotero is absent (tests, a window torn
 * down mid-render) and against ids the library may no longer hold. A resolver
 * that throws or finds nothing returns undefined, and the card falls back to
 * the identity the receipt carried rather than inventing a name.
 */
function readLibrary<T>(read: () => T | undefined): T | undefined {
  try {
    if (typeof Zotero === "undefined") return undefined;
    return read();
  } catch {
    return undefined;
  }
}

/** The year a citation reads by: the first one the item's date states. */
function citationYear(item: Zotero.Item): string | undefined {
  return /\b(19|20)\d{2}\b/.exec(item.getField("date") || "")?.[0];
}

/**
 * How the reader already sees an item cited: creator and year, falling back to
 * the creator alone and then to the title, because a paper with no date is
 * still a paper the reader recognizes.
 */
function citationLabel(
  item: Zotero.Item,
): { label: string; libraryID: number; itemKey: string } | undefined {
  const creator = item.firstCreator;
  const year = citationYear(item);
  const label =
    creator && year ? `${creator}, ${year}` : creator || item.getDisplayTitle();
  return label
    ? { label, libraryID: item.libraryID, itemKey: item.key }
    : undefined;
}

/**
 * How the panel names a native object the receipts touched.
 *
 * An item is named the way the reader already sees it cited. A note is not:
 * a note-writing receipt targets the note it wrote, and that note is already
 * the row's own chip, so the row is given the paper the note hangs under and
 * told which item that is. A note that hangs under nothing is named nowhere
 * else, and the row shows it as the note chip alone.
 */
export function createZoteroActionCardResolvers(
  materialTitle: (documentId: string) => string | undefined,
): ActionCardResolvers {
  return {
    itemLabel: (itemId) =>
      readLibrary(() => {
        const item = Zotero.Items.get(itemId);
        if (!item) return undefined;
        if (item.isNote?.()) {
          const parentItemID = item.parentItemID;
          if (!parentItemID) return undefined;
          const parent = Zotero.Items.get(parentItemID);
          const named = parent ? citationLabel(parent) : undefined;
          return named ? { ...named, itemId: parentItemID } : undefined;
        }
        return citationLabel(item);
      }),
    collectionLabel: (collectionId) =>
      readLibrary(() => {
        const collection = Zotero.Collections.get(
          collectionId,
        ) as Zotero.Collection | null;
        return collection?.name
          ? { label: collection.name, libraryID: collection.libraryID }
          : undefined;
      }),
    noteLabel: (noteId) =>
      readLibrary(() => {
        const note = Zotero.Items.get(noteId);
        // A note id the library answers with something that is not a note is a
        // stale id; the row keeps the identity rather than naming a paper.
        if (!note || !note.isNote?.()) return undefined;
        return {
          label: note.getNoteTitle() || "Note",
          libraryID: note.libraryID,
          itemKey: note.key,
        };
      }),
    materialTitle,
  };
}
