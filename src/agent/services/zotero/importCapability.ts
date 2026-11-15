/**
 * Bringing outside references into the library: bibliography files, local
 * files, and identifier lookups through Zotero's translators.
 *
 * Split out of `zoteroGateway.ts`, where it was the largest contiguous block.
 * The capability never names the facade: the three gateway methods the import
 * paths used to call through `this` arrive as constructor dependencies, so a
 * caller (or a test) that supplies its own item and collection lookups gets
 * exactly the behaviour it asked for.
 */

import type {
  EditableArticleCreator,
  EditableArticleMetadataField,
  EditableArticleMetadataPatch,
  EditableArticleMetadataSnapshot,
} from "../libraryMutation/valueTypes";
import { toLocalFileHandle } from "./internal/fileHandles";
import { EDITABLE_ARTICLE_METADATA_FIELDS } from "./internal/metadataTables";

/**
 * What the import paths need from the rest of the gateway.
 *
 * `getItem` and `getCollection` are the facade's own resolvers rather than
 * the free functions in `internal/` on purpose: the facade passes thunks that
 * call its methods, so an instance-level override still reaches the import
 * paths. `getEditableArticleMetadata` belongs to the item surface and is read
 * only on the temporary-item fallback of an identifier lookup.
 */
export type ImportCapabilityDeps = {
  getItem(itemId: number | undefined): Zotero.Item | null;
  getCollection(collectionId: number | undefined): Zotero.Collection | null;
  getEditableArticleMetadata(
    item: Zotero.Item | null | undefined,
  ): EditableArticleMetadataSnapshot | null;
};

export class ImportCapability {
  constructor(private readonly deps: ImportCapabilityDeps) {}

  /**
   * Imports a bibliography file through Zotero's translators.
   *
   * `importLocalFiles` attached whatever it was given, so handing it a
   * `.ris` or `.bib` produced **one dead attachment row named refs.ris** and
   * reported "Imported 1 file" -- not a single reference reached the library.
   * This is the path that actually reads the file.
   */
  async importBibliographyFile(params: {
    filePath: string;
    libraryID: number;
    targetCollectionId?: number;
  }): Promise<{
    status: "imported" | "unsupported" | "error";
    itemIds: number[];
    reason?: string;
  }> {
    const TranslateImport = (
      Zotero as unknown as {
        Translate?: { Import?: new () => unknown };
      }
    ).Translate?.Import;
    if (!TranslateImport) {
      return {
        status: "error",
        itemIds: [],
        reason: "Zotero.Translate.Import is not available in this build",
      };
    }
    try {
      const translation = new TranslateImport() as {
        setLocation: (file: unknown) => void;
        getTranslators: () => Promise<unknown[]>;
        setTranslator: (translator: unknown) => void;
        translate: (options: {
          libraryID: number;
          collections: number[] | null;
        }) => Promise<Array<{ id: number }>>;
      };
      translation.setLocation(toLocalFileHandle(params.filePath));
      const translators = await translation.getTranslators();
      if (!translators.length) {
        // Distinct from an error: the file is fine, Zotero just has no
        // translator for it. Reported so the caller can fall back to
        // attaching rather than failing outright.
        return {
          status: "unsupported",
          itemIds: [],
          reason: `No Zotero translator recognises ${params.filePath}`,
        };
      }
      translation.setTranslator(translators[0]);
      const imported = await translation.translate({
        libraryID: params.libraryID,
        collections: params.targetCollectionId
          ? [params.targetCollectionId]
          : null,
      });
      const itemIds = (imported || [])
        .map((item) => Number(item?.id))
        .filter((id) => Number.isFinite(id) && id > 0);
      return { status: "imported", itemIds };
    } catch (error) {
      return {
        status: "error",
        itemIds: [],
        // Zotero rejects with a bare string, not an Error.
        reason:
          error instanceof Error
            ? error.message
            : String(error) || "Import failed",
      };
    }
  }

  /**
   * Import local files (PDFs, etc.) into the Zotero library.
   * Uses Zotero.Attachments.importFromFile to create items with attached files.
   */
  async importLocalFiles(params: {
    filePaths: string[];
    libraryID?: number;
    targetCollectionId?: number;
    /**
     * `translate` reads bibliography files (.ris, .bib, .enw, .nbib, RDF)
     * through Zotero's translators. `attach` stores the file as an
     * attachment. `auto` picks by extension, which is what a user means by
     * "import this file".
     */
    mode?: "auto" | "translate" | "attach";
    /** Run Zotero's PDF metadata recognition on imported PDFs. */
    recognize?: boolean;
  }): Promise<{
    succeeded: number;
    failed: number;
    items: Array<{
      filePath: string;
      status: "imported" | "error" | "not_found";
      itemId?: number;
      title?: string;
      reason?: string;
    }>;
  }> {
    const targetLibraryID =
      params.libraryID ??
      (Zotero as unknown as { Libraries?: { userLibraryID?: number } })
        .Libraries?.userLibraryID ??
      1;
    const targetCollection = params.targetCollectionId
      ? this.deps.getCollection(params.targetCollectionId)
      : null;

    let succeeded = 0;
    let failed = 0;
    const items: Array<{
      filePath: string;
      status: "imported" | "error" | "not_found";
      itemId?: number;
      title?: string;
      reason?: string;
    }> = [];

    const Attachments = (Zotero as any).Attachments;

    for (const filePath of params.filePaths) {
      try {
        // Check file exists
        const fileExists = await (async () => {
          try {
            const IOUtils = (globalThis as any).IOUtils;
            if (IOUtils?.exists) return await IOUtils.exists(filePath);
            const OSFile = (globalThis as any).OS?.File;
            if (OSFile?.exists) return await OSFile.exists(filePath);
            return true; // assume exists if we can't check
          } catch {
            return false;
          }
        })();

        if (!fileExists) {
          items.push({
            filePath,
            status: "not_found",
            reason: "File not found",
          });
          failed++;
          continue;
        }

        // Create a nsIFile reference
        let nsFile: any;
        const Components = (globalThis as any).Components;
        if (Components?.classes) {
          nsFile = Components.classes[
            "@mozilla.org/file/local;1"
          ].createInstance(Components.interfaces.nsIFile);
          nsFile.initWithPath(filePath);
        }

        // Bibliography files are read, not attached. Handing a .ris to
        // importFromFile produced one dead attachment row and reported
        // success, so not a single reference reached the library.
        const isBibliography =
          /\.(ris|bib|bibtex|enw|nbib|rdf|xml|json|mods|refer|txt)$/i.test(
            filePath,
          );
        const wantsTranslate =
          params.mode === "translate" ||
          (params.mode !== "attach" && isBibliography);
        if (wantsTranslate) {
          const translated = await this.importBibliographyFile({
            filePath,
            libraryID: targetLibraryID,
            targetCollectionId: targetCollection?.id,
          });
          if (translated.status === "imported") {
            items.push({
              filePath,
              status: "imported",
              itemId: translated.itemIds[0],
              title: `${translated.itemIds.length} reference${
                translated.itemIds.length === 1 ? "" : "s"
              } from ${filePath.split(/[\\/]/).pop()}`,
            });
            succeeded++;
            continue;
          }
          if (params.mode === "translate") {
            // Explicitly asked to translate, so falling back to attaching
            // would answer a different question than the one asked.
            items.push({
              filePath,
              status: "error",
              reason: translated.reason || "No translator recognised the file",
            });
            failed++;
            continue;
          }
          // Auto mode: an unrecognised file is still worth attaching.
        }

        let attachmentItem: any;

        if (Attachments?.importFromFile && nsFile) {
          // Primary: Zotero.Attachments.importFromFile({ file, libraryID })
          attachmentItem = await Attachments.importFromFile({
            file: nsFile,
            libraryID: targetLibraryID,
          });
        } else if (Attachments?.importFromFile) {
          // Try with path string
          attachmentItem = await Attachments.importFromFile({
            file: filePath,
            libraryID: targetLibraryID,
          });
        } else {
          items.push({
            filePath,
            status: "error",
            reason: "Zotero.Attachments.importFromFile is not available",
          });
          failed++;
          continue;
        }

        if (!attachmentItem) {
          items.push({
            filePath,
            status: "error",
            reason: "Import returned no item",
          });
          failed++;
          continue;
        }

        const itemId = Number(attachmentItem.id);
        const title = String(
          attachmentItem.getField?.("title") ||
            (attachmentItem as any).attachmentFilename ||
            filePath.split(/[\\/]/).pop() ||
            filePath,
        );

        // If there's a parent item (Zotero auto-created from metadata retrieval),
        // use that for collection assignment
        const parentId = attachmentItem.parentID;
        const targetItem = parentId
          ? this.deps.getItem(parentId) || attachmentItem
          : attachmentItem;

        // importFromFile returns a top-level ATTACHMENT, so isRegularItem()
        // is false and the gate silently dropped targetCollectionId for
        // every local-file import. Zotero files top-level attachments into
        // collections perfectly well.
        if (targetCollection && !targetItem.parentID) {
          targetItem.addToCollection(targetCollection.id);
          await targetItem.saveTx();
        }

        // Metadata retrieval never ran for any file, PDFs included --
        // Attachments.importFromFile has no recognition step, and Zotero
        // wires autoRecognizeItems only to the UI drop handlers and the
        // browser connector. The tool description promised it anyway, so a
        // PDF import produced a bare attachment titled paper.pdf with no
        // title, authors, year or DOI.
        let recognizedParentId: number | undefined;
        if (params.recognize !== false && attachmentItem.isPDFAttachment?.()) {
          const recognizer = (
            Zotero as unknown as {
              RecognizeDocument?: {
                recognizeItems?: (items: unknown[]) => Promise<unknown>;
              };
            }
          ).RecognizeDocument;
          if (recognizer?.recognizeItems) {
            try {
              await recognizer.recognizeItems([attachmentItem]);
              const newParent = Number(attachmentItem.parentID);
              if (Number.isFinite(newParent) && newParent > 0) {
                recognizedParentId = newParent;
              }
            } catch {
              // A failed lookup leaves a plain attachment, which is the old
              // behaviour -- it must not fail the import.
            }
          }
        }
        // Recognition creates a parent item, and that is what belongs in the
        // collection, not the attachment underneath it.
        if (recognizedParentId && targetCollection) {
          const parent = this.deps.getItem(recognizedParentId);
          if (parent) {
            parent.addToCollection(targetCollection.id);
            await parent.saveTx();
          }
        }

        items.push({
          filePath,
          status: "imported",
          itemId: recognizedParentId || parentId || itemId,
          title,
        });
        succeeded++;
      } catch (error) {
        items.push({
          filePath,
          status: "error",
          reason: error instanceof Error ? error.message : String(error),
        });
        failed++;
      }
    }

    return { succeeded, failed, items };
  }

  /**
   * Fetch canonical metadata for a paper by identifier (DOI, arXiv ID, or ISBN)
   * using Zotero's built-in Translate.Search engine — the same engine that powers
   * "Add Item by Identifier". Returns a complete metadata patch with ALL fields
   * without creating any item in the library.
   *
   * Falls back to creating a temporary item and reading its fields if the
   * translator does not support libraryID: false.
   */
  /**
   * Parses a user- or model-supplied identifier into Zotero's translator
   * shape.
   *
   * The import path used to have its own two-branch version: a
   * case-SENSITIVE `arxiv:` prefix, else "assume DOI". So the ISBNs and URLs
   * both schemas advertised silently failed, and — worse — the tool's own
   * validation hint suggested `"arXiv:2301.00001"` with a capital V, which
   * failed its own check.
   */
  /**
   * Works out what kind of identifier a string is.
   *
   * The hand-rolled version had four branches and fell through to "assume
   * DOI", which mis-sent several forms the schema advertises:
   *
   * - a bare arXiv ID (`2301.00001`) failed the ISBN test because of the dot
   *   and became a DOI -- and that is the form a literature search most often
   *   produces, so the most common arXiv case never worked
   * - a bare PMID (8-9 digits) fell under the 10-character ISBN threshold and
   *   became a DOI
   * - ADS bibcodes had no branch at all
   *
   * `Zotero.Utilities.extractIdentifiers` is the same parser Zotero's own
   * "Add Item by Identifier" uses, so these all resolve correctly. It has no
   * URL branch either, which is why URLs are handled separately below rather
   * than being silently turned into a DOI.
   */
  parseImportIdentifier(rawIdentifier: string): Record<string, string> {
    const trimmed = rawIdentifier.trim();
    const extract = (
      Zotero as unknown as {
        Utilities?: {
          extractIdentifiers?: (text: string) => Array<Record<string, string>>;
        };
      }
    ).Utilities?.extractIdentifiers;
    if (extract) {
      try {
        const found = extract(trimmed);
        if (found?.length) return found[0];
      } catch {
        // Fall through to the legacy branches below.
      }
    }
    if (/^arxiv:/i.test(trimmed)) {
      return { arXiv: trimmed.replace(/^arxiv:/i, "").trim() };
    }
    const withoutIsbnPrefix = trimmed.replace(/^isbn[:\s]?/i, "");
    if (/^[\d-]{10,}$/.test(withoutIsbnPrefix)) {
      return { ISBN: withoutIsbnPrefix.trim() };
    }
    if (/^pmid[:\s]?\d+$/i.test(trimmed)) {
      return { PMID: trimmed.replace(/^pmid[:\s]?/i, "").trim() };
    }
    return { DOI: trimmed.replace(/^https?:\/\/doi\.org\//i, "") };
  }

  /**
   * Whether this identifier can be resolved at all.
   *
   * `Translate.Search.setIdentifier` throws for anything outside
   * DOI/ISBN/PMID/arXiv/adsBibcode, and a plain URL is not among them --
   * Zotero's own Add-by-Identifier box does not accept URLs either. The
   * schemas advertised URL import, so pasting an arXiv abstract page, a
   * Nature article page or a PubMed page came back "No translator could
   * resolve this identifier". URLs whose path happens to contain a DOI worked
   * by accident, which made the failure look random rather than systematic.
   */
  describeUnresolvableIdentifier(raw: string): string | null {
    const trimmed = raw.trim();
    if (!/^https?:\/\//i.test(trimmed)) return null;
    // A DOI anywhere in the URL is extractable, so those still work.
    if (/10\.\d{4,}\/[^\s]+/.test(trimmed)) return null;
    return (
      "Zotero cannot import from a page URL — only DOIs, ISBNs, PMIDs, arXiv IDs and ADS bibcodes. " +
      "Open the page and use the DOI or arXiv ID from it instead."
    );
  }

  async fetchMetadataByIdentifier(
    rawIdentifier: string,
  ): Promise<EditableArticleMetadataPatch | null> {
    try {
      const isArXiv = /^arxiv:/i.test(rawIdentifier);
      const isIsbn = /^(isbn[:\s]?)?[\d-]{10,}$/i.test(
        rawIdentifier.replace(/^isbn[:\s]?/i, ""),
      );
      const identifier: Record<string, string> = isArXiv
        ? { arXiv: rawIdentifier.replace(/^arxiv:/i, "") }
        : isIsbn
          ? { ISBN: rawIdentifier.replace(/^isbn[:\s]?/i, "").trim() }
          : { DOI: rawIdentifier.replace(/^https?:\/\/doi\.org\//i, "") };

      const translate = new (
        Zotero as unknown as {
          Translate: {
            Search: new () => {
              setIdentifier(id: Record<string, string>): void;
              getTranslators(): Promise<unknown[]>;
              setTranslator(t: unknown): void;
              translate(opts?: {
                libraryID?: number | false;
                saveAttachments?: boolean;
              }): Promise<unknown[]>;
            };
          };
        }
      ).Translate.Search();

      translate.setIdentifier(identifier);
      const translators = await translate.getTranslators();
      if (!translators || translators.length === 0) return null;
      translate.setTranslator(translators);

      // Try libraryID: false first — returns raw JSON without saving to DB
      let rawItems: unknown[];
      let tempItemId: number | null = null;
      try {
        rawItems = await translate.translate({
          libraryID: false as unknown as number,
          saveAttachments: false,
        });
      } catch {
        // Fallback: create a temporary item, read its metadata, then delete it
        const targetLibraryID =
          (Zotero as unknown as { Libraries?: { userLibraryID?: number } })
            .Libraries?.userLibraryID ?? 1;
        rawItems = await translate.translate({ libraryID: targetLibraryID });
        if (rawItems?.[0] && typeof rawItems[0] === "object") {
          const id = Number((rawItems[0] as { id?: unknown }).id);
          if (Number.isFinite(id) && id > 0) tempItemId = Math.floor(id);
        }
      }

      if (!rawItems || rawItems.length === 0) return null;
      const raw = rawItems[0] as Record<string, unknown>;

      // If we got a real Zotero item (fallback path), read fields from it
      if (tempItemId) {
        const item = this.deps.getItem(tempItemId);
        if (item) {
          const snapshot = this.deps.getEditableArticleMetadata(item);
          // Clean up the temporary item
          try {
            item.deleted = true;
            await item.saveTx();
            await item.eraseTx();
          } catch {
            // Best-effort cleanup
          }
          if (snapshot) {
            const patch: EditableArticleMetadataPatch = {};
            for (const [key, value] of Object.entries(snapshot.fields)) {
              if (value) {
                patch[key as EditableArticleMetadataField] = value;
              }
            }
            if (snapshot.creators.length) patch.creators = snapshot.creators;
            return Object.keys(patch).length ? patch : null;
          }
        }
        return null;
      }

      // libraryID: false path — raw is a translator JSON object
      return this.translatorJsonToPatch(raw);
    } catch {
      return null;
    }
  }

  /**
   * Convert a raw Zotero translator JSON result (from libraryID: false) into
   * an EditableArticleMetadataPatch.
   */
  translatorJsonToPatch(
    raw: Record<string, unknown>,
  ): EditableArticleMetadataPatch | null {
    const patch: EditableArticleMetadataPatch = {};
    for (const fieldName of EDITABLE_ARTICLE_METADATA_FIELDS) {
      const value = raw[fieldName];
      if (typeof value === "string" && value.trim()) {
        patch[fieldName] = value.trim();
      } else if (typeof value === "number") {
        patch[fieldName] = String(value);
      }
    }
    // Creators from translator JSON come as [{firstName, lastName, creatorType}]
    const rawCreators = Array.isArray(raw.creators) ? raw.creators : [];
    const creators: EditableArticleCreator[] = [];
    for (const entry of rawCreators) {
      if (!entry || typeof entry !== "object") continue;
      const c = entry as Record<string, unknown>;
      const creatorType =
        typeof c.creatorType === "string" && c.creatorType.trim()
          ? c.creatorType.trim()
          : "author";
      const firstName =
        typeof c.firstName === "string" && c.firstName.trim()
          ? c.firstName.trim()
          : undefined;
      const lastName =
        typeof c.lastName === "string" && c.lastName.trim()
          ? c.lastName.trim()
          : undefined;
      const name =
        typeof c.name === "string" && c.name.trim() ? c.name.trim() : undefined;
      if (!name && !firstName && !lastName) continue;
      creators.push({
        creatorType,
        firstName,
        lastName,
        name,
        fieldMode: (name && !firstName && !lastName ? 1 : 0) as 0 | 1,
      });
    }
    if (creators.length) patch.creators = creators;
    return Object.keys(patch).length ? patch : null;
  }

  /**
   * Import papers into the Zotero library by identifier (DOI or arXiv ID).
   *
   * - Plain DOI strings (starting with "10.") → `{ DOI: id }`
   * - arXiv IDs prefixed with `"arxiv:"` (e.g. `"arxiv:2301.12345"`) → `{ arXiv: id }`
   *
   * Uses Zotero's built-in `Translate.Search` API, which fetches metadata from
   * CrossRef / arXiv translators and saves items to the target library.
   * Zotero will also attempt to attach a PDF if one is openly available.
   */
  async importPapersByIdentifiers(
    identifiers: string[],
    libraryID?: number,
    targetCollectionId?: number,
  ): Promise<{
    succeeded: number;
    failed: number;
    itemIds?: number[];
    items: Array<{
      identifier: string;
      status: "imported" | "not_found" | "error";
      itemId?: number;
      reason?: string;
    }>;
  }> {
    let succeeded = 0;
    let failed = 0;
    const itemIds: number[] = [];
    // Per-identifier rows: "10 of 50 failed" was previously unattributable,
    // so a user had no way to know which ten to retry.
    const rows: Array<{
      identifier: string;
      status: "imported" | "not_found" | "error";
      itemId?: number;
      reason?: string;
    }> = [];
    const targetLibraryID =
      libraryID ??
      (Zotero as unknown as { Libraries?: { userLibraryID?: number } })
        .Libraries?.userLibraryID ??
      1;
    const targetCollection = targetCollectionId
      ? this.deps.getCollection(targetCollectionId)
      : null;
    if (targetCollectionId && !targetCollection) {
      throw new Error("Target collection not found");
    }

    for (const rawId of identifiers) {
      try {
        const identifier = this.parseImportIdentifier(rawId);

        const translate = new (
          Zotero as unknown as {
            Translate: {
              Search: new () => {
                setIdentifier(id: Record<string, string>): void;
                getTranslators(): Promise<unknown[]>;
                setTranslator(t: unknown): void;
                translate(opts?: {
                  libraryID?: number | false;
                }): Promise<unknown[]>;
              };
            };
          }
        ).Translate.Search();

        translate.setIdentifier(identifier);
        const translators = await translate.getTranslators();
        if (!translators || translators.length === 0) {
          failed++;
          rows.push({
            identifier: rawId,
            status: "not_found",
            reason:
              this.describeUnresolvableIdentifier(rawId) ||
              "No translator could resolve this identifier",
          });
          continue;
        }
        translate.setTranslator(translators);
        // Search inherits Zotero's Web translator, which does not forward
        // saveOptions and automatically selects its newly saved item. Resolve
        // metadata first, then let the native ItemSaver persist the complete
        // translator payload without changing the user's conversation context.
        const translatedItems = await translate.translate({ libraryID: false });
        const ItemSaver = (
          Zotero as unknown as {
            Translate: {
              ItemSaver: {
                new (options: {
                  libraryID: number;
                  collections: number[] | null;
                  attachmentMode: number;
                  forceTagType: number;
                  saveOptions: { skipSelect: boolean };
                }): {
                  saveItems(
                    items: unknown[],
                    onAttachment: () => void,
                  ): Promise<unknown[]>;
                };
                ATTACHMENT_MODE_DOWNLOAD: number;
              };
            };
          }
        ).Translate.ItemSaver;
        const items = translatedItems?.length
          ? await new ItemSaver({
              libraryID: targetLibraryID,
              collections: targetCollection ? [targetCollection.id] : null,
              attachmentMode: ItemSaver.ATTACHMENT_MODE_DOWNLOAD,
              forceTagType: 1,
              saveOptions: { skipSelect: true },
            }).saveItems(translatedItems, () => {})
          : [];
        if (items && items.length > 0) {
          const importedRegularItemIds = items
            .map((item) =>
              item && typeof item === "object"
                ? Number((item as { id?: unknown }).id)
                : NaN,
            )
            .filter((itemId) => Number.isFinite(itemId) && itemId > 0)
            .map((itemId) => Math.floor(itemId))
            .filter((itemId) => {
              const importedItem = this.deps.getItem(itemId);
              return Boolean(importedItem?.isRegularItem?.());
            });
          itemIds.push(...importedRegularItemIds);
          // Previously `|| items.length`, which reported success when the
          // translator returned something but nothing survived the
          // regular-item filter — so nothing was filed and it still counted.
          if (importedRegularItemIds.length) {
            succeeded += importedRegularItemIds.length;
            for (const itemId of importedRegularItemIds) {
              rows.push({ identifier: rawId, status: "imported", itemId });
            }
          } else {
            failed++;
            rows.push({
              identifier: rawId,
              status: "error",
              reason:
                "The translator returned no regular item for this identifier",
            });
          }
        } else {
          failed++;
          rows.push({
            identifier: rawId,
            status: "not_found",
            reason: "The translator returned no items",
          });
        }
      } catch (error) {
        failed++;
        rows.push({
          identifier: rawId,
          status: "error",
          // Zotero rejects a translation with a bare STRING, not an Error
          // ("No items returned from any translator"), so assuming Error
          // flattened every real translator failure to the two words "Import
          // failed" and told the user nothing.
          reason:
            error instanceof Error
              ? error.message
              : typeof error === "string" && error.trim()
                ? error.trim()
                : "Import failed",
        });
      }
    }

    // A follow-up library_search would not have seen the new items.

    return { succeeded, failed, itemIds, items: rows };
  }
}
