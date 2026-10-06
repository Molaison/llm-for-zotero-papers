import { assert } from "chai";
import {
  createLibraryRetrieveTool,
  LIBRARY_RETRIEVE_COVERAGE_GUIDANCE,
} from "../src/agent/tools/read/libraryRetrieve";

/**
 * Paper chat does not render library_retrieve's turn guidance, so the
 * coverage-honesty rule rides the result whenever coverage is not complete.
 */
describe("library_retrieve result-time coverage guidance", function () {
  function result(params: {
    metadataCoverage: "complete" | "partial";
    indexedTextCoverage: "complete" | "partial" | "none";
    snippetCoverage: "sampled" | "expanded";
    papersPlanned: number;
    papersBodyRead: number;
    papersMetadataOnly: number;
  }) {
    return {
      answerContract: {
        metadataCoverage: params.metadataCoverage,
        indexedTextCoverage: params.indexedTextCoverage,
        snippetCoverage: params.snippetCoverage,
        safeClaims: [],
        unsafeClaims: [],
      },
      coverageReceipt: {
        text: "",
        papersPlanned: params.papersPlanned,
        papersBodyRead: params.papersBodyRead,
        papersMetadataOnly: params.papersMetadataOnly,
        coverageFrontier: [],
      },
      snippets: [],
      warnings: [],
    };
  }

  async function run(content: Record<string, unknown>) {
    const tool = createLibraryRetrieveTool({
      retrieve: async () => content,
    } as never);
    const parsed = tool.validate({ query: "grid cells" });
    assert.isTrue(parsed.ok);
    if (!parsed.ok) throw new Error("validation failed");
    return (await tool.execute(parsed.value, {
      request: { conversationKey: 1, mode: "agent", userText: "q" },
    } as never)) as Record<string, any>;
  }

  it("states that partial coverage is not exhaustive", async function () {
    const retrieved = await run(
      result({
        metadataCoverage: "complete",
        indexedTextCoverage: "partial",
        snippetCoverage: "sampled",
        papersPlanned: 6,
        papersBodyRead: 3,
        papersMetadataOnly: 3,
      }),
    );
    assert.equal(retrieved.guidance, LIBRARY_RETRIEVE_COVERAGE_GUIDANCE);
    assert.include(retrieved.guidance, "exhaustive");
    assert.include(retrieved.guidance, "metadata-only");
    assert.include(retrieved.guidance, "abstract-only");
  });

  it("adds nothing when every planned paper was read in full coverage", async function () {
    const retrieved = await run(
      result({
        metadataCoverage: "complete",
        indexedTextCoverage: "complete",
        snippetCoverage: "expanded",
        papersPlanned: 4,
        papersBodyRead: 4,
        papersMetadataOnly: 0,
      }),
    );
    assert.notProperty(retrieved, "guidance");
  });
});
