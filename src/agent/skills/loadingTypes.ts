export type SkillInventoryEntry = Readonly<{
  id: string;
  name: string;
  description: string;
  version: number;
  contexts: readonly (
    | "any"
    | "single-paper"
    | "paper-set"
    | "library-corpus"
    | "note"
    | "visual-input"
  )[];
  activation: "auto" | "manual" | "both";
}>;

/** Durable identity of the exact instructions returned by `load_skill`. */
export type LoadedSkillRecord = Readonly<{
  id: string;
  version: number;
  instructionFingerprint: string;
  source: "loaded" | "forced";
}>;

export type LoadedSkill = Readonly<{
  skill: SkillInventoryEntry;
  customizationNotice: string | null;
  instructions: string;
  loadedSkill: LoadedSkillRecord;
}>;
