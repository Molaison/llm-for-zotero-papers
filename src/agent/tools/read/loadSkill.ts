import { readOnlyInvocationPlan } from "../../authorization/invocationPlan";
import {
  getAllSkills,
  getBuiltinSkillInstructionById,
  loadSkill,
} from "../../skills";
import type { AgentSkill, LoadedSkill } from "../../skills";
import type { AgentRuntimeRequest, AgentToolDefinition } from "../../types";
import { fail, ok, validateObject } from "../shared";

export type LoadSkillInput = { id: string };

export type LoadSkillResult =
  | ({ found: true; toolGuidance?: string } & LoadedSkill)
  | {
      found: false;
      error: string;
      availableSkillIds: string[];
    };

export type LoadSkillToolOptions = {
  getSkills?: () => ReadonlyArray<AgentSkill>;
  getShippedInstruction?: (id: string) => string | undefined;
  /** The tools offered on this request, for guidance tied to a skill. */
  getToolDefinitions?: (
    request: AgentRuntimeRequest,
  ) => ReadonlyArray<AgentToolDefinition<any, any>>;
};

/**
 * Tool guidance that becomes active only because `skillId` is active, minus
 * guidance the turn already rendered for the skills active before this load
 * (forced, plan-pinned, or loaded earlier in the turn). The system prompt is
 * rendered once per turn, so this is the only way a skill loaded mid-turn
 * brings its tool rules with it.
 */
function collectSkillToolGuidance(
  skillId: string,
  request: AgentRuntimeRequest,
  activeSkillIds: ReadonlyArray<string>,
  tools: ReadonlyArray<AgentToolDefinition<any, any>>,
): string | undefined {
  const instructions = new Set<string>();
  for (const tool of tools) {
    const guidance = tool.guidance;
    if (!guidance) continue;
    if (!guidance.matches(request, { matchedSkillIds: [skillId] })) continue;
    if (guidance.matches(request, { matchedSkillIds: activeSkillIds }))
      continue;
    const instruction = guidance.instruction.trim();
    if (instruction) instructions.add(instruction);
  }
  if (!instructions.size) return undefined;
  return ["Tool guidance for this skill:", ...instructions].join("\n\n");
}

/**
 * Read one installed skill into the active agent workflow. The initial prompt
 * can carry only the metadata inventory; this tool returns the exact body and
 * its stable identity without invoking another model.
 */
export function createLoadSkillTool(
  options: LoadSkillToolOptions = {},
): AgentToolDefinition<LoadSkillInput, LoadSkillResult> {
  const getSkills = options.getSkills || getAllSkills;
  const getShippedInstruction =
    options.getShippedInstruction || getBuiltinSkillInstructionById;
  return {
    spec: {
      name: "load_skill",
      description:
        "Load the full instructions for one installed skill by exact ID. Use this when a skill in the supplied inventory matches the current work and its workflow guidance is needed. Loading guidance does not authorize actions or override the user's current request.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: {
          id: {
            type: "string",
            description: "Exact ID from the installed skill inventory.",
          },
        },
      },
      executionClass: "read",
      workCategory: "retrieval",
    },
    validate(args) {
      if (
        !validateObject<Record<string, unknown>>(args) ||
        Object.keys(args).some((key) => key !== "id") ||
        typeof args.id !== "string" ||
        !args.id.trim()
      ) {
        return fail("id must be a non-empty installed skill ID");
      }
      return ok({ id: args.id.trim() });
    },
    planInvocation: () =>
      readOnlyInvocationPlan({
        domains: [],
        reason: "Skill loading reads host-owned in-memory guidance.",
      }),
    async execute(input, context) {
      const skills = getSkills();
      const skill = skills.find((candidate) => candidate.id === input.id);
      if (!skill) {
        return {
          found: false,
          error: `Skill "${input.id}" is not installed.`,
          availableSkillIds: skills
            .map((candidate) => candidate.id)
            .sort((left, right) => left.localeCompare(right)),
        };
      }
      const loaded = await loadSkill(skill, getShippedInstruction(skill.id));
      let toolGuidance: string | undefined;
      if (context?.request) {
        const records = context.request.loadedSkillRecords || [];
        if (options.getToolDefinitions) {
          toolGuidance = collectSkillToolGuidance(
            skill.id,
            context.request,
            records.map((record) => record.id),
            options.getToolDefinitions(context.request),
          );
        }
        const alreadyLoaded = records.some(
          (record) =>
            record.id === loaded.loadedSkill.id &&
            record.instructionFingerprint ===
              loaded.loadedSkill.instructionFingerprint,
        );
        context.request.loadedSkillRecords = [
          ...records.filter((record) => record.id !== loaded.loadedSkill.id),
          loaded.loadedSkill,
        ];
        if (!alreadyLoaded) await context.publishSkillActivation?.(skill.id);
      }
      return {
        found: true,
        ...loaded,
        ...(toolGuidance ? { toolGuidance } : {}),
      };
    },
  };
}
