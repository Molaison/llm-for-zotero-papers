/** An adapter can forbid recovery that would resubmit the same input. */
export type ModelErrorRecovery = {
  automaticRecovery: "none";
  source: "pdf_input";
};

export type ModelRecoveryError = Error & {
  modelRecovery?: ModelErrorRecovery;
};

export function forbidsAutomaticModelRecovery(error: unknown): boolean {
  return (
    (error as ModelRecoveryError | null)?.modelRecovery?.automaticRecovery ===
    "none"
  );
}
