/**
 * Fake-gateway rig for LibraryRetrieveService tests. The item, PDF-context
 * and gateway fakes are copied from test/libraryRetrieveService.test.ts so
 * later library-index tasks can build a service without importing that file.
 */
import { LibraryRetrieveService as ResolvedLibraryRetrieveService } from "../../src/agent/services/libraryRetrieveService";
import type {
  EditableArticleMetadataSnapshot,
  LibraryItemTarget,
} from "../../src/agent/services/zoteroGateway";
import type {
  PaperContextCandidate,
  PdfContext,
} from "../../src/services/paperContent/types";
import type { PaperContextRef } from "../../src/shared/types";
import type { LibraryTextIndexFacade } from "../../src/services/libraryTextIndex";
import { resolvedAgentRequest } from "./resolvedAgentRequest";

export function makeItem(
  itemId: number,
  title: string,
  abstractNote = "",
  options: {
    hasPdf?: boolean;
    collectionIds?: number[];
    tags?: string[];
    contextItemId?: number;
  } = {},
): {
  target: LibraryItemTarget;
  metadata: EditableArticleMetadataSnapshot;
  paperContext: PaperContextRef | null;
} {
  const hasPdf = options.hasPdf !== false;
  const contextItemId = options.contextItemId ?? 1000 + itemId;
  return {
    target: {
      itemId,
      itemType: "journalArticle",
      title,
      firstCreator: "Smith",
      year: "2024",
      attachments: hasPdf
        ? [
            {
              contextItemId,
              title: "PDF",
              contentType: "application/pdf",
            },
          ]
        : [],
      tags: options.tags || [],
      collectionIds: options.collectionIds || [],
    },
    metadata: {
      itemId,
      itemType: "journalArticle",
      title,
      fields: {
        title,
        shortTitle: "",
        abstractNote,
        publicationTitle: "",
        journalAbbreviation: "",
        proceedingsTitle: "",
        date: "2024",
        volume: "",
        issue: "",
        pages: "",
        DOI: "",
        url: "",
        language: "",
        extra: "",
        ISSN: "",
        ISBN: "",
        publisher: "",
        place: "",
      },
      creators: [
        {
          creatorType: "author",
          firstName: "Ada",
          lastName: "Smith",
        },
      ],
    },
    paperContext: hasPdf
      ? {
          itemId,
          contextItemId,
          title,
          firstCreator: "Smith",
          year: "2024",
        }
      : null,
  };
}

export function makePdfContext(chunks: string[]): PdfContext {
  return {
    title: "PDF",
    chunks,
    chunkMeta: chunks.map((chunk, index) => ({
      chunkIndex: index,
      text: chunk,
      normalizedText: chunk,
      chunkKind: index === 0 ? "abstract" : "body",
      sectionLabel: index === 0 ? "Abstract" : "Methods",
    })),
    chunkStats: chunks.map((chunk, index) => ({
      index,
      tf: {},
      uniqueTerms: [],
      length: chunk.split(/\s+/).length,
    })),
    docFreq: {},
    avgChunkLength: chunks.length
      ? chunks.join(" ").split(/\s+/).length / chunks.length
      : 0,
    fullLength: chunks.join("\n\n").length,
    sourceType: "zotero-fulltext-cache",
  };
}

export function makeGateway(
  entries: ReturnType<typeof makeItem>[],
  options: {
    collectionItems?: ReturnType<typeof makeItem>[];
    quicksearchItemIds?: number[] | ((query: string | undefined) => number[]);
    quicksearchCalls?: Array<{
      limit?: number;
      query?: string;
      filters?: Record<string, unknown>;
      allowedItemIds?: number[];
    }>;
  } = {},
) {
  const byItemId = new Map(
    entries.map((entry) => [entry.target.itemId, entry]),
  );
  const collectionItems = options.collectionItems || entries;
  return {
    resolveLibraryID: () => 1,
    getItem: (itemId: number | undefined) =>
      itemId ? ({ id: itemId } as Zotero.Item) : null,
    getEditableArticleMetadata: (item: Zotero.Item | null | undefined) =>
      item ? byItemId.get((item as { id: number }).id)?.metadata || null : null,
    resolvePaperContextTarget: ({ itemId }: { itemId?: number }) =>
      itemId ? byItemId.get(itemId)?.paperContext || null : null,
    getCollectionSummary: (collectionId: number | undefined) =>
      collectionId
        ? {
            collectionId,
            name: `Collection ${collectionId}`,
            libraryID: 1,
            path: `Root / Collection ${collectionId}`,
          }
        : null,
    listBibliographicItemTargets: async ({ limit }: { limit?: number }) => ({
      items: entries
        .map((entry) => entry.target)
        .slice(0, limit || entries.length),
      totalCount: entries.length,
    }),
    listCollectionItemTargets: async ({
      collectionId,
      limit,
    }: {
      collectionId: number;
      limit?: number;
    }) => ({
      collection: {
        collectionId,
        name: `Collection ${collectionId}`,
        libraryID: 1,
        path: `Root / Collection ${collectionId}`,
      },
      items: collectionItems
        .map((entry) => entry.target)
        .slice(0, limit || collectionItems.length),
      totalCount: collectionItems.length,
    }),
    listTagItemTargets: async ({
      tagContext,
      limit,
    }: {
      tagContext: {
        name: string;
        normalizedName?: string;
        scope?: "allTagged" | "untagged";
      };
      limit?: number;
    }) => {
      const normalizedName = (
        tagContext.normalizedName || tagContext.name
      ).toLowerCase();
      const tagItems = entries.filter((entry) => {
        if (tagContext.scope === "allTagged") {
          return entry.target.tags.length > 0;
        }
        if (tagContext.scope === "untagged") {
          return entry.target.tags.length === 0;
        }
        return entry.target.tags.some(
          (tag) =>
            tag === tagContext.name || tag.toLowerCase() === normalizedName,
        );
      });
      return {
        tagName: tagContext.name,
        items: tagItems
          .map((entry) => entry.target)
          .slice(0, limit || tagItems.length),
        totalCount: tagItems.length,
      };
    },
    resolveLibraryScopeItemIds: async ({
      itemIds = [],
      collectionIds = [],
      tagContexts = [],
    }: {
      itemIds?: number[];
      collectionIds?: number[];
      tagContexts?: Array<{
        name: string;
        normalizedName?: string;
        scope?: "allTagged" | "untagged";
      }>;
    }) => {
      const union = new Set<number>();
      const tagItemIds = new Set<number>();
      let summedScopeCount = 0;
      const add = (
        scopedEntries: ReturnType<typeof makeItem>[],
        tagScope = false,
      ) => {
        for (const entry of scopedEntries) {
          union.add(entry.target.itemId);
          if (tagScope) tagItemIds.add(entry.target.itemId);
        }
        return scopedEntries.length;
      };

      add(
        itemIds
          .map((itemId) => byItemId.get(itemId))
          .filter((entry): entry is ReturnType<typeof makeItem> =>
            Boolean(entry),
          ),
      );

      const collectionNames: string[] = [];
      for (const collectionId of collectionIds) {
        collectionNames.push(`Root / Collection ${collectionId}`);
        const matches = collectionItems.filter((entry) =>
          entry.target.collectionIds.includes(collectionId),
        );
        summedScopeCount += add(matches);
      }

      const tagNames: string[] = [];
      for (const tagContext of tagContexts) {
        tagNames.push(tagContext.name);
        const normalizedName = (
          tagContext.normalizedName || tagContext.name
        ).toLowerCase();
        const matches = entries.filter((entry) => {
          if (tagContext.scope === "allTagged") {
            return entry.target.tags.length > 0;
          }
          if (tagContext.scope === "untagged") {
            return entry.target.tags.length === 0;
          }
          return entry.target.tags.some(
            (tag) =>
              tag === tagContext.name || tag.toLowerCase() === normalizedName,
          );
        });
        summedScopeCount += add(matches, true);
      }

      return {
        itemIds: [...union],
        tagItemIds: [...tagItemIds],
        collectionNames,
        tagNames,
        summedScopeCount,
      };
    },
    getBibliographicItemTargetsByItemIds: (itemIds: number[]) =>
      itemIds
        .map((itemId) => byItemId.get(itemId)?.target)
        .filter((entry): entry is LibraryItemTarget => Boolean(entry)),
    searchAllLibraryItems: async (params: {
      limit?: number;
      query?: string;
      filters?: Record<string, unknown>;
      allowedItemIds?: number[];
    }) => {
      options.quicksearchCalls?.push(params);
      const quicksearchIds =
        typeof options.quicksearchItemIds === "function"
          ? options.quicksearchItemIds(params.query)
          : options.quicksearchItemIds || [];
      const allowedItemIds = Array.isArray(params.allowedItemIds)
        ? new Set(params.allowedItemIds)
        : null;
      const tagFilter =
        typeof params.filters?.tag === "string" ? params.filters.tag : "";
      const collectionFilter =
        typeof params.filters?.collectionId === "number"
          ? params.filters.collectionId
          : 0;
      const matches = quicksearchIds
        .map((itemId) => byItemId.get(itemId)?.target)
        .filter((entry): entry is LibraryItemTarget => Boolean(entry))
        .filter((entry) =>
          allowedItemIds ? allowedItemIds.has(entry.itemId) : true,
        )
        .filter((entry) =>
          collectionFilter
            ? entry.collectionIds.includes(collectionFilter)
            : true,
        )
        .filter((entry) => (tagFilter ? entry.tags.includes(tagFilter) : true));
      const limit = params.limit || matches.length;
      return {
        items: matches.slice(0, limit),
        totalCount: matches.length,
      };
    },
  };
}

/**
 * Resolves a raw request the same way Agent dispatch does, and leaves an
 * absent request absent (the workflow bench calls retrieve without one).
 */
export class RigLibraryRetrieveService extends ResolvedLibraryRetrieveService {
  override retrieve(
    params: Parameters<ResolvedLibraryRetrieveService["retrieve"]>[0],
  ): ReturnType<ResolvedLibraryRetrieveService["retrieve"]> {
    return super.retrieve(
      params.request
        ? { ...params, request: resolvedAgentRequest(params.request) }
        : params,
    );
  }
}

type CandidateBuilder = NonNullable<
  ConstructorParameters<typeof ResolvedLibraryRetrieveService>[2]
>;
type ProbeReformulator = NonNullable<
  ConstructorParameters<typeof ResolvedLibraryRetrieveService>[3]
>;
type Triage = NonNullable<
  ConstructorParameters<typeof ResolvedLibraryRetrieveService>[4]
>;
type QueryEmbedder = NonNullable<
  ConstructorParameters<typeof ResolvedLibraryRetrieveService>[6]
>;
type CandidateBuildOptions = NonNullable<Parameters<CandidateBuilder>[4]>;
type CandidateBuildApiOverrides = NonNullable<Parameters<CandidateBuilder>[3]>;

export type CandidateBuildCall = {
  itemId: number;
  question: string;
  apiOverrides: CandidateBuildApiOverrides;
  options: CandidateBuildOptions;
};

export type RetrieveServiceRig = {
  service: RigLibraryRetrieveService;
  entries: ReturnType<typeof makeItem>[];
  candidateBuilderCalls: number[];
  quicksearchCalls: () => number;
  ensurePaperContextCalls: () => number;
  triageCalls: () => number;
  reformulationCalls: () => number;
  /** Query-embedding requests the fake embedder answered. */
  embeddingCalls: () => number;
  /** Every candidate-builder call with both of its option objects. */
  candidateBuildCalls: () => CandidateBuildCall[];
  /** Highest number of quicksearch calls in flight at once. */
  maxConcurrentQuicksearch: () => number;
  /** Quicksearch queries in the order they were issued. */
  quicksearchQueries: () => string[];
};

export type RetrieveServiceRigOptions = {
  papers?: number;
  /** Defaults to a disabled index, so the rig keeps today's direct path. */
  textIndex?: LibraryTextIndexFacade;
  /** Variants the fake reformulator returns, one list per round. */
  reformulations?: string[][];
  /**
   * Passes model credentials into `retrieve` so `hasModelConfig` is true.
   * Defaults to true when `reformulations` are scripted.
   */
  modelConfigured?: boolean;
  /**
   * Titles and abstracts that do not mention "method", so the first
   * lexical pass is weak and the probe-reformulation loop runs.
   */
  unmatchedMetadata?: boolean;
  /** What the fake triage returns (default null: keep lexical ranking). */
  triageResult?: Awaited<ReturnType<Triage>>;
  /** Whether the fake embedder reports semantic search on (default false). */
  semantic?: boolean;
  /** Vector the fake embedder returns for the query (default [1, 0]). */
  queryEmbedding?: number[];
  /** Makes the fake embedder reject, like a provider that times out. */
  queryEmbeddingFails?: boolean;
  /** Delay before each fake quicksearch answers, fixed or per query. */
  quicksearchDelayMs?: number | ((query: string) => number);
  /** Item ids each fake quicksearch query matches (default none). */
  quicksearchItemIds?: (query: string | undefined) => number[];
};

const DISABLED_TEXT_INDEX: LibraryTextIndexFacade = {
  isEnabled: () => false,
  search: async () => null,
  leadingChunks: async () => null,
};

/**
 * Builds a service over `papers` PDF-backed items (item ids 10, 20, 30...,
 * attachment ids 11, 21, 31...) whose titles, abstracts (unless
 * `unmatchedMetadata`) and chunks all mention "method", with a candidate builder that returns two evidence
 * chunks per paper.
 */
export function createRetrieveServiceRig(
  options: RetrieveServiceRigOptions = {},
): RetrieveServiceRig {
  const count = Math.max(0, Math.floor(options.papers ?? 2));
  const entries = Array.from({ length: count }, (_, index) => {
    const itemId = (index + 1) * 10;
    return makeItem(
      itemId,
      options.unmatchedMetadata
        ? `Paper ${index + 1}`
        : `Method paper ${index + 1}`,
      options.unmatchedMetadata
        ? "This paper describes a procedure."
        : "This paper describes a method.",
      { hasPdf: true, contextItemId: itemId + 1 },
    );
  });
  const candidateBuilderCalls: number[] = [];
  const candidateBuildCalls: CandidateBuildCall[] = [];
  const candidateBuilder: CandidateBuilder = async (
    paperContext,
    _pdfContext,
    question,
    apiOverrides,
    buildOptions,
  ): Promise<PaperContextCandidate[]> => {
    candidateBuilderCalls.push(paperContext.itemId);
    candidateBuildCalls.push({
      itemId: paperContext.itemId,
      question,
      apiOverrides: (apiOverrides || {}) as CandidateBuildApiOverrides,
      options: (buildOptions || {}) as CandidateBuildOptions,
    });
    return [0, 1].map((index) => ({
      paperKey: `${paperContext.itemId}:${paperContext.contextItemId}`,
      itemId: paperContext.itemId,
      contextItemId: paperContext.contextItemId,
      title: paperContext.title,
      chunkIndex: index,
      chunkText: `Chunk ${index} explains the method of ${paperContext.title}.`,
      chunkKind: "methods",
      estimatedTokens: 10,
      bm25Score: 1,
      embeddingScore: 0,
      hybridScore: 1,
      evidenceScore: 1 - index * 0.1,
    }));
  };
  const gatewayQuicksearchCalls: unknown[] = [];
  let ensurePaperContextCount = 0;
  let triageCount = 0;
  let reformulationCount = 0;
  const reformulations = options.reformulations || [];
  const probeReformulator: ProbeReformulator = async () => {
    const variants = reformulations[reformulationCount] || [];
    reformulationCount += 1;
    return { variants, notes: [] };
  };
  const triage: Triage = async () => {
    triageCount += 1;
    return options.triageResult ?? null;
  };
  let embeddingCount = 0;
  const queryEmbedder: QueryEmbedder = {
    isEnabled: () => options.semantic === true,
    embed: async () => {
      embeddingCount += 1;
      if (options.queryEmbeddingFails) {
        throw new Error("Embedding request timed out after 30000 ms");
      }
      return options.queryEmbedding || [1, 0];
    },
  };
  const gateway = makeGateway(entries, {
    quicksearchCalls: gatewayQuicksearchCalls as Array<{ query?: string }>,
    quicksearchItemIds: options.quicksearchItemIds,
  });
  let inFlightQuicksearch = 0;
  let maxInFlightQuicksearch = 0;
  const searchAllLibraryItems = gateway.searchAllLibraryItems;
  gateway.searchAllLibraryItems = async (params) => {
    inFlightQuicksearch += 1;
    maxInFlightQuicksearch = Math.max(
      maxInFlightQuicksearch,
      inFlightQuicksearch,
    );
    try {
      const delay =
        typeof options.quicksearchDelayMs === "function"
          ? options.quicksearchDelayMs(params.query || "")
          : options.quicksearchDelayMs || 0;
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      return await searchAllLibraryItems(params);
    } finally {
      inFlightQuicksearch -= 1;
    }
  };
  const service = new RigLibraryRetrieveService(
    gateway as any,
    {
      ensurePaperContext: async () => {
        ensurePaperContextCount += 1;
        return makePdfContext([
          "Abstract\nThis paper describes a method.",
          "Methods\nThe method is evaluated on two datasets.",
        ]);
      },
    } as any,
    candidateBuilder,
    probeReformulator,
    triage,
    options.textIndex || DISABLED_TEXT_INDEX,
    queryEmbedder,
  );
  const modelConfigured = options.modelConfigured ?? reformulations.length > 0;
  if (modelConfigured) {
    const retrieve = service.retrieve.bind(service);
    // Caller variants keep the query planner off the network; the plan's
    // effective queries stay the plain query.
    service.retrieve = (params) =>
      retrieve({
        apiKey: "test-key",
        ...params,
        queryVariants: params.queryVariants?.length
          ? params.queryVariants
          : [params.query],
      });
  }
  return {
    service,
    entries,
    candidateBuilderCalls,
    quicksearchCalls: () => gatewayQuicksearchCalls.length,
    ensurePaperContextCalls: () => ensurePaperContextCount,
    triageCalls: () => triageCount,
    reformulationCalls: () => reformulationCount,
    embeddingCalls: () => embeddingCount,
    candidateBuildCalls: () => candidateBuildCalls,
    maxConcurrentQuicksearch: () => maxInFlightQuicksearch,
    quicksearchQueries: () =>
      (gatewayQuicksearchCalls as Array<{ query?: string }>).map(
        (call) => call.query || "",
      ),
  };
}
