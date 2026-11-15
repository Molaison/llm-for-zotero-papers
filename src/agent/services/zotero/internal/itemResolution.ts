/**
 * Turning an id, a portal stand-in or a child attachment into the item a
 * write or a read should actually act on.
 *
 * Every capability starts here, which is why these are free functions: the
 * facade keeps `getItem`/`resolveBibliographicItem` as methods for its
 * callers, but a capability calls the function and never the facade.
 */

import {
  isGlobalPortalItem,
  isPaperPortalItem,
  resolvePaperPortalBaseItem,
} from "../../../../services/context/portalItems";
import {
  refusalFor,
  type LibraryOperation,
} from "../../../capabilities/libraryObjects";
import { NON_EDITABLE_METADATA_FIELDS } from "./metadataTables";

/** The item behind an id, or null for anything that is not a live item. */
export function getItem(itemId: number | undefined): Zotero.Item | null {
  if (!Number.isFinite(itemId) || !itemId || itemId <= 0) return null;
  return Zotero.Items.get(Math.floor(itemId)) || null;
}

/**
 * Resolves an item for a collection-membership write and reports why it may
 * not proceed, using the declared capability matrix rather than the old
 * regular-item filter.
 *
 * The behaviour change that matters: standalone notes and standalone
 * attachments are legal collection members in Zotero and are now filed
 * instead of being reported as "Item not found", and a child attachment is
 * refused explicitly instead of silently filing its parent.
 *
 * Portal pseudo-items are still unwrapped first — they stand in for a real
 * paper and must be resolved before the matrix sees them.
 */
export function resolveMatrixItem(
  item: Zotero.Item | null | undefined,
  itemId: number,
  operation: LibraryOperation,
): { item: Zotero.Item } | { refusal: string } {
  if (!item) {
    return { refusal: `No item with ID ${itemId} exists in this library` };
  }
  if (isGlobalPortalItem(item)) {
    return { refusal: "The library portal is not an item that can be filed" };
  }
  const resolved = isPaperPortalItem(item)
    ? resolvePaperPortalBaseItem(item)
    : item;
  if (!resolved) {
    return { refusal: `No item with ID ${itemId} exists in this library` };
  }
  const refusal = refusalFor(operation, resolved, itemId);
  return refusal ? { refusal } : { item: resolved };
}

export function resolveRegularItem(
  item: Zotero.Item | null | undefined,
): Zotero.Item | null {
  if (!item) return null;
  if (isGlobalPortalItem(item)) return null;
  if (isPaperPortalItem(item)) {
    return resolvePaperPortalBaseItem(item);
  }
  if (item.isAttachment() && item.parentID) {
    const parent = Zotero.Items.get(item.parentID) || null;
    return parent?.isRegularItem?.() ? parent : null;
  }
  return item?.isRegularItem?.() ? item : null;
}

export function getItemTypeName(item: Zotero.Item): string {
  try {
    const name = (
      Zotero as unknown as { ItemTypes?: { getName?: (id: number) => string } }
    ).ItemTypes?.getName?.(item.itemTypeID);
    return typeof name === "string" && name.trim() ? name.trim() : "";
  } catch (_error) {
    void _error;
    return "";
  }
}

/**
 * The bibliographic item a caller means: the parent of a child attachment,
 * the paper behind a portal stand-in, or the regular item itself.
 */
export function resolveBibliographicItem(
  item: Zotero.Item | null | undefined,
): Zotero.Item | null {
  return resolveRegularItem(item);
}

/**
 * Whether a field can be written on this particular item.
 *
 * Two defects here, both of which reported success while doing the wrong
 * thing:
 *
 * - No base-field mapping. `publicationTitle` is a *base* field whose
 *   type-specific name is `bookTitle` on a book section and
 *   `proceedingsTitle` on a conference paper. Checking the base id against
 *   the type said "invalid" for fields Zotero writes happily. `setField`
 *   itself resolves this with `getFieldIDFromTypeAndBase`, so the check has
 *   to as well or it disagrees with the write it is guarding.
 * - Fail-open. The `catch` returned `true`, so if `Zotero.ItemFields` were
 *   missing every field was declared valid and the error surfaced later as a
 *   raw throw from `setField`. No test defines `ItemFields`, so that branch
 *   has never run in CI.
 */
export function isFieldValidForItemType(
  item: Zotero.Item,
  fieldName: string,
): boolean {
  if (NON_EDITABLE_METADATA_FIELDS.has(fieldName)) return false;
  const itemFields = (
    Zotero as unknown as {
      ItemFields?: {
        getID?: (name: string) => number | false;
        isValidForType?: (fieldId: number, itemTypeId: number) => boolean;
        getFieldIDFromTypeAndBase?: (
          itemTypeId: number,
          baseFieldId: number,
        ) => number | false;
      };
    }
  ).ItemFields;
  // Fail closed: without the schema there is no way to tell a valid field
  // from a typo, and guessing "valid" turns a typo into a thrown write.
  if (!itemFields?.getID || typeof itemFields.isValidForType !== "function") {
    return false;
  }
  try {
    const baseFieldId = itemFields.getID(fieldName);
    if (!baseFieldId) return false;
    const itemTypeID = item.itemTypeID;
    // Mirrors setField: prefer the type-specific field, fall back to the base.
    const fieldId =
      itemFields.getFieldIDFromTypeAndBase?.(itemTypeID, baseFieldId) ||
      baseFieldId;
    return Boolean(itemFields.isValidForType(fieldId, itemTypeID));
  } catch {
    return false;
  }
}

/**
 * Every field this item type accepts, for telling the model what it may set.
 */
export function listEditableFieldsForItem(item: Zotero.Item): string[] {
  const itemFields = (
    Zotero as unknown as {
      ItemFields?: {
        getItemTypeFields?: (itemTypeId: number) => number[];
        getName?: (fieldId: number) => string;
      };
    }
  ).ItemFields;
  if (!itemFields?.getItemTypeFields || !itemFields.getName) return [];
  try {
    return itemFields
      .getItemTypeFields(item.itemTypeID)
      .map((fieldId) => itemFields.getName?.(fieldId) || "")
      .filter((name) => name && !NON_EDITABLE_METADATA_FIELDS.has(name));
  } catch {
    return [];
  }
}
