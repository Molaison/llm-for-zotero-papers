import { assert } from "chai";
import { AGENT_PERSONA_INSTRUCTIONS } from "../src/agent/model/agentPersona";
import { buildInstructionInventory } from "../src/agent/model/instructionInventory";
import {
  AGENT_ACTION_CONTRACT,
  CORE_RESEARCH_CONTRACT,
  PAPER_CITATION_CONTRACT,
  RESEARCH_RESPONSE_FORMAT_GUIDANCE,
  RUNTIME_CAPABILITY_CONTEXT,
} from "../src/shared/instructionContracts";
import { DEFAULT_SYSTEM_PROMPT } from "../src/utils/llmDefaults";
import { estimateTextTokens } from "../src/utils/modelInputCap";
import {
  BUILTIN_SKILL_FILES,
  getAllSkills,
  parseSkill,
  setUserSkills,
} from "../src/agent/skills";
import { buildAgentInitialMessages } from "../src/agent/model/messageBuilder";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";

describe("instruction harness inventory", function () {
  it("requires a numerical grounding check across the shared research routes", function () {
    for (const prompt of [
      DEFAULT_SYSTEM_PROMPT,
      AGENT_PERSONA_INSTRUCTIONS.join("\n"),
    ]) {
      assert.include(prompt, "reported values from your own calculations");
      assert.include(prompt, "units and percentage conversions");
      assert.include(prompt, "do not assume a chance baseline");
      assert.include(
        prompt,
        "class counts, ceilings or causality from accuracy alone",
      );
      assert.include(
        prompt,
        "Label inferences and correct unsupported earlier claims",
      );
      assert.include(prompt, "Missing information stays unknown");
      assert.include(prompt, "labeling a guess does not supply evidence");
    }
  });
  it("keeps discovery selection distinct from explicit imports in the fixed persona", function () {
    const prompt = AGENT_PERSONA_INSTRUCTIONS.join("\n");
    assert.include(
      prompt,
      "literature_review to present a requested discovery shortlist (calling it always opens the paper selection card; discovery never imports on its own in any mode)",
    );
    assert.include(prompt, "library_import only for explicit import requests");
    assert.notInclude(prompt, "only for imports, note saving");
  });
  it("keeps the shared semantic contracts provider-neutral", function () {
    const contracts = [
      CORE_RESEARCH_CONTRACT,
      PAPER_CITATION_CONTRACT,
      AGENT_ACTION_CONTRACT,
      RUNTIME_CAPABILITY_CONTEXT,
    ].join("\n");

    assert.notMatch(
      contracts,
      /\b(OpenAI|Anthropic|Claude|Gemini|Google|DeepSeek|MiniMax|Ollama|Codex)\b/i,
    );
  });

  it("assembles the required contracts without a percentage target", function () {
    const persona = AGENT_PERSONA_INSTRUCTIONS.join("\n");

    for (const contract of [
      CORE_RESEARCH_CONTRACT,
      PAPER_CITATION_CONTRACT,
      AGENT_ACTION_CONTRACT,
      RUNTIME_CAPABILITY_CONTEXT,
      RESEARCH_RESPONSE_FORMAT_GUIDANCE,
    ]) {
      assert.include(persona, contract);
    }
    assert.include(DEFAULT_SYSTEM_PROMPT, CORE_RESEARCH_CONTRACT);
    assert.include(DEFAULT_SYSTEM_PROMPT, PAPER_CITATION_CONTRACT);
    assert.include(DEFAULT_SYSTEM_PROMPT, RESEARCH_RESPONSE_FORMAT_GUIDANCE);
    assert.include(CORE_RESEARCH_CONTRACT, "concise but thorough");
    assert.include(
      PAPER_CITATION_CONTRACT,
      "whether the paper itself states the reason",
    );
    assert.include(PAPER_CITATION_CONTRACT, "no separate caveat paragraph");
    for (const prompt of [persona, DEFAULT_SYSTEM_PROMPT]) {
      assert.include(prompt, "derived from the paper's stated premises");
    }
    assert.include(
      RUNTIME_CAPABILITY_CONTEXT,
      "verify required output before claiming success",
    );
    assert.include(
      RESEARCH_RESPONSE_FORMAT_GUIDANCE,
      "Use tables for structured comparisons, not by default",
    );
  });

  it("keeps default skill bodies below half the previous instruction budget", function () {
    const bodies = Object.values(BUILTIN_SKILL_FILES).map(
      (raw) => parseSkill(raw).instruction,
    );
    const previousBodyTokens = 10355;
    assert.isBelow(
      bodies.reduce((total, body) => total + estimateTextTokens(body), 0),
      previousBodyTokens / 2,
    );
  });

  it("sends complete selected guidance without loading other skill bodies", async function () {
    const previous = getAllSkills();
    const skills = Object.values(BUILTIN_SKILL_FILES).map(parseSkill);
    setUserSkills(skills);
    try {
      for (const ids of [
        [],
        ["write-note"],
        ["write-note", "analyze-figures"],
        ["literature-review"],
      ]) {
        let skillTokens = 0;
        const messages = await buildAgentInitialMessages(
          resolvedAgentRequest({
            conversationKey: 918271,
            mode: "agent",
            libraryID: 1,
            model: "test-model",
            userText: "Use the supplied evidence",
            conversationKind: "global",
          }),
          [],
          ids,
          undefined,
          {
            onInstructionInventory: (inventory) => {
              skillTokens = inventory.matchedSkillTokens;
            },
          },
        );
        const text = messages.map((message) => message.content).join("\n");
        for (const skill of skills) {
          assert.equal(
            text.includes(skill.instruction),
            ids.includes(skill.id),
            skill.id,
          );
        }
        if (ids.length) assert.isAbove(skillTokens, 0);
        else assert.equal(skillTokens, 0);
      }
    } finally {
      setUserSkills(previous);
    }
  });

  it("reports fixed, tool, skill, stable, and turn surfaces separately", function () {
    const inventory = buildInstructionInventory({
      fixed: "fixed behavior",
      tools: [
        {
          spec: {
            name: "demo_tool",
            description: "Demonstrate a tool.",
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" } },
            },
          },
          validate: () => ({ ok: true, value: {} }),
          execute: async () => ({ content: {} }),
        },
      ],
      matchedSkills: ["skill workflow"],
      dynamicGuidance: "turn-specific rule",
      stableResource: "stable evidence",
      turnResource: "current resource evidence",
      providerMessages: [
        { role: "system", content: "fixed behavior" },
        { role: "user", content: "current resource evidence" },
      ],
    });

    assert.isAbove(inventory.fixedTokens, 0);
    assert.isAbove(inventory.toolTokens, 0);
    assert.isAbove(inventory.matchedSkillTokens, 0);
    assert.isAbove(inventory.dynamicGuidanceTokens, 0);
    assert.isAbove(inventory.stableResourceTokens, 0);
    assert.isAbove(inventory.turnResourceTokens, 0);
    assert.equal(
      inventory.categorizedTotalTokens,
      inventory.fixedTokens +
        inventory.toolTokens +
        inventory.matchedSkillTokens +
        inventory.dynamicGuidanceTokens +
        inventory.stableResourceTokens +
        inventory.turnResourceTokens,
    );
    assert.isAbove(inventory.providerBoundTokens, 0);
    assert.match(inventory.promptHash, /^fnv1a32-[0-9a-f]{8}$/);
  });
});
