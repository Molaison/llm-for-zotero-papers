import { assert } from "chai";
import { createBuiltInToolRegistry } from "../src/agent/tools";
import {
  clearAgentToolResultHandleStore,
  createAgentToolResultHandleRecord,
  upsertAgentToolResultHandles,
} from "../src/agent/store/toolResultHandles";
import {
  clearAgentTranscriptStore,
  replaceAgentTranscriptSegment,
} from "../src/agent/store/transcriptStore";
import type {
  AgentModelMessage,
  AgentRuntimeRequest,
  AgentToolContext,
  AgentToolDefinition,
} from "../src/agent/types";
import { installMockDb } from "./helpers/agentRuntimeMockDb";

/**
 * `context_read` is the one tool for exact stored context: `source:'tool_result'`
 * pages a stored tool result by handle, `source:'conversation'` lists or reads
 * chat messages. The branch-level reading cases live in
 * agentToolResultHandles.test.ts and agentRetentionStorage.test.ts; this file
 * pins the routing, the per-source validation, and availability.
 */
describe("context_read", function () {
  const registry = createBuiltInToolRegistry({
    zoteroGateway: {} as never,
    pdfService: {} as never,
    pdfPageService: {} as never,
    retrievalService: {} as never,
  });
  const tool = registry.getTool("context_read") as AgentToolDefinition<
    unknown,
    unknown
  >;
  const request = (
    conversationKey: number,
    metadata?: Record<string, unknown>,
  ): AgentRuntimeRequest =>
    ({
      conversationKey,
      mode: "agent",
      userText: "read context",
      ...(metadata ? { metadata } : {}),
    }) as AgentRuntimeRequest;
  const context = (
    conversationKey: number,
    metadata?: Record<string, unknown>,
  ): AgentToolContext => ({
    request: request(conversationKey, metadata),
    item: null,
    currentAnswerText: "",
    modelName: "test-model",
  });
  const run = async (args: unknown, toolContext: AgentToolContext) => {
    const input = tool.validate(args);
    if (!input.ok) throw new Error(input.error);
    return (await tool.execute(input.value, toolContext)) as Record<
      string,
      unknown
    >;
  };

  let restore: () => void;
  beforeEach(function () {
    clearAgentToolResultHandleStore();
    clearAgentTranscriptStore();
    restore = installMockDb();
  });
  afterEach(function () {
    restore();
    clearAgentTranscriptStore();
  });

  it("replaces tool_result_read and conversation_read in the registry", function () {
    assert.exists(tool);
    assert.equal(tool.spec.name, "context_read");
    assert.notExists(registry.getTool("tool_result_read"));
    assert.notExists(registry.getTool("conversation_read"));
    assert.deepEqual(
      (tool.spec.inputSchema as { required?: string[] }).required,
      ["source"],
    );
  });

  it("stays available whether or not any tool result has been stored", function () {
    const listed = (req: AgentRuntimeRequest) =>
      registry.listToolsForRequest(req).map((entry) => entry.name);
    assert.include(listed(request(1)), "context_read");
    assert.include(
      listed(request(1, { agentToolResultReadAvailable: true })),
      "context_read",
    );
  });

  it("requires a known source", function () {
    assert.isFalse(tool.validate({}).ok);
    assert.isFalse(tool.validate({ source: "paper", handle: "trh_a1" }).ok);
  });

  it("requires a valid handle for source:'tool_result' and rejects conversation fields", function () {
    assert.isFalse(tool.validate({ source: "tool_result" }).ok);
    assert.isFalse(tool.validate({ source: "tool_result", handle: "x" }).ok);
    assert.isFalse(
      tool.validate({
        source: "tool_result",
        handle: "trh_a1",
        messageId: "answer-0",
      }).ok,
    );
    assert.isTrue(
      tool.validate({ source: "tool_result", handle: "trh_a1" }).ok,
    );
  });

  it("treats messageId as optional for source:'conversation' and rejects handle fields", function () {
    assert.isTrue(tool.validate({ source: "conversation" }).ok);
    assert.isTrue(
      tool.validate({ source: "conversation", messageId: "answer-0" }).ok,
    );
    assert.isFalse(
      tool.validate({ source: "conversation", handle: "trh_a1" }).ok,
    );
    assert.isFalse(tool.validate({ source: "conversation", messageId: "" }).ok);
  });

  it("routes source:'tool_result' to the stored result by handle", async function () {
    const record = createAgentToolResultHandleRecord({
      conversationKey: 7,
      toolName: "library_search",
      toolCallId: "call-catalog",
      content: { results: [{ itemId: 1 }, { itemId: 2 }] },
    });
    await upsertAgentToolResultHandles([record!]);

    const output = await run(
      { source: "tool_result", handle: record!.handle, path: "results" },
      context(7, { agentToolResultReadAvailable: true }),
    );

    assert.equal(output.ok, true);
    assert.equal(output.handle, record!.handle);
    assert.deepEqual(output.items, [{ itemId: 1 }, { itemId: 2 }]);
  });

  it("answers source:'tool_result' with a clear error when this turn holds no stored results", async function () {
    const record = createAgentToolResultHandleRecord({
      conversationKey: 8,
      toolName: "library_search",
      toolCallId: "call-catalog",
      content: { results: [{ itemId: 1 }] },
    });
    await upsertAgentToolResultHandles([record!]);

    const output = await run(
      { source: "tool_result", handle: record!.handle, path: "results" },
      context(8),
    );

    assert.equal(output.ok, false);
    assert.notProperty(output, "items");
    assert.match(String(output.error), /No stored tool results/);
  });

  it("routes source:'conversation' without messageId to the message list", async function () {
    const messages: AgentModelMessage[] = [
      { role: "user", content: "First question", messageId: "user-0" },
      { role: "assistant", content: "First answer", messageId: "answer-0" },
    ] as AgentModelMessage[];
    await replaceAgentTranscriptSegment({
      conversationKey: 9,
      compatibilityKey: "portable-v2",
      messages,
    });

    const listed = await run({ source: "conversation" }, context(9));
    assert.equal(listed.ok, true);
    assert.equal(listed.totalCount, 2);
    assert.deepEqual(
      (listed.messages as Array<{ messageId: string }>).map(
        (message) => message.messageId,
      ),
      ["answer-0", "user-0"],
    );

    const read = await run(
      { source: "conversation", messageId: "answer-0" },
      context(9),
    );
    assert.equal(read.ok, true);
    assert.equal(read.role, "assistant");
    assert.equal(read.text, "First answer");
  });
});
