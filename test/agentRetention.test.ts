import { assert } from "chai";
import { AgentRuntime } from "../src/agent/runtime";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import {
  clearAgentTranscriptStore,
  loadLatestAgentTranscriptSegment,
} from "../src/agent/store/transcriptStore";
import type { AgentModelMessage, AgentModelStep } from "../src/agent/types";
import { installMockDb } from "./helpers/agentRuntimeMockDb";

describe("conversation content retention", function () {
  beforeEach(function () {
    clearAgentTranscriptStore();
  });

  for (const changeModel of [false, true]) {
    it(`retains the exact visible answer after restart${changeModel ? " and model change" : ""}`, async function () {
      const restore = installMockDb();
      const answer =
        "## Comparison\n\n" +
        "A substantive paragraph with spacing.\n\n".repeat(40) +
        "## Last section\n\nExact tail: α = 0.125; **retain this**.\n";
      const prompts: AgentModelMessage[][] = [];
      const run = async (userText: string, model: string, text: string) =>
        new AgentRuntime({
          registry: new AgentToolRegistry(),
          adapterFactory: () => ({
            supportsTools: () => true,
            getCapabilities: () => ({
              streaming: false,
              toolCalls: true,
              multimodal: false,
            }),
            async runStep(params): Promise<AgentModelStep> {
              prompts.push(params.messages.slice());
              return {
                kind: "final",
                text,
                assistantMessage: { role: "assistant", content: text },
              };
            },
          }),
        }).runTurn({
          request: {
            conversationKey: 919141,
            mode: "agent",
            model,
            userText,
            libraryID: 1,
          },
        });
      try {
        assert.equal(
          (await run("Compare the three approaches.", "gpt-5.4", answer)).kind,
          "completed",
        );
        clearAgentTranscriptStore();
        assert.equal(
          (
            await run(
              "Explain your last section.",
              changeModel ? "deepseek-v4-flash" : "gpt-5.4",
              "Explanation.",
            )
          ).kind,
          "completed",
        );
        assert.isTrue(
          prompts[1].some(
            (message) =>
              message.role === "assistant" && message.content === answer,
          ),
          "fresh sessions must receive the exact recent visible answer",
        );
        if (!changeModel)
          assert.deepEqual(
            prompts[1].filter((message) => message.role === "system"),
            prompts[0].filter((message) => message.role === "system"),
            "retaining answers must preserve stable prompt prefix bytes",
          );
        const stored = await loadLatestAgentTranscriptSegment(919141);
        assert.isTrue(
          stored?.messages.some(
            (message) =>
              message.role === "assistant" && message.content === answer,
          ),
        );
      } finally {
        restore();
      }
    });
  }
});
