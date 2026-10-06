import { assert } from "chai";
import { createBuiltInToolRegistry } from "../src/agent/tools";
import { resolveAgentRuntimeRequest } from "../src/agent/context/resolvedAgentRequest";
import { createApplyTagsTool } from "../src/agent/tools/write/applyTags";
import { createUpdateMetadataTool } from "../src/agent/tools/write/updateMetadata";
import { createMergeItemsTool } from "../src/agent/tools/write/mergeItems";
import { createImportLocalFilesTool } from "../src/agent/tools/write/importLocalFiles";

/**
 * Delegates behind library_update, library_delete and library_import are not
 * registered, so guidance on them never reached the model. The facades own
 * the live rules.
 */
describe("library write guidance owners", function () {
  function registry() {
    return createBuiltInToolRegistry({
      zoteroGateway: {} as never,
      pdfService: {} as never,
      pdfPageService: {} as never,
      retrievalService: {} as never,
    });
  }

  it("carries no guidance on unregistered delegates", function () {
    for (const tool of [
      createApplyTagsTool({} as never),
      createUpdateMetadataTool({} as never),
      createMergeItemsTool({} as never),
      createImportLocalFilesTool({} as never),
    ]) {
      assert.isUndefined(tool.guidance, tool.spec.name);
    }
  });

  it("keeps the canonical-metadata rule on library_update and reads cleanly", function () {
    const update = registry()
      .listToolDefinitions()
      .find((tool) => tool.spec.name === "library_update")!;
    const instruction = update.guidance!.instruction;
    assert.include(
      instruction,
      "use literature_search with workflow:'review' and mode:'metadata' to fetch canonical data",
    );
    assert.notInclude(instruction, "; A computation");
    assert.include(
      instruction,
      "use assignments when the schema supports them. A zotero_script computation",
    );
  });

  it("names every supported identifier kind in the library_import descriptions", function () {
    const tools = registry();
    const identifiers = "DOI, ISBN, arXiv ID, PMID, or ADS bibcode";
    const spec = tools
      .listToolDefinitions()
      .find((tool) => tool.spec.name === "library_import")!.spec;
    assert.include(spec.description, identifiers);
    const request = resolveAgentRuntimeRequest({
      conversationKey: 1,
      mode: "agent",
      userText: "Import this paper",
      libraryID: 1,
    });
    const modelTool = tools
      .listToolsForRequest(request)
      .find((tool) => tool.name === "library_import")!;
    assert.include(modelTool.description, identifiers);
  });
});
