import { assert } from "chai";
import { AgentRuntime } from "../src/agent/runtime";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import {
  clearAgentTranscriptStore,
  readAgentConversationAnswer,
} from "../src/agent/store/transcriptStore";
import { installMockDb } from "./helpers/agentRuntimeMockDb";

describe("agent final outcome delivery", function () {
  it("stores the final answer and completed run before invoking a fallible UI observer", async function () {
    const db = installMockDb();
    clearAgentTranscriptStore();
    const runtime = new AgentRuntime({
      registry: new AgentToolRegistry(),
      adapterFactory: () => ({
        supportsTools: () => true,
        getCapabilities: () => ({
          streaming: false,
          toolCalls: true,
          multimodal: false,
        }),
        runStep: async () => ({
          kind: "final",
          text: "Complete reusable answer.",
          assistantMessage: {
            role: "assistant",
            content: "Complete reusable answer.",
          },
        }),
      }),
    });
    let runId = "";
    let statusAtFinal: unknown;
    let storedAtFinal = "";
    try {
      let errorText = "";
      try {
        await runtime.runTurn({
          request: {
            conversationKey: 983012,
            mode: "agent",
            libraryID: 1,
            model: "gpt-5.4",
            userText: "Explain the topic.",
          },
          onStart: (id) => {
            runId = id;
          },
          onEvent: async (event) => {
            if (event.type !== "final") return;
            statusAtFinal = db.runs.get(runId)?.status;
            storedAtFinal = await readAgentConversationAnswer(
              983012,
              `${runId}:answer`,
            ).catch(() => "missing");
            throw new Error("Native final presentation failed");
          },
        });
      } catch (error) {
        errorText = String(error);
      }
      assert.include(errorText, "Native final presentation failed");
      assert.equal(statusAtFinal, "completed");
      assert.equal(storedAtFinal, "Complete reusable answer.");
      assert.equal(
        db.runs.get(runId)?.status,
        "completed",
        "a presentation exception does not erase a completed run",
      );
    } finally {
      db();
      clearAgentTranscriptStore();
    }
  });
});
