import { AgentToolRegistry } from "../../src/agent/tools/registry";
import { createPaperReadTool } from "../../src/agent/tools/read/paperRead";
import { RetrievalService } from "../../src/agent/services/retrievalService";
import { clearAgentTranscriptStore } from "../../src/agent/store/transcriptStore";
import { initPlanDocumentStore } from "../../src/agent/documents/store";
import { initAgentChangeJournal } from "../../src/agent/store/changeJournal";
import { setOriginalAgentPermissionMode } from "../../src/agent/originalAgentPermissionMode";
import { installMockDb, installAgentStoreSqlite } from "./agentRuntimeMockDb";
import {
  collectRun,
  finalStep,
  runJourneyTurn,
  toolCallStep,
} from "./materialJourneys";
import type { MaterialJourneyRun } from "./materialJourneys";
import type { PdfService } from "../../src/agent/services/pdfService";
import type { ZoteroGateway } from "../../src/agent/services/zoteroGateway";
import type { PaperContextRef } from "../../src/shared/types";
import type {
  PaperContextCandidate,
  PdfContext,
} from "../../src/services/paperContent/types";

/**
 * The retrieval journey: one turn that asks the same question twice.
 *
 * The two material journeys measure what writing costs. This one measures what
 * reading costs, and specifically what a *repeat* read costs: the model asks
 * the same question of the same paper twice in one run, then asks it of a
 * second paper. Nothing about that is unusual -- an agent re-reads a paper it
 * has already read whenever a later step needs the passage again -- so the
 * question is whether the second ask reaches the ranking pass or is answered
 * from the evidence cache.
 *
 * Everything below the tool is real: the runtime, the registry, the
 * targeted `paper_read` tool and `RetrievalService` itself. Only the two seams that
 * would otherwise read a PDF are fakes, and they are fakes that count -- the
 * `candidateBuilder` the service is constructed with, and the `PdfService` it
 * ensures paper contexts through. Those two counters are the measurement; the
 * events are what attributes them to calls.
 *
 * Determinism: the script passes `queryVariants`, which makes
 * `resolveRetrievalQueryPlan` return a locally built plan instead of asking a
 * model for one. Nothing here touches the network.
 */

/** The paper the journey reads twice. */
export const FIRST_PAPER: PaperContextRef = {
  itemId: 40,
  contextItemId: 41,
  libraryID: 1,
  title: "Retrieval Paper",
  firstCreator: "Rivera",
  year: "2024",
};

/** The paper the journey reads once, after the repeat. */
export const SECOND_PAPER: PaperContextRef = {
  itemId: 50,
  contextItemId: 51,
  libraryID: 1,
  title: "Second Paper",
  firstCreator: "Okafor",
  year: "2025",
};

/** The one question the journey asks, three times over two papers. */
export const JOURNEY_QUESTION = "What is the method?";

/**
 * Fixed probes handed to every call.
 *
 * With variants supplied the query plan is built locally and identically every
 * time, so the evidence cache key is stable and the run needs no model.
 */
export const JOURNEY_QUERY_VARIANTS = ["methods", "experimental procedure"];

const EMPTY_PDF_CONTEXT = {
  title: "Mock Paper",
  chunks: ["The method is a scripted one."],
  chunkMeta: [],
  chunkStats: [],
  docFreq: {},
  avgChunkLength: 0,
  fullLength: 0,
} as unknown as PdfContext;

function candidateFor(paper: PaperContextRef): PaperContextCandidate {
  return {
    paperKey: `${paper.itemId}:${paper.contextItemId}`,
    itemId: paper.itemId,
    contextItemId: paper.contextItemId,
    title: paper.title,
    firstCreator: paper.firstCreator,
    year: paper.year,
    chunkIndex: 0,
    chunkText: `The method of ${paper.title} is a scripted one.`,
    chunkKind: "body",
    estimatedTokens: 9,
    bm25Score: 1,
    embeddingScore: 0,
    hybridScore: 1,
    evidenceScore: 1,
  } as PaperContextCandidate;
}

/** The counting seams, plus the service and registry built on top of them. */
export type RetrievalJourneyRig = {
  /** Candidate-ranking passes the service actually ran. */
  candidateBuilds: () => number;
  /** Times a paper's indexed context was ensured, at the PDF-service seam. */
  paperContextEnsures: () => number;
  /** The one service instance every turn of this rig retrieves through. */
  service: RetrievalService;
  registry: AgentToolRegistry;
};

/**
 * Builds the retrieval stack with counters at the two seams that matter.
 *
 * One `RetrievalService` instance, because that is what production has: the
 * agent builds one per runtime and the evidence cache lives on it.
 */
export function createRetrievalJourneyRig(): RetrievalJourneyRig {
  let candidateBuilds = 0;
  let paperContextEnsures = 0;
  const papers = [FIRST_PAPER, SECOND_PAPER];
  const pdfService = {
    ensurePaperContext: async () => {
      paperContextEnsures += 1;
      return EMPTY_PDF_CONTEXT;
    },
  } as unknown as PdfService;
  const service = new RetrievalService(pdfService, async (paperContext) => {
    candidateBuilds += 1;
    return [candidateFor(paperContext as PaperContextRef)];
  });
  const gateway = {
    resolvePaperContextTarget: ({
      itemId,
      contextItemId,
    }: {
      itemId?: number;
      contextItemId?: number;
    }) =>
      papers.find(
        (paper) =>
          (!itemId || paper.itemId === itemId) &&
          (!contextItemId || paper.contextItemId === contextItemId),
      ) || null,
  } as unknown as ZoteroGateway;
  const registry = new AgentToolRegistry();
  registry.register(
    createPaperReadTool(pdfService, service, {} as never, gateway),
  );
  return {
    candidateBuilds: () => candidateBuilds,
    paperContextEnsures: () => paperContextEnsures,
    service,
    registry,
  };
}

/** One scripted targeted `paper_read` call against one paper. */
function targetedReadStep(callId: string, paper: PaperContextRef) {
  return toolCallStep(callId, "paper_read", {
    mode: "targeted",
    target: { itemId: paper.itemId, contextItemId: paper.contextItemId },
    query: JOURNEY_QUESTION,
    queryVariants: JOURNEY_QUERY_VARIANTS,
  });
}

export type RetrievalJourneyRun = MaterialJourneyRun & {
  candidateBuilds: number;
  paperContextEnsures: number;
};

export type RetrievalJourneyEnvironment = {
  restore: () => void;
};

/** Installs the stores one scripted retrieval turn needs. */
export async function installRetrievalJourneyEnvironment(): Promise<RetrievalJourneyEnvironment> {
  clearAgentTranscriptStore();
  const restoreDb = installMockDb();
  const restoreStores = installAgentStoreSqlite();
  const zotero = globalThis.Zotero as unknown as Record<string, unknown>;
  zotero.Libraries = { userLibraryID: 1 };
  const originalToolkit = (globalThis as Record<string, unknown>).ztoolkit;
  (globalThis as Record<string, unknown>).ztoolkit = { log: () => undefined };
  setOriginalAgentPermissionMode("safe");
  await initPlanDocumentStore();
  await initAgentChangeJournal();
  return {
    restore: () => {
      (globalThis as Record<string, unknown>).ztoolkit = originalToolkit;
      restoreStores();
      restoreDb();
    },
  };
}

/**
 * Runs one turn of the journey: read paper A, read paper A again, read paper B.
 *
 * The rig is passed in rather than built here so a caller can hand the same rig
 * -- and therefore the same evidence cache -- to a second run and see whether
 * the cache outlives the run that filled it.
 */
export async function runRetrievalTurn(params: {
  rig: RetrievalJourneyRig;
  conversationKey: number;
}) {
  return runJourneyTurn({
    registry: params.rig.registry,
    conversationKey: params.conversationKey,
    userText: "Check the method in both papers",
    sourceMessageTimestamp: 100,
    steps: [
      targetedReadStep("targeted-read-1", FIRST_PAPER),
      targetedReadStep("targeted-read-2", FIRST_PAPER),
      targetedReadStep("targeted-read-3", SECOND_PAPER),
      finalStep("Both papers describe the same scripted method."),
    ],
  });
}

/**
 * Replays the retrieval journey, for a reader that only measures it.
 *
 * One turn, one service instance, on a private environment of its own.
 */
export async function runRetrievalJourney(): Promise<RetrievalJourneyRun> {
  const environment = await installRetrievalJourneyEnvironment();
  try {
    const rig = createRetrievalJourneyRig();
    const turn = await runRetrievalTurn({ rig, conversationKey: 882_101 });
    return {
      ...collectRun([turn], 0),
      candidateBuilds: rig.candidateBuilds(),
      paperContextEnsures: rig.paperContextEnsures(),
    };
  } finally {
    environment.restore();
  }
}
