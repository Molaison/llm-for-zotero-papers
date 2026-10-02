export type SkillRequestedScope =
  | "none"
  | "single-paper"
  | "paper-set"
  | "library-corpus"
  | "note"
  | "visual-input";

export type ValidatedSkillActivation = Readonly<{
  id: string;
  source: "automatic" | "explicit";
  requestedScope: SkillRequestedScope;
  evidence?: Readonly<{ text: string; start: number; end: number }>;
  version: number;
  instructionHash: string;
}>;

export type SkillRoutingReceipt = Readonly<{
  routerSchemaVersion: number;
  routerIdentityHash: string;
  skillManifestHash: string;
  skills: readonly ValidatedSkillActivation[];
}>;
