import { assert } from "chai";
import { createLiteratureSearchTool } from "../src/agent/tools/read/literatureSearch";
import type { AgentToolContext } from "../src/agent/types";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";

describe("literature_search tool", function () {
  const baseContext: AgentToolContext = {
    runId: "search-tool-test",
    request: resolvedAgentRequest({
      conversationKey: 11,
      mode: "agent",
      userText: "Explain the evidence on this topic using scholarly sources",
      libraryID: 1,
    }),
    item: null,
    currentAnswerText: "",
    modelName: "gpt-5.4",
  };

  const originalFetch = (
    globalThis as typeof globalThis & { fetch?: typeof fetch }
  ).fetch;

  afterEach(function () {
    (globalThis as typeof globalThis & { fetch?: typeof fetch }).fetch =
      originalFetch;
  });

  it("says its metadata mode proposes changes to approve, and reading a paper uses answer", function () {
    const tool = createLiteratureSearchTool({} as never);
    // A literature review once called workflow:'review' to read an abstract
    // and waited on a metadata-change card nobody asked for.
    assert.include(
      tool.spec.description,
      "To read a paper's abstract or details, use workflow:'answer'; workflow:'review' with mode:'metadata' proposes metadata changes the user must approve, so use it only when the user asks to check or fix an item's metadata.",
    );
  });

  it("supports metadata lookups through the unified online tool", async function () {
    const crossRefItem = {
      DOI: "10.1000/example",
      title: ["Example Title"],
      author: [{ given: "Alice", family: "Example" }],
      "container-title": ["Journal"],
      URL: "https://doi.org/10.1000/example",
    };
    const s2Item = {
      title: "Example Title",
      authors: [{ name: "Alice Example" }],
      year: 2024,
      abstract: "Abstract",
      venue: "Journal",
      citationCount: 12,
      externalIds: { DOI: "10.1000/example" },
    };
    (globalThis as typeof globalThis & { fetch?: typeof fetch }).fetch =
      (async (url: string | URL | Request) => {
        const href = String(url);
        // Title search (used by resolveIdentifier)
        if (href.includes("api.crossref.org/works?query.bibliographic")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ message: { items: [crossRefItem] } }),
          } as Response;
        }
        // DOI lookup (used by supplement phase)
        if (href.includes("api.crossref.org/works/10.1000")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ message: crossRefItem }),
          } as Response;
        }
        // Semantic Scholar DOI or title search
        if (href.includes("api.semanticscholar.org")) {
          return {
            ok: true,
            status: 200,
            json: async () =>
              href.includes("/search") ? { data: [s2Item] } : s2Item,
          } as Response;
        }
        throw new Error(`Unexpected URL: ${href}`);
      }) as typeof fetch;

    const tool = createLiteratureSearchTool({
      resolveMetadataItem: () => null,
      getEditableArticleMetadata: () => null,
      fetchMetadataByIdentifier: async () => null,
    } as never);
    const validated = tool.validate({
      mode: "metadata",
      title: "Example Title",
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;
    assert.equal(validated.value.workflow, "answer");

    const result = await tool.execute(validated.value, baseContext);
    assert.equal((result as { mode: string }).mode, "metadata");
    assert.equal((result as { workflow: string }).workflow, "answer");
    assert.lengthOf((result as { results: unknown[] }).results, 2);
  });

  it("resolves metadata lookups from the current Zotero item when only item context is provided", async function () {
    (globalThis as typeof globalThis & { fetch?: typeof fetch }).fetch =
      (async (url: string | URL | Request) => {
        const href = String(url);
        if (href.includes("api.crossref.org/works/10.1000%2Fexample")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              message: {
                DOI: "10.1000/example",
                title: ["Example Title"],
                author: [{ given: "Alice", family: "Example" }],
                "container-title": ["Journal"],
                URL: "https://doi.org/10.1000/example",
              },
            }),
          } as Response;
        }
        if (
          href.includes(
            "api.semanticscholar.org/graph/v1/paper/DOI:10.1000%2Fexample",
          )
        ) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              title: "Example Title",
              authors: [{ name: "Alice Example" }],
              year: 2024,
              abstract: "Abstract",
              venue: "Journal",
              citationCount: 12,
              externalIds: { DOI: "10.1000/example" },
            }),
          } as Response;
        }
        throw new Error(`Unexpected URL: ${href}`);
      }) as typeof fetch;

    const item = { id: 7 } as any;
    const tool = createLiteratureSearchTool({
      resolveMetadataItem: () => item,
      getEditableArticleMetadata: () =>
        ({
          title: "Existing Title",
          fields: { DOI: "10.1000/example" },
        }) as any,
      fetchMetadataByIdentifier: async () => null,
    } as never);
    const validated = tool.validate({
      mode: "metadata",
      itemId: 7,
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;

    const result = await tool.execute(validated.value, baseContext);
    assert.equal((result as { workflow: string }).workflow, "answer");
    assert.equal((result as { mode: string }).mode, "metadata");
    assert.lengthOf((result as { results: unknown[] }).results, 2);
  });

  it("supports live search mode through the unified online tool", async function () {
    (globalThis as typeof globalThis & { fetch?: typeof fetch }).fetch =
      (async (url: string | URL | Request) => {
        const href = String(url);
        if (href.includes("api.openalex.org/works?search=")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              results: [
                {
                  id: "https://openalex.org/W123",
                  display_name: "Related Paper",
                  authorships: [
                    { author: { display_name: "Bob Example" } },
                    { author: { display_name: "Riley Example" } },
                  ],
                  publication_year: 2025,
                  cited_by_count: 4,
                  doi: "https://doi.org/10.1000/related",
                  open_access: { oa_url: "https://example.com/paper.pdf" },
                },
              ],
            }),
          } as Response;
        }
        throw new Error(`Unexpected URL: ${href}`);
      }) as typeof fetch;

    const tool = createLiteratureSearchTool({
      resolveMetadataItem: () => null,
      getEditableArticleMetadata: () => null,
    } as never);
    const validated = tool.validate({
      mode: "search",
      source: "openalex",
      query: "neural networks",
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;

    const result = await tool.execute(validated.value, baseContext);
    const results = (result as { results: Array<Record<string, unknown>> })
      .results;
    assert.equal((result as { workflow: string }).workflow, "answer");
    assert.lengthOf(results, 1);
    assert.equal(results[0].title, "Related Paper");
    assert.equal(results[0].doi, "10.1000/related");
    assert.equal(tool.presentation?.traceIcon, "library");
    assert.isTrue(tool.presentation?.mergeResultIntoCallTrace);
    assert.deepEqual(
      tool.presentation?.buildTraceDetails?.({
        args: validated.value,
        content: result,
      }),
      [
        { label: "Query", value: "neural networks" },
        {
          label: "Paper",
          value: "Bob Example et al., 2025, Related Paper",
          timeline: {
            icon: "paper",
            href: "https://example.com/paper.pdf",
          },
        },
      ],
    );
    const reviewAction = await tool.createResultReviewAction?.(
      validated.value,
      {
        callId: "call-search",
        name: "literature_search",
        ok: true,
        content: result,
      },
      baseContext,
    );
    assert.isNull(reviewAction);
  });

  it("returns saved candidate references even when discovery asks for review", async function () {
    (globalThis as typeof globalThis & { fetch?: typeof fetch }).fetch =
      (async (url: string | URL | Request) => {
        const href = String(url);
        if (href.includes("api.openalex.org/works?search=")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              results: [
                {
                  id: "https://openalex.org/W456",
                  display_name: "Reviewable Paper",
                  authorships: [{ author: { display_name: "Riley Example" } }],
                  publication_year: 2024,
                  cited_by_count: 8,
                  doi: "https://doi.org/10.1000/reviewable",
                  open_access: { oa_url: "https://example.com/reviewable.pdf" },
                },
              ],
            }),
          } as Response;
        }
        throw new Error(`Unexpected URL: ${href}`);
      }) as typeof fetch;

    const tool = createLiteratureSearchTool({
      resolveMetadataItem: () => null,
      getEditableArticleMetadata: () => null,
    } as never);
    const validated = tool.validate({
      workflow: "review",
      mode: "search",
      source: "openalex",
      query: "reviewable papers",
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;

    const result = await tool.execute(validated.value, baseContext);
    assert.equal((result as { workflow: string }).workflow, "answer");
    const reviewAction = await tool.createResultReviewAction?.(
      validated.value,
      {
        callId: "call-search",
        name: "literature_search",
        ok: true,
        content: result,
      },
      baseContext,
    );
    assert.isNull(reviewAction);
    assert.isString((result as { candidateSetId: string }).candidateSetId);
  });
});
