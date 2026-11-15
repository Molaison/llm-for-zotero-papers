import type {
  LocalDocumentResource,
  PaperContextRef,
} from "../../shared/types";
import { isAbsoluteLocalPath } from "../../utils/localPath";

/**
 * Validates the request-scoped identity binding before any run, trace, or
 * provider session is created.  The error deliberately contains no local
 * path so failed preflight cannot disclose attachment locations.
 */
export function validateLocalPdfDocumentBatch(params: {
  pdfPaperContexts?: readonly PaperContextRef[];
  localDocuments?: readonly LocalDocumentResource[];
}): readonly LocalDocumentResource[] {
  const papers = params.pdfPaperContexts || [];
  const documents = params.localDocuments || [];
  if (!papers.length && !documents.length) return documents;
  if (papers.length !== documents.length) {
    throw new Error("Raw PDF identity batch does not match its resources.");
  }

  const sourceKeys = new Set<string>();
  for (let index = 0; index < papers.length; index += 1) {
    const paper = papers[index];
    const document = documents[index];
    const itemId = Number(paper?.itemId);
    const contextItemId = Number(paper?.contextItemId);
    const expectedSourceKey = `zotero-pdf:${itemId}:${contextItemId}`;
    if (
      !Number.isSafeInteger(itemId) ||
      itemId <= 0 ||
      !Number.isSafeInteger(contextItemId) ||
      contextItemId <= 0 ||
      paper?.contentSourceMode !== "pdf" ||
      !document ||
      document.kind !== "local_pdf" ||
      document.mimeType !== "application/pdf" ||
      document.itemId !== itemId ||
      document.contextItemId !== contextItemId ||
      document.sourceKey !== expectedSourceKey ||
      !isAbsoluteLocalPath(document.absolutePath) ||
      !document.absolutePath.trim()
    ) {
      throw new Error(
        `Raw PDF identity binding is invalid at position ${index + 1}.`,
      );
    }
    if (sourceKeys.has(document.sourceKey)) {
      throw new Error("Raw PDF identity batch contains a duplicate resource.");
    }
    sourceKeys.add(document.sourceKey);
  }
  return documents;
}
