/**
 * The host side of a digest part: what `task_update` runs when the model
 * declares (or declares again) a part whose effect is `digest`.
 *
 * It resolves each `item:<id>` target to its paper, reads the paper's text,
 * runs `runPaperDigestJob` with the chat turn's own model and the turn's
 * Stop signal, and publishes each paper's outcome as it lands: digest
 * evidence on the turn's outcome ledger (one checkpoint change per paper)
 * and one paper-row update built by the ledger's own digest builders.
 * Complete digests are cached in the conversation's tool-result handle
 * store, where context_read reads them by handle; failures never are.
 */
import { DEFAULT_INPUT_TOKEN_CAP } from "../../utils/llmDefaults";
import type { UtilityLLMParams } from "../../utils/utilityLLM";
import type { PaperContextRef } from "../../shared/types";
import {
  buildDigestFailureLedgerDelta,
  buildDigestLedgerDelta,
  type TaskPaperDigestPaper,
} from "../context/taskPaperLedger";
import { getTurnPapers } from "../context/requestTurnPaperScope";
import { applyOutcomeEvidence } from "../loop/outcomes";
import type { PdfService } from "../services/pdfService";
import type { ZoteroGateway } from "../services/zoteroGateway";
import {
  createAgentToolResultHandleRecord,
  listAgentToolResultHandles,
  upsertAgentToolResultHandles,
  type AgentToolResultHandleRecord,
} from "../store/toolResultHandles";
import { readPaperTextForDigest } from "../tools/read/paperRead";
import type { AgentRuntimeRequest, AgentToolContext } from "../types";
import {
  renderHostPaperDigests,
  runPaperDigestJob,
  type HostPaperDigest,
  type PaperDigestCache,
  type PaperDigestFailure,
  type PaperDigestSource,
} from "./paperDigestWorker";

/** The tool name the digest cache's handle records are stored under. */
export const PAPER_DIGEST_HANDLE_TOOL = "paper_digest";

/** Parallel model calls per digest part. */
const DIGEST_CONCURRENCY = 4;

/** The text a digest reads for one resolved paper, already cut. */
export type DigestPaperText = Pick<
  PaperDigestSource,
  "backend" | "text" | "totalCharacters"
>;

/** A digest cache that also names the handle context_read reads it by. */
export type HostPaperDigestCache = PaperDigestCache & {
  /** The handle holding `digest` for the current scope, stored if needed. */
  handleOf(digest: HostPaperDigest): Promise<string | undefined>;
};

export type DigestJobHostDeps = {
  /** The paper an `item:<id>` target names, or null when none resolves. */
  resolvePaper: (
    request: AgentRuntimeRequest,
    itemId: number,
  ) => Promise<PaperContextRef | null>;
  /** The paper's text cut to `maxChars`, or null when it has none. */
  readText: (
    paper: PaperContextRef,
    maxChars: number,
  ) => Promise<DigestPaperText | null>;
  /** Test seam forwarded to `callUtilityLLM`. */
  llmCall?: UtilityLLMParams["llmCall"];
  /** Test seam; defaults to the handle-store cache. */
  createCache?: (context: AgentToolContext) => HostPaperDigestCache;
};

/** One digest part to run now, and the papers to digest. */
export type DigestPartRequest = { taskId: string; targets: string[] };

/** What a digest run adds to the `task_update` result. */
export type DigestRunResult = {
  /** Rendered digests, one block per paper in scope order, then failures. */
  digests?: string;
  /** The handle context_read reads each digest by. */
  digestHandles?: Array<{ itemId: number; handle: string }>;
  digestFailures?: Array<{ itemId: number; title?: string; reason: string }>;
  /** Targets Stop left undone; declare the part again to continue them. */
  digestPending?: string[];
};

type DigestCacheContent = {
  cacheKey: string;
  digest: HostPaperDigest;
  rendered: string;
};

function cachedDigest(
  record: AgentToolResultHandleRecord,
): HostPaperDigest | null {
  const content = record.content as Partial<DigestCacheContent> | null;
  const digest = content?.digest;
  if (
    !content ||
    typeof content.cacheKey !== "string" ||
    !digest ||
    typeof digest !== "object" ||
    digest.cacheKey !== content.cacheKey ||
    typeof digest.summary !== "string" ||
    !digest.summary.trim()
  )
    return null;
  return digest;
}

/**
 * The digest cache over the conversation's tool-result handle store: one
 * record per complete digest, keyed by its cache key, whose handle
 * context_read pages. The store is read once per instance.
 */
export function createHandleStorePaperDigestCache(params: {
  conversationKey: number;
  resourceSignature?: string;
  /** The turn's handle writer; defaults to the store itself. */
  persist?: (records: AgentToolResultHandleRecord[]) => Promise<void>;
  now?: () => number;
}): HostPaperDigestCache {
  const persist = params.persist || upsertAgentToolResultHandles;
  const now = params.now || (() => Date.now());
  /** cacheKey → the handle of its record under the current scope. */
  const handles = new Map<string, string>();
  let index: Promise<Map<string, HostPaperDigest>> | null = null;
  const load = () =>
    (index ||= listAgentToolResultHandles({
      conversationKey: params.conversationKey,
      toolName: PAPER_DIGEST_HANDLE_TOOL,
    }).then((records) => {
      const digests = new Map<string, HostPaperDigest>();
      for (const record of records) {
        const digest = cachedDigest(record);
        if (!digest) continue;
        digests.set(digest.cacheKey, digest);
        if (
          (record.resourceSignature || "") === (params.resourceSignature || "")
        )
          handles.set(digest.cacheKey, record.handle);
      }
      return digests;
    }));
  const store = async (digest: HostPaperDigest) => {
    const content: DigestCacheContent = {
      cacheKey: digest.cacheKey,
      digest,
      rendered: renderHostPaperDigests([digest], []),
    };
    const record = createAgentToolResultHandleRecord({
      conversationKey: params.conversationKey,
      toolName: PAPER_DIGEST_HANDLE_TOOL,
      toolCallId: digest.cacheKey,
      resourceSignature: params.resourceSignature,
      content,
      createdAt: now(),
    });
    if (!record) return undefined;
    await persist([record]);
    handles.set(digest.cacheKey, record.handle);
    return record.handle;
  };
  return {
    get: async (key) => (await load()).get(key) || null,
    set: async (digest) => {
      // Only a complete digest is cached; the worker never hands a failure.
      if (!digest.summary.trim()) return;
      const digests = await load();
      await store(digest);
      digests.set(digest.cacheKey, digest);
    },
    handleOf: async (digest) => {
      await load();
      return handles.get(digest.cacheKey) || (await store(digest));
    },
  };
}

/**
 * Resolves papers and reads their text from Zotero: the turn's own paper
 * ref when the turn carries it, else the gateway's resolver. The gateway's
 * ref does not carry the MinerU cache directory, so it is looked up from the
 * paper's attachments, as the figure read does, and the text is read
 * exactly as the overview read picks it (MinerU `full.md`, else the PDF).
 */
export function createZoteroPaperDigestSources(deps: {
  zoteroGateway: Pick<
    ZoteroGateway,
    "resolvePaperContextTarget" | "getAllChildAttachmentInfos"
  >;
  pdfService: Pick<PdfService, "getOverviewExcerpt">;
}): Pick<DigestJobHostDeps, "resolvePaper" | "readText"> {
  return {
    resolvePaper: async (request, itemId) => {
      let paper: PaperContextRef | null = null;
      try {
        paper =
          getTurnPapers(request).find((entry) => entry.itemId === itemId) ||
          deps.zoteroGateway.resolvePaperContextTarget({ itemId });
      } catch {
        return null;
      }
      if (!paper || paper.mineruCacheDir) return paper;
      try {
        const infos =
          await deps.zoteroGateway.getAllChildAttachmentInfos(itemId);
        const match = infos.find(
          (entry) => entry.contextItemId === paper!.contextItemId,
        );
        if (match?.mineruCacheDir)
          return {
            ...paper,
            contentSourceMode: paper.contentSourceMode || "mineru",
            mineruCacheDir: match.mineruCacheDir,
          };
      } catch {
        // No MinerU directory: the PDF text is read instead.
      }
      return paper;
    },
    readText: (paper, maxChars) =>
      readPaperTextForDigest({
        paperContext: paper,
        pdfService: deps.pdfService,
        maxChars,
      }),
  };
}

/**
 * Runs each digest part's job in order, with the chat turn's model, budget
 * and Stop signal, publishing every paper's outcome as it lands. Stop ends
 * the run between papers: finished digests stay, and the papers not
 * finished are reported pending.
 */
export async function runDigestParts(params: {
  parts: readonly DigestPartRequest[];
  context: AgentToolContext;
  deps: DigestJobHostDeps;
  /** The part's id as the model names it. */
  localTaskId: (taskId: string) => string;
}): Promise<DigestRunResult> {
  const { context, deps } = params;
  const request = context.request;
  const signal = context.signal;
  const llm = {
    model: request.model,
    apiBase: request.apiBase,
    apiKey: request.apiKey,
    authMode: request.authMode,
    providerProtocol: request.providerProtocol,
    profileOverride: request.advanced?.profileOverride,
    llmCall: deps.llmCall,
  };
  const inputCapTokens =
    request.runtimeContextBudget?.contextWindowTokens ||
    DEFAULT_INPUT_TOKEN_CAP;
  const cache =
    deps.createCache?.(context) ||
    createHandleStorePaperDigestCache({
      conversationKey: request.conversationKey,
      resourceSignature: context.resourceSignature,
      persist: context.persistToolResultHandles,
    });
  const papers = new Map<number, Promise<PaperContextRef | null>>();
  const resolved = new Map<number, PaperContextRef>();
  const resolvePaper = (itemId: number) => {
    let paper = papers.get(itemId);
    if (!paper) {
      paper = deps
        .resolvePaper(request, itemId)
        .catch(() => null)
        .then((ref) => {
          if (ref) resolved.set(itemId, ref);
          return ref;
        });
      papers.set(itemId, paper);
    }
    return paper;
  };
  const titleOf = (itemId: number) =>
    resolved.get(itemId)?.title ||
    request.turnScopePapers?.papers?.[itemId]?.title ||
    undefined;
  /** The paper's row identity; none without a library to key it by. */
  const ledgerPaper = (itemId: number): TaskPaperDigestPaper | null => {
    const paper = resolved.get(itemId);
    const libraryID = paper?.libraryID || request.libraryID;
    if (!libraryID || !(itemId > 0)) return null;
    const title = titleOf(itemId);
    return {
      libraryID,
      itemId,
      ...(paper?.contextItemId ? { contextItemId: paper.contextItemId } : {}),
      ...(title ? { title } : {}),
      ...(paper?.year ? { year: paper.year } : {}),
      ...(paper?.firstCreator ? { creator: paper.firstCreator } : {}),
    };
  };
  const recordEvidence = (
    taskId: string,
    done: string[],
    failed: Pick<PaperDigestFailure, "target" | "reason">[],
  ) =>
    context.updateExecutionCheckpoint?.(
      (checkpoint) =>
        applyOutcomeEvidence(
          checkpoint,
          { kind: "digest", taskId, done, failed },
          Date.now(),
        ).checkpoint,
    );

  const digests: HostPaperDigest[] = [];
  const failures: PaperDigestFailure[] = [];
  const pending: string[] = [];
  for (const part of params.parts) {
    if (signal?.aborted) {
      pending.push(...part.targets);
      continue;
    }
    const local = params.localTaskId(part.taskId);
    const base = context.toolCallId || `${context.runId || "run"}:${local}`;
    // One call id per part, so two parts over one paper both apply.
    const callId = params.parts.length > 1 ? `${base}:${local}` : base;
    const instruction =
      request.executionCheckpoint?.tasks.find(
        (task) => task.taskId === part.taskId,
      )?.description || "";
    const result = await runPaperDigestJob({
      targets: part.targets,
      instruction,
      readText: async (itemId, maxChars) => {
        const paper = await resolvePaper(itemId);
        if (!paper) return null;
        const text = await deps.readText(paper, maxChars);
        if (!text) return null;
        return {
          itemId,
          contextItemId: paper.contextItemId,
          ...(paper.libraryID ? { libraryID: paper.libraryID } : {}),
          ...(paper.title ? { title: paper.title } : {}),
          ...text,
        };
      },
      llm,
      inputCapTokens,
      concurrency: DIGEST_CONCURRENCY,
      signal,
      cache,
      onDigest: async (digest, target) => {
        await recordEvidence(part.taskId, [target], []);
        const paper = ledgerPaper(digest.itemId);
        if (!paper) return;
        await context.publishPaperLedgerDelta?.(
          buildDigestLedgerDelta({
            runId: context.runId,
            callId,
            toolName: "task_update",
            digest,
            paper,
          }),
        );
      },
      onFailure: async (failure) => {
        await recordEvidence(
          part.taskId,
          [],
          [{ target: failure.target, reason: failure.reason }],
        );
        const paper = ledgerPaper(failure.itemId);
        if (!paper) return;
        await context.publishPaperLedgerDelta?.(
          buildDigestFailureLedgerDelta({
            runId: context.runId,
            callId,
            toolName: "task_update",
            failure,
            paper,
          }),
        );
      },
    });
    digests.push(...result.digests);
    failures.push(...result.failures);
    pending.push(...result.pending);
  }

  const handles: Array<{ itemId: number; handle: string }> = [];
  for (const digest of digests) {
    try {
      const handle = await cache.handleOf(digest);
      if (handle) handles.push({ itemId: digest.itemId, handle });
    } catch {
      // The digest stays in the result; only its handle is missing.
    }
  }
  return {
    ...(digests.length || failures.length
      ? { digests: renderHostPaperDigests(digests, failures, titleOf) }
      : {}),
    ...(handles.length ? { digestHandles: handles } : {}),
    ...(failures.length
      ? {
          digestFailures: failures.map((failure) => {
            const title = titleOf(failure.itemId);
            return {
              itemId: failure.itemId,
              ...(title ? { title } : {}),
              reason: failure.reason,
            };
          }),
        }
      : {}),
    ...(pending.length ? { digestPending: pending } : {}),
  };
}
