import { ActionAuthorizationService } from "../../authorization/service";
import { createActionReviewer } from "../../model/actionReview";
import { resolveActionInteraction } from "../../authorization/interaction";
import { defaultInvocationPlan } from "../../authorization/invocationPlan";
import { authorizeExternalAction } from "../../authorization/policy";
import { buildActionProposal } from "../../authorization/proposal";
import type {
  ActionInteraction,
  ActionProposal,
  AuthorizationDecision,
  ActionReviewRecord,
} from "../../authorization/types";
import {
  ActionContractService,
  type PreparedActionExecution,
  type ScopeValidationFailure,
} from "../../contracts/actionContract";
import { prepareActionExecution } from "../../contracts/actionOperationEvidence";
import { preparationEffectBlock } from "../../contracts/actionPreparation";
import { getOriginalAgentPermissionMode } from "../../originalAgentPermissionMode";
import { isAgentChangeJournalAvailable } from "../../store/changeJournal";
import { evaluateHostAccess } from "../../authorization/hostAccess";
import type {
  AgentInvocationPlan,
  AgentToolContext,
  AgentToolDefinition,
  PreparedToolExecutionOptions,
} from "../../types";

export type AssessedInvocation = {
  input: unknown;
  plan: AgentInvocationPlan;
  preparedAction?: PreparedActionExecution;
  proposal: ActionProposal;
  scopeFailure: ScopeValidationFailure | null;
  interaction: ActionInteraction;
  authorization: AuthorizationDecision;
  review?: ActionReviewRecord;
};

function completePlan(value: unknown): value is AgentInvocationPlan {
  if (!value || typeof value !== "object") return false;
  const plan = value as Record<string, unknown>;
  return (
    ["none", "shell", "zotero_script"].includes(String(plan.mechanism)) &&
    ["read_only", "state_change", "ambiguous", "prohibited"].includes(
      String(plan.impact),
    ) &&
    ["runtime_enforced", "statically_recognized", "unknown"].includes(
      String(plan.assurance),
    ) &&
    ["domains", "effects", "targets", "riskSignals"].every((key) =>
      Array.isArray(plan[key]),
    ) &&
    ["full", "partial", "none"].includes(String(plan.reversibility)) &&
    typeof plan.reason === "string" &&
    Boolean(plan.reason.trim())
  );
}

function positiveInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function explicitLibraryIDs(value: unknown, depth = 0): number[] {
  if (!value || typeof value !== "object" || depth > 5) return [];
  if (Array.isArray(value))
    return value.flatMap((entry) => explicitLibraryIDs(entry, depth + 1));
  return Object.entries(value as Record<string, unknown>).flatMap(
    ([key, entry]) => {
      if (key === "libraryID") {
        const libraryID = positiveInteger(entry);
        return libraryID ? [libraryID] : [];
      }
      return explicitLibraryIDs(entry, depth + 1);
    },
  );
}

function nativeTargetLibraryIDs(
  requestedTargets: readonly string[],
  destinationCollectionIds: readonly number[],
): number[] {
  const ids: number[] = [];
  const zotero = globalThis.Zotero;
  for (const target of requestedTargets) {
    const itemMatch = /^item:(\d+)$/.exec(target);
    const collectionMatch = /^collection:(\d+)$/.exec(target);
    const savedSearchMatch = /^saved-search:(\d+)$/.exec(target);
    const nativeObject = itemMatch
      ? zotero?.Items?.get?.(Number(itemMatch[1]))
      : collectionMatch
        ? zotero?.Collections?.get?.(Number(collectionMatch[1]))
        : savedSearchMatch
          ? zotero?.Searches?.get?.(Number(savedSearchMatch[1]))
          : null;
    const libraryID = positiveInteger(nativeObject?.libraryID);
    if (libraryID) ids.push(libraryID);
  }
  for (const collectionId of destinationCollectionIds) {
    const collection = zotero?.Collections?.get?.(collectionId);
    const libraryID = positiveInteger(collection?.libraryID);
    if (libraryID) ids.push(libraryID);
  }
  return ids;
}

/** Exact invocation assessment is shared by preparation, edited review and execution. */
export class InvocationAssessor {
  private readonly authorizationService: ActionAuthorizationService;

  constructor(
    readonly tool: AgentToolDefinition<any, any>,
    readonly context: AgentToolContext,
    readonly options: PreparedToolExecutionOptions,
    readonly contracts?: ActionContractService,
  ) {
    this.authorizationService = new ActionAuthorizationService(
      context.reviewAction || createActionReviewer(context.request),
    );
  }

  async assess(
    input: unknown,
    concreteWrite = true,
  ): Promise<AssessedInvocation> {
    const { tool, context, options, contracts } = this;
    const request = context.request;
    const delegated = context.authorization?.kind === "external_runtime";
    const plan = await (
      tool.planInvocation ||
      (() => defaultInvocationPlan(tool.spec.executionClass))
    )(input, context);
    if (!completePlan(plan))
      throw new Error(
        `${tool.spec.name} returned an incomplete AgentInvocationPlan. Execution was refused.`,
      );
    const preparedAction =
      tool.spec.executionClass === "external_effect"
        ? await (contracts
            ? contracts.prepare(tool, input, context)
            : prepareActionExecution(tool, input, context))
        : undefined;
    const chatLibraryID =
      request.executionContext?.chatLibraryID ||
      positiveInteger(request.libraryID) ||
      undefined;
    const targetLibraryIDs = [
      ...explicitLibraryIDs(input),
      ...nativeTargetLibraryIDs(
        preparedAction?.requestedTargets || [],
        preparedAction?.destinationCollectionIds || [],
      ),
    ];
    if (
      !targetLibraryIDs.length &&
      plan.domains.includes("zotero_library") &&
      chatLibraryID
    )
      targetLibraryIDs.push(chatLibraryID);
    const proposal = buildActionProposal({
      tool,
      input,
      plan,
      typedProposals: preparedAction?.proposals,
      targetLibraryIDs,
      intentBinding: {
        conversationKey: request.conversationKey,
        conversationGeneration: request.conversationGeneration,
        actionContractId: request.actionContract?.id,
        userText: request.userText,
      },
    });
    const effect =
      tool.spec.executionClass === "external_effect" &&
      plan.impact !== "read_only";
    const hostAction =
      Boolean(options.inheritedApproval) ||
      (options.callerKind === "action" &&
        request.actionEntryPoint !== "conversation");
    const directAgent =
      request.executionContext?.permissionOwner === "original_agent";
    const hostAccess =
      request.executionContext && delegated
        ? await evaluateHostAccess({
            toolName: tool.spec.name,
            plan,
            executionContext: request.executionContext,
          })
        : ({ kind: "allow" } as const);
    const hostAccessAuthorization: AuthorizationDecision | null =
      hostAccess.kind === "allow"
        ? null
        : hostAccess.kind === "block" ||
            (delegated && context.authorization?.standalone)
          ? { kind: "block", reason: hostAccess.reason }
          : { kind: "confirm", reason: hostAccess.reason };
    const enforceContract =
      !delegated &&
      !directAgent &&
      (!hostAction || Boolean(context.journalActionScope));
    const preparationBlock =
      hostAction || delegated || directAgent
        ? null
        : preparationEffectBlock(request, plan);
    if (preparationBlock) throw new Error(preparationBlock);
    if (
      effect &&
      (!preparedAction?.hasExplicitAdapter || !preparedAction.proposals.length)
    )
      throw new Error(
        `External effect blocked for ${tool.spec.name}: no typed action adapter describes its exact operation, capability, proof domain, and targets.`,
      );
    if (
      effect &&
      !delegated &&
      !directAgent &&
      !hostAction &&
      contracts &&
      !request.actionContract
    )
      throw new Error(
        `Mutation blocked for ${tool.spec.name}: no validated action contract exists for this request.`,
      );
    if (
      enforceContract &&
      request.actionContract &&
      plan.impact !== "read_only" &&
      !contracts
    )
      throw new Error(
        `Write blocked: ${tool.spec.name} has no configured Action Contract verifier.`,
      );
    const scopeValidated = Boolean(
      enforceContract &&
      plan.impact !== "read_only" &&
      preparedAction &&
      request.actionContract &&
      contracts,
    );
    const scopeFailure = scopeValidated
      ? await contracts!.validateScope(
          request.actionContract!,
          preparedAction!,
          {
            allowPartialCoverage: Boolean(
              options.checkpointedWorkflow ||
              (options.callerKind === "action" && context.journalActionScope),
            ),
            concreteWrite: concreteWrite && plan.impact !== "read_only",
            progress: request.actionProgress,
          },
        )
      : null;
    if (
      !scopeFailure &&
      plan.impact !== "read_only" &&
      !isAgentChangeJournalAvailable()
    )
      throw new Error(
        `${tool.spec.name} was refused because the durable change journal is unavailable. Effects cannot run without restart-safe authorization and recovery.`,
      );
    const interaction = resolveActionInteraction(
      request,
      preparedAction?.proposals || [],
      // Native action pages are explicitly requested editing/review workflows.
      // A model's generic review hint cannot override Auto or YOLO permissions.
      Boolean(options.forceConfirmation && options.callerKind === "action"),
    );
    if (delegated) proposal.runtime = "external";
    const directDecision = hostAccessAuthorization
      ? hostAccessAuthorization
      : delegated
        ? authorizeExternalAction(proposal)
        : null;
    const decision = directDecision
      ? { authorization: directDecision }
      : await this.authorizationService.assess(
          proposal,
          {
            mode: getOriginalAgentPermissionMode(),
            interaction,
            executionContext: request.executionContext,
            constraints:
              request.actionContract?.intent?.semantic?.constraints || [],
            semantic: request.executionContext
              ? undefined
              : request.classifiedIntent?.semantic ||
                request.actionContract?.intent?.semantic,
            hasMatchingActionIntent:
              hostAction ||
              Boolean(
                scopeValidated &&
                !scopeFailure &&
                preparedAction?.proposals.length &&
                request.actionContract?.obligations.length,
              ),
          },
          {
            input,
            userRequest: request.userText,
            currentTurnActions: context.readCurrentTurnActions?.(),
            clarifications: request.clarificationHistory || [],
            conversation: (request.history || [])
              .filter(
                (message) =>
                  (message.role === "user" || message.role === "assistant") &&
                  typeof message.content === "string",
              )
              .slice(-6)
              .map((message) => ({
                role: message.role as "user" | "assistant",
                text: String(message.content),
              })),
            userInstructions: request.customInstructions,
            workspace: request.executionContext?.workspaceSnapshot || null,
            constraints:
              request.actionContract?.intent?.semantic?.constraints || [],
          },
          context.signal,
        );
    return {
      input,
      plan,
      preparedAction,
      proposal,
      scopeFailure,
      interaction,
      ...decision,
    };
  }
}
