/**
 * A fake Zotero reader whose PDF.js FindController behaves like the real one
 * closely enough for page-native quote navigation: a find dispatch replaces
 * the query, reports matches on one page, and fires the progress events the
 * navigator waits for. `livePdfSelectionLocator.test.ts` drives the locator
 * with it directly; the citation-navigation characterization tests drive the
 * whole click path through it.
 *
 * As in Zotero's PDF.js, a new search marks the results dirty at once and
 * keeps the previous search's results until it runs, a moment later; it then
 * empties the same result list in place and fills it again. With
 * `readerRealm`, the reader also has PDF.js's find bar, and, as in the real
 * reader page, it cannot read a request object made outside it: such a
 * request reaches PDF.js empty and clears the results. Objects copied in with
 * the fixture's `cloneInto` (installed as the global the plugin uses), or
 * built by the find bar itself, are readable.
 */
import { assert } from "chai";

export type ExactFindControllerReaderParams = {
  pageItems: Array<Array<{ str: string; hasEOL?: boolean }>>;
  targetPageIndex: number;
  matchCount?: number;
  shouldMatch?: boolean;
  matchesQuery?: (query: string) => boolean;
  previousQuery?: string;
  delayedAcceptanceMs?: number;
  delayedResultsMs?: number;
  resultPageIndex?: number;
  ignoreFindAgain?: boolean;
  fingerprint?: string;
  /** Model the reader page's realm boundary, with PDF.js's find bar. */
  readerRealm?: boolean;
};

export type ExactFindControllerReaderFixture = {
  reader: any;
  /** Requests the plugin sent to PDF.js's event bus itself. */
  dispatched: Array<{ type: string; query: string }>;
  /** Requests PDF.js's find bar built from its own field. */
  findBarRequests: Array<{ type: string; query: string }>;
  findController: any;
  getListenerCount: () => number;
  setDelayedResultsMs: (delayMs: number | undefined) => void;
  /** With `readerRealm`: copies an object into the reader page. */
  cloneInto: (value: object, targetWindow: unknown) => any;
};

/** How long PDF.js waits after a typed search before it runs it (fake). */
const FAKE_FIND_DEBOUNCE_MS = 5;

export function createExactFindControllerReader(
  params: ExactFindControllerReaderParams,
): ExactFindControllerReaderFixture {
  const dispatched: Array<{ type: string; query: string }> = [];
  const findBarRequests: Array<{ type: string; query: string }> = [];
  const matchCount = params.matchCount ?? 1;
  const findController: any = {
    _rawQuery: params.previousQuery || "",
    _state: {
      query: params.previousQuery || "",
      phraseSearch: true,
    },
    _dirtyMatch: false,
    pageMatches: params.pageItems.map(() => []),
    _pendingFindMatches: new Set(),
    _pagesToSearch: 0,
    matchesCount: { total: 0 },
    selected: { pageIdx: 0, matchIdx: 0 },
  };
  const listeners = new Map<string, Set<() => void>>();
  const emit = (eventName: string): void => {
    for (const listener of listeners.get(eventName) || []) listener();
  };
  let delayedResultsMs = params.delayedResultsMs;
  const applySearch = (query: string): void => {
    // As in PDF.js, the request's query is the state at once; `_rawQuery`
    // follows only when the search runs.
    findController._state = {
      ...findController._state,
      query,
    };
    // The previous results stay until the search runs.
    findController._dirtyMatch = true;
    findController._pendingFindMatches = new Set([0]);
    findController._pagesToSearch = params.pageItems.length;
    const shouldMatch =
      query !== "" &&
      (params.matchesQuery?.(query) ?? params.shouldMatch !== false);
    const finishSearch = (): void => {
      if (findController._state.query !== query) return;
      // PDF.js empties the same list in place, then fills it again.
      findController._rawQuery = query;
      findController._dirtyMatch = false;
      const pageMatches = findController.pageMatches as number[][];
      pageMatches.length = 0;
      for (const _page of params.pageItems) pageMatches.push([]);
      findController.matchesCount = { total: 0 };
      findController.selected = { pageIdx: -1, matchIdx: -1 };
      const resultPageIndex = params.resultPageIndex ?? params.targetPageIndex;
      if (shouldMatch && query !== params.previousQuery) {
        pageMatches[resultPageIndex] = Array.from(
          { length: matchCount },
          (_value, index) => index,
        );
        findController.matchesCount = { total: matchCount };
        findController.selected = {
          pageIdx: resultPageIndex,
          matchIdx: 0,
        };
      }
      findController._pendingFindMatches = new Set();
      findController._pagesToSearch = 0;
      emit("updatefindmatchescount");
      emit("updatefindcontrolstate");
    };
    setTimeout(finishSearch, delayedResultsMs ?? FAKE_FIND_DEBOUNCE_MS);
  };
  // Objects of the reader page: built there, or copied in.
  const readerObjects = new WeakSet<object>();
  const readable = (value: unknown): Record<string, any> =>
    !params.readerRealm ||
    (value && typeof value === "object" && readerObjects.has(value))
      ? ((value || {}) as Record<string, any>)
      : {};
  const eventBus = {
    _on: (eventName: string, listener: () => void) => {
      const registered = listeners.get(eventName) || new Set<() => void>();
      registered.add(listener);
      listeners.set(eventName, registered);
    },
    _off: (eventName: string, listener: () => void) => {
      listeners.get(eventName)?.delete(listener);
    },
    dispatch: (eventName: string, request: unknown) =>
      deliver(eventName, request, dispatched),
  };
  function deliver(
    eventName: string,
    request: unknown,
    log: Array<{ type: string; query: string }>,
  ): void {
    if (eventName !== "find") return;
    const state = readable(request);
    const type = state.type || "";
    // As in PDF.js, a request without a query (or one PDF.js cannot read)
    // is an empty search.
    const query = typeof state.query === "string" ? state.query : "";
    log.push({ type, query });
    if (type === "again") {
      if (params.ignoreFindAgain) return;
      findController.selected = {
        pageIdx: params.targetPageIndex,
        matchIdx:
          (Number(findController.selected?.matchIdx || 0) + 1) % matchCount,
      };
      return;
    }
    applySearch(query);
  }
  class FakeInputEvent {
    constructor(_type: string, _init?: EventInit) {}
  }
  const readerWindow = {
    Event: FakeInputEvent,
    InputEvent: FakeInputEvent,
  };
  let findBar: any;
  if (params.delayedAcceptanceMs !== undefined || params.readerRealm) {
    const findField: any = {
      value: params.previousQuery || "",
      ownerDocument: {
        defaultView: readerWindow,
      },
      dispatchEvent: () => {
        const query = findField.value;
        // The find bar builds its request in the reader page.
        const send = () => {
          const request = { type: "", query };
          readerObjects.add(request);
          deliver("find", request, findBarRequests);
        };
        if (params.delayedAcceptanceMs !== undefined) {
          setTimeout(send, params.delayedAcceptanceMs);
        } else {
          send();
        }
        return true;
      },
    };
    findBar = {
      opened: false,
      open: () => {
        findBar.opened = true;
      },
      close: () => {
        findBar.opened = false;
      },
      // PDFFindBar.dispatchEvent: a request built from its own field.
      dispatchEvent: (type: string, findPrevious = false) => {
        const request = {
          source: findBar,
          type,
          query: findField.value,
          findPrevious,
        };
        readerObjects.add(request);
        deliver("find", request, findBarRequests);
      },
      findField,
      _findField: findField,
    };
  }
  const app = {
    pdfDocument: {
      numPages: params.pageItems.length,
      fingerprints: [params.fingerprint || "test-pdf"],
      getPage: async (pageNumber: number) => ({
        getTextContent: async (options: { disableNormalization?: boolean }) => {
          assert.isTrue(options.disableNormalization);
          return { items: params.pageItems[pageNumber - 1] || [] };
        },
      }),
    },
    pagesCount: params.pageItems.length,
    page: params.targetPageIndex + 1,
    eventBus,
    findBar,
    findController,
  };
  return {
    reader: {
      _window: {
        PDFViewerApplication: app,
      },
    },
    dispatched,
    findBarRequests,
    findController,
    getListenerCount: () =>
      Array.from(listeners.values()).reduce(
        (total, registered) => total + registered.size,
        0,
      ),
    setDelayedResultsMs: (delayMs) => {
      delayedResultsMs = delayMs;
    },
    cloneInto: (value, targetWindow) => {
      const copy = { ...(value as Record<string, unknown>) };
      if (targetWindow === readerWindow) readerObjects.add(copy);
      return copy;
    },
  };
}
