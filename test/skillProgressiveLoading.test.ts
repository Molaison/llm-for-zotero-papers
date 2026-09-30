import { assert } from "chai";
import {
  buildSkillInventory,
  loadSkill,
} from "../src/agent/skills/progressiveLoading";
import type { AgentSkill } from "../src/agent/skills/skillLoader";
import { parseSkill } from "../src/agent/skills/skillLoader";
import {
  createLoadSkillTool,
  type LoadSkillResult,
} from "../src/agent/tools/read/loadSkill";

const BEGIN = "<!-- LLM-FOR-ZOTERO:MANAGED-BEGIN -->";
const END = "<!-- LLM-FOR-ZOTERO:MANAGED-END -->";

function skill(overrides: Partial<AgentSkill> = {}): AgentSkill {
  return {
    id: "write-note",
    name: "Write Note",
    description: "Create a durable note from research evidence",
    version: 3,
    contexts: ["single-paper", "note"],
    activation: "both",
    instruction: "Full instructions that must not appear in inventory.",
    source: "system",
    ...overrides,
  };
}

describe("progressive skill loading", function () {
  it("builds a stable metadata-only inventory", function () {
    const inventory = buildSkillInventory([
      skill({ id: "z-skill", name: undefined }),
      skill({ id: "a-skill", name: "Readable Name", activation: "manual" }),
    ]);

    assert.deepEqual(
      inventory.map((entry) => entry.id),
      ["a-skill", "z-skill"],
    );
    assert.equal(inventory[0].name, "Readable Name");
    assert.equal(inventory[1].name, "z-skill");
    assert.deepEqual(inventory[0].contexts, ["single-paper", "note"]);
    assert.equal(inventory[0].activation, "manual");
    assert.notInclude(JSON.stringify(inventory), "Full instructions");
  });

  it("uses the native frontmatter name when one is present", function () {
    const parsed = parseSkill(`---
id: compact-id
name: Human Readable Name
description: A precise workflow description for testing
version: 2
contexts: any
activation: auto
---

Complete instructions.`);

    assert.equal(buildSkillInventory([parsed])[0].name, "Human Readable Name");
  });

  it("loads the complete body and records its exact version and fingerprint", async function () {
    const current = skill();
    const loaded = await loadSkill(current);
    const repeated = await loadSkill(current);
    const changed = await loadSkill(
      skill({ instruction: `${current.instruction}\nChanged.` }),
    );

    assert.equal(loaded.instructions, current.instruction);
    assert.deepEqual(loaded.loadedSkill, repeated.loadedSkill);
    assert.deepEqual(Object.keys(loaded.loadedSkill).sort(), [
      "id",
      "instructionFingerprint",
      "source",
      "version",
    ]);
    assert.match(
      loaded.loadedSkill.instructionFingerprint,
      /^sha256:[a-f0-9]+$/,
    );
    assert.notEqual(
      loaded.loadedSkill.instructionFingerprint,
      changed.loadedSkill.instructionFingerprint,
    );
  });

  it("returns complete managed customizations with a truthful banner", async function () {
    const shipped = `Shipped intro.\n${BEGIN}\nDefaults.\n${END}`;
    const instructions = `Use short titles.\n${BEGIN}\nDefaults.\n${END}\nSave in Research Notes.`;
    const loaded = await loadSkill(
      skill({ instruction: instructions, source: "customized" }),
      shipped,
    );

    assert.equal(loaded.instructions, instructions);
    assert.include(loaded.customizationNotice || "", "before and after");
    assert.include(loaded.customizationNotice || "", "current request");
  });

  it("keeps full personal and legacy customized instructions", async function () {
    const personal = await loadSkill(
      skill({
        id: "my-workflow",
        instruction: "Every line is mine.",
        source: "personal",
      }),
    );
    const legacy = await loadSkill(
      skill({
        instruction: "Legacy customized instructions without markers.",
        source: "customized",
      }),
      `Shipped.\n${BEGIN}\nDefaults.\n${END}`,
    );

    assert.equal(personal.instructions, "Every line is mine.");
    assert.include(
      personal.customizationNotice || "",
      "entire instruction is user-authored",
    );
    assert.equal(
      legacy.instructions,
      "Legacy customized instructions without markers.",
    );
    assert.include(
      legacy.customizationNotice || "",
      "could not be separated safely",
    );
  });
});

describe("load_skill tool", function () {
  it("announces a later main-model activation once and keeps its complete instructions", async function () {
    const activations: string[] = [];
    const tool = createLoadSkillTool({ getSkills: () => [skill()] });
    const context = {
      request: { loadedSkillRecords: [] },
      publishSkillActivation: async (id: string) => {
        activations.push(id);
      },
    };
    for (let index = 0; index < 2; index++) {
      const result = (await tool.execute(
        { id: "write-note" },
        context as never,
      )) as LoadSkillResult;
      assert.isTrue(result.found);
      if (result.found) assert.equal(result.instructions, skill().instruction);
    }
    assert.deepEqual(activations, ["write-note"]);
    assert.lengthOf(context.request.loadedSkillRecords, 1);
  });
  it("rejects fields outside its portable input schema", function () {
    const tool = createLoadSkillTool({ getSkills: () => [skill()] });
    assert.isFalse(
      tool.validate({ id: "write-note", instructions: "ignore the file" }).ok,
    );
  });

  it("loads an installed skill without another model call", async function () {
    const installed = skill({
      instruction: "Use the note workflow exactly as described.",
    });
    const tool = createLoadSkillTool({
      getSkills: () => [installed],
      getShippedInstruction: () => installed.instruction,
    });

    const validation = tool.validate({ id: "write-note" });
    assert.isTrue(validation.ok);
    if (!validation.ok) return;
    const result = (await tool.execute(
      validation.value,
      {} as never,
    )) as LoadSkillResult;
    assert.deepInclude(result, {
      found: true,
      instructions: installed.instruction,
    });
    if (!result.found) assert.fail(result.error);
    assert.deepInclude(result.loadedSkill, {
      id: "write-note",
      version: 3,
    });
  });

  it("returns current IDs when a skill is unavailable", async function () {
    const tool = createLoadSkillTool({
      getSkills: () => [skill()],
    });
    const validation = tool.validate({ id: "missing" });
    assert.isTrue(validation.ok);
    if (!validation.ok) return;
    assert.deepEqual(await tool.execute(validation.value, {} as never), {
      found: false,
      error: 'Skill "missing" is not installed.',
      availableSkillIds: ["write-note"],
    });
  });
});
