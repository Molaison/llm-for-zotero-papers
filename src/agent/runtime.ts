import { resolveNoteEditModelRequest } from "./model/noteEditingPolicy";
import { buildPaperDisplayLabels } from "../shared/paperDisplayLabels";
import { listScopeSnapshotItems } from "./research/store";
import { ensureModelCapabilities } from "../modelCapabilities";
import { reanchorQuoteCitationsToClaims } from "../services/quotes/claimAnchoring";
import type { QuoteCitation } from "../shared/types";
import {
  areConversationWritesFrozen,
  getConversationWriteGeneration,
  isConversationWriteGenerationCurrent,
  withConversationWriteLock,
} from "../shared/conversationWriteFence";
import { getNotesDirectoryConfig } from "../utils/notesDirectoryConfig";
import { createTurnUsageRecorder } from "../utils/usageTurnRecorder";
import type { UsageEventRuntime } from "../utils/usageStore";
import { classifyConversationKey } from "../shared/conversationKeySpace";
import type { WebAttributionAssessment } from "../webAccess/attribution";
import { clearWebSourcesForRun } from "../webAccess/runSources";
import {
  buildAgentContextBudgetState,
  resolveAgentContextBudgetPolicy,
} from "./context/budgetPolicy";
import {
  commitAgentCoverageActivities,
  hydrateAgentCoverageLedger,
} from "./context/coverageLedger";
import { validateLocalPdfDocumentBatch } from "./context/localDocumentBatch";
import { PaperEvidenceFrontier } from "./context/paperEvidenceFrontier";
import { PassageCitationCollector } from "./context/passageCitationCollector";
import {
  AgentPromptBudgetError,
  enforceAgentPromptBudget,
  resolveAgentPromptBudgetLimits,
} from "./context/promptBudget";
import { getTurnPapersWithRoles } from "./context/requestTurnPaperScope";
import {
  resolveAgentRuntimeRequest,
  type AgentRequestPaperContextResolver,
} from "./context/resolvedAgentRequest";
import {
  buildAgentResourceContextPlan,
  commitAgentReadActivities,
  hydrateAgentEvidenceCache,
  type AgentPendingReadActivity,
} from "./context/resourceContextPlan";
import {
  buildAgentSemanticCheckpoint,
  buildPortableAgentTranscript,
  buildConversationReferenceMessage,
  buildRetainedActionMessage,
  readRetainedWorkingDirectory,
  compactAgentTranscript,
} from "./context/transcriptCompactor";
import { AgentRunContinuationSession } from "./continuation/runContinuationSession";
import {
  ActionContractRunSession,
  readLatestActionContractCheckpoint,
  type ActionContractCheckpoint,
} from "./contracts/actionContractRunSession";
import { loadWorkflowCheckpoint } from "./contracts/workflowCheckpoint";
import { resolveDocumentOutcomePolicy } from "./documents/outcomePolicy";
import type { MaterialRef } from "./documents/materialRef";
import {
  loadWorkflowMaterial,
  materialRefFromDocument,
} from "./documents/workflowMaterial";
import { AgentFinalAnswerController } from "./finalization/finalAnswerController";
import type { AgentModelAdapter } from "./model/adapter";
import { resolveCapabilitiesContentInputs } from "./model/contentCapabilities";
import { buildAnswerContinuationInstruction } from "./model/completion";
import { MAX_ANSWER_CONTINUATIONS, resolveAgentLimits } from "./model/limits";
import {
  buildAgentPromptInstructionInventory,
  composeAgentModelInput,
  normalizeHistoryMessages,
  renderAgentPromptEnvelope,
} from "./model/messageBuilder";
import { resolvePlanSkillRoutingReceipt } from "./model/semanticSkillRouting";
import {
  buildAdapterToolCallResult,
  type ToolWorkflowOutcome,
} from "./model/toolArtifactDelivery";
import { PlanExecutionRunSession } from "./plans/runSession";
import { loadPlanArtifact } from "./plans/store";
import type { PlanEvent } from "./plans/types";
import {
  acquireLocalDocumentPathLease,
  AgentEventLocalDocumentStreamRedactor,
  LocalDocumentPathStreamRedactor,
} from "./privacy/localDocumentPathRedaction";
import {
  getAllSkills,
  getBuiltinSkillInstructionById,
  getMatchedSkillIds,
  loadSkill,
} from "./skills";
import { listJournalActions } from "./store/changeJournal";
import { recordAgentTurn } from "./store/conversationMemory";
import {
  hasAgentToolResultHandles,
  hydrateAgentToolResultHandles,
  upsertAgentToolResultHandles,
  type AgentToolResultHandleRecord,
} from "./store/toolResultHandles";
import { listResumableBatches } from "./store/batchItemStore";
import {
  appendAgentRunEvent,
  createAgentRun,
  finishAgentRun,
  getAgentRunTrace,
  getLatestAgentRunForConversation,
  INTERRUPTED_AGENT_RUN_MARKER,
} from "./store/traceStore";
import {
  appendAgentTranscriptMessages,
  PORTABLE_TRANSCRIPT_KEY,
  loadAgentTranscriptSegment,
  loadLatestAgentTranscriptSegment,
  replaceAgentTranscriptSegment,
  type AgentTranscriptWriteResult,
} from "./store/transcriptStore";
import { resolveAgentToolCallWorkCategory } from "./workCategory";
import { AgentToolRegistry } from "./tools/registry";
import { latestExecutionCheckpoint } from "./execution/checkpoint";
import { createAgentExecutionContext } from "./execution/context";
import { loadMaterialOutcomesForConversation } from "./execution/materialOutcomes";
import {
  createToolExecution,
  type ToolExecutionRecord,
} from "./execution/toolExecution";
import {
  buildInterruptedRunRecoveryMessage,
  buildTranscriptUserMessage,
  buildTurnStartRecoveryMessage,
  isCurrentTurnUserTranscriptMessage,
  isManualCompactRequest,
  readLatestTranscriptGoal,
} from "./execution/transcriptRecovery";
import {
  buildToolProgressFingerprint,
  filterTransientRecoveryTool,
  isUserDeniedToolResult,
  readToolError,
  setToolResultReadAvailability,
} from "./execution/toolResultLifecycle";
import type { PreparedActionCall } from "./tools/workflowSteps";
import type {
  AgentAssistantMessage,
  AgentConfirmationResolution,
  AgentEvent,
  AgentModelMessage,
  AgentModelStep,
  AgentPendingAction,
  AgentRuntimeOutcome,
  AgentRuntimeRequest,
  AgentRuntimeRequestInput,
  AgentToolContext,
  AgentToolMessage,
  AgentToolResult,
  AgentUserMessage,
  ResolvedAgentRuntimeRequest,
} from "./types";
import { buildAgentStageEvent } from "./stageEvents";
import { selectAutomaticSkills } from "./model/automaticSkillSelection";

type AgentRuntimeDeps = {
  registry: AgentToolRegistry;
  adapterFactory: (request: ResolvedAgentRuntimeRequest) => AgentModelAdapter;
  paperContextResolver?: AgentRequestPaperContextResolver;
  now?: () => number;
  skillSelector?: typeof selectAutomaticSkills;
  /** Overridable so a failing re-anchoring can be exercised in tests. */
  reanchorCitations?: typeof reanchorQuoteCitationsToClaims;
};

/**
 * Best-effort log. The runtime runs inside Zotero, where `ztoolkit` exists,
 * and inside unit tests, where it does not.
 */
function logRuntimeWarning(message: string, error: unknown): void {
  (
    globalThis as typeof globalThis & {
      ztoolkit?: { log?: (...args: unknown[]) => void };
    }
  ).ztoolkit?.log?.(message, error);
}

type PendingConfirmation = {
  resolve: (resolution: AgentConfirmationResolution) => void;
};

function createRunId(): string {
  return `agent-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function createConfirmationRequestId(): string {
  return `confirm-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * What a plan event says about the planning stage.
 *
 * A revision still being drafted opens the stage and a reviewable plan closes
 * it. Every other plan event reports work inside a stage rather than a
 * transition of one: an execution ledger advancing would otherwise close a
 * stage nothing had opened, once per task.
 */
const PLANNING_STAGE_STATUS_BY_PLAN_EVENT: Readonly<
  Partial<Record<PlanEvent["type"], "started" | "completed">>
> = {
  plan_updated: "started",
  plan_ready: "completed",
};

export class AgentRuntime {
  private readonly registry: AgentToolRegistry;
  private readonly adapterFactory: AgentRuntimeDeps["adapterFactory"];
  private readonly paperContextResolver?: AgentRequestPaperContextResolver;
  private readonly now: () => number;
  private readonly skillSelector: typeof selectAutomaticSkills;
  private readonly reanchorCitations: typeof reanchorQuoteCitationsToClaims;
  private readonly pendingConfirmations = new Map<
    string,
    PendingConfirmation
  >();

  constructor(deps: AgentRuntimeDeps) {
    this.registry = deps.registry;
    this.adapterFactory = deps.adapterFactory;
    this.paperContextResolver = deps.paperContextResolver;
    this.now = deps.now || (() => Date.now());
    this.skillSelector = deps.skillSelector || selectAutomaticSkills;
    this.reanchorCitations =
      deps.reanchorCitations || reanchorQuoteCitationsToClaims;
  }

  listTools() {
    return this.registry.listTools();
  }

  getToolDefinition(name: string) {
    return this.registry.getTool(name);
  }

  registerTool<TInput, TResult>(
    tool: import("./types").AgentToolDefinition<TInput, TResult>,
  ): void {
    this.registry.register(tool);
  }

  unregisterTool(name: string): boolean {
    return this.registry.unregister(name);
  }

  async prepareExecutionRequest(
    requestInput: AgentRuntimeRequestInput | AgentRuntimeRequest,
    options: {
      signal?: AbortSignal;
      permissionOwner?: NonNullable<
        AgentRuntimeRequest["executionContext"]
      >["permissionOwner"];
    } = {},
  ): Promise<AgentRuntimeRequest> {
    const request =
      "turnPaperScope" in requestInput
        ? requestInput
        : resolveAgentRuntimeRequest(requestInput, {
            resolvePaperContext: this.paperContextResolver,
          });
    request.workflowCheckpoint = await loadWorkflowCheckpoint(
      request.conversationKey,
    );
    request.conversationGeneration ??= getConversationWriteGeneration(
      request.conversationKey,
    );
    if (request.planContext?.phase === "executing") {
      const plan = request.planContext;
      const artifact = await loadPlanArtifact(plan.planId, plan.revision);
      if (
        !artifact ||
        artifact.digest !== plan.approvedDigest ||
        artifact.status !== "approved"
      )
        throw new Error(
          "The approved plan is unavailable or changed. No action was authorized.",
        );
      request.actionContract = artifact.actionContract;
      request.classifiedIntent = artifact.actionContract?.intent;
    } else {
      request.actionContract = undefined;
      request.actionProgress = undefined;
      request.actionPreparation = undefined;
      request.classifiedIntent = undefined;
      request.skillRoutingReceipt = undefined;
    }
    if (options.signal?.aborted)
      throw new Error("Agent preparation was cancelled.");
    request.executionContext ||= createAgentExecutionContext(
      request,
      `execution-${request.conversationKey}-${request.conversationGeneration}-${this.now()}`,
    );
    if (options.permissionOwner) {
      request.executionContext = {
        ...request.executionContext,
        permissionOwner: options.permissionOwner,
      };
    }
    return request;
  }

  getCapabilities(request: AgentRuntimeRequestInput) {
    const resolved = resolveAgentRuntimeRequest(request, {
      resolvePaperContext: this.paperContextResolver,
    });
    return this.adapterFactory(resolved).getCapabilities(
      resolved as unknown as AgentRuntimeRequest,
    );
  }

  /**
   * Registers an external pending confirmation so that `resolveConfirmation`
   * can settle it.  Used by the action-picker UI to wire action HITL cards
   * into the same resolution path as agent-turn confirmations.
   */
  registerPendingConfirmation(
    requestId: string,
    resolve: (resolution: AgentConfirmationResolution) => void,
  ): void {
    this.pendingConfirmations.set(requestId, { resolve });
  }

  resolveConfirmation(
    requestId: string,
    approvedOrResolution: boolean | AgentConfirmationResolution,
    data?: unknown,
  ): boolean {
    const pending = this.pendingConfirmations.get(requestId);
    if (!pending) return false;
    this.pendingConfirmations.delete(requestId);
    const resolution =
      typeof approvedOrResolution === "boolean"
        ? {
            approved: approvedOrResolution,
            actionId: approvedOrResolution ? undefined : "cancel",
            data,
          }
        : {
            approved: Boolean(approvedOrResolution.approved),
            actionId: approvedOrResolution.actionId,
            data: approvedOrResolution.data,
          };
    pending.resolve(resolution);
    return true;
  }

  async getRunTrace(runId: string) {
    return getAgentRunTrace(runId);
  }

  async runTurn(params: {
    request: AgentRuntimeRequestInput;
    onEvent?: (event: AgentEvent) => void | Promise<void>;
    onStart?: (runId: string) => void | Promise<void>;
    signal?: AbortSignal;
    /**
     * False when this run replays a question the local usage ledger already
     * counted (a retry). The tokens it burns are still recorded.
     */
    usageCountsAsQuestion?: boolean;
  }): Promise<AgentRuntimeOutcome> {
    const request = resolveAgentRuntimeRequest(params.request, {
      resolvePaperContext: this.paperContextResolver,
    });
    request.conversationGeneration ??= getConversationWriteGeneration(
      request.conversationKey,
    );
    const runId = createRunId();
    request.executionContext ||= createAgentExecutionContext(request, runId);
    const writeAllowed = () =>
      !areConversationWritesFrozen(request.conversationKey) &&
      (request.conversationGeneration === undefined ||
        isConversationWriteGenerationCurrent(
          request.conversationKey,
          request.conversationGeneration,
        ));
    // Local usage ledger for this turn. The adapter reports usage per round
    // and cumulatively within a round, so the recorder folds every callback
    // into the one row written when the run settles below.
    const usageConversationSystem = classifyConversationKey(
      request.conversationKey,
    )?.system;
    const usageRuntime: UsageEventRuntime =
      usageConversationSystem === "claude_code"
        ? "claude-code"
        : usageConversationSystem === "codex"
          ? "codex"
          : "agent";
    const usageRecorder = createTurnUsageRecorder({
      conversationKey: request.conversationKey,
      conversationGeneration: request.conversationGeneration,
      countsAsQuestion: params.usageCountsAsQuestion !== false,
      runtime: usageRuntime,
      model: request.model,
      provider: request.modelProviderLabel,
    });
    const persistIfLive = async <T>(
      task: () => Promise<T>,
    ): Promise<T | undefined> => {
      if (!writeAllowed()) return undefined;
      return withConversationWriteLock(request.conversationKey, async () => {
        if (!writeAllowed()) return undefined;
        return task();
      });
    };
    try {
      await ensureModelCapabilities(
        {
          model: request.model || "",
          apiBase: request.apiBase,
          protocol: request.providerProtocol,
          authMode: request.authMode,
          apiKey: request.apiKey,
        },
        { timeoutMs: 5_000 },
      );
    } catch {
      // Capability discovery is advisory; the adapter retains its fallback
      // profile when a provider does not expose a catalog.
    }
    validateLocalPdfDocumentBatch({
      pdfPaperContexts: getTurnPapersWithRoles(request, ["raw_pdf"]),
      localDocuments: request.localDocuments?.map((entry) => entry.resource),
    });
    const pathLease = acquireLocalDocumentPathLease(
      request.conversationKey,
      request.localDocuments?.map((entry) => entry.resource),
    );
    let webSourceRunId: string | undefined;
    let runTerminalized = false;
    let redactRunTerminalText = (value: string) => value;
    let planSession: PlanExecutionRunSession | undefined;
    try {
      const latestPriorRun = await getLatestAgentRunForConversation(
        request.conversationKey,
      );
      request.workflowCheckpoint = await loadWorkflowCheckpoint(
        request.conversationKey,
        latestPriorRun,
      );
      const interruptedPriorRun =
        latestPriorRun?.status === "failed" &&
        latestPriorRun.finalText === INTERRUPTED_AGENT_RUN_MARKER
          ? latestPriorRun
          : null;
      webSourceRunId = runId;
      const adapter = this.adapterFactory(request);
      const adapterCapabilities = adapter.getCapabilities(request);
      const eventStreamRedactor = new AgentEventLocalDocumentStreamRedactor(
        request.conversationKey,
      );
      const turnPathRedactor = new LocalDocumentPathStreamRedactor(
        request.conversationKey,
      );
      redactRunTerminalText = (value) =>
        turnPathRedactor.redactTerminalText(value);
      const persistToolResultHandles = async (
        records: AgentToolResultHandleRecord[],
      ): Promise<void> => {
        if (!records.length) return;
        const sanitized = turnPathRedactor.redactTerminalValue(records);
        await persistIfLive(() => upsertAgentToolResultHandles(sanitized));
      };
      let eventSeq = 0;
      let currentAnswerText = "";
      const item = request.item || null;
      await persistIfLive(() =>
        createAgentRun({
          runId,
          conversationKey: request.conversationKey,
          mode: "agent",
          model: request.model,
          status: "running",
          createdAt: this.now(),
        }),
      );
      // createAgentRun may have waited on the provider/DB.  Clear can commit
      // during that await and intentionally leave the conversation key live,
      // so a retired-key check alone is insufficient.  Never publish a late
      // run ID into the cleared generation's UI/cache.
      if (writeAllowed()) await params.onStart?.(runId);

      // Every citation this run's tools delivered, with the passage it was cut
      // from, so the terminal answer can be re-anchored to the claims it makes.
      const passageCitations = new PassageCitationCollector();
      let passageCollectionFailed = false;
      const emit = async (event: AgentEvent) => {
        if (!writeAllowed()) return;
        // Collected before redaction: the collector keeps only quote and
        // passage text, and the citations it publishes are redacted with the
        // final event that carries them.  Citation bookkeeping never decides
        // whether the run survives, so a failure while walking a tool result
        // is logged once and the turn keeps going.
        if (event.type === "tool_result" && event.ok) {
          try {
            passageCitations.collect(event.content, event.artifacts);
          } catch (error) {
            if (!passageCollectionFailed) {
              passageCollectionFailed = true;
              logRuntimeWarning(
                "LLM Agent: passage citation collection failed",
                error,
              );
            }
          }
        }
        for (const redactedEvent of eventStreamRedactor.process(event)) {
          eventSeq += 1;
          await persistIfLive(() =>
            appendAgentRunEvent(runId, eventSeq, redactedEvent),
          );
          if (writeAllowed()) await params.onEvent?.(redactedEvent);
        }
      };
      /**
       * Plan events and the planning stage they move, in one place.
       *
       * Both the plan session and every plan tool publish through this, so
       * the stage can never be stamped on one path and missed on the other.
       */
      const emitPlanEvent = async (event: PlanEvent) => {
        const status = PLANNING_STAGE_STATUS_BY_PLAN_EVENT[event.type];
        if (status)
          await emit(buildAgentStageEvent({ stage: "planning", status }));
        await emit(event);
      };
      if (request.workflowCheckpoint)
        await emit({
          type: "provider_event",
          providerType: "agent_workflow_predecessor",
          payload: request.workflowCheckpoint,
        });
      const actionContractSession = new ActionContractRunSession({
        request,
        contracts: this.registry,
        emit,
      });
      const activePlanSession = new PlanExecutionRunSession(
        request,
        emitPlanEvent,
      );
      planSession = activePlanSession;

      const context: AgentToolContext = {
        request,
        runId,
        item,
        currentAnswerText,
        modelName: request.model || "unknown",
        modelProviderLabel: request.modelProviderLabel,
        signal: params.signal,
        readCurrentTurnActions: () =>
          toolExecutionRecords
            .slice(-8)
            .map(({ name, ok, input, content }) => ({
              name,
              ok,
              input,
              content,
            })),
        checkpointActionProgress: () => actionContractSession.checkpoint(),
        publishPlanEvent: emitPlanEvent,
        publishSkillActivation: (id) =>
          emit({ type: "status", text: `Skill activated: ${id}` }),
        publishExecutionCheckpoint: (checkpoint) =>
          emit({ type: "execution_checkpoint", checkpoint }),
        loadApprovedPlanEffectContext: async () => {
          const specification = activePlanSession.approvedEffectSpecification();
          if (!specification) return undefined;
          return {
            specification,
            activeEffectIds: activePlanSession.activeWorkflowEffectIds() || [],
            resolvedMaterials:
              await activePlanSession.resolvedWorkflowMaterials(),
            resolvedTargetBindings:
              await activePlanSession.resolvedWorkflowTargetBindings(),
          };
        },
      };
      const toolsUsedThisTurn: string[] = [];
      const toolExecutionRecords: ToolExecutionRecord[] = [];
      const pendingReadActivities: AgentPendingReadActivity[] = [];
      await hydrateAgentToolResultHandles(request.conversationKey);
      let toolResultReadAvailable = hasAgentToolResultHandles(
        request.conversationKey,
      );
      setToolResultReadAvailability(request, false);
      // Approved Plans retain their frozen skill binding. Ordinary turns select
      // guidance before the main model; skill routing never predicts actions.
      let turnIntent: {
        skillIds: string[];
        classifiedIntent: AgentRuntimeRequest["classifiedIntent"] | null;
        degraded: boolean;
        routingReceipt?: AgentRuntimeRequest["skillRoutingReceipt"];
      };
      let approvedPlanArtifact: Awaited<ReturnType<typeof loadPlanArtifact>> =
        null;
      if (request.planContext?.phase === "executing") {
        approvedPlanArtifact = await loadPlanArtifact(
          request.planContext.planId,
          request.planContext.revision,
        );
        const reused = await resolvePlanSkillRoutingReceipt(
          approvedPlanArtifact?.skillRoutingReceipt,
          getAllSkills(),
        );
        if (reused.changedExplicitSkillIds.length) {
          throw new Error(
            `Explicit plan skill changed after approval (${reused.changedExplicitSkillIds.join(", ")}); revise and approve the plan again`,
          );
        }
        if (reused.changedAutomaticSkillIds.length) {
          await emit({
            type: "provider_event",
            providerType: "plan_skill_routing",
            payload: {
              status: "changed_automatic_skills_omitted",
              skillIds: reused.changedAutomaticSkillIds,
            },
          });
        }
        turnIntent = {
          skillIds: reused.skillIds,
          classifiedIntent:
            approvedPlanArtifact?.actionContract?.intent || null,
          degraded: false,
        };
      } else {
        request.actionContract = undefined;
        request.actionProgress = undefined;
        request.actionPreparation = undefined;
        request.classifiedIntent = undefined;
        request.userTextSignals = computeUserTextSignals(request.userText);
        request.skillRoutingReceipt = undefined;
        const started = this.now();
        const selected = adapter.supportsTools(request)
          ? await this.skillSelector(request, getAllSkills(), params.signal)
          : { skillIds: [], status: "selected" as const };
        if (adapter.supportsTools(request))
          await emit({
            type: "provider_event",
            providerType: "agent_skill_selection",
            payload: { ...selected, elapsedMs: this.now() - started },
          });
        turnIntent = {
          skillIds: selected.skillIds,
          classifiedIntent: null,
          degraded: false,
        };
      }
      request.classifiedIntent = turnIntent.classifiedIntent || undefined;
      request.skillRoutingReceipt = turnIntent.routingReceipt;
      const matchedSkills = getMatchedSkillIds(request, turnIntent.skillIds);
      if (request.planContext?.phase !== "executing") {
        const forcedSkillIds = new Set(request.forcedSkillIds || []);
        request.loadedSkillRecords = (
          await Promise.all(
            getAllSkills()
              .filter((skill) => matchedSkills.includes(skill.id))
              .map(async (skill) => ({
                ...(
                  await loadSkill(
                    skill,
                    getBuiltinSkillInstructionById(skill.id),
                  )
                ).loadedSkill,
                source: forcedSkillIds.has(skill.id)
                  ? ("forced" as const)
                  : ("loaded" as const),
              })),
          )
        ).sort((left, right) => left.id.localeCompare(right.id));
      }
      const plannedSpec =
        approvedPlanArtifact?.contract?.deliverable.kind === "document"
          ? approvedPlanArtifact.contract.deliverable.spec
          : undefined;
      request.documentOutcomePolicy = resolveDocumentOutcomePolicy({
        request,
        plannedDocumentKind: plannedSpec?.kind,
        plannedResearch: Boolean(approvedPlanArtifact?.contract?.investigation),
      });
      if (!adapter.supportsTools(request)) {
        if (request.documentOutcomePolicy.required) {
          const failure =
            "The requested document cannot be produced because this model does not support Agent tools. Choose a tool-capable model and retry.";
          await persistIfLive(() => finishAgentRun(runId, "failed", failure));
          runTerminalized = true;
          throw new Error(failure);
        }
        const reason =
          "Agent tools unavailable for this model; used direct response instead.";
        await emit({
          type: "fallback",
          reason,
        });
        await persistIfLive(() => finishAgentRun(runId, "completed"));
        runTerminalized = true;
        return {
          kind: "fallback",
          runId,
          reason,
          usedFallback: true,
        };
      }
      const toolDefinitions =
        this.registry.listToolDefinitionsForRequest(request);
      const toolSpecs = filterTransientRecoveryTool(
        this.registry.listToolsForRequest(request),
      );
      await hydrateAgentEvidenceCache(request.conversationKey);
      await hydrateAgentCoverageLedger({
        conversationKey: request.conversationKey,
        request,
      });
      const resourceContextPlan = buildAgentResourceContextPlan(request);
      context.resourceSignature = resourceContextPlan.resourceSignature;
      request.contextCache = resourceContextPlan.contextCache;
      const paperEvidenceFrontier = new PaperEvidenceFrontier({
        planExecuting: request.planContext?.phase === "executing",
      });
      const preservedTurnHandleRecords: AgentToolResultHandleRecord[] = [];
      const transcriptCompatibilityKey = PORTABLE_TRANSCRIPT_KEY;
      let transcriptSegment = await loadAgentTranscriptSegment({
        conversationKey: request.conversationKey,
        compatibilityKey: transcriptCompatibilityKey,
      });
      if (!transcriptSegment.messages.length) {
        const legacy = await loadLatestAgentTranscriptSegment(
          request.conversationKey,
        );
        if (legacy)
          transcriptSegment = {
            ...legacy,
            compatibilityKey: transcriptCompatibilityKey,
          };
      }
      const history = normalizeHistoryMessages(request);
      const legacyCheckpoint = transcriptSegment.messages.some(
        (message) =>
          message.role === "user" &&
          typeof message.content === "string" &&
          message.content.startsWith("Agent semantic continuation checkpoint:"),
      );
      const portable = buildPortableAgentTranscript({
        messages:
          legacyCheckpoint && history.length
            ? [
                ...transcriptSegment.messages.map((message) =>
                  message.role === "user" &&
                  typeof message.content === "string" &&
                  message.content.startsWith(
                    "Agent semantic continuation checkpoint:",
                  )
                    ? {
                        ...message,
                        content: message.content.replace(
                          "Agent semantic continuation checkpoint:",
                          "Legacy conversation summary (earlier exact text may be unavailable):",
                        ),
                      }
                    : message,
                ),
                ...history,
              ]
            : transcriptSegment.messages.length
              ? transcriptSegment.messages
              : history,
        conversationKey: request.conversationKey,
        resourceSignature: resourceContextPlan.resourceSignature,
      });
      await persistToolResultHandles(portable.handleRecords);
      transcriptSegment = { ...transcriptSegment, messages: portable.messages };
      request.workingDirectory ||= readRetainedWorkingDirectory(
        portable.messages,
      );
      const hadCompatibleTranscript = transcriptSegment.messages.length > 0;
      let transcriptMessagesForPrompt = [...transcriptSegment.messages];
      await persistIfLive(() =>
        replaceAgentTranscriptSegment(transcriptSegment),
      );
      // Material the conversation finalized outlives the run that made it.
      // Every turn -- not only the one after an interruption -- has to know
      // what is still unwritten, or it regenerates what already exists.
      request.materialOutcomes = (
        await loadMaterialOutcomesForConversation(request.conversationKey)
      ).entries;
      // The same is true of a note batch that stopped halfway: its unwritten
      // items live in durable rows, and a turn that cannot see them has no way
      // to continue the batch except by authoring every body again.
      const resumableBatches = await listResumableBatches(
        request.conversationKey,
      );
      let recoveryMessage: AgentModelMessage | null = null;
      let interruptedActionCheckpoint: ActionContractCheckpoint | null = null;
      if (interruptedPriorRun) {
        const [actions, latestTranscriptSegment, interruptedTrace] =
          await Promise.all([
            listJournalActions({
              runId: interruptedPriorRun.runId,
              limit: 50,
            }),
            loadLatestAgentTranscriptSegment(request.conversationKey),
            getAgentRunTrace(interruptedPriorRun.runId),
          ]);
        interruptedActionCheckpoint = readLatestActionContractCheckpoint(
          interruptedTrace.events.map((event) => event.payload),
        );
        const ordinaryCheckpoint = latestExecutionCheckpoint(
          interruptedTrace.events,
        );
        if (
          ordinaryCheckpoint &&
          request.executionContext?.permissionOwner === "original_agent" &&
          ordinaryCheckpoint.conversationKey === request.conversationKey &&
          ordinaryCheckpoint.conversationGeneration ===
            request.executionContext.conversationGeneration
        ) {
          request.executionCheckpoint = ordinaryCheckpoint;
          request.executionContext = {
            ...request.executionContext,
            executionId: ordinaryCheckpoint.executionId,
          };
        }
        const compatibilityMatches =
          latestTranscriptSegment?.compatibilityKey ===
          transcriptCompatibilityKey;
        recoveryMessage = buildInterruptedRunRecoveryMessage({
          run: interruptedPriorRun,
          actions,
          priorGoal: compatibilityMatches
            ? undefined
            : readLatestTranscriptGoal(latestTranscriptSegment?.messages || []),
          materialOutcomes: request.materialOutcomes,
          resumableBatches,
        });
        transcriptMessagesForPrompt = compatibilityMatches
          ? [...transcriptMessagesForPrompt, recoveryMessage]
          : [recoveryMessage];
      }
      // An interrupted run already carries this block inside its one-time
      // recovery note. Every other turn gets it as a prompt-only host
      // message: the ledger is recomputed from run events at every turn
      // start, so persisting the block would only stack identical -- and,
      // once the material is saved, stale -- copies in the transcript.
      const materialRecoveryMessage = recoveryMessage
        ? null
        : buildTurnStartRecoveryMessage({
            materialOutcomes: request.materialOutcomes,
            resumableBatches,
          });
      const conversationReferenceMessage = buildConversationReferenceMessage(
        transcriptSegment.messages,
      );
      const promptTranscriptMessages = (): AgentModelMessage[] => {
        const retainedActionMessage = buildRetainedActionMessage(
          transcriptSegment.messages,
          transcriptMessagesForPrompt,
        );
        return [
          ...transcriptMessagesForPrompt,
          ...(conversationReferenceMessage
            ? [conversationReferenceMessage]
            : []),
          ...(retainedActionMessage ? [retainedActionMessage] : []),
          ...(materialRecoveryMessage ? [materialRecoveryMessage] : []),
        ];
      };

      if (isManualCompactRequest(request)) {
        const policy = resolveAgentContextBudgetPolicy();
        const budget = buildAgentContextBudgetState({
          messages: transcriptMessagesForPrompt,
          model: request.model,
          inputTokenCap: request.advanced?.inputTokenCap,
          apiBase: request.apiBase,
          providerProtocol: request.providerProtocol,
          authMode: request.authMode,
          profileOverride: request.advanced?.profileOverride,
          policy,
          forceCompact: true,
        });
        const compacted = compactAgentTranscript({
          messages: transcriptMessagesForPrompt,
          budget,
          force: true,
          conversationKey: request.conversationKey,
          resourceSignature: resourceContextPlan.resourceSignature,
        });
        const text = compacted.compacted
          ? "Conversation compacted"
          : "Nothing to compact yet";
        if (compacted.compacted) {
          transcriptSegment = {
            ...transcriptSegment,
            compactedAt: this.now(),
          };
          await persistToolResultHandles(compacted.handleRecords);
          if (compacted.handleRecords.length) toolResultReadAvailable = true;
          await persistIfLive(() =>
            replaceAgentTranscriptSegment(
              turnPathRedactor.redactTerminalValue(transcriptSegment),
            ),
          );
          await emit({ type: "context_compacted", automatic: false });
        }
        await emit({ type: "final", text });
        await persistIfLive(() => finishAgentRun(runId, "completed", text));
        runTerminalized = true;
        return {
          kind: "completed",
          runId,
          text,
          usedFallback: false,
        };
      }

      const currentUserTranscriptMessage = buildTranscriptUserMessage(request);
      const turnStartTranscriptMessages: AgentModelMessage[] = transcriptSegment
        .messages.length
        ? recoveryMessage
          ? [recoveryMessage]
          : []
        : [...transcriptMessagesForPrompt];
      const transcriptTail =
        turnStartTranscriptMessages[turnStartTranscriptMessages.length - 1] ||
        transcriptSegment.messages[transcriptSegment.messages.length - 1];
      if (
        hadCompatibleTranscript ||
        !isCurrentTurnUserTranscriptMessage(transcriptTail, request)
      ) {
        turnStartTranscriptMessages.push(currentUserTranscriptMessage);
      }
      if (turnStartTranscriptMessages.length) {
        await persistIfLive(() =>
          appendAgentTranscriptMessages({
            conversationKey: request.conversationKey,
            compatibilityKey: transcriptCompatibilityKey,
            messages: turnPathRedactor.redactTerminalValue(
              turnStartTranscriptMessages,
            ),
          }),
        );
        if (writeAllowed()) {
          transcriptSegment = {
            ...transcriptSegment,
            messages: [
              ...transcriptSegment.messages,
              ...turnStartTranscriptMessages,
            ],
          };
        }
      }

      const requiresFileNoteWrite = Boolean(
        request.classifiedIntent?.actionIntents?.some(
          (intent) => intent.operation === "file_write",
        ),
      );
      const planInitialization = await activePlanSession.initialize();
      if (planInitialization.kind === "failed") {
        const text = planInitialization.userMessage;
        await emit({ type: "final", text });
        await persistIfLive(() => finishAgentRun(runId, "failed", text));
        runTerminalized = true;
        return {
          kind: "completed",
          runId,
          text,
          usedFallback: false,
        };
      }
      const actionContractInitialization =
        await actionContractSession.initialize({
          checkpoint: interruptedActionCheckpoint,
        });
      if (actionContractInitialization.kind === "failed") {
        const text = actionContractInitialization.userMessage;
        await emit({ type: "final", text });
        await persistIfLive(() => finishAgentRun(runId, "failed", text));
        runTerminalized = true;
        return {
          kind: "completed",
          runId,
          text,
          usedFallback: false,
        };
      }
      if (request.planContext?.phase === "planning") {
        await emit({
          type: "status",
          text: "Planning the request and reviewing context",
        });
      } else if (request.planContext?.phase === "executing") {
        await emit({
          type: "status",
          text: "Executing the approved plan",
        });
      }
      const noteWritePolicy = requiresFileNoteWrite
        ? getNotesDirectoryConfig()
        : null;
      if (noteWritePolicy) {
        request.metadata = {
          ...(request.metadata || {}),
          fileNoteWritePolicy: noteWritePolicy,
        };
      }
      await emit({
        type: "provider_event",
        providerType: "agent_context_envelope",
        payload: {
          resourceSignature: resourceContextPlan.resourceSignature,
          selectedPaperCount: getTurnPapersWithRoles(request, ["selected"])
            .length,
          fullTextPaperCount: getTurnPapersWithRoles(request, ["full_text"])
            .length,
          selectedCollectionCount: request.turnPaperScope.collections.length,
          selectedTagCount: request.turnPaperScope.tags.length,
          attachmentCount: request.attachments?.length || 0,
          screenshotCount: request.screenshots?.length || 0,
        },
      });
      const displaySnapshot =
        approvedPlanArtifact?.contract?.investigation?.scopeSnapshot;
      if (displaySnapshot) {
        const papers = await listScopeSnapshotItems(displaySnapshot.snapshotId);
        const displayLabels = Object.fromEntries(
          buildPaperDisplayLabels(
            papers.map((paper) => ({
              ...paper,
              identity: `${paper.libraryID}:${paper.itemKey}`,
            })),
          ),
        );
        request.metadata = {
          ...request.metadata,
          paperDisplayLabels: displayLabels,
        };
        await emit({
          type: "provider_event",
          providerType: "paper_display_labels",
          payload: { version: 1, displayLabels },
        });
      }
      const captureInstructionInventory =
        request.metadata?.instructionHarnessInventory === true;
      let renderedPrompt = await renderAgentPromptEnvelope(
        request,
        toolDefinitions,
        matchedSkills,
        resourceContextPlan,
        {
          contentInputs: resolveCapabilitiesContentInputs(adapterCapabilities),
        },
      );
      const initialTranscriptMessages = promptTranscriptMessages();
      const messages = composeAgentModelInput(renderedPrompt.envelope, {
        transcriptMessages: initialTranscriptMessages,
      });
      const instructionInventory = captureInstructionInventory
        ? buildAgentPromptInstructionInventory(
            renderedPrompt,
            messages,
            initialTranscriptMessages,
          )
        : undefined;
      if (captureInstructionInventory && instructionInventory) {
        await emit({
          type: "provider_event",
          providerType: "instruction_harness_inventory",
          payload: {
            model: request.model || "",
            protocol: request.providerProtocol || "",
            matchedSkillIds: matchedSkills,
            ...instructionInventory,
          },
        });
      }
      const continuationSession = new AgentRunContinuationSession(messages);

      const budgetState = buildAgentContextBudgetState({
        messages,
        model: request.model,
        inputTokenCap: request.advanced?.inputTokenCap,
        apiBase: request.apiBase,
        providerProtocol: request.providerProtocol,
        authMode: request.authMode,
        profileOverride: request.advanced?.profileOverride,
        recentlyCompacted: Boolean(transcriptSegment.compactedAt),
      });
      const providerReplaySoftLimit = resolveAgentPromptBudgetLimits({
        model: request.model,
        inputTokenCap: request.advanced?.inputTokenCap,
        apiBase: request.apiBase,
        providerProtocol: request.providerProtocol,
        authMode: request.authMode,
        profileOverride: request.advanced?.profileOverride,
        outputTokenLimit: request.advanced?.outputTokenLimit,
      }).softLimitTokens;
      if (
        (budgetState.shouldCompact || transcriptSegment.compactedAt) &&
        transcriptMessagesForPrompt.length
      ) {
        await emit({ type: "status", text: "Compacting context…" });
        const compacted = compactAgentTranscript({
          messages: transcriptMessagesForPrompt,
          budget: budgetState,
          force: Boolean(transcriptSegment.compactedAt),
          conversationKey: request.conversationKey,
          resourceSignature: resourceContextPlan.resourceSignature,
        });
        if (compacted.compacted) {
          transcriptMessagesForPrompt = compacted.messages;
          transcriptSegment = {
            ...transcriptSegment,
            compactedAt: this.now(),
          };
          await persistToolResultHandles(compacted.handleRecords);
          if (compacted.handleRecords.length) toolResultReadAvailable = true;
          await persistIfLive(() =>
            replaceAgentTranscriptSegment(
              turnPathRedactor.redactTerminalValue(transcriptSegment),
            ),
          );
          await emit({ type: "context_compacted", automatic: true });
          messages.splice(
            0,
            messages.length,
            ...composeAgentModelInput(renderedPrompt.envelope, {
              transcriptMessages: promptTranscriptMessages(),
            }),
          );
        }
      }
      const newTranscriptMessages: AgentModelMessage[] = [];
      let latestProviderReplayTokens = 0;
      const commitSemanticCheckpoint = async (params: {
        sourceMessages: AgentModelMessage[];
        preservedHandleRecords?: AgentToolResultHandleRecord[];
        retryInstruction?: string;
      }): Promise<{
        checkpoint: AgentUserMessage;
        writeResult: AgentTranscriptWriteResult | undefined;
        handleCount: number;
      }> => {
        const semantic = buildAgentSemanticCheckpoint({
          messages: params.sourceMessages,
          summaryTokens: budgetState.summaryTokens,
          conversationKey: request.conversationKey,
          resourceSignature: resourceContextPlan.resourceSignature,
          preservedHandleRecords: [
            ...preservedTurnHandleRecords,
            ...(params.preservedHandleRecords || []),
          ],
        });
        const checkpoint: AgentUserMessage = {
          ...semantic.checkpoint,
          content: [
            turnPathRedactor.redactTerminalText(semantic.checkpoint.content),
            params.retryInstruction
              ? turnPathRedactor.redactTerminalText(params.retryInstruction)
              : "",
          ]
            .filter(Boolean)
            .join("\n\n"),
        };
        await persistToolResultHandles(semantic.handleRecords);
        const nextSegment = {
          ...transcriptSegment,
          compactedAt: this.now(),
        };
        const writeResult = await persistIfLive(() =>
          replaceAgentTranscriptSegment(nextSegment),
        );
        if (
          writeAllowed() &&
          (writeResult === "persisted" || writeResult === "memory_only")
        ) {
          transcriptSegment = nextSegment;
        }
        return {
          checkpoint,
          writeResult,
          handleCount: semantic.handleRecords.length,
        };
      };
      const requireAcceptedCheckpointWrite = (
        result: AgentTranscriptWriteResult | undefined,
      ): void => {
        if (result === "persisted" || result === "memory_only") return;
        throw new Error(
          result === "failed"
            ? "Agent transcript checkpoint storage failed."
            : "Agent transcript checkpoint was skipped because the conversation is no longer writable.",
        );
      };
      const persistTranscriptCheckpoint = async (
        options: {
          requireAccepted?: boolean;
        } = {},
      ): Promise<AgentTranscriptWriteResult | undefined> => {
        if (!newTranscriptMessages.length) return "skipped";
        const portable = buildPortableAgentTranscript({
          messages: [...transcriptSegment.messages, ...newTranscriptMessages],
          conversationKey: request.conversationKey,
          resourceSignature: resourceContextPlan.resourceSignature,
        });
        await persistToolResultHandles(portable.handleRecords);
        const nextSegment = {
          ...transcriptSegment,
          messages: portable.messages,
        };
        const committed = {
          writeResult: await persistIfLive(() =>
            replaceAgentTranscriptSegment(nextSegment),
          ),
        };
        if (
          committed.writeResult === "persisted" ||
          committed.writeResult === "memory_only"
        )
          transcriptSegment = nextSegment;
        if (options.requireAccepted) {
          requireAcceptedCheckpointWrite(committed.writeResult);
        }
        if (
          committed.writeResult !== "persisted" &&
          committed.writeResult !== "memory_only"
        ) {
          return committed.writeResult;
        }
        newTranscriptMessages.splice(0, newTranscriptMessages.length);
        return committed.writeResult;
      };
      const restartFromSemanticCheckpoint = async (params: {
        sourceMessages: AgentModelMessage[];
        handleRecords?: AgentToolResultHandleRecord[];
        retryInstruction?: string;
      }): Promise<void> => {
        if (newTranscriptMessages.length)
          await persistTranscriptCheckpoint({ requireAccepted: true });
        const committed = await commitSemanticCheckpoint({
          sourceMessages: params.sourceMessages,
          preservedHandleRecords: params.handleRecords,
          retryInstruction: params.retryInstruction,
        });
        requireAcceptedCheckpointWrite(committed.writeResult);
        if (committed.handleCount) {
          toolResultReadAvailable = true;
          setToolResultReadAvailability(request, true);
        }
        const restartMessages = composeAgentModelInput(
          renderedPrompt.envelope,
          {
            transcriptMessages: [],
            postTurnMessages: [
              committed.checkpoint,
              ...[
                conversationReferenceMessage,
                buildRetainedActionMessage(transcriptSegment.messages),
              ].filter((message): message is AgentUserMessage =>
                Boolean(message),
              ),
            ],
          },
        );
        continuationSession.restartWithMessages(restartMessages);
        newTranscriptMessages.splice(0, newTranscriptMessages.length);
        latestProviderReplayTokens = 0;
        adapter.resetState?.();
      };

      for (const skillId of matchedSkills) {
        await emit({ type: "status", text: `Skill activated: ${skillId}` });
      }

      let consecutiveToolErrorRounds = 0;
      // Rejected input never ran, so it is a repair opportunity, not a failing
      // tool. It gets its own, more forgiving cap.
      let consecutiveInputRejectionRounds = 0;
      const extendedRunLimits =
        request.planContext?.phase === "executing" ||
        request.metadata?.hostRecordedBatchJob === true;
      const { maxRounds, maxToolCallsPerRound } =
        resolveAgentLimits(extendedRunLimits);
      const finalAnswerController = new AgentFinalAnswerController(
        request,
        actionContractSession,
        transcriptMessagesForPrompt,
        activePlanSession,
      );
      let toolCallOverflowCorrectionUsed = false;
      const shouldFlushStreamBuffer = (value: string): boolean => {
        if (!value) return false;
        if (value.length >= 8) return true;
        return /(?:\n|[.!?,:;]\s?)$/u.test(value);
      };
      let finalizedMaterial:
        | { documentId: string; finalText: string }
        | undefined;
      // Material this run finalized, keyed by document id, so the terminal
      // event can name the exact revision the answer came from.
      const finalizedMaterialRefs = new Map<string, MaterialRef>();
      const completeRun = async (
        finalText: string,
        status: "completed" | "failed" = "completed",
        options: {
          emitFinalEvent?: boolean;
          webAttribution?: WebAttributionAssessment;
          documentId?: string;
        } = {},
      ): Promise<AgentRuntimeOutcome> => {
        if (finalizedMaterial && !options.documentId) {
          options = { ...options, documentId: finalizedMaterial.documentId };
          finalText =
            status === "failed"
              ? `${finalizedMaterial.finalText}\n\n${finalText}`
              : finalizedMaterial.finalText;
        }
        const redactedFinalText =
          turnPathRedactor.redactTerminalText(finalText);
        if (status === "failed") {
          await activePlanSession.interrupt(
            redactedFinalText ||
              "The agent run ended before the plan completed",
          );
        }
        const finalMaterialRef = options.documentId
          ? finalizedMaterialRefs.get(options.documentId)
          : undefined;
        // The transcript and the read/coverage ledgers record what this run
        // DID. Gating them on a clean finish meant a run that exhausted its
        // rounds -- or was failed by three cancellations -- threw away its own
        // memory *after* its library writes had already landed, so "continue"
        // started blind on a library that had already changed.
        //
        // recordAgentTurn stays gated below: it is the turn summary, and
        // summarising an unfinished turn as an answer would be its own lie.
        {
          await persistIfLive(() =>
            commitAgentReadActivities({
              conversationKey: request.conversationKey,
              activities: pendingReadActivities,
              resourceSignature: resourceContextPlan.resourceSignature,
            }),
          );
          await persistIfLive(() =>
            commitAgentCoverageActivities({
              conversationKey: request.conversationKey,
              activities: pendingReadActivities,
            }),
          );
          if (redactedFinalText)
            newTranscriptMessages.push({
              role: "assistant",
              content: redactedFinalText,
              messageId: `${runId}:answer`,
            });
          await persistTranscriptCheckpoint({ requireAccepted: true });
          if (status === "completed" && redactedFinalText) {
            await persistIfLive(() =>
              recordAgentTurn(
                request.conversationKey,
                turnPathRedactor.redactTerminalText(request.userText),
                toolsUsedThisTurn,
                redactedFinalText,
              ),
            );
          }
        }
        await persistIfLive(() =>
          finishAgentRun(runId, status, redactedFinalText),
        );
        runTerminalized = true;
        // The tools' citations name the sentence the retrieval picked, not the
        // sentence the answer went on to make. Re-anchor them to the claim that
        // cites them, so a chip opens the line the reader is looking at.
        //
        // The answer is already durable at this point. Citations are an
        // improvement on it, never a condition of publishing it: if
        // re-anchoring or its redaction throws, the final event and the
        // outcome still carry the answer, without citations.
        let finalQuoteCitations: QuoteCitation[] | undefined;
        try {
          finalQuoteCitations = passageCitations.quoteCitations.length
            ? turnPathRedactor.redactTerminalValue(
                this.reanchorCitations({
                  text: redactedFinalText,
                  quoteCitations: passageCitations.quoteCitations,
                  passageTextByCitationId:
                    passageCitations.passageTextByCitationId,
                }).quoteCitations,
              )
            : undefined;
        } catch (error) {
          finalQuoteCitations = undefined;
          logRuntimeWarning("LLM Agent: claim re-anchoring failed", error);
        }
        // A final event publishes a durable outcome. A UI observer may fail;
        // it must not leave an already completed answer only on screen.
        if (options.emitFinalEvent !== false) {
          await emit({
            type: "final",
            text: redactedFinalText,
            ...(options.documentId ? { documentId: options.documentId } : {}),
            ...(finalMaterialRef ? { materialRef: finalMaterialRef } : {}),
            ...(options.webAttribution?.status === "valid" &&
            options.webAttribution.anchors.length
              ? {
                  webSourceAnchors: options.webAttribution.anchors,
                }
              : {}),
            ...(finalQuoteCitations
              ? { quoteCitations: finalQuoteCitations }
              : {}),
          });
        }
        return {
          kind: "completed",
          runId,
          text: redactedFinalText,
          ...(options.documentId ? { documentId: options.documentId } : {}),
          ...(finalQuoteCitations
            ? { quoteCitations: finalQuoteCitations }
            : {}),
          usedFallback: false,
        } as const;
      };
      const emitFinalStep = async (
        step: Extract<AgentModelStep, { kind: "final" }>,
        stepStreamedText: string,
        webAttribution: WebAttributionAssessment,
        options: {
          /** Answer text already held by earlier transcript messages. */
          transcriptPrefix?: string;
        } = {},
      ): Promise<AgentRuntimeOutcome> => {
        const modelFinalText = webAttribution.cleanText;
        const receiptStatus = actionContractSession.receiptStatus();
        const finalText = receiptStatus
          ? `${modelFinalText}\n\n${receiptStatus}`
          : modelFinalText;
        if (finalText) {
          if (!stepStreamedText) {
            currentAnswerText = finalText;
            await emit({
              type: "message_delta",
              text: finalText,
            });
          } else if (finalText.startsWith(stepStreamedText)) {
            const remainder = finalText.slice(stepStreamedText.length);
            if (remainder) {
              currentAnswerText += remainder;
              await emit({
                type: "message_delta",
                text: remainder,
              });
            }
          } else {
            currentAnswerText = finalText;
          }
        }
        return await completeRun(finalText, "completed", { webAttribution });
      };
      const providerTerminalOutcomes: ToolWorkflowOutcome[] = [];
      const runModelStep = async (
        round: number,
        statusText: string,
      ): Promise<{ step: AgentModelStep; stepStreamedText: string }> => {
        if (params.signal?.aborted) {
          await persistIfLive(() =>
            finishAgentRun(
              runId,
              "cancelled",
              turnPathRedactor.redactTerminalText(currentAnswerText),
            ),
          );
          runTerminalized = true;
          throw new Error("Aborted");
        }
        await emit({
          type: "status",
          text: statusText,
        });
        let stepStreamedText = "";
        let stepPendingDelta = "";
        const flushStepDelta = async () => {
          if (!stepPendingDelta) return;
          const text = stepPendingDelta;
          stepPendingDelta = "";
          currentAnswerText += text;
          await emit({
            type: "message_delta",
            text,
          });
        };
        const rollbackStepStreamedText = async () => {
          await flushStepDelta();
          if (!stepStreamedText) return;
          currentAnswerText = currentAnswerText.slice(
            0,
            Math.max(0, currentAnswerText.length - stepStreamedText.length),
          );
          await emit({
            type: "message_rollback",
            length: stepStreamedText.length,
            text: stepStreamedText,
          });
          stepStreamedText = "";
          stepPendingDelta = "";
        };
        if (latestProviderReplayTokens > providerReplaySoftLimit) {
          const replayTokens = latestProviderReplayTokens;
          await restartFromSemanticCheckpoint({ sourceMessages: messages });
          await emit({
            type: "provider_event",
            providerType: "agent_context_budget",
            payload: {
              action: "checkpoint_provider_replay_usage",
              providerReplayTokens: replayTokens,
              softLimitTokens: providerReplaySoftLimit,
            },
          });
        }
        const preflight = enforceAgentPromptBudget({
          messages,
          model: request.model,
          inputTokenCap: request.advanced?.inputTokenCap,
          apiBase: request.apiBase,
          providerProtocol: request.providerProtocol,
          authMode: request.authMode,
          profileOverride: request.advanced?.profileOverride,
          outputTokenLimit: request.advanced?.outputTokenLimit,
          conversationKey: request.conversationKey,
          resourceSignature: resourceContextPlan.resourceSignature,
        });
        if (preflight.changed) {
          await restartFromSemanticCheckpoint({
            sourceMessages: preflight.messages,
            handleRecords: preflight.handleRecords,
          });
          await emit({
            type: "provider_event",
            providerType: "agent_context_budget",
            payload: {
              action: "compacted_model_prompt",
              beforeTokens: preflight.estimatedBeforeTokens,
              afterTokens: preflight.estimatedAfterTokens,
              softLimitTokens: preflight.softLimitTokens,
              contextWindow: preflight.contextWindow,
              reductions: preflight.reductions,
              handleCount: preflight.handleRecords.length,
            },
          });
        }
        const stepToolResultReadAvailable =
          toolResultReadAvailable || preflight.handleRecords.length > 0;
        setToolResultReadAvailability(request, stepToolResultReadAvailable);
        const stepToolSpecs = this.registry.listToolsForRequest(request);
        const stepContextWindow = preflight.contextWindow;
        const stepInputLimitIsUserAuthoritative =
          preflight.inputLimitSource === "advanced" ||
          preflight.inputLimitSource === "user";
        const stepContextTokens = preflight.estimatedAfterTokens;
        request.runtimeContextBudget = {
          contextWindowTokens: stepContextWindow,
          usedContextTokens: stepContextTokens,
        };
        if (stepContextTokens > 0 && stepContextWindow > 0) {
          await emit({
            type: "usage",
            round,
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            contextTokens: stepContextTokens,
            contextWindow: stepContextWindow,
          });
        }
        const modelInput = continuationSession.inputForNextStep();
        // The provider bills from here on, abort included, so the turn owes a
        // usage row even if this round never finishes.
        usageRecorder.markDispatched();
        const step = await adapter.runStep({
          request: resolveNoteEditModelRequest(request),
          messages: modelInput.messages,
          continuationMessages: modelInput.continuationMessages,
          tools: stepToolSpecs,
          signal: params.signal,
          onTextDelta: async (delta) => {
            if (!delta) return;
            stepStreamedText += delta;
            stepPendingDelta += delta;
            if (shouldFlushStreamBuffer(stepPendingDelta)) {
              await flushStepDelta();
            }
          },
          onReasoning: async (reasoning) => {
            if (!reasoning.summary && !reasoning.details) return;
            await emit({
              type: "reasoning",
              round,
              stepId: reasoning.stepId,
              stepLabel: reasoning.stepLabel,
              summary: reasoning.summary,
              details: reasoning.details,
            });
          },
          onUsage: async (usage) => {
            // One agent round is one provider request: its counters are
            // cumulative within the round, and each round is billed on top of
            // the previous one.
            usageRecorder.record(usage, { segment: round });
            const usageRecord = usage as unknown as Record<string, unknown>;
            const totalTokens = Math.max(0, usage.totalTokens || 0);
            const promptTokens = Math.max(0, usage.promptTokens || 0);
            const completionTokens = Math.max(0, usage.completionTokens || 0);
            const contextTokens =
              typeof usageRecord.contextTokens === "number" &&
              Number.isFinite(usageRecord.contextTokens)
                ? Math.max(0, usageRecord.contextTokens)
                : undefined;
            const providerContextWindow =
              typeof usageRecord.contextWindow === "number" &&
              Number.isFinite(usageRecord.contextWindow)
                ? Math.max(0, usageRecord.contextWindow)
                : undefined;
            const contextWindow = stepInputLimitIsUserAuthoritative
              ? stepContextWindow
              : providerContextWindow ||
                (typeof contextTokens === "number" && contextTokens > 0
                  ? stepContextWindow
                  : undefined);
            const contextWindowIsAuthoritative =
              !stepInputLimitIsUserAuthoritative &&
              usageRecord.contextWindowIsAuthoritative === true;
            const percentage =
              typeof usageRecord.percentage === "number" &&
              Number.isFinite(usageRecord.percentage)
                ? Math.max(0, Math.min(100, usageRecord.percentage))
                : undefined;
            const sessionId =
              typeof usageRecord.sessionId === "string" &&
              usageRecord.sessionId.trim()
                ? usageRecord.sessionId.trim()
                : undefined;
            const model =
              typeof usageRecord.model === "string" && usageRecord.model.trim()
                ? usageRecord.model.trim()
                : undefined;
            const cacheReadTokens =
              typeof usageRecord.cacheReadTokens === "number" &&
              Number.isFinite(usageRecord.cacheReadTokens)
                ? Math.max(0, usageRecord.cacheReadTokens)
                : undefined;
            const cacheWriteTokens =
              typeof usageRecord.cacheWriteTokens === "number" &&
              Number.isFinite(usageRecord.cacheWriteTokens)
                ? Math.max(0, usageRecord.cacheWriteTokens)
                : undefined;
            const cacheMissTokens =
              typeof usageRecord.cacheMissTokens === "number" &&
              Number.isFinite(usageRecord.cacheMissTokens)
                ? Math.max(0, usageRecord.cacheMissTokens)
                : undefined;
            const cacheHitRatio =
              typeof usageRecord.cacheHitRatio === "number" &&
              Number.isFinite(usageRecord.cacheHitRatio)
                ? Math.max(0, Math.min(1, usageRecord.cacheHitRatio))
                : undefined;
            const cacheProvider =
              typeof usageRecord.cacheProvider === "string" &&
              usageRecord.cacheProvider.trim()
                ? usageRecord.cacheProvider.trim()
                : undefined;
            latestProviderReplayTokens = Math.max(
              latestProviderReplayTokens,
              totalTokens,
              typeof contextTokens === "number" ? contextTokens : 0,
            );
            if (
              totalTokens <= 0 &&
              promptTokens <= 0 &&
              completionTokens <= 0 &&
              !(typeof contextTokens === "number" && contextTokens > 0) &&
              !(typeof contextWindow === "number" && contextWindow > 0)
            ) {
              return;
            }
            await emit({
              type: "usage",
              round,
              promptTokens,
              completionTokens,
              totalTokens,
              ...(typeof contextTokens === "number" ? { contextTokens } : {}),
              ...(typeof contextWindow === "number" ? { contextWindow } : {}),
              ...(contextWindowIsAuthoritative
                ? { contextWindowIsAuthoritative: true }
                : {}),
              ...(typeof percentage === "number" ? { percentage } : {}),
              ...(sessionId ? { sessionId } : {}),
              ...(model ? { model } : {}),
              ...(typeof cacheReadTokens === "number"
                ? { cacheReadTokens }
                : {}),
              ...(typeof cacheWriteTokens === "number"
                ? { cacheWriteTokens }
                : {}),
              ...(typeof cacheMissTokens === "number"
                ? { cacheMissTokens }
                : {}),
              ...(typeof cacheHitRatio === "number" ? { cacheHitRatio } : {}),
              ...(cacheProvider ? { cacheProvider } : {}),
            });
          },
          onToolCall: async (call) => {
            await rollbackStepStreamedText();
            const outcome = await toolExecution.executeToolWorkflow(
              call,
              round,
              {
                modelCallId: call.id,
              },
            );
            if (outcome.stopRun) providerTerminalOutcomes.push(outcome);
            newTranscriptMessages.push({
              role: "assistant",
              content: "",
              tool_calls: [call],
            });
            if (outcome.delivery) {
              newTranscriptMessages.push({
                role: "tool",
                tool_call_id: outcome.delivery.callId,
                name: outcome.delivery.name,
                workCategory: this.registry.getTool(call.name)
                  ? resolveAgentToolCallWorkCategory(
                      this.registry.getTool(call.name)!,
                      call.arguments,
                    )
                  : undefined,
                content: JSON.stringify(outcome.delivery.content ?? {}),
              });
              newTranscriptMessages.push(...outcome.delivery.followupMessages);
            }
            if (
              outcome.stopRun &&
              outcome.finalText &&
              !outcome.preserveToolOnlyTranscript
            ) {
              newTranscriptMessages.push({
                role: "assistant",
                content: outcome.finalText,
              });
            }
            await persistTranscriptCheckpoint();
            return buildAdapterToolCallResult(outcome);
          },
        });
        continuationSession.commitProviderResponse();
        await flushStepDelta();
        return {
          step,
          stepStreamedText,
        };
      };
      const requestActionResolution = async (
        action: AgentPendingAction,
      ): Promise<{
        requestId: string;
        resolution: AgentConfirmationResolution;
      }> => {
        const requestId = createConfirmationRequestId();
        const resolution = new Promise<AgentConfirmationResolution>(
          (resolve) => {
            this.pendingConfirmations.set(requestId, { resolve });
          },
        );
        await emit({
          type: "confirmation_required",
          requestId,
          action,
        });
        const settled = await resolution;
        await emit({
          type: "confirmation_resolved",
          requestId,
          approved: settled.approved,
          actionId: settled.actionId,
          data: settled.data,
        });
        return {
          requestId,
          resolution: settled,
        };
      };
      // Tool execution is its own collaborator, built once per turn with the
      // state its three functions used to reach through this method's
      // closure. The prepared-action summaries it appends to are read by the
      // finalization path below, so they stay declared here.
      const workflowSummaries: string[] = [];
      const toolExecution = createToolExecution({
        registry: this.registry,
        now: this.now,
        signal: params.signal,
        emit,
        request,
        runId,
        context,
        writeAllowed,
        adapterCapabilities,
        actionContractSession,
        activePlanSession,
        paperEvidenceFrontier,
        resourceContextPlan,
        persistToolResultHandles,
        requestActionResolution,
        finalizedMaterialRefs,
        pendingReadActivities,
        preservedTurnHandleRecords,
        toolExecutionRecords,
        toolsUsedThisTurn,
        workflowSummaries,
        getCurrentAnswerText: () => currentAnswerText,
        setFinalizedMaterial: (material) => {
          finalizedMaterial = material;
        },
        setToolResultReadAvailable: (available) => {
          toolResultReadAvailable = available;
        },
      });
      // A prepared effect already has its native identities and arguments. It
      // uses the same permission, journal and receipt path as any model call.
      let referencesClarified = false;
      if (request.actionPreparation?.state === "needs_input") {
        const clarification = await toolExecution.executeToolWorkflow(
          {
            id: `preparation:${runId}`,
            name: "request_user_input",
            arguments: {
              questions: [
                {
                  id: "reference",
                  question: request.actionPreparation.issues.join("\n"),
                  options:
                    request.actionPreparation.sourceSelection?.candidates.map(
                      (candidate) => ({
                        id: `source:${candidate.id}`,
                        label: candidate.path,
                        description:
                          "Remove this membership and preserve every other membership.",
                      }),
                    ) || [],
                },
              ],
            },
          },
          0,
          { suppressModelDelivery: true },
        );
        if (!clarification.toolResult.ok)
          return await completeRun(
            readToolError(clarification.toolResult) ||
              "The requested action is still awaiting your input.",
            "failed",
          );
        if (
          (
            request.actionPreparation as import("./contracts/actionPreparation").ActionPreparation
          ).state !== "ready"
        )
          return await completeRun(
            request.actionPreparation.issues.join("\n") ||
              "The requested references remain unresolved.",
            "failed",
          );
        referencesClarified = true;
      }
      if (request.actionProgress?.materialOutputs?.length) {
        const retained = await loadWorkflowMaterial(request);
        if (retained) {
          finalizedMaterial = {
            documentId: retained.documentId,
            finalText: retained.visibleMarkdown,
          };
          // Material re-adopted from an earlier run must reach the terminal
          // event with the same identity it was finalized under, not as a
          // bare document id.
          finalizedMaterialRefs.set(
            retained.documentId,
            materialRefFromDocument(retained),
          );
        }
      }
      let operationSequence = 0;
      context.invokeRegisteredOperation = async (name, args) => {
        const tool = this.registry.getTool(name);
        if (
          !tool ||
          tool.spec.executionClass === "control" ||
          name === "zotero_script" ||
          tool.spec.exposure === "internal" ||
          tool.isAvailable?.(request) === false
        )
          throw new Error("Unknown or unavailable registered operation.");
        const outcome = await toolExecution.executeToolWorkflow(
          {
            id: `workflow-script:${runId}:${++operationSequence}`,
            name,
            arguments: args,
          },
          0,
          { suppressModelDelivery: true, checkpointedWorkflow: true },
        );
        await actionContractSession.checkpoint();
        return outcome.toolResult;
      };
      const advanceHostWorkflow =
        async (): Promise<AgentRuntimeOutcome | null> => {
          while (true) {
            const next = await this.registry.getNextWorkflowStep(
              request,
              activePlanSession.activeWorkflowObligationIds(),
            );
            if (next.kind === "blocked")
              return await completeRun(next.reason, "failed");
            if (next.kind === "model") return null;
            if (next.kind === "complete") {
              if (!workflowSummaries.length) return null;
              const intent = request.classifiedIntent;
              const canReport =
                Boolean(finalizedMaterial) ||
                (intent?.retrievalIntent === "none" &&
                  intent.externalSearchIntent === "none" &&
                  intent.deliverableIntent === "chat");
              if (!canReport) return null;
              const decision = await actionContractSession.evaluateFinal({
                canCorrect: false,
              });
              if (decision.kind !== "accept")
                return await completeRun(
                  decision.kind === "fail"
                    ? decision.failure
                    : decision.correction,
                  "failed",
                );
              const planDecision = await activePlanSession.evaluateFinal({
                canCorrect: false,
              });
              if (planDecision.kind !== "accept") return null;
              const text =
                workflowSummaries.join("\n\n") ||
                actionContractSession.receiptStatus() ||
                "The requested actions are verified complete.";
              newTranscriptMessages.push({
                role: "assistant",
                content: finalizedMaterial?.finalText || text,
              });
              return await completeRun(text);
            }
            const prepared = next.prepared;
            await emit({
              type: "status",
              text: "Applying the next resolved action",
            });
            const result = await toolExecution.executeToolWorkflow(
              prepared.call,
              0,
              {
                suppressModelDelivery: true,
                preparedAction: prepared,
              },
            );
            if (result.failed)
              return await completeRun(
                result.finalText || "The action failed.",
                "failed",
              );
            const message: AgentUserMessage = {
              role: "user",
              content: JSON.stringify({
                type: "host_workflow_progress",
                instruction:
                  "This is verified host execution evidence. Continue only unfinished work within the frozen request; do not repeat these completed actions.",
                summary: prepared.summary,
                actionReceipts: result.toolResult.actionReceipts,
                progress: request.actionProgress,
                planProgress: activePlanSession.workflowProgress(),
              }),
            };
            continuationSession.appendHostMessage(message);
            newTranscriptMessages.push(message);
            await persistTranscriptCheckpoint({ requireAccepted: true });
          }
        };
      if (referencesClarified) {
        // The first model call must see the resolved authority, not the
        // pre-clarification prompt that correctly prohibited effects.
        renderedPrompt = await renderAgentPromptEnvelope(
          request,
          toolDefinitions,
          matchedSkills,
          resourceContextPlan,
          {
            contentInputs:
              resolveCapabilitiesContentInputs(adapterCapabilities),
          },
        );
        continuationSession.restartWithMessages(
          composeAgentModelInput(renderedPrompt.envelope, {
            transcriptMessages: promptTranscriptMessages(),
          }),
        );
      }
      const rollbackCommittedStreamedText = async (
        stepStreamedText: string,
      ): Promise<void> => {
        if (!stepStreamedText) return;
        currentAnswerText = currentAnswerText.slice(
          0,
          Math.max(0, currentAnswerText.length - stepStreamedText.length),
        );
        await emit({
          type: "message_rollback",
          length: stepStreamedText.length,
          text: stepStreamedText,
        });
      };
      // A final answer the provider cut off at its output limit stays on
      // screen and in the transcript; the model is asked for the remainder.
      let answerContinuations = 0;
      let keptAnswerVisibleText = "";
      let keptAnswerModelText = "";
      const rollbackKeptAnswer = async (): Promise<void> => {
        if (!keptAnswerVisibleText) {
          keptAnswerModelText = "";
          return;
        }
        const text = keptAnswerVisibleText;
        keptAnswerVisibleText = "";
        keptAnswerModelText = "";
        currentAnswerText = currentAnswerText.slice(
          0,
          Math.max(0, currentAnswerText.length - text.length),
        );
        await emit({
          type: "message_rollback",
          length: text.length,
          text,
        });
      };
      let round = 0;
      let segment = 1;
      let streamRecoveryUsed = false;
      const seenProgressFingerprints = new Set<string>();
      while (true) {
        const segmentRecordStart = toolExecutionRecords.length;
        for (
          let segmentRound = 1;
          segmentRound <= maxRounds;
          segmentRound += 1
        ) {
          const hostOutcome =
            approvedPlanArtifact && approvedPlanArtifact.version <= 4
              ? await advanceHostWorkflow()
              : null;
          if (hostOutcome) return hostOutcome;
          round += 1;
          let stepResult: { step: AgentModelStep; stepStreamedText: string };
          try {
            stepResult = await runModelStep(
              round,
              round === 1
                ? "Running agent"
                : segment === 1
                  ? `Continuing agent (${segmentRound}/${maxRounds})`
                  : `Continuing agent (segment ${segment}, ${segmentRound}/${maxRounds})`,
            );
          } catch (err) {
            if (err instanceof AgentPromptBudgetError) {
              return await completeRun(err.message, "failed");
            }
            throw err;
          }
          const { step, stepStreamedText } = stepResult;
          const terminalOutcome = providerTerminalOutcomes.shift();
          if (terminalOutcome) {
            return await completeRun(
              terminalOutcome.finalText || currentAnswerText,
              terminalOutcome.failed ? "failed" : "completed",
              { documentId: terminalOutcome.documentId },
            );
          }
          if (step.kind === "incomplete") {
            const truncatedAnswerText = step.text || "";
            if (
              step.reason === "output_limit" &&
              truncatedAnswerText.trim().length > 0
            ) {
              // The model was writing its answer, not a tool call: keep what
              // it wrote visible and ask only for the remainder.
              if (stepStreamedText) {
                keptAnswerVisibleText += stepStreamedText;
              } else {
                const visible =
                  turnPathRedactor.redactTerminalText(truncatedAnswerText);
                currentAnswerText += visible;
                keptAnswerVisibleText += visible;
                await emit({ type: "message_delta", text: visible });
              }
              keptAnswerModelText += truncatedAnswerText;
              const truncatedAssistantMessage: AgentAssistantMessage =
                step.assistantMessage || {
                  role: "assistant",
                  content: truncatedAnswerText,
                };
              if (
                answerContinuations >= MAX_ANSWER_CONTINUATIONS ||
                segmentRound >= maxRounds
              ) {
                newTranscriptMessages.push(truncatedAssistantMessage);
                const customLimit = request.advanced?.outputTokenLimit;
                const note =
                  customLimit?.mode === "custom"
                    ? `\n\n[This answer was cut short by the custom per-response output limit (${customLimit.tokens} tokens) ${answerContinuations + 1} times. Raise the limit in Advanced settings, or ask to continue.]`
                    : `\n\n[This answer was cut short by the provider's output limit ${answerContinuations + 1} times. Ask to continue if it is incomplete.]`;
                return await completeRun(
                  `${turnPathRedactor.redactTerminalText(keptAnswerModelText)}${note}`,
                  "completed",
                );
              }
              answerContinuations += 1;
              (
                globalThis as typeof globalThis & {
                  ztoolkit?: { log?: (...args: unknown[]) => void };
                }
              ).ztoolkit?.log?.(
                "LLM Agent: Continuing a truncated final answer",
                {
                  settingMode:
                    request.advanced?.outputTokenLimit?.mode || "auto",
                  providerStopReason: step.providerReason,
                  continuation: answerContinuations,
                  keptCharacters: keptAnswerModelText.length,
                },
              );
              newTranscriptMessages.push(
                ...continuationSession.appendFinalCorrection({
                  assistantMessage: truncatedAssistantMessage,
                  correctionMessage: {
                    role: "user",
                    content: buildAnswerContinuationInstruction(),
                  },
                }),
              );
              await persistTranscriptCheckpoint();
              continue;
            }
            if (step.reason === "stream_interrupted") {
              if (streamRecoveryUsed) {
                await rollbackCommittedStreamedText(stepStreamedText);
                return await completeRun(
                  "The response stream failed again after one automatic retry. Durable Plan progress was preserved; continue when the connection is available.",
                  "failed",
                );
              }
              streamRecoveryUsed = true;
              await emit({
                type: "status",
                text: "Response stream interrupted; retrying the unfinished step once",
              });
            }
            (
              globalThis as typeof globalThis & {
                ztoolkit?: { log?: (...args: unknown[]) => void };
              }
            ).ztoolkit?.log?.("LLM Agent: Recovering incomplete model step", {
              settingMode: request.advanced?.outputTokenLimit?.mode || "auto",
              incompleteReason: step.reason,
              providerStopReason: step.providerReason,
              recoveryCount: segmentRound,
            });
            await rollbackCommittedStreamedText(stepStreamedText);
            if (segmentRound >= maxRounds) {
              const customLimit = request.advanced?.outputTokenLimit;
              const exhaustionMessage =
                step.reason === "stream_interrupted"
                  ? "The response stream was interrupted at the model-step limit. Durable Plan progress was preserved; continue to resume the unfinished step."
                  : step.reason === "provider_pause"
                    ? "The provider repeatedly paused before completing the required structured step. Durable Plan progress was preserved; continue the plan to resume from the pending work unit."
                    : customLimit?.mode === "custom"
                      ? `The custom per-response output limit (${customLimit.tokens} tokens) repeatedly prevented the model from completing the required structured step. Raise the limit in Advanced settings, then continue; durable Plan progress was preserved.`
                      : "The provider repeatedly reached its output limit before completing the required structured step. Durable Plan progress was preserved; continue the plan to resume from the pending work unit.";
              return await completeRun(exhaustionMessage, "failed");
            }
            const assistantMessage: AgentAssistantMessage =
              step.assistantMessage || {
                role: "assistant",
                content: step.text,
              };
            newTranscriptMessages.push(
              ...continuationSession.appendFinalCorrection({
                assistantMessage,
                correctionMessage: {
                  role: "user",
                  content: step.recoveryInstruction,
                },
              }),
            );
            await persistTranscriptCheckpoint();
            continue;
          }
          if (step.kind === "final") {
            const returnedText = step.text || "";
            const streamedTextOffset = stepStreamedText
              ? returnedText.indexOf(stepStreamedText)
              : -1;
            const rawModelFinalText = stepStreamedText
              ? streamedTextOffset >= 0
                ? returnedText.slice(streamedTextOffset)
                : stepStreamedText
              : keptAnswerModelText
                ? // A kept truncated answer already holds the visible text;
                  // falling back to it (or a placeholder) would corrupt it.
                  returnedText
                : returnedText || currentAnswerText || "No response.";
            const finalDecision = await finalAnswerController.evaluate({
              candidateText: turnPathRedactor.redactTerminalText(
                `${keptAnswerModelText}${rawModelFinalText}`,
              ),
              canCorrect: segmentRound < maxRounds,
              toolExecutionRecords,
            });
            if (finalDecision.kind !== "accept") {
              await rollbackCommittedStreamedText(stepStreamedText);
              await rollbackKeptAnswer();
              if (finalDecision.kind === "correct") {
                const assistantCorrectionMessage: AgentAssistantMessage = {
                  ...(step.assistantMessage ?? {
                    role: "assistant" as const,
                    content: step.text || stepStreamedText,
                  }),
                  ...(typeof finalDecision.assistantContent === "string"
                    ? { content: finalDecision.assistantContent }
                    : {}),
                };
                const userCorrectionMessage: AgentUserMessage = {
                  role: "user",
                  content: finalDecision.correction,
                };
                continuationSession.appendFinalCorrection({
                  assistantMessage: assistantCorrectionMessage,
                  correctionMessage: userCorrectionMessage,
                });
                await persistTranscriptCheckpoint({
                  requireAccepted: Boolean(
                    finalDecision.actionContractRejection,
                  ),
                });
                if (finalDecision.actionContractRejection) {
                  actionContractSession.commitRejectedFinal(
                    finalDecision.actionContractRejection,
                  );
                }
                continue;
              }
              if (finalDecision.actionContractRejection) {
                actionContractSession.commitRejectedFinal(
                  finalDecision.actionContractRejection,
                );
              }
              return await completeRun(finalDecision.userMessage, "failed");
            }
            const answerPrefix = keptAnswerVisibleText;
            keptAnswerVisibleText = "";
            keptAnswerModelText = "";
            return await emitFinalStep(
              step,
              `${answerPrefix}${stepStreamedText}`,
              finalDecision.webAttribution,
              { transcriptPrefix: answerPrefix },
            );
          }

          // The step returned tool_calls, not a final answer.  Any text the
          // model streamed during this step is intermediate "thinking" text
          // (e.g. "Let me read more of the paper...") that should appear in
          // the agent trace but NOT in the final chat answer.  Roll it back.
          await rollbackCommittedStreamedText(stepStreamedText);
          await rollbackKeptAnswer();

          if (step.calls.length > maxToolCallsPerRound) {
            const overflowMessage = `The model returned ${step.calls.length} tool calls in one step, exceeding the safe limit of ${maxToolCallsPerRound}. None of those calls were executed.`;
            if (toolCallOverflowCorrectionUsed || segmentRound >= maxRounds) {
              return await completeRun(
                `${overflowMessage} Please narrow the request and try again.`,
                "failed",
              );
            }
            toolCallOverflowCorrectionUsed = true;
            await restartFromSemanticCheckpoint({
              sourceMessages: messages,
              retryInstruction: `${overflowMessage} Retry with a complete new step containing at most ${maxToolCallsPerRound} tool calls. Do not assume that any result exists for the rejected calls.`,
            });
            await emit({
              type: "provider_event",
              providerType: "agent_tool_call_overflow",
              payload: {
                action: "checkpoint_and_retry",
                returnedToolCalls: step.calls.length,
                maxToolCallsPerRound,
              },
            });
            continue;
          }

          const calls = step.calls;
          const assistantToolMessage: AgentAssistantMessage =
            step.assistantMessage;
          if (!calls.length) break;
          continuationSession.beginToolStep(assistantToolMessage);
          newTranscriptMessages.push(assistantToolMessage);
          const roundToolMessages: AgentToolMessage[] = [];
          const roundFollowupMessages: AgentModelMessage[] = [];
          let continuationCheckpoint:
            | NonNullable<AgentToolResult["continuationCheckpoint"]>
            | undefined;
          const appendRoundContinuation = () => {
            const delta = continuationSession.completeToolStep({
              toolMessages: roundToolMessages,
              followupMessages: roundFollowupMessages,
            });
            newTranscriptMessages.push(...delta);
          };
          let roundHadSuccessfulToolResult = false;
          let roundHadToolFailure = false;
          let roundHadInputRejection = false;
          for (const call of calls) {
            const outcome = await toolExecution.executeToolWorkflow(
              call,
              round,
              {
                modelCallId: call.id,
              },
            );
            if (outcome.toolResult.ok) roundHadSuccessfulToolResult = true;
            else if (outcome.toolResult.inputRejected)
              roundHadInputRejection = true;
            else if (!isUserDeniedToolResult(outcome.toolResult))
              roundHadToolFailure = true;
            if (
              outcome.toolResult.ok &&
              outcome.toolResult.continuationCheckpoint
            ) {
              continuationCheckpoint =
                outcome.toolResult.continuationCheckpoint;
            }
            if (outcome.delivery) {
              const toolMessage: AgentToolMessage = {
                role: "tool",
                tool_call_id: outcome.delivery.callId,
                name: outcome.delivery.name,
                workCategory: this.registry.getTool(call.name)
                  ? resolveAgentToolCallWorkCategory(
                      this.registry.getTool(call.name)!,
                      call.arguments,
                    )
                  : undefined,
                content: JSON.stringify(outcome.delivery.content ?? {}),
              };
              roundToolMessages.push(toolMessage);
              for (const followupMessage of outcome.delivery.followupMessages) {
                roundFollowupMessages.push(followupMessage);
              }
            }
            if (outcome.stopRun) {
              appendRoundContinuation();
              const stopFinalText = outcome.finalText || currentAnswerText;
              if (stopFinalText && !outcome.preserveToolOnlyTranscript) {
                newTranscriptMessages.push({
                  role: "assistant",
                  content: stopFinalText,
                });
              }
              await persistTranscriptCheckpoint();
              return await completeRun(
                stopFinalText,
                outcome.failed ? "failed" : "completed",
                {
                  documentId: outcome.documentId,
                },
              );
            }
          }
          appendRoundContinuation();
          // Sibling calls are one attempt: deliver every result before judging
          // repeated failure, so the next model round can repair their inputs.
          if (roundHadSuccessfulToolResult) {
            consecutiveToolErrorRounds = 0;
            consecutiveInputRejectionRounds = 0;
          } else {
            if (roundHadToolFailure) consecutiveToolErrorRounds += 1;
            if (roundHadInputRejection && !roundHadToolFailure)
              consecutiveInputRejectionRounds += 1;
          }
          if (
            consecutiveToolErrorRounds >= 3 ||
            consecutiveInputRejectionRounds >= 6
          ) {
            await persistTranscriptCheckpoint();
            const finalText =
              currentAnswerText ||
              (consecutiveInputRejectionRounds >= 6
                ? "Agent stopped after repeated invalid tool inputs. Please adjust the request and try again."
                : "Agent stopped after repeated tool errors. Please adjust the request and try again.");
            return await completeRun(finalText, "failed");
          }
          if (continuationCheckpoint) {
            await restartFromSemanticCheckpoint({
              sourceMessages: messages,
              retryInstruction: continuationCheckpoint.instruction,
            });
            await emit({
              type: "provider_event",
              providerType: "agent_context_budget",
              payload: {
                action: "checkpoint_durable_tool_state",
                reason: continuationCheckpoint.reason,
              },
            });
          } else {
            await persistTranscriptCheckpoint();
          }
        }

        const newFingerprints = toolExecutionRecords
          .slice(segmentRecordStart)
          .filter(
            (record) =>
              record.ok &&
              (record.mutability !== "write" ||
                record.effect === "applied" ||
                record.effect === "partial"),
          )
          .map(buildToolProgressFingerprint)
          .filter((fingerprint) => !seenProgressFingerprints.has(fingerprint));
        if (!newFingerprints.length) {
          const finalText =
            currentAnswerText ||
            `Agent stopped after segment ${segment} produced no new successful tool result. The completed transcript was saved; narrow or redirect the request before continuing.`;
          return await completeRun(finalText, "failed");
        }
        for (const fingerprint of newFingerprints) {
          seenProgressFingerprints.add(fingerprint);
        }
        // This is the durable continuation boundary. If Zotero or the model
        // process exits later, the next turn can continue from the complete
        // tool-call/result pairs checkpointed here instead of starting blind.
        await persistTranscriptCheckpoint();
        await emit({
          type: "status",
          text: `Checkpointed agent segment ${segment}; continuing`,
        });
        segment += 1;
      }
    } catch (error) {
      if (!runTerminalized)
        await planSession
          ?.interrupt(
            params.signal?.aborted
              ? "The user stopped the approved plan execution"
              : "The provider or runtime failed before the approved plan completed",
          )
          .catch(() => undefined);
      if (webSourceRunId && !runTerminalized) {
        const message = redactRunTerminalText(
          error instanceof Error ? error.message : String(error),
        );
        await persistIfLive(() =>
          finishAgentRun(
            webSourceRunId!,
            params.signal?.aborted ? "cancelled" : "failed",
            params.signal?.aborted ? message : INTERRUPTED_AGENT_RUN_MARKER,
          ),
        ).catch(() => undefined);
      }
      throw error;
    } finally {
      // Completion, provider failure, and abort all land here: write the one
      // usage row for this turn. It never throws, and it is not awaited so a
      // slow database cannot delay the turn's teardown.
      void usageRecorder.flush(params.signal?.aborted ? "abort" : "complete");
      if (webSourceRunId) clearWebSourcesForRun(webSourceRunId);
      pathLease.release();
    }
  }
}

/**
 * Cheap keyword signals from the user's text, computed once per ordinary
 * turn. They only select which tool guidance is shown; never authority.
 */
export function computeUserTextSignals(
  userText: string,
): NonNullable<AgentRuntimeRequest["userTextSignals"]> {
  return {
    mentionsDuplicates: /duplicat|merge|重复|合并/i.test(userText),
    mentionsTrash: /trash|restore|回收站|恢复/i.test(userText),
    mentionsAttachment: /attachment|rename|relink|附件/i.test(userText),
    mentionsImport: /import|导入|add .* to (my )?library/i.test(userText),
  };
}
