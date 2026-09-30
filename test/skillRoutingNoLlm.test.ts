import { assert } from "chai";
import {
  BUILTIN_SKILL_FILES,
  getAllSkills,
  parseSkill,
  setUserSkills,
  type AgentSkill,
} from "../src/agent/skills";
import type {
  AgentEvent,
  AgentModelMessage,
  AgentRuntimeRequestInput,
} from "../src/agent/types";
import type {
  AgentModelStep,
  AgentStepParams,
} from "../src/agent/model/adapter";
import { AgentRuntime } from "../src/agent/runtime";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { resolveAgentRuntimeRequest } from "../src/agent/context/resolvedAgentRequest";
import { renderAgentPromptEnvelope } from "../src/agent/model/messageBuilder";
import { initAgentTraceStore } from "../src/agent/store/traceStore";
import { initConversationKeyLedgerStore } from "../src/shared/conversationKeyLedger";
import { installMockDb } from "./helpers/agentRuntimeMockDb";
import {
  installResearchHarness,
  type ResearchHarness,
} from "./helpers/researchHarness";

/**
 * Skill guidance never costs a model request. A turn renders a skill body only
 * when the user forced it or an approved plan pinned it; otherwise the model
 * sees the installed inventory and calls load_skill itself.
 */

const SHIPPED_SKILL_IDS = [
  "analyze-figures",
  "compare-papers",
  "evidence-based-qa",
  "import-to-library",
  "library-analysis",
  "literature-review",
  "write-note",
];

type ToolkitGlobal = typeof globalThis & { ztoolkit?: unknown };

function promptText(messages: AgentModelMessage[]): string {
  return messages
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content
            .map((part) => (part.type === "text" ? part.text : ""))
            .join("\n"),
    )
    .join("\n");
}

/**
 * Runs one turn against a model that answers on its first request, counting
 * every HTTP request (the utility model's only transport) and every main-model
 * request.
 */
async function runOneTurn(request: Partial<AgentRuntimeRequestInput>): Promise<{
  httpRequests: number;
  httpRequestsBeforeFirstStep: number;
  modelRequests: number;
  prompt: string;
  loadedSkillIds: string[];
  events: AgentEvent[];
}> {
  const scope = globalThis as ToolkitGlobal;
  const originalToolkit = scope.ztoolkit;
  let httpRequests = 0;
  let httpRequestsBeforeFirstStep = -1;
  let modelRequests = 0;
  let prompt = "";
  let loadedSkillIds: string[] = [];
  const events: AgentEvent[] = [];
  scope.ztoolkit = {
    log: () => undefined,
    getGlobal: (name: string) => {
      if (name !== "fetch")
        return (globalThis as Record<string, unknown>)[name];
      return async () => {
        httpRequests += 1;
        throw new Error("no network in unit tests");
      };
    },
  };
  const restoreDb = installMockDb();
  try {
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
          modelRequests += 1;
          if (modelRequests === 1) {
            httpRequestsBeforeFirstStep = httpRequests;
            prompt = promptText(params.messages);
            loadedSkillIds = (params.request.loadedSkillRecords || []).map(
              (record) => record.id,
            );
          }
          return {
            kind: "final",
            text: "Done.",
            assistantMessage: { role: "assistant", content: "Done." },
          };
        },
      }),
    });
    await runtime.runTurn({
      request: {
        conversationKey: 93_001,
        libraryID: 1,
        mode: "agent",
        userText: "Summarize this paper.",
        // A configured model, so a utility call would really be attempted.
        model: "gpt-5.4",
        apiKey: "test",
        apiBase: "https://example.invalid/v1",
        ...request,
      },
      onEvent: (event) => {
        events.push(event);
      },
    });
  } finally {
    restoreDb();
    scope.ztoolkit = originalToolkit;
  }
  return {
    httpRequests,
    httpRequestsBeforeFirstStep,
    modelRequests,
    prompt,
    loadedSkillIds,
    events,
  };
}

describe("skill routing without a model call", function () {
  let installedSkills: AgentSkill[] = [];

  beforeEach(function () {
    installedSkills = [...getAllSkills()];
    setUserSkills(
      Object.values(BUILTIN_SKILL_FILES).map((raw) => parseSkill(raw)),
    );
  });

  afterEach(function () {
    setUserSkills(installedSkills);
  });

  it("answers an ordinary single-paper turn with one model request and no skill block", async function () {
    const turn = await runOneTurn({
      selectedPaperContexts: [
        { itemId: 10, contextItemId: 11, title: "Paper" },
      ],
    });

    assert.equal(turn.httpRequestsBeforeFirstStep, 0, "no utility request");
    assert.equal(turn.httpRequests, 0);
    assert.equal(turn.modelRequests, 1);
    assert.deepEqual(turn.loadedSkillIds, []);
    assert.notInclude(turn.prompt, "### Skill:");
    assert.notInclude(turn.prompt, "Active skills for this turn");
    assert.isFalse(
      turn.events.some(
        (event) =>
          event.type === "provider_event" &&
          event.providerType === "agent_skill_selection",
      ),
    );
    assert.isFalse(
      turn.events.some(
        (event) =>
          event.type === "status" && event.text.startsWith("Skill activated"),
      ),
    );
  });

  it("renders the write-note block for a forced $write-note turn", async function () {
    const turn = await runOneTurn({
      userText: "$write-note\n\nSave a summary of this paper as a note.",
      forcedSkillIds: ["write-note"],
      selectedPaperContexts: [
        { itemId: 10, contextItemId: 11, title: "Paper" },
      ],
    });

    assert.equal(turn.httpRequests, 0);
    assert.equal(turn.modelRequests, 1);
    assert.deepEqual(turn.loadedSkillIds, ["write-note"]);
    assert.include(turn.prompt, "### Skill: write-note");
    assert.include(turn.prompt, "Activation: explicit slash selection");
    assert.notInclude(turn.prompt, "### Skill: evidence-based-qa");
  });

  it("lists the shipped skills, without the retired one, as a load_skill inventory", async function () {
    setUserSkills([
      ...getAllSkills(),
      parseSkill(
        [
          "---",
          "id: slash-only",
          "description: A workflow the user applies only from the slash menu",
          "version: 1",
          "activation: manual",
          "---",
          "Slash-only instructions.",
        ].join("\n"),
      ),
    ]);
    const request = resolveAgentRuntimeRequest({
      conversationKey: 1,
      mode: "agent",
      userText: "Summarize this paper.",
      libraryID: 1,
    });
    const rendered = await renderAgentPromptEnvelope(request, [], []);
    const line = rendered.inventory.fixedPrompt
      .split("\n")
      .find((entry) => entry.startsWith("Installed skill inventory"));
    assert.isString(line);
    assert.include(line, "call load_skill");
    assert.notInclude(line, "automatic selection");
    const inventory = JSON.parse(
      (line as string).slice((line as string).indexOf("["), line!.length),
    ) as Array<Record<string, unknown>>;
    assert.deepEqual(
      inventory.map((entry) => entry.id),
      SHIPPED_SKILL_IDS,
    );
    for (const entry of inventory) {
      assert.deepEqual(Object.keys(entry), ["id", "description"]);
    }
    assert.notInclude(line, "simple-paper-qa");
    assert.notInclude(line, "slash-only");
  });

  describe("an executing investigation plan", function () {
    let harness: ResearchHarness | undefined;

    beforeEach(function () {
      harness = installResearchHarness({ conversationKey: 93_002 });
    });

    afterEach(function () {
      harness?.close();
      harness = undefined;
    });

    it("still renders the literature-review block", async function () {
      const ledger = await harness!.approve();
      await initAgentTraceStore();
      await initConversationKeyLedgerStore();
      let prompt = "";
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
            prompt = promptText(params.messages);
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
      assert.include(prompt, "### Skill: literature-review");
    });
  });
});
