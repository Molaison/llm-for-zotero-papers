import { assert } from "chai";
import { DatabaseSync } from "node:sqlite";
import { AgentRuntime } from "../src/agent/runtime";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { createContextReadTool } from "../src/agent/tools/read/contextRead";
import { createNoteWriteTool } from "../src/agent/tools/write/noteWrite";
import {
  clearAgentTranscriptStore,
  loadLatestAgentTranscriptSegment,
  readAgentConversationAnswer,
  replaceAgentTranscriptSegment,
} from "../src/agent/store/transcriptStore";
import { buildPortableAgentTranscript } from "../src/agent/context/transcriptCompactor";
import type { AgentModelMessage, AgentToolContext } from "../src/agent/types";
import { installMockDb } from "./helpers/agentRuntimeMockDb";

describe("retention through existing SQLite storage", function () {
  let restore: () => void;
  let db: DatabaseSync;
  let failWrite = false;
  const key = 141919;
  const answer =
    "## Last section\n\n" +
    "α = 0.125; **preserved**\n\n".repeat(1500) +
    "EXACT_END\n";
  const context = {
    request: {
      conversationKey: key,
      mode: "agent",
      libraryID: 1,
      userText: "save the answer",
    },
    item: null,
    currentAnswerText: "",
    modelName: "test",
  } as AgentToolContext;
  beforeEach(function () {
    clearAgentTranscriptStore();
    restore = installMockDb();
    db = new DatabaseSync(":memory:");
    // Supported pre-change shape: no new column or migration is needed.
    db.exec(
      "CREATE TABLE llm_for_zotero_agent_transcript (conversation_key INTEGER NOT NULL, compatibility_key TEXT NOT NULL, sequence INTEGER NOT NULL, message_json TEXT NOT NULL, compacted_at INTEGER, created_at INTEGER NOT NULL, PRIMARY KEY(conversation_key, compatibility_key, sequence))",
    );
    const base = Zotero.DB;
    failWrite = false;
    (Zotero as any).DB = {
      queryAsync: async (sql: string, params: unknown[] = []) => {
        if (!sql.includes("llm_for_zotero_agent_transcript"))
          return base.queryAsync(sql, params);
        if (failWrite && sql.includes("INSERT INTO"))
          throw new Error("Interrupted write");
        const statement = db.prepare(sql);
        return /^\s*SELECT/.test(sql)
          ? statement.all(...(params as never[]))
          : (statement.run(...(params as never[])), []);
      },
      executeTransaction: async (task: () => Promise<unknown>) => {
        db.exec("BEGIN");
        try {
          const result = await task();
          db.exec("COMMIT");
          return result;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
    };
  });
  afterEach(function () {
    restore();
    db.close();
    clearAgentTranscriptStore();
  });

  it("keeps exact sources across compression and restart, pages them losslessly, and binds note payloads before authorization", async function () {
    const portable = buildPortableAgentTranscript({
      conversationKey: key,
      messages: Array.from(
        { length: 6 },
        (_, index) =>
          [
            { role: "user", content: `Question ${index}` },
            {
              role: "assistant",
              content: answer,
              messageId: `answer-${index}`,
            },
          ] as AgentModelMessage[],
      ).flat(),
    });
    assert.equal(
      await replaceAgentTranscriptSegment({
        conversationKey: key,
        compatibilityKey: "portable-v2",
        messages: portable.messages,
      }),
      "persisted",
    );
    const runtime = new AgentRuntime({
      registry: new AgentToolRegistry(),
      adapterFactory: () => ({
        supportsTools: () => true,
        getCapabilities: () => ({
          toolCalls: true,
          streaming: false,
          multimodal: false,
        }),
        runStep: async () => {
          throw new Error("Manual compaction requires no model call");
        },
      }),
    });
    const result = await runtime.runTurn({
      request: { ...context.request, userText: "/compact", model: "test" },
    });
    assert.equal(result.kind, "completed");
    clearAgentTranscriptStore();
    assert.equal(await readAgentConversationAnswer(key, "answer-0"), answer);
    const read = createContextReadTool();
    let recovered = "",
      textOffset = 0;
    for (let page = 0; page < 200; page++) {
      const input = read.validate({
        source: "conversation",
        messageId: "answer-0",
        textOffset,
        maxTokens: 512,
      });
      if (!input.ok) throw new Error(input.error);
      const output = (await read.execute(input.value, context)) as {
        text: string;
        nextTextOffset?: number;
      };
      recovered += output.text;
      if (output.nextTextOffset === undefined) break;
      assert.isAbove(output.nextTextOffset, textOffset);
      textOffset = output.nextTextOffset;
    }
    assert.equal(recovered, answer);
    const note = createNoteWriteTool({} as never);
    const input = note.validate({
      mode: "create",
      target: "standalone",
      collections: [17],
      sourceMessageId: "answer-0",
    });
    if (!input.ok) throw new Error(input.error);
    await note.planInvocation(input.value, context);
    assert.equal(input.value.content, answer.trim());
    assert.deepEqual(input.value.collections, [17]);
    assert.isFalse(
      note.validate({
        mode: "create",
        sourceMessageId: "answer-0",
        content: "substitute",
      }).ok,
    );
    let failure = "";
    try {
      await readAgentConversationAnswer(key + 1, "answer-0");
    } catch (error) {
      failure = String(error);
    }
    assert.include(failure, "current conversation");
  });

  it("rolls back an interrupted replacement and reloads the exact prior answer", async function () {
    const segment = {
      conversationKey: key,
      compatibilityKey: "portable-v2",
      messages: [
        { role: "assistant", content: answer, messageId: "answer" },
      ] as AgentModelMessage[],
    };
    assert.equal(await replaceAgentTranscriptSegment(segment), "persisted");
    failWrite = true;
    assert.equal(
      await replaceAgentTranscriptSegment({
        ...segment,
        messages: [
          { role: "assistant", content: "replacement", messageId: "answer" },
        ],
      }),
      "failed",
    );
    clearAgentTranscriptStore();
    assert.equal(await readAgentConversationAnswer(key, "answer"), answer);
  });

  it("restores visible history over a legacy lossy checkpoint without duplicating it on later turns", async function () {
    await replaceAgentTranscriptSegment({
      conversationKey: key,
      compatibilityKey: "legacy-provider-key",
      messages: [
        {
          role: "user",
          content:
            "Agent semantic continuation checkpoint:\nLatest root user goal: compare papers\nRecent visible assistant state: truncated...",
        },
      ],
    });
    const history = [
      { role: "user", content: "Compare papers" },
      { role: "assistant", content: answer },
    ] as ChatMessage[];
    const runtime = new AgentRuntime({
      registry: new AgentToolRegistry(),
      adapterFactory: () => ({
        supportsTools: () => true,
        getCapabilities: () => ({
          toolCalls: true,
          streaming: false,
          multimodal: false,
        }),
        async runStep(params) {
          assert.isTrue(
            params.messages.some(
              (message) =>
                message.role === "assistant" && message.content === answer,
            ),
          );
          return {
            kind: "final" as const,
            text: "Done",
            assistantMessage: { role: "assistant" as const, content: "Done" },
          };
        },
      }),
    });
    for (let turn = 0; turn < 2; turn++) {
      clearAgentTranscriptStore();
      await runtime.runTurn({
        request: {
          ...context.request,
          model: "test",
          history,
          userText: "Explain the last section",
        },
      });
    }
    const stored = await loadLatestAgentTranscriptSegment(key);
    assert.lengthOf(
      stored!.messages.filter((message) => message.content === answer),
      1,
    );
  });
});
