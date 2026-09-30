import type { AgentSkill } from "../skills/skillLoader";
import { sha256Text } from "../store/journalRecoveryBlobStore";
import type { PlanSkillRoutingReceipt } from "../skills/routingTypes";

async function hashInstruction(skill: AgentSkill): Promise<string> {
  return `sha256:${await sha256Text(skill.instruction)}`;
}

export async function resolvePlanSkillRoutingReceipt(
  receipt: PlanSkillRoutingReceipt | undefined,
  skills: ReadonlyArray<AgentSkill>,
): Promise<{
  skillIds: string[];
  changedAutomaticSkillIds: string[];
  changedExplicitSkillIds: string[];
}> {
  if (!receipt) {
    return {
      skillIds: [],
      changedAutomaticSkillIds: [],
      changedExplicitSkillIds: [],
    };
  }
  const byId = new Map(skills.map((skill) => [skill.id, skill]));
  const skillIds: string[] = [];
  const changedAutomaticSkillIds: string[] = [];
  const changedExplicitSkillIds: string[] = [];
  for (const routed of receipt.skills) {
    const current = byId.get(routed.id);
    const unchanged = Boolean(
      current &&
      current.version === routed.version &&
      (await hashInstruction(current)) === routed.instructionHash,
    );
    if (unchanged) {
      skillIds.push(routed.id);
    } else if (routed.source === "explicit") {
      changedExplicitSkillIds.push(routed.id);
    } else {
      changedAutomaticSkillIds.push(routed.id);
    }
  }
  return { skillIds, changedAutomaticSkillIds, changedExplicitSkillIds };
}
