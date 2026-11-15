import { assert } from "chai";

import { validateLocalPdfDocumentBatch } from "../src/agent/context/localDocumentBatch";
import type {
  LocalDocumentResource,
  PaperContextRef,
} from "../src/shared/types";

function paper(itemId: number, contextItemId: number): PaperContextRef {
  return {
    itemId,
    contextItemId,
    title: `Paper ${contextItemId}`,
    contentSourceMode: "pdf",
  };
}

function document(
  itemId: number,
  contextItemId: number,
  path = `/papers/${contextItemId}.pdf`,
): LocalDocumentResource {
  return {
    kind: "local_pdf",
    sourceKey: `zotero-pdf:${itemId}:${contextItemId}`,
    itemId,
    contextItemId,
    title: `Paper ${contextItemId}`,
    name: `${contextItemId}.pdf`,
    mimeType: "application/pdf",
    absolutePath: path,
  };
}

describe("local PDF request batch identity", function () {
  it("preserves exact multi-PDF order and returns the same immutable batch", function () {
    const documents = Object.freeze([document(1, 11), document(2, 22)]);
    const validated = validateLocalPdfDocumentBatch({
      pdfPaperContexts: [paper(1, 11), paper(2, 22)],
      localDocuments: documents,
    });
    assert.strictEqual(validated, documents);
  });

  it("rejects missing, reordered, duplicate, or non-PDF identity bindings", function () {
    const cases = [
      {
        pdfPaperContexts: [paper(1, 11)],
        localDocuments: [],
      },
      {
        pdfPaperContexts: [paper(1, 11), paper(2, 22)],
        localDocuments: [document(2, 22), document(1, 11)],
      },
      {
        pdfPaperContexts: [paper(1, 11), paper(1, 11)],
        localDocuments: [document(1, 11), document(1, 11)],
      },
      {
        pdfPaperContexts: [
          { ...paper(1, 11), contentSourceMode: "text" as const },
        ],
        localDocuments: [document(1, 11)],
      },
    ];
    for (const value of cases) {
      assert.throws(() => validateLocalPdfDocumentBatch(value));
    }
  });

  it("accepts POSIX, drive, and UNC absolute paths without rewriting them", function () {
    const paths = [
      "/papers/Selected File.pdf",
      "C:\\Papers\\Selected File.pdf",
      "\\\\server\\share\\Selected File.pdf",
    ];
    for (const [index, path] of paths.entries()) {
      const itemId = index + 1;
      const contextItemId = index + 101;
      const resource = document(itemId, contextItemId, path);
      const [validated] = validateLocalPdfDocumentBatch({
        pdfPaperContexts: [paper(itemId, contextItemId)],
        localDocuments: [resource],
      });
      assert.equal(validated.absolutePath, path);
    }
  });
});
