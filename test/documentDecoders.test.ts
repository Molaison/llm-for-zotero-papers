/**
 * Stored documents decode exactly: a direct document keeps its origin without
 * plan identifiers, quote certificates decode deeply, and a malformed record
 * is rejected rather than half-read.
 *
 * Moved from test/planResearchArchitectureV3.test.ts when the research engine
 * was deleted; documents outlive it, and so do these checks.
 */
import { assert } from "chai";
import { decodePlanDocument } from "../src/agent/documents/decoders";
import type { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import { createSubmitDocumentTool } from "../src/agent/tools/control/submitDocument";

describe("stored document decoding", function () {
  it("rejects a deeply invalid persisted document", function () {
    assert.throws(() => decodePlanDocument({ version: 1 }), /required|arrays/i);
  });

  it("decodes direct DocumentArtifactV2 origins without inventing Plan IDs", function () {
    const decoded = decodePlanDocument({
      version: 2,
      documentId: "run-1:document:1",
      documentVersion: 1,
      documentKind: "report",
      integrityPolicy: "authored",
      origin: {
        kind: "direct",
        runId: "run-1",
        sourceMessageTimestamp: 10,
      },
      conversationKey: 1,
      title: "Report",
      visibleMarkdown: "# Report\n\nComplete.",
      visibleHtml: "<h1>Report</h1><p>Complete.</p>",
      citationBundle: {
        clusters: [],
        bibliographyEntries: [],
        style: { id: "apa", title: "APA" },
        locale: "en-US",
      },
      verifiedQuotes: [],
      assets: [],
      coverageItems: [],
      validation: {
        integrityValidated: true,
        groundingReviewed: "not_run",
        quoteVerified: "not_applicable",
        issues: [],
      },
      contentHash: "sha256:document",
      createdAt: 10,
    });
    assert.equal(decoded.version, 2);
    if (decoded.version === 2) {
      assert.equal(decoded.origin.kind, "direct");
      assert.notProperty(decoded.origin, "planId");
    }
  });

  it("keeps quote verification host-owned and deeply decodes certificates", function () {
    const tool = createSubmitDocumentTool({} as ZoteroGateway);
    const required = tool.spec.inputSchema.required as string[];
    assert.include(required, "quotes");
    assert.notInclude(required, "quoteVerified");
    const document = {
      version: 1,
      documentId: "document-1",
      documentVersion: 1,
      planId: "plan-1",
      planRevision: 1,
      executionId: "execution-1",
      conversationKey: 1,
      parentTaskId: "task-1",
      contractDigest: "sha256:contract",
      title: "Review",
      visibleMarkdown: "> Verified wording",
      visibleHtml: "<blockquote>Verified wording</blockquote>",
      citationBundle: {
        clusters: [],
        bibliographyEntries: [],
        style: { id: "apa", title: "APA" },
        locale: "en-US",
      },
      verifiedQuotes: [
        {
          quoteId: "Q1",
          text: "Verified wording",
          libraryID: 1,
          itemKey: "AAAA1111",
          attachmentItemKey: "PDFP2222",
          evidenceRefs: ["evidence-1"],
          certificate: {
            contextItemId: 20,
            sourceFingerprint: "pdfjs:fingerprint",
            pageIndex: 4,
            sourceMatchText: "Verified wording",
            sourceMatchKind: "exact",
            sourceMatchPageOccurrence: 0,
          },
        },
      ],
      assets: [],
      coverageItems: [],
      validation: {
        integrityValidated: true,
        groundingReviewed: "passed",
        quoteVerified: "verified",
        issues: [],
      },
      contentHash: "sha256:document",
      createdAt: 1,
    };
    assert.equal(
      decodePlanDocument(document).verifiedQuotes[0].certificate.pageIndex,
      4,
    );
    assert.throws(
      () =>
        decodePlanDocument({
          ...document,
          verifiedQuotes: [
            {
              ...document.verifiedQuotes[0],
              certificate: {
                ...document.verifiedQuotes[0].certificate,
                pageIndex: -1,
              },
            },
          ],
        }),
      /pageIndex/,
    );
  });
});
