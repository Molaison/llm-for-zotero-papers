import type { AgentToolContext } from "../types";
import {
  createAgentToolResultHandleRecord,
  getAgentToolResultHandle,
  upsertAgentToolResultHandles,
  type AgentToolResultHandleRecord,
} from "../store/toolResultHandles";
import {
  areConversationWritesFrozen,
  isConversationWriteGenerationCurrent,
  withConversationWriteLock,
} from "../../shared/conversationWriteFence";
import { isConversationKeyRetiredInMemory } from "../../shared/conversationKeyLedger";

export type LiteratureDiscoveryRequest = {
  batchSize: number;
  mode?: "references" | "citations";
  source?: "openalex" | "arxiv" | "europepmc";
};
export type LiteratureSelection = {
  candidateSetId: string;
  candidateIndex: number;
  reason: string;
};
export type LiteratureReviewInput = {
  selections: LiteratureSelection[];
  sessionId?: string;
  revision?: number;
  targetCollectionId?: number;
  shortfallReason?: string;
  outcome?: "complete" | "no_more" | "search_failed";
};
export type LiteratureCandidateSet = {
  kind: "literature_candidates";
  runId?: string;
  libraryID?: number;
  mode?: string;
  source?: string;
  results: Record<string, unknown>[];
};
export type LiteratureDiscoverySession = {
  kind: "literature_discovery";
  runId?: string;
  libraryID?: number;
  request: LiteratureDiscoveryRequest;
  revision: number;
  phase: "gathering" | "review" | "expanding" | "closed";
  candidateSetIds: string[];
  papers: Record<string, unknown>[];
  selectedIds: string[];
  targetCollectionId?: number;
  destinationLabel?: string;
  shortfallReason?: string;
  outcome: "complete" | "no_more" | "search_failed";
};

/** A discovery batch is five papers unless the tool call says otherwise. */
export function resolveLiteratureDiscoveryRequest(): LiteratureDiscoveryRequest {
  return { batchSize: 5, mode: undefined, source: undefined };
}

function assertActive(context: AgentToolContext): void {
  const key = context.request.conversationKey;
  if (
    !key ||
    !context.runId ||
    context.signal?.aborted ||
    isConversationKeyRetiredInMemory(key) ||
    areConversationWritesFrozen(key) ||
    (context.request.conversationGeneration !== undefined &&
      !isConversationWriteGenerationCurrent(
        key,
        context.request.conversationGeneration,
      ))
  ) {
    throw new Error(
      "This discovery is no longer active. Start a new discovery request.",
    );
  }
}

function sessionSeed(context: AgentToolContext): AgentToolResultHandleRecord {
  assertActive(context);
  const content: LiteratureDiscoverySession = {
    kind: "literature_discovery",
    runId: context.runId,
    libraryID: context.request.libraryID,
    request: resolveLiteratureDiscoveryRequest(),
    revision: 0,
    phase: "gathering",
    candidateSetIds: [],
    papers: [],
    selectedIds: [],
    outcome: "complete",
  };
  return createAgentToolResultHandleRecord({
    conversationKey: context.request.conversationKey,
    toolName: "literature_review",
    toolCallId: context.runId!,
    resourceSignature: context.resourceSignature,
    content,
  })!;
}

/** One turn-scoped record in the existing result store owns all discovery state. */
export async function getLiteratureDiscovery(
  context: AgentToolContext,
  create = false,
) {
  const seed = sessionSeed(context);
  return withConversationWriteLock(seed.conversationKey, async () => {
    let record = await getAgentToolResultHandle({
      conversationKey: seed.conversationKey,
      handle: seed.handle,
    });
    assertActive(context);
    if (!record && create) {
      await upsertAgentToolResultHandles([seed]);
      record = seed;
    }
    if (!record) return null;
    return { record, session: record.content as LiteratureDiscoverySession };
  });
}

async function save(
  record: AgentToolResultHandleRecord,
  context: AgentToolContext,
) {
  assertActive(context);
  await upsertAgentToolResultHandles([record]);
}

/** Lowercase a DOI and strip `doi:` / resolver-URL prefixes. */
function normalizeDoi(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^doi:\s*/, "")
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//, "")
    .trim();
}

/**
 * Bare, version-free arXiv id from an id, `arXiv:` form or arxiv.org
 * abs/pdf URL; empty when the value is not an arXiv id. Versions of one
 * paper share an id, so they match and dedupe as one paper.
 */
function normalizeArxivId(value: unknown): string {
  const id = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^arxiv:\s*/, "")
    .replace(
      /^(?:https?:\/\/)?(?:www\.|export\.)?arxiv\.org\/(?:abs|pdf)\//,
      "",
    )
    .replace(/\.pdf$/, "")
    .replace(/\/$/, "")
    .replace(/v\d+$/, "");
  return /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z-]+)?\/\d{7})$/.test(id) ? id : "";
}

/** Match identifiers across providers, with normalized title as a metadata fallback. */
export function literaturePaperIdentities(
  paper: Record<string, unknown>,
): string[] {
  const keys: string[] = [];
  const doi = normalizeDoi(paper.doi);
  if (doi) keys.push(`doi:${doi}`);
  const arxiv = normalizeArxivId(paper.arxivId);
  if (arxiv) keys.push(`arxiv:${arxiv}`);
  for (const value of [paper.id, paper.sourceUrl]) {
    if (typeof value === "string" && value.trim())
      keys.push(
        value
          .toLowerCase()
          .replace(/^https?:\/\//, "")
          .replace(/\/$/, ""),
      );
  }
  // Ids derived from an arXiv DOI or URL follow the provider keys, so the
  // first key (the stored discoveryPaperId) is unchanged.
  for (const derived of [
    doi.match(/^10\.48550\/arxiv\.(.+)$/)?.[1],
    paper.id,
    paper.sourceUrl,
  ]) {
    const id = normalizeArxivId(derived);
    if (id && !keys.includes(`arxiv:${id}`)) keys.push(`arxiv:${id}`);
  }
  const title = String(paper.title || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
  if (title && !keys.length) keys.push(`title:${title}:${paper.year || ""}`);
  return keys;
}

export function discoveryContent(record: AgentToolResultHandleRecord) {
  const session = record.content as LiteratureDiscoverySession;
  return {
    mode: "search",
    sessionId: record.handle,
    revision: session.revision,
    discoveryPhase: session.phase,
    batchSize: session.request.batchSize,
    results: session.papers.map((p) => ({
      ...p,
      checked: session.selectedIds.includes(String(p.discoveryPaperId)),
    })),
    reviewRequired: true,
    libraryID: session.libraryID,
    targetCollectionId: session.targetCollectionId,
    destinationLabel: session.destinationLabel,
    shortfallReason: session.shortfallReason,
    outcome: session.outcome,
  };
}

export async function identifyLiteratureCandidates(
  content: Record<string, unknown>,
  context: AgentToolContext,
  reviewRequired: boolean,
  routeImports = false,
): Promise<Record<string, unknown>> {
  const results = Array.isArray(content.results) ? content.results : [];
  const discovery = reviewRequired
    ? await getLiteratureDiscovery(context, true)
    : null;
  const set: LiteratureCandidateSet = {
    kind: "literature_candidates",
    runId: context.runId,
    libraryID: context.request.libraryID,
    mode: String(content.mode || "search"),
    source: String(content.source || ""),
    results,
  };
  const record = createAgentToolResultHandleRecord({
    conversationKey: context.request.conversationKey,
    toolName: "literature_search",
    toolCallId: context.runId || "literature-search",
    resourceSignature: context.resourceSignature,
    content: set,
  });
  if (!record) return { ...content, reviewRequired: false };
  await upsertAgentToolResultHandles([record]);
  if (discovery) {
    if (!discovery.session.candidateSetIds.includes(record.handle))
      discovery.session.candidateSetIds.push(record.handle);
    await save(discovery.record, context);
  }
  return {
    ...content,
    candidateSetId: record.handle,
    results: results.map((r, index) => ({ ...r, candidateIndex: index + 1 })),
    reviewRequired,
    ...(discovery
      ? {
          sessionId: discovery.record.handle,
          revision: discovery.session.revision,
          nextStep: discoveryInstruction(discovery.record, routeImports),
        }
      : routeImports
        ? { nextStep: CANDIDATE_ROUTE }
        : {}),
  };
}

/**
 * Unclassified turns (chat, fresh plan executions) cannot tell discovery from
 * an explicit import. The search result is read when the model picks its next
 * tool, so for callers that can open the card it states the import branch
 * first. Every other caller gets the card-only text unchanged.
 */
const IMPORT_ROUTE =
  "If the user asked to import or add papers to Zotero without asking to choose them first, skip the selection card: rank these candidates, skip papers already in the library, then call library_import with the DOI or arXiv identifiers of exactly the number the user requested and the requested destination (targetCollectionId; create the collection first only when the user named a new one).";
const CANDIDATE_ROUTE = `${IMPORT_ROUTE} If they only asked to find or recommend papers, call literature_review with ranked candidateSetId/candidateIndex selections. Otherwise answer from these results.`;

function discoveryInstruction(
  record: AgentToolResultHandleRecord,
  offerImport = false,
): string {
  const s = record.content as LiteratureDiscoverySession;
  const select = `titles and abstracts and select ${s.request.batchSize} ${s.papers.length ? "additional " : ""}genuinely relevant papers in ranked order. Respect the user's topic and these constraints: ${JSON.stringify(s.request)}. Assess unused saved candidates first; search further if needed. To expand a provider list, increase its retrieval limit rather than repeating the same bounded request.`;
  const review = `literature_review with sessionId '${record.handle}', revision ${s.revision}, NEW candidateSetId/candidateIndex selections and evidence-based relevance reasons. Do not repeat displayed papers or dump the raw pool. If fewer qualify, explain shortfallReason; use outcome 'no_more' when no further relevant matches were found, or 'search_failed' for a retrieval failure. Empty selections with an explanation are allowed.`;
  return offerImport
    ? `${IMPORT_ROUTE} Otherwise the user only wants discovery: assess ${select} Then call ${review} Discovery never imports and never finishes with prose instead of the card.`
    : `Assess ${select} Call ${review} Never import during discovery or finish with prose instead of the card.`;
}

export async function prepareLiteratureDiscoveryReview(
  input: LiteratureReviewInput,
  context: AgentToolContext,
  destination: { targetCollectionId?: number; destinationLabel: string },
) {
  const discovery = await getLiteratureDiscovery(context, true);
  const { record, session } = discovery!;
  if (
    session.phase === "closed" ||
    session.phase === "review" ||
    (input.sessionId !== undefined && input.sessionId !== record.handle) ||
    (input.revision !== undefined && input.revision !== session.revision) ||
    (session.revision > 0 &&
      (input.sessionId !== record.handle ||
        input.revision !== session.revision))
  ) {
    throw new Error(
      "This discovery review is stale. Use the active sessionId and revision from Find more.",
    );
  }
  const expectedPhase = session.phase;
  const expectedRevision = session.revision;
  const identities = new Set(session.papers.flatMap(literaturePaperIdentities));
  const selected: Record<string, unknown>[] = [];
  for (const selection of input.selections) {
    const saved = await getAgentToolResultHandle({
      conversationKey: record.conversationKey,
      handle: selection.candidateSetId,
    });
    const set = saved?.content as LiteratureCandidateSet | undefined;
    if (
      !saved ||
      saved.toolName !== "literature_search" ||
      set?.kind !== "literature_candidates" ||
      set.runId !== context.runId ||
      set.libraryID !== context.request.libraryID ||
      saved.resourceSignature !== context.resourceSignature
    ) {
      throw new Error(
        "Candidate set is unavailable or belongs to another turn/library/paper. Search again before reviewing.",
      );
    }
    if (session.request.mode && set.mode !== session.request.mode)
      throw new Error(
        `Only ${session.request.mode} candidates satisfy this discovery request.`,
      );
    if (
      session.request.source &&
      set.source?.toLowerCase().replace(/\s/g, "") !== session.request.source
    )
      throw new Error(
        `Only ${session.request.source} candidates satisfy this discovery request.`,
      );
    const candidate = set.results[selection.candidateIndex - 1];
    if (!candidate)
      throw new Error(
        "Candidate index does not exist in the saved search results.",
      );
    const keys = literaturePaperIdentities(candidate);
    if (!keys.length || keys.some((key) => identities.has(key)))
      throw new Error(
        "The shortlist repeats a paper already selected or displayed.",
      );
    keys.forEach((key) => identities.add(key));
    selected.push({
      ...candidate,
      relevanceReason: selection.reason,
      discoveryPaperId: keys[0],
    });
  }
  if (
    selected.length > session.request.batchSize ||
    (selected.length < session.request.batchSize && !input.shortfallReason)
  ) {
    throw new Error(
      `Review requires ${session.request.batchSize} new ranked papers, not ${selected.length}. Search further or disclose a genuine shortfall.`,
    );
  }
  assertActive(context);
  if (session.phase !== expectedPhase || session.revision !== expectedRevision)
    throw new Error("The discovery changed while preparing this batch.");
  session.papers.push(...selected);
  session.selectedIds.push(...selected.map((p) => String(p.discoveryPaperId)));
  session.targetCollectionId = destination.targetCollectionId;
  session.destinationLabel = destination.destinationLabel;
  session.phase = "review";
  session.shortfallReason = input.shortfallReason;
  session.outcome = input.outcome || "complete";
  await save(record, context);
  return discovery!;
}

export async function resolveLiteratureDiscoveryReview(
  content: { sessionId?: string; revision?: number },
  actionId: string,
  selectedIds: unknown,
  context: AgentToolContext,
) {
  const discovery = await getLiteratureDiscovery(context);
  if (
    !discovery ||
    content.sessionId !== discovery.record.handle ||
    content.revision !== discovery.session.revision ||
    discovery.session.phase !== "review"
  ) {
    throw new Error("This discovery card is no longer active.");
  }
  const { record, session } = discovery;
  const allowed = new Set(
    session.papers.map((p) => String(p.discoveryPaperId)),
  );
  if (Array.isArray(selectedIds)) {
    if (selectedIds.some((id) => typeof id !== "string" || !allowed.has(id)))
      throw new Error("Unknown paper selection.");
    session.selectedIds = [...new Set(selectedIds as string[])];
  }
  if (actionId === "find_more") {
    if (session.outcome === "no_more")
      throw new Error(
        "No additional relevant matches were found for this discovery.",
      );
    session.phase = "expanding";
    session.revision += 1;
    session.shortfallReason = undefined;
    session.outcome = "complete";
  } else {
    session.phase = "closed";
  }
  await save(record, context);
  return {
    ...discoveryContent(record),
    candidateSetIds: session.candidateSetIds,
    nextStep: discoveryInstruction(record),
  };
}
