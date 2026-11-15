import { revealLocalPath } from "../../../utils/revealLocalPath";
import { navigatePlanDocumentCitationSource } from "../planDocumentPresentation";
import { navigationTargetOf, type NavigableTarget } from "./actionCardChips";

/**
 * Opening what the action card names.
 *
 * A card states what a turn did to the library, so every object it names is a
 * place the reader can go: the paper it tagged, the collection it filed into,
 * the note it wrote, the file it produced. The visit itself is Zotero's — the
 * items pane, the collection tree, the tag selector — and this module is the
 * one place that knows which of those a card object belongs to.
 *
 * The window is reached through a host rather than the `Zotero` global so a
 * test can state the visit it expects without a live pane, and so a card
 * rendered where no pane exists simply has nothing to open.
 */

/**
 * The live library pane, as much of it as opening an object needs.
 *
 * The selection calls take their options as an object: the boolean argument
 * they used to take is deprecated and logs a warning on every click.
 */
export type NavigationPane = {
  selectItems?: (
    ids: number[],
    options?: { inLibraryRoot?: boolean },
  ) => Promise<boolean | undefined>;
  selectItem?: (
    id: number,
    options?: { inLibraryRoot?: boolean },
  ) => boolean | undefined;
  collectionsView?:
    | {
        selectByID?: (id: string) => Promise<unknown> | unknown;
        selectCollection?: (id: number) => Promise<unknown> | unknown;
      }
    | false;
  tagSelector?: {
    handleTagSelected?: (tag: string) => unknown;
    setFilter?: (text: string) => unknown;
  } | null;
};

/** Everything a visit needs from the running application. */
export type NavigationHost = {
  pane: () => NavigationPane | null;
  openNote: (source: {
    libraryID: number;
    itemKey: string;
  }) => Promise<boolean>;
  revealFile: (path: string) => Promise<boolean>;
  focusMainWindow: () => void;
};

/**
 * The running Zotero application, as the card sees it.
 *
 * Every call is guarded: the card is also rendered in a standalone window and
 * in tests, and a chip must never throw at the reader because a window went
 * away between the render and the click.
 */
export function createZoteroNavigationHost(): NavigationHost {
  return {
    pane: () => {
      if (typeof Zotero === "undefined") return null;
      try {
        return (
          (Zotero.getActiveZoteroPane?.() as NavigationPane | undefined) || null
        );
      } catch {
        return null;
      }
    },
    // A note is opened the way a document citation opens one, so the reader
    // lands on the same place from the card as from a quote.
    openNote: async (source) => {
      if (typeof Zotero === "undefined") return false;
      return navigatePlanDocumentCitationSource({
        libraryID: source.libraryID,
        itemKey: source.itemKey,
        evidenceRefs: [],
      });
    },
    revealFile: async (path) => revealLocalPath(path) !== null,
    focusMainWindow: () => {
      if (typeof Zotero === "undefined") return;
      try {
        Zotero.getMainWindow?.()?.focus?.();
      } catch {
        /* The window the card was rendered for is gone. */
      }
    },
  };
}

/** The collection tree, when the pane has a live one. */
function collectionTreeOf(host: NavigationHost): {
  selectByID?: (id: string) => unknown;
  selectCollection?: (id: number) => unknown;
} | null {
  const view = host.pane()?.collectionsView;
  return view || null;
}

/** The library the trash belongs to, when the object did not name one. */
function defaultLibraryID(): number | undefined {
  if (typeof Zotero === "undefined") return undefined;
  try {
    const id = Zotero.Libraries?.userLibraryID;
    return typeof id === "number" ? id : undefined;
  } catch {
    return undefined;
  }
}

/** What a failed visit calls the object it could not open. */
function targetLabel(target: NavigableTarget): string {
  // Every object carries the words the chip shows, except the trash, whose
  // chip is drawn with the one name it can have.
  return "label" in target ? target.label : "Trash";
}

/**
 * Whether this object is somewhere the reader can actually be taken.
 *
 * A chip that names something unreachable — a tag with no tag selector on
 * screen, a collection no receipt identified — is drawn as plain text rather
 * than a link the reader would click for nothing.
 */
export function canNavigate(
  target: NavigableTarget,
  host: NavigationHost,
): boolean {
  switch (target.kind) {
    case "item": {
      const pane = host.pane();
      return (
        typeof pane?.selectItems === "function" ||
        typeof pane?.selectItem === "function"
      );
    }
    case "note":
      return Boolean(target.itemKey) && typeof target.libraryID === "number";
    case "collection": {
      if (target.collectionId === undefined) return false;
      const tree = collectionTreeOf(host);
      return (
        typeof tree?.selectByID === "function" ||
        typeof tree?.selectCollection === "function"
      );
    }
    case "trash":
      return typeof collectionTreeOf(host)?.selectByID === "function";
    case "tag":
      return typeof host.pane()?.tagSelector?.handleTagSelected === "function";
    case "file":
      return Boolean(target.path);
    case "library":
      // A whole library is the trace's own subject, not a place to be sent.
      return false;
  }
}

/**
 * Take the reader to what a chip names, and say whether they got there.
 *
 * A visit that landed raises the library window, because the reader clicked
 * inside the panel and the object they asked for is in Zotero's own view. A
 * revealed file is the exception: it was opened in the desktop's own file
 * window, and raising Zotero would cover the very thing the reader asked for.
 */
export async function navigateToLibraryObject(
  target: NavigableTarget,
  host: NavigationHost,
): Promise<boolean> {
  const arrived = (reached: boolean): boolean => {
    if (reached) host.focusMainWindow();
    return reached;
  };
  switch (target.kind) {
    case "item": {
      const pane = host.pane();
      if (!pane) return false;
      // The item is selected where the reader is already looking: asking for
      // the library root would throw them out of the collection they had open
      // on every chip click. Zotero falls back to the root by itself when the
      // item is not in the current view.
      if (typeof pane.selectItems === "function") {
        const selected = await pane.selectItems([target.itemId], {
          inLibraryRoot: false,
        });
        if (selected !== false) return arrived(true);
      }
      if (typeof pane.selectItem === "function")
        return arrived(
          pane.selectItem(target.itemId, { inLibraryRoot: false }) !== false,
        );
      return false;
    }
    case "note": {
      if (!target.itemKey || typeof target.libraryID !== "number") return false;
      return arrived(
        await host.openNote({
          libraryID: target.libraryID,
          itemKey: target.itemKey,
        }),
      );
    }
    case "collection": {
      if (target.collectionId === undefined) return false;
      const tree = collectionTreeOf(host);
      // The collection tree is addressed by its own row ids: `C<id>` is the
      // collection, `T<library>` the library's trash. The tree answers `false`
      // for a row it no longer has, which is how a collection deleted since
      // the turn is told apart from one the reader was taken to.
      if (typeof tree?.selectByID === "function")
        return arrived(
          (await tree.selectByID(`C${target.collectionId}`)) !== false,
        );
      if (typeof tree?.selectCollection === "function")
        return arrived(
          (await tree.selectCollection(target.collectionId)) !== false,
        );
      return false;
    }
    case "trash": {
      const tree = collectionTreeOf(host);
      if (typeof tree?.selectByID !== "function") return false;
      const libraryID = target.libraryID ?? defaultLibraryID();
      if (libraryID === undefined) return false;
      return arrived((await tree.selectByID(`T${libraryID}`)) !== false);
    }
    case "tag": {
      const tagSelector = host.pane()?.tagSelector;
      if (typeof tagSelector?.handleTagSelected !== "function") return false;
      tagSelector.handleTagSelected(target.label);
      return arrived(true);
    }
    case "file":
      return host.revealFile(target.path);
    case "library":
      return false;
  }
}

/**
 * Make every chip in a card a way in.
 *
 * The card listens once for all of them: rows are built and rebuilt as the
 * trace lands, and a listener per chip would be a listener per render. A chip
 * click is the chip's alone — a row that folds open is a different gesture, so
 * the event stops here rather than reaching the disclosure it sits in.
 */
export function attachActionCardNavigation(
  card: HTMLElement,
  status: HTMLElement,
  host: NavigationHost,
): void {
  const activate = async (event: Event): Promise<void> => {
    const link = (event.target as HTMLElement | null)?.closest?.(
      ".llm-agent-action-link",
    ) as HTMLElement | null;
    const target = link ? navigationTargetOf(link) : null;
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      if (await navigateToLibraryObject(target, host)) return;
    } catch {
      /* The pane refused; the pill below says so. */
    }
    status.textContent = `${targetLabel(target)} is unavailable`;
    status.dataset.status = "error";
  };
  card.addEventListener("click", activate);
  card.addEventListener("keydown", (event) =>
    (event as KeyboardEvent).key === "Enter" ? activate(event) : undefined,
  );
}
