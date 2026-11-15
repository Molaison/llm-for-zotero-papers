import { createSurfaceBridge } from "../surfaceBridge";

export type RetrievalCandidateInvalidator = (contextItemId?: number) => void;

const bridge = createSurfaceBridge<RetrievalCandidateInvalidator>(
  "retrieval candidate invalidator",
);

export function configureRetrievalCandidateInvalidator(
  invalidator: RetrievalCandidateInvalidator | null,
): () => void {
  return bridge.configure(invalidator);
}

export function invalidateRetrievalCandidates(contextItemId?: number): void {
  bridge.require()(contextItemId);
}
