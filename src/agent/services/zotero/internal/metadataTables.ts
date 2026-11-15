/**
 * The tables that decide what the agent may read and write.
 *
 * Each of these is a deliberate allow/deny list rather than a derived set:
 * what the agent can change in a user's library is a product decision, and
 * keeping the lists in one place is what makes that decision reviewable.
 */

import type { EditableArticleCreator } from "../../libraryMutation/valueTypes";

export const EDITABLE_ARTICLE_METADATA_FIELDS = [
  "title",
  "shortTitle",
  "abstractNote",
  "publicationTitle",
  "journalAbbreviation",
  "proceedingsTitle",
  "date",
  "volume",
  "issue",
  "pages",
  "DOI",
  "url",
  "language",
  "extra",
  "ISSN",
  "ISBN",
  "publisher",
  "place",
] as const;

/**
 * Fields that are never patchable, whatever the item type.
 *
 * These are primary or computed columns rather than `itemData` fields.
 * `setField` throws for most of them, and the few it accepts (`dateAdded`,
 * `dateModified`) would let the agent rewrite provenance -- so they are
 * refused here with a reason rather than surfacing as a raw Zotero throw.
 */
export const NON_EDITABLE_METADATA_FIELDS = new Set([
  "id",
  "key",
  "libraryID",
  "itemID",
  "itemType",
  "itemTypeID",
  "dateAdded",
  "dateModified",
  "version",
  "synced",
  "deleted",
  "firstCreator",
  "numChildren",
  "parentItem",
  "parentID",
  "parentKey",
  "relations",
  "collections",
  "tags",
  "note",
  "createdByUserID",
  "lastModifiedByUserID",
]);

/**
 * Zotero preferences the agent may read and write.
 *
 * An allowlist rather than open access to `Zotero.Prefs`: the pref tree
 * includes sync credentials, data directory paths and proxy settings, and an
 * agent that can rewrite those can lock a user out of their own library. Each
 * entry here changes behaviour the user might reasonably ask about.
 */
export const AGENT_WRITABLE_PREFS: Record<
  string,
  { type: "boolean" | "number" | "string"; description: string }
> = {
  recursiveCollections: {
    type: "boolean",
    description: "Show items from subcollections in a collection",
  },
  sortNotesChronologically: {
    type: "boolean",
    description: "Sort child notes by date rather than title",
  },
  showTrashWhenEmpty: {
    type: "boolean",
    description: "Keep the Trash row visible when it is empty",
  },
  automaticSnapshots: {
    type: "boolean",
    description: "Save a snapshot when creating an item from a web page",
  },
  automaticTags: {
    type: "boolean",
    description: "Add keywords and subject headings as automatic tags",
  },
  trashAutoEmptyDays: {
    type: "number",
    description: "Days before trashed items are erased automatically",
  },
  "export.quickCopy.setting": {
    type: "string",
    description: "The Quick Copy citation style or export format",
  },
  "export.quickCopy.locale": {
    type: "string",
    description: "Locale used for Quick Copy citations",
  },
  attachmentRenameTemplate: {
    type: "string",
    description: "Filename template used when renaming attachments",
  },
  autoRenameFiles: {
    type: "boolean",
    description: "Rename attachment files from their parent's metadata",
  },
  "annotations.noteTemplates.title": {
    type: "string",
    description: "Template for the title of a note built from annotations",
  },
  "annotations.noteTemplates.note": {
    type: "string",
    description: "Template for each annotation in such a note",
  },
  fontSize: { type: "number", description: "Interface font size" },
  "note.fontSize": { type: "number", description: "Note editor font size" },
  layout: {
    type: "string",
    description: "Item pane layout ('standard' or 'stacked')",
  },
};

export function normalizeCreatorForSnapshot(
  creator: _ZoteroTypes.Item.CreatorJSON | _ZoteroTypes.Item.Creator,
): EditableArticleCreator | null {
  const creatorType =
    typeof (creator as { creatorType?: unknown }).creatorType === "string" &&
    (creator as { creatorType?: string }).creatorType?.trim()
      ? (creator as { creatorType: string }).creatorType.trim()
      : "author";
  const name =
    typeof (creator as { name?: unknown }).name === "string" &&
    (creator as { name?: string }).name?.trim()
      ? (creator as { name: string }).name.trim()
      : undefined;
  const firstName =
    typeof (creator as { firstName?: unknown }).firstName === "string" &&
    (creator as { firstName?: string }).firstName?.trim()
      ? (creator as { firstName: string }).firstName.trim()
      : undefined;
  const lastName =
    typeof (creator as { lastName?: unknown }).lastName === "string" &&
    (creator as { lastName?: string }).lastName?.trim()
      ? (creator as { lastName: string }).lastName.trim()
      : undefined;
  const fieldMode =
    Number((creator as { fieldMode?: unknown }).fieldMode) === 1 || name
      ? 1
      : 0;
  if (!name && !firstName && !lastName) return null;
  return {
    creatorType,
    name,
    firstName,
    lastName,
    fieldMode,
  };
}
