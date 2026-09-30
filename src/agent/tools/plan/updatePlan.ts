import { buildPaperDisplayLabels } from "../../../shared/paperDisplayLabels";
import { listScopeSnapshotItems } from "../../research/store";
import type { PlanArtifact } from "../../plans/types";
import type { AgentToolDefinition } from "../../types";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import { readOnlyInvocationPlan } from "../../authorization/invocationPlan";
import {
  preparePlanExecution,
  validateUpdatePlanInput,
  type UpdatePlanInput,
} from "../../plans/preparation";
import {
  PLAN_CONTRACT_SCHEMA,
  PLAN_EFFECT_SPECIFICATION_SCHEMA,
  PLAN_STEPS_SCHEMA,
} from "../../plans/contractSchema";
export {
  validateUpdatePlanInput,
  resolvePlanContract,
  type UpdatePlanInput,
} from "../../plans/preparation";

export function createUpdatePlanTool(
  gateway?: ZoteroGateway,
): AgentToolDefinition<UpdatePlanInput, unknown> {
  return {
    spec: {
      name: "update_plan",
      description:
        "Create or revise the structured plan. Approved steps are immutable; this tool is available only during planning. Set ready=true only when the plan is ready for user review.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["steps", "ready"],
        properties: {
          explanation: {
            type: "string",
            description:
              "User-visible explanation rendered directly in the plan card. Follow the readable paper-mention rule; exact item keys belong in the structured scope fields.",
          },
          ready: { type: "boolean" },
          contract: PLAN_CONTRACT_SCHEMA,
          effectSpecification: PLAN_EFFECT_SPECIFICATION_SCHEMA,
          steps: PLAN_STEPS_SCHEMA,
        },
      },
      executionClass: "control",
      workCategory: "planning",
    },
    /**
     * The plan machinery itself. Its calls are how a plan is drafted and
     * advanced, and the plan card already shows the reader the outcome, so a
     * row for each of them would report the trace's own plumbing.
     */
    presentation: { hiddenInTrace: true },
    isAvailable: (request) =>
      request.planContext?.phase === "planning" &&
      !request.planContext.nativePlanning,
    guidance: {
      matches: (request) => request.planContext?.phase === "planning",
      instruction:
        "update_plan takes a composable contract and its steps (the planning-phase section owns what the contract should contain). Every acceptance criterion is {criterionId,description,verifier}; the host derives completion requirements, so never provide a separate requirement list. Set ready=true only after the plan is complete for review; the host freezes the exact Zotero corpus, research policy, citation preferences, effect scope, and skill pins.",
    },
    validate: validateUpdatePlanInput,
    planInvocation: () =>
      readOnlyInvocationPlan({
        domains: [],
        reason:
          "This host-owned control updates only the active plan representation.",
      }),
    resolveTerminalResult: (input, result) => {
      if (!input.ready || !result.ok) return null;
      const artifact = (result.content as { artifact?: PlanArtifact })
        ?.artifact;
      if (artifact?.status !== "awaiting_approval") return null;
      return {
        finalText: [
          "The plan is ready for review.",
          artifact.explanation || "",
          artifact.steps
            .map((step, index) => `${index + 1}. ${step.content}`)
            .join("\n"),
        ]
          .filter(Boolean)
          .join("\n\n"),
        providerTranscript: "tool_only",
      };
    },
    execute: async (input, context) => {
      const artifact = await preparePlanExecution(input, context, gateway);
      await context.publishPlanEvent?.({
        type: input.ready ? "plan_ready" : "plan_updated",
        artifact,
      });
      const snapshot = artifact.contract?.investigation?.scopeSnapshot;
      const papers = snapshot
        ? await listScopeSnapshotItems(snapshot.snapshotId)
        : [];
      return {
        artifact,
        displayLabels: Object.fromEntries(
          buildPaperDisplayLabels(
            papers.map((paper) => ({
              ...paper,
              identity: `${paper.libraryID}:${paper.itemKey}`,
            })),
          ),
        ),
      };
    },
  };
}
