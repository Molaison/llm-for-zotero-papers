import { assert } from "chai";
import { createBuiltInToolRegistry } from "../src/agent/tools";
import { resolveAgentRuntimeRequest } from "../src/agent/context/resolvedAgentRequest";
import { renderAgentPromptEnvelope } from "../src/agent/model/messageBuilder";

describe("direct Agent model tool surface", function () {
  it("keeps the fixed ordinary tool and prompt payload within the migration targets", async function () {
    const registry = createBuiltInToolRegistry({
      zoteroGateway: {} as never,
      pdfService: {} as never,
      pdfPageService: {} as never,
      retrievalService: {} as never,
    });
    // An ordinary turn runs as the Original Agent, so task_update counts.
    const request = resolveAgentRuntimeRequest({
      conversationKey: 1,
      mode: "agent",
      userText: "Answer a question about my library",
      libraryID: 1,
      executionContext: {
        version: 1,
        executionId: "execution-1",
        conversationKey: 1,
        conversationGeneration: 0,
        chatLibraryID: 1,
        permissionOwner: "original_agent",
        workspaceSnapshot: { selectedPapers: [], selectedCollections: [] },
        configuredAccess: { libraryIDs: [1], outputDirectories: [] },
      },
    });

    const tools = registry.listToolsForRequest(request);
    const serializedToolCharacters = tools
      .map((tool) =>
        [tool.name, tool.description, JSON.stringify(tool.inputSchema)].join(
          "\n",
        ),
      )
      .join("\n\n").length;
    const rendered = await renderAgentPromptEnvelope(
      request,
      registry.listToolDefinitionsForRequest(request),
      [],
    );

    // Includes concrete figure selectors, the native image-embedding contract
    // and task_update. Each cap is the next whole thousand above the measured
    // payload: 22,766 tool characters and 31,121 with the fixed prompt
    // (2026-10-02, after task_update took excluded, replaces and reason).
    assert.isAtMost(serializedToolCharacters, 23_000);
    assert.isAtMost(
      rendered.inventory.fixedPrompt.length + serializedToolCharacters,
      32_000,
    );
    assert.includeMembers(
      tools.map((tool) => tool.name),
      [
        "task_update",
        "library_search",
        "paper_read",
        "library_update",
        "note_write",
        "submit_document",
        "request_user_input",
        "load_skill",
      ],
    );
  });
});
