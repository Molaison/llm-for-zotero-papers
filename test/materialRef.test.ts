import { assert } from "chai";
import {
  assertMaterialRefMatches,
  materialRefFromDocument,
} from "../src/agent/documents/workflowMaterial";

const document = {
  documentId: "document:summary",
  documentVersion: 3,
  contentHash: `sha256:${"b".repeat(64)}`,
};

describe("workflow MaterialRef", function () {
  it("binds identity to an exact document version and content hash", function () {
    const ref = materialRefFromDocument(document);
    assert.deepEqual(ref, document);
    assert.doesNotThrow(() => assertMaterialRefMatches(document, ref));
    assert.throws(
      () =>
        assertMaterialRefMatches(
          { ...document, documentVersion: document.documentVersion + 1 },
          ref,
        ),
      /version or content has changed/i,
    );
  });
});
