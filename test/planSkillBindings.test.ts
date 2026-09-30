import { assert } from "chai";
import type { AgentSkill } from "../src/agent/skills/skillLoader";
import {
  fingerprintSkillInstruction,
  resolvePinnedPlanSkills,
} from "../src/agent/skills";

const skill = (instruction = "Exact approved instructions"): AgentSkill => ({
  id: "review",
  name: "Review",
  description: "Review a set of papers with bounded evidence.",
  version: 2,
  contexts: ["paper-set"],
  activation: "both",
  instruction,
  source: "customized",
});

describe("v5 Plan skill bindings", function () {
  it("loads only the exact approved instruction version and fingerprint", async function () {
    const current = skill();
    const fingerprint = await fingerprintSkillInstruction(current.instruction);
    const result = await resolvePinnedPlanSkills({
      bindings: [
        {
          id: current.id,
          version: current.version,
          instructionFingerprint: fingerprint,
          source: "forced",
        },
      ],
      installedSkills: [current],
    });
    assert.equal(result.kind, "compatible");
    if (result.kind !== "compatible") return;
    assert.equal(result.loadedSkills[0].instructions, current.instruction);
    assert.equal(result.loadedSkills[0].loadedSkill.source, "forced");
  });

  it("requires renewed approval when a forced skill body changed", async function () {
    const result = await resolvePinnedPlanSkills({
      bindings: [
        {
          id: "review",
          version: 2,
          instructionFingerprint: await fingerprintSkillInstruction("old"),
          source: "forced",
        },
      ],
      installedSkills: [skill("new")],
    });
    assert.equal(result.kind, "renewed_approval_required");
  });

  it("omits a changed optional loaded skill without substituting its body", async function () {
    const result = await resolvePinnedPlanSkills({
      bindings: [
        {
          id: "review",
          version: 2,
          instructionFingerprint: await fingerprintSkillInstruction("old"),
          source: "loaded",
        },
      ],
      installedSkills: [skill("new")],
    });
    assert.equal(result.kind, "compatible");
    if (result.kind !== "compatible") return;
    assert.isEmpty(result.loadedSkills);
    assert.deepEqual(result.unavailableLoadedSkillIds, ["review"]);
  });
});
