import { assert } from "chai";
import type {
  FormattedCitationCluster,
  PlanDocument,
} from "../src/agent/documents/types";
import { scheduleCitationStyleRegistryRepair } from "../src/modules/contextPanel/planDocumentPresentation";
import { setAppLogSinkForTests } from "../src/core/logging";

/**
 * Zotero loads its citation style registry a few seconds after the app is
 * usable, so a persisted document rendered during that window shows its
 * grouped citations raw. The display repair re-renders once the registry is
 * ready — without re-rendering forever when it never becomes ready.
 */
describe("document citation style registry repair", function () {
  const scope = globalThis as typeof globalThis & { Zotero?: any };
  const original = scope.Zotero;
  const logged: unknown[][] = [];

  const source = (itemKey: string) => ({
    libraryID: 3,
    itemKey,
    evidenceRefs: ["evidence"],
  });

  const documentWith = (
    clusters: readonly FormattedCitationCluster[],
  ): PlanDocument => ({
    version: 2,
    documentId: "document-test",
    documentVersion: 1,
    documentKind: "custom",
    integrityPolicy: "research_grounded",
    origin: { kind: "direct", runId: "run", sourceMessageTimestamp: 123 },
    conversationKey: 10,
    title: "Document",
    visibleMarkdown: "Evidence [c1].",
    visibleHtml: "",
    citationBundle: {
      clusters,
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
      quoteVerified: "not_applicable",
      issues: [],
    },
    contentHash: "unchanged",
    createdAt: 123,
  });

  const grouped = () =>
    documentWith([
      {
        citationId: "c1",
        text: "(Alpha, 2020; Beta, 2021)",
        html: "",
        sources: [source("ALPHAKEY"), source("BETAKEY0")],
      },
    ]);

  const single = () =>
    documentWith([
      {
        citationId: "c1",
        text: "(Alpha, 2020)",
        html: "",
        sources: [source("ALPHAKEY")],
      },
    ]);

  let initCalls: number;
  let resolveInit: () => void;
  let rejectInit: (error: Error) => void;

  function install(styles: unknown) {
    initCalls = 0;
    scope.Zotero = { Styles: styles };
  }

  function coldRegistry(options: { reject?: boolean } = {}) {
    install({
      initialized: () => false,
      init: () => {
        initCalls += 1;
        return new Promise<void>((resolve, reject) => {
          resolveInit = resolve;
          rejectInit = () => reject(new Error("registry unavailable"));
          if (options.reject) rejectInit(new Error("registry unavailable"));
        });
      },
    });
  }

  const flush = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  };

  beforeEach(function () {
    logged.length = 0;
    initCalls = 0;
    setAppLogSinkForTests((_level, args) => logged.push([...args]));
  });

  afterEach(function () {
    scope.Zotero = original;
    setAppLogSinkForTests(null);
  });

  it("leaves a document without a grouped citation alone", function () {
    coldRegistry();
    let rerendered = 0;
    assert.isFalse(
      scheduleCitationStyleRegistryRepair({
        document: single(),
        root: { isConnected: true },
        rerender: () => {
          rerendered += 1;
        },
      }),
    );
    assert.equal(initCalls, 0);
    assert.equal(rerendered, 0);
  });

  it("does nothing when the style registry is already loaded", function () {
    install({
      initialized: () => true,
      init: () => {
        initCalls += 1;
        return Promise.resolve();
      },
    });
    assert.isFalse(
      scheduleCitationStyleRegistryRepair({
        document: grouped(),
        root: { isConnected: true },
        rerender: () => assert.fail("must not re-render a loaded registry"),
      }),
    );
    assert.equal(initCalls, 0);
  });

  it("does nothing when the registry cannot be initialized at all", function () {
    install({ initialized: () => false });
    assert.isFalse(
      scheduleCitationStyleRegistryRepair({
        document: grouped(),
        root: { isConnected: true },
        rerender: () => assert.fail("must not re-render without init()"),
      }),
    );
  });

  it("re-renders a grouped citation once, only after the registry loads", async function () {
    coldRegistry();
    let rerendered = 0;
    assert.isTrue(
      scheduleCitationStyleRegistryRepair({
        document: grouped(),
        root: { isConnected: true },
        rerender: () => {
          rerendered += 1;
        },
      }),
    );
    assert.equal(initCalls, 1);
    assert.equal(rerendered, 0, "must not re-render before init resolves");
    resolveInit();
    await flush();
    assert.equal(rerendered, 1);
    assert.equal(initCalls, 1);
  });

  it("does not re-render into a root that is no longer connected", async function () {
    coldRegistry();
    const root = { isConnected: true };
    let rerendered = 0;
    assert.isTrue(
      scheduleCitationStyleRegistryRepair({
        document: grouped(),
        root,
        rerender: () => {
          rerendered += 1;
        },
      }),
    );
    root.isConnected = false;
    resolveInit();
    await flush();
    assert.equal(rerendered, 0);
  });

  it("never re-renders forever when the registry stays cold", async function () {
    coldRegistry();
    const root = { isConnected: true };
    let rerendered = 0;
    const params = {
      document: grouped(),
      root,
      // The live caller re-enters this helper through its own render path.
      rerender: () => {
        rerendered += 1;
        scheduleCitationStyleRegistryRepair(params);
      },
    };
    assert.isTrue(scheduleCitationStyleRegistryRepair(params));
    resolveInit();
    await flush();
    assert.equal(rerendered, 1);
    assert.equal(initCalls, 1);
  });

  it("reports a failed registry load without throwing", async function () {
    coldRegistry({ reject: true });
    let rerendered = 0;
    assert.isTrue(
      scheduleCitationStyleRegistryRepair({
        document: grouped(),
        root: { isConnected: true },
        rerender: () => {
          rerendered += 1;
        },
      }),
    );
    await flush();
    assert.equal(rerendered, 0);
    assert.equal(
      logged[0]?.[0],
      "LLM document citation group display repair unavailable",
    );
  });
});
