import type { DocumentOutcomePolicy } from "./types";

const NO_DOCUMENT: DocumentOutcomePolicy = {
  required: false,
  documentKind: "custom",
  integrityPolicy: "authored",
  trigger: "none",
};

/**
 * The document a turn owes before it runs: none. The classifier-era intent
 * that could require one is gone; a turn that publishes a document declares
 * its kind and integrity policy in its own submit_document call.
 */
export function resolveDocumentOutcomePolicy(): DocumentOutcomePolicy {
  return NO_DOCUMENT;
}
