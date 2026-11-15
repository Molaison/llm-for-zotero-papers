/**
 * What a read result proves about its sources: the stable library identity
 * of each paper and the trusted PDF locator of each passage.
 *
 * Moved from test/planResearchArchitectureV3.test.ts when the research engine
 * was deleted; the MCP server still projects reads this way.
 */
import { assert } from "chai";
import { extractVerifiedReadSources } from "../src/agent/context/readEvidence";

describe("verified read sources", function () {
  it("projects stable item and trusted PDF locator identity from read results", function () {
    const priorZotero = (globalThis as { Zotero?: unknown }).Zotero;
    (globalThis as { Zotero?: unknown }).Zotero = {
      Items: {
        get: (itemId: number) =>
          itemId === 10
            ? { id: 10, libraryID: 1, key: "AAAA1111" }
            : itemId === 20
              ? {
                  id: 20,
                  libraryID: 1,
                  key: "PDFP2222",
                  parentID: 10,
                }
              : false,
      },
    };
    try {
      const sources = extractVerifiedReadSources({
        papers: [
          {
            paperContext: { itemId: 10, contextItemId: 20 },
            passages: [
              {
                pageIndex: 4,
                sourceFingerprint: "pdfjs:document-1",
              },
            ],
          },
        ],
      });
      assert.deepInclude(sources, {
        libraryID: 1,
        itemKey: "AAAA1111",
        attachmentItemKey: "PDFP2222",
        pageIndex: 4,
        sourceFingerprint: "pdfjs:document-1",
      });
    } finally {
      (globalThis as { Zotero?: unknown }).Zotero = priorZotero;
    }
  });
});
