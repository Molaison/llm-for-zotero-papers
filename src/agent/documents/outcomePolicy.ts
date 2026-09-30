import type { AgentRuntimeRequest } from "../types";
import type { DocumentOutcomePolicy } from "./types";

const NO_DOCUMENT: DocumentOutcomePolicy = {
  required: false,
  documentKind: "custom",
  integrityPolicy: "authored",
  trigger: "none",
};

export function resolveDocumentOutcomePolicy(params: {
  request: Pick<AgentRuntimeRequest, "classifiedIntent">;
}): DocumentOutcomePolicy {
  if (params.request.classifiedIntent?.semantic?.materialOutputs?.length) {
    return {
      required: true,
      documentKind: params.request.classifiedIntent.documentKind || "custom",
      integrityPolicy: "authored",
      trigger: "workflow_material",
    };
  }
  if (params.request.classifiedIntent?.deliverableIntent === "document") {
    const documentKind =
      params.request.classifiedIntent.documentKind || "custom";
    return {
      required: true,
      documentKind,
      integrityPolicy:
        documentKind === "literature_review" ? "research_grounded" : "authored",
      trigger:
        documentKind === "literature_review"
          ? "literature_review_intent"
          : "document_intent",
    };
  }
  return NO_DOCUMENT;
}
