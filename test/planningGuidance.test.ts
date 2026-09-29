import { assert } from "chai";
import { renderAgentPromptEnvelope } from "../src/agent/model/messageBuilder";
import {
  EXECUTING_PHASE_GUIDANCE,
  PLANNING_PHASE_GUIDANCE,
} from "../src/agent/plans/planningGuidance";
import type { PlanRuntimeContext } from "../src/agent/plans/types";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";

/**
 * The plan workflow narrative has one owner per phase: a system section the
 * envelope renders only while the plan is in that phase. The plan tools keep
 * only their argument contracts.
 */
function request(planContext?: PlanRuntimeContext) {
  return resolvedAgentRequest({
    conversationKey: 912001,
    mode: "agent",
    model: "test-model",
    userText: "Review these papers",
    ...(planContext ? { planContext } : {}),
  });
}

const planning: PlanRuntimeContext = {
  phase: "planning",
  planId: "plan-guidance",
  revision: 1,
  provider: "original",
};

const executing: PlanRuntimeContext = {
  phase: "executing",
  planId: "plan-guidance",
  revision: 1,
  executionId: "execution-guidance",
  approvedDigest: "sha256:guidance",
  provider: "original",
};

async function fixedPrompt(planContext?: PlanRuntimeContext) {
  // No tools: the sections must not depend on any tool's guidance.
  const rendered = await renderAgentPromptEnvelope(
    request(planContext),
    [],
    [],
  );
  return rendered.inventory.fixedPrompt;
}

describe("plan phase guidance", function () {
  it("renders the planning section only while planning", async function () {
    const prompt = await fixedPrompt(planning);
    assert.include(prompt, PLANNING_PHASE_GUIDANCE);
    assert.notInclude(prompt, EXECUTING_PHASE_GUIDANCE);
  });

  it("renders the executing section only while executing", async function () {
    const prompt = await fixedPrompt(executing);
    assert.include(prompt, EXECUTING_PHASE_GUIDANCE);
    assert.notInclude(prompt, PLANNING_PHASE_GUIDANCE);
  });

  it("renders neither section outside a plan", async function () {
    const prompt = await fixedPrompt();
    assert.notInclude(prompt, PLANNING_PHASE_GUIDANCE);
    assert.notInclude(prompt, EXECUTING_PHASE_GUIDANCE);
  });

  it("owns the planning contract rules moved out of update_plan", function () {
    for (const rule of [
      "You are planning, not executing",
      "omit investigation unless it requires open-ended research or corpus screening",
      "stable effectId, exact operation, host-resolved target identities",
      "Bind every mutation step to its effectIds",
      "Use a deferredEffect only when research must choose the exact targets",
      "add an earlier artifact step with materialOutputId and material_integrity",
      "never call a write, command, script, import, upload, or settings tool",
      "three stable steps",
      "verified_read on the reading step, research_coverage on the relationship-synthesis step, and document_integrity plus document_published",
      "resolve it with one bounded metadata query",
      "omit include",
      "never use zotero_script just to recover keys",
      "Never freeze the containing collection or library instead",
      "do not add an execution step that re-enumerates or verifies it",
      "reviewMode:'narrative', readingStrategy:'adaptive', criteria:[], requiredEvidenceDepth:'body', and estimatedDeepReadPapers:0",
      "never invent a paper quota",
      "reviewMode:'scoping' when the user wants a field map",
      "reviewMode:'systematic', readingStrategy:'selected'",
      "deliverable:{kind:'document',spec:{kind:'literature_review',title,requiredSections,requiresReferences:true,requiresCoverageSection:true,allowFigures:false}}",
      "Omit effectSpecification unless the user explicitly requested an effectful action",
      "mutation_receipts only on a mutation criterion and bounded_reasoning only",
    ]) {
      assert.include(PLANNING_PHASE_GUIDANCE, rule);
    }
  });

  it("owns the executing rules moved out of amend_plan and the approval tools", function () {
    for (const rule of [
      "amend_plan research_scope when newly discovered papers are host-provably inside the approved source",
      "contract_revision for a changed question, source boundary, deliverable, operation, or parameters",
      "Never describe imports or Zotero mutations as research-scope amendments",
      "When research_update reports checkpointRequired, stop deep reading and call approve_research_expansion",
      "Do not raise the ceiling through research_update",
      "finalize a partial result at the user's direction or revise the plan to narrow scope",
      "do not call a Zotero write tool until research is terminal and approve_research_mutation has frozen and authorized",
      "Targets use stable libraryID/itemKey pairs from paper findings",
      "use only write calls covered by those derived effects",
      "mark only the mutation task skipped and preserve the research document",
    ]) {
      assert.include(EXECUTING_PHASE_GUIDANCE, rule);
    }
  });
});
