import { assert } from "chai";
import type { PlanDocument } from "../src/agent/documents/types";
import { decoratePlanDocumentCitations } from "../src/modules/contextPanel/planDocumentPresentation";

type ClickListener = (event: {
  preventDefault: () => void;
  stopPropagation: () => void;
}) => void;

describe("plan document citation navigation marker", function () {
  const scope = globalThis as typeof globalThis & { Zotero?: any };
  const original = scope.Zotero;
  const sourceHref = "zotero://select/library/items/SRCKEY00";
  const item = { id: 42, key: "SRCKEY00", libraryID: 3 };

  const makeAnchor = () => {
    const attributes = new Map<string, string>([["href", sourceHref]]);
    const listeners: ClickListener[] = [];
    return {
      dataset: {} as Record<string, string>,
      title: "",
      textContent: "(Fixture, 2024)",
      getAttribute: (name: string) => attributes.get(name) ?? null,
      setAttribute: (name: string, value: string) =>
        void attributes.set(name, value),
      addEventListener: (type: string, listener: ClickListener) => {
        if (type === "click") listeners.push(listener);
      },
      click: () => {
        for (const listener of listeners)
          listener({ preventDefault: () => {}, stopPropagation: () => {} });
      },
      listeners,
    };
  };

  const fixture = (): PlanDocument => ({
    version: 2,
    documentId: "document-test",
    documentVersion: 1,
    documentKind: "custom",
    integrityPolicy: "research_grounded",
    origin: { kind: "direct", runId: "run", sourceMessageTimestamp: 123 },
    conversationKey: 42,
    title: "Document",
    visibleMarkdown: "Body [(Fixture, 2024)](" + sourceHref + ")",
    visibleHtml: "",
    citationBundle: {
      clusters: [
        {
          citationId: "C1",
          text: "(Fixture, 2024)",
          html: "(Fixture, 2024)",
          sources: [
            { libraryID: 3, itemKey: "SRCKEY00", evidenceRefs: ["evidence"] },
          ],
        },
      ],
      bibliographyEntries: [],
      style: { id: "apa", title: "APA" },
      locale: "en-US",
    },
    verifiedQuotes: [],
    assets: [],
    coverageItems: [],
    validation: {
      integrityValidated: true,
      groundingReviewed: "passed",
      quoteVerified: "verified",
      issues: [],
    },
    contentHash: "unchanged",
    createdAt: 123,
  });

  let focusCalls = 0;
  let resolveSelect: (value: unknown) => void = () => {};
  let selectItemIds: number[] = [];

  beforeEach(function () {
    focusCalls = 0;
    selectItemIds = [];
    const selectPromise = new Promise((resolve) => {
      resolveSelect = resolve;
    });
    scope.Zotero = {
      Items: {
        get: (id: number) => (id === item.id ? item : null),
        getByLibraryAndKey: (library: number, key: string) =>
          library === 3 && key === item.key ? item : null,
      },
      Libraries: {
        userLibraryID: 3,
        get: () => null,
      },
      getMainWindow: () => ({ focus: () => void focusCalls++ }),
      getActiveZoteroPane: () => ({
        selectItems: (ids: number[]) => {
          selectItemIds = ids;
          return selectPromise;
        },
      }),
    };
  });

  afterEach(function () {
    scope.Zotero = original;
  });

  it("marks a citation link busy until the source window has been revealed", async function () {
    const anchor = makeAnchor();
    const root = {
      querySelectorAll: (selector: string) =>
        selector === "a" ? [anchor] : [],
    };
    decoratePlanDocumentCitations({
      doc: {} as any,
      root: root as any,
      document: fixture(),
    });
    assert.equal(anchor.dataset.llmPlanCitationSource, "true");
    assert.lengthOf(anchor.listeners, 1);

    anchor.click();
    assert.equal(
      anchor.dataset.loading,
      "true",
      "the click must mark navigation in flight before it awaits Zotero",
    );
    assert.equal(focusCalls, 0);

    resolveSelect(true);
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(selectItemIds, [42]);
    assert.equal(
      anchor.dataset.loading,
      "false",
      "the marker must clear only after navigation settles",
    );
    assert.equal(focusCalls, 1);
  });
});
