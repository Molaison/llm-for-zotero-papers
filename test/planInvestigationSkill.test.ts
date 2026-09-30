import { assert } from "chai";
import {
  PLAN_INVESTIGATION_SKILL_ID,
  withPlanInvestigationSkill,
} from "../src/agent/skills/planBindings";
import {
  BUILTIN_SKILL_FILES,
  getAllSkills,
  setUserSkills,
  type AgentSkill,
} from "../src/agent/skills";
import { parseSkill } from "../src/agent/skills/skillLoader";
import type { AgentModelMessage } from "../src/agent/types";
import type {
  AgentModelStep,
  AgentStepParams,
} from "../src/agent/model/adapter";
import { AgentRuntime } from "../src/agent/runtime";
import { initAgentTraceStore } from "../src/agent/store/traceStore";
import { initConversationKeyLedgerStore } from "../src/shared/conversationKeyLedger";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { EXECUTING_PHASE_GUIDANCE } from "../src/agent/plans/planningGuidance";
import {
  installResearchHarness,
  type ResearchHarness,
} from "./helpers/researchHarness";

/**
 * The research-loop rules live in the literature-review skill, so an approved
 * plan with an investigation must carry that skill on every executing turn
 * even when skill routing never selected it.
 */
describe("plan investigation skill binding", function () {
  it("adds the literature-review skill only for a contract with an investigation", function () {
    const skills = [{ id: PLAN_INVESTIGATION_SKILL_ID }, { id: "write-note" }];
    assert.deepEqual(
      withPlanInvestigationSkill(["write-note"], { investigation: {} }, skills),
      ["write-note", PLAN_INVESTIGATION_SKILL_ID],
    );
    assert.deepEqual(
      withPlanInvestigationSkill(
        [PLAN_INVESTIGATION_SKILL_ID],
        { investigation: {} },
        skills,
      ),
      [PLAN_INVESTIGATION_SKILL_ID],
      "never duplicated",
    );
    assert.deepEqual(withPlanInvestigationSkill(["write-note"], {}, skills), [
      "write-note",
    ]);
    assert.deepEqual(withPlanInvestigationSkill(["write-note"], null, skills), [
      "write-note",
    ]);
    assert.deepEqual(
      withPlanInvestigationSkill(["write-note"], { investigation: {} }, []),
      ["write-note"],
      "an uninstalled skill is never invented",
    );
  });

  describe("an executing turn of an approved investigation", function () {
    let harness: ResearchHarness | undefined;
    let installedSkills: AgentSkill[] = [];

    beforeEach(function () {
      installedSkills = [...getAllSkills()];
      // The shipped skill, as a fresh install has it on disk.
      setUserSkills([parseSkill(BUILTIN_SKILL_FILES["literature-review.md"])]);
      harness = installResearchHarness({ conversationKey: 91_004 });
    });

    afterEach(function () {
      harness?.close();
      harness = undefined;
      setUserSkills(installedSkills);
    });

    it("renders the research-loop rules and the executing section without skill routing", async function () {
      const ledger = await harness!.approve();
      // The runtime persists its run trace in the harness database.
      await initAgentTraceStore();
      await initConversationKeyLedgerStore();
      let promptMessages: AgentModelMessage[] = [];
      const runtime = new AgentRuntime({
        registry: new AgentToolRegistry(),
        adapterFactory: () => ({
          getCapabilities: () => ({
            streaming: false,
            toolCalls: true,
            multimodal: false,
          }),
          supportsTools: () => true,
          async runStep(params: AgentStepParams): Promise<AgentModelStep> {
            promptMessages = params.messages;
            // Stop after the first request; only the rendered prompt matters.
            throw new Error("prompt captured");
          },
        }),
      });
      await runtime
        .runTurn({
          request: {
            conversationKey: harness!.conversationKey,
            mode: "agent",
            userText: "Continue the approved plan",
            libraryID: harness!.libraryID,
            model: "test",
            apiKey: "test",
            apiBase: "https://example.invalid",
            planContext: {
              phase: "executing",
              planId: harness!.planId,
              revision: 1,
              executionId: ledger.executionId,
              approvedDigest: ledger.planDigest,
              activeTaskId: ledger.activeTaskId,
              provider: "original",
            },
          },
        })
        .catch((error) => {
          if (!String(error).includes("prompt captured")) throw error;
        });
      const prompt = promptMessages
        .map((message) =>
          typeof message.content === "string"
            ? message.content
            : message.content
                .map((part) => (part.type === "text" ? part.text : ""))
                .join("\n"),
        )
        .join("\n");
      assert.isNotEmpty(prompt, "the model was called");
      assert.include(prompt, "### Skill: literature-review");
      assert.include(prompt, EXECUTING_PHASE_GUIDANCE);
    });
  });
});
