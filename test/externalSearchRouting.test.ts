import { assert } from "chai";
import { AGENT_PERSONA_INSTRUCTIONS } from "../src/agent/model/agentPersona";
import { createBuiltInToolRegistry } from "../src/agent/tools";
import type {
  AgentRuntimeRequest,
  AgentToolDefinition,
} from "../src/agent/types";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";

function registry() {
  return createBuiltInToolRegistry({
    zoteroGateway: {} as never,
    pdfService: {} as never,
    pdfPageService: {} as never,
    retrievalService: {} as never,
  });
}

function request(userText: string): AgentRuntimeRequest {
  return resolvedAgentRequest({
    conversationKey: Math.floor(Math.random() * 1_000_000),
    mode: "agent",
    userText,
    libraryID: 1,
  });
}

function guidanceTools(): {
  web: AgentToolDefinition<any, any>;
  literature: AgentToolDefinition<any, any>;
} {
  const tools = registry();
  const web = tools.getTool("web_search");
  const literature = tools.getTool("literature_search");
  assert.exists(web);
  assert.exists(literature);
  return { web: web!, literature: literature! };
}

function guidanceMatches(
  tool: AgentToolDefinition<any, any>,
  value: AgentRuntimeRequest,
): boolean {
  return tool.guidance?.matches(value) || false;
}

describe("external search guidance routing", function () {
  it("does not route absent semantic intent from English or multilingual words", function () {
    const { web, literature } = guidanceTools();
    for (const text of [
      "Search the web for release notes",
      "查找最新论文",
      "find papers online",
    ]) {
      assert.isFalse(guidanceMatches(web, request(text)));
      assert.isFalse(guidanceMatches(literature, request(text)));
    }
  });
  it("keeps the evidence-necessity and composability rules in the persona", function () {
    const persona = AGENT_PERSONA_INSTRUCTIONS.join("\n");
    assert.include(persona, "Use external search when");
    assert.include(persona, "both source families");
    assert.include(persona, "Preserve the user's language");
    assert.include(persona, "If necessary web access is unavailable");
    assert.notInclude(persona, "Start with basic depth");
    assert.notInclude(persona, "focused lookup");
    assert.notInclude(persona, "exploratory or ambiguous discovery");
  });
});
