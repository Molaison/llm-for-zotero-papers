import type { AgentSkill } from "./skillLoader";
import {
  fingerprintSkillInstruction,
  loadSkill,
  type LoadedSkill,
  type LoadedSkillRecord,
} from "./progressiveLoading";

export type PlanSkillBindingResolution =
  | Readonly<{
      kind: "compatible";
      loadedSkills: readonly LoadedSkill[];
      unavailableLoadedSkillIds: readonly string[];
    }>
  | Readonly<{
      kind: "renewed_approval_required";
      reason: string;
    }>;

/**
 * Resolve only the exact instruction bodies frozen with a v5 Plan.
 *
 * A forced skill is part of the user's approved request, so a missing or
 * changed body requires a new Plan approval. An opportunistically loaded
 * skill may be omitted when unavailable, but is never replaced by its current
 * changed body.
 */
export async function resolvePinnedPlanSkills(params: {
  bindings: readonly LoadedSkillRecord[];
  installedSkills: readonly AgentSkill[];
  shippedInstructionById?: (id: string) => string | undefined;
}): Promise<PlanSkillBindingResolution> {
  const installed = new Map(
    params.installedSkills.map((skill) => [skill.id, skill]),
  );
  const loadedSkills: LoadedSkill[] = [];
  const unavailableLoadedSkillIds: string[] = [];
  const seen = new Set<string>();
  for (const binding of params.bindings) {
    if (seen.has(binding.id)) {
      return {
        kind: "renewed_approval_required",
        reason: `The approved Plan contains duplicate skill binding '${binding.id}'.`,
      };
    }
    seen.add(binding.id);
    const skill = installed.get(binding.id);
    const exact =
      skill &&
      skill.version === binding.version &&
      (await fingerprintSkillInstruction(skill.instruction)) ===
        binding.instructionFingerprint;
    if (!exact) {
      if (binding.source === "forced") {
        return {
          kind: "renewed_approval_required",
          reason: `The forced skill '${binding.id}' changed or is unavailable. Revise and approve the Plan again.`,
        };
      }
      unavailableLoadedSkillIds.push(binding.id);
      continue;
    }
    const loaded = await loadSkill(
      skill,
      params.shippedInstructionById?.(binding.id),
    );
    loadedSkills.push({
      ...loaded,
      loadedSkill: { ...loaded.loadedSkill, source: binding.source },
    });
  }
  return {
    kind: "compatible",
    loadedSkills,
    unavailableLoadedSkillIds,
  };
}

/**
 * The skill that owns the research loop's rules (inventory, nodes, links,
 * verification, structure, writing). research_update carries only its
 * operation catalog, so every approved plan with an investigation executes
 * with this skill whether or not skill routing selected it.
 */
export const PLAN_INVESTIGATION_SKILL_ID = "literature-review";

/**
 * Add the investigation skill to an executing turn's skill ids when the
 * approved contract has an investigation. The installed copy is what renders,
 * so a user-customized skill file is honoured like any other activation.
 */
export function withPlanInvestigationSkill(
  skillIds: readonly string[],
  contract: Readonly<{ investigation?: unknown }> | null | undefined,
  installedSkills: readonly Pick<AgentSkill, "id">[],
): string[] {
  if (
    !contract?.investigation ||
    skillIds.includes(PLAN_INVESTIGATION_SKILL_ID) ||
    !installedSkills.some((skill) => skill.id === PLAN_INVESTIGATION_SKILL_ID)
  )
    return [...skillIds];
  return [...skillIds, PLAN_INVESTIGATION_SKILL_ID];
}
