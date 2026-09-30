import { assert } from "chai";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { createResearchUpdateTool } from "../src/agent/tools/plan/researchUpdate";
import { createSubmitDocumentTool } from "../src/agent/tools/control/submitDocument";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";

describe("literature review without the experimental workflow", function () {
  it("lets an ordinary review submit its document without an investigation or saved-draft protocol", function () {
    const registry = new AgentToolRegistry();
    registry.register(createResearchUpdateTool({} as never));
    registry.register(createSubmitDocumentTool({} as never));
    const request = resolvedAgentRequest({
      conversationKey: 1,
      userText: "Review the literature",
      documentOutcomePolicy: {
        required: true,
        documentKind: "literature_review",
        integrityPolicy: "research_grounded",
        trigger: "literature_review_skill",
      },
    });

    const tools = registry.listToolsForRequest(request);
    assert.notInclude(
      tools.map((tool) => tool.name),
      "research_update",
    );
    const submission = tools.find((tool) => tool.name === "submit_document");
    assert.exists(submission);
    const schema = submission!.inputSchema as any;
    assert.property(schema.properties, "markdown");
    assert.property(schema.properties, "groundingReviewed");
    assert.notProperty(schema.properties, "draftId");
  });

  it("keeps approved Plan research on its original persisted-paper contract", function () {
    const registry = new AgentToolRegistry();
    registry.register(createResearchUpdateTool({} as never));
    const request = resolvedAgentRequest({
      conversationKey: 1,
      userText: "Execute the approved review",
      planContext: { phase: "executing" } as never,
    });
    const research = registry
      .listToolsForRequest(request)
      .find((tool) => tool.name === "research_update");
    assert.exists(research);
    const operations = (research!.inputSchema as any).properties.operation.enum;
    assert.includeMembers(operations, [
      "inventory_scope",
      "record_papers",
      "finalize",
    ]);
    assert.notInclude(operations, "begin_research");
    assert.notInclude(operations, "record_research");
  });
});
