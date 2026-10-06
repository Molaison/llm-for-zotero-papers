import { assert } from "chai";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { createSubmitDocumentTool } from "../src/agent/tools/control/submitDocument";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";

describe("literature review without the experimental workflow", function () {
  it("lets an ordinary review submit its document without an investigation or saved-draft protocol", function () {
    const registry = new AgentToolRegistry();
    registry.register(createSubmitDocumentTool({} as never));
    const request = resolvedAgentRequest({
      conversationKey: 1,
      userText: "Review the literature",
    });

    const tools = registry.listToolsForRequest(request);
    const submission = tools.find((tool) => tool.name === "submit_document");
    assert.exists(submission);
    const schema = submission!.inputSchema as any;
    assert.property(schema.properties, "markdown");
    assert.property(schema.properties, "groundingReviewed");
    assert.notProperty(schema.properties, "draftId");
  });
});
