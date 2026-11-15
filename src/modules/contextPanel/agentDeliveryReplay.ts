/** Native acceptance fixture: only the model is scripted; delivery and the note write are real. */
import { sendAgentTurn } from "./agentMode/agentEngine";
import { buildAgentEngineDepsForTests, getConversationKey } from "./chat";
import { getConversationWriteGeneration } from "../../shared/conversationWriteFence";
import { getAgentRunTrace } from "../../agent/store/traceStore";
import { AgentRuntime } from "../../agent/runtime";
import { AgentToolRegistry } from "../../agent/tools/registry";
import { ActionContractService } from "../../agent/contracts/actionContract";
import { ZoteroGateway } from "../../agent/services/zoteroGateway";
import {
  getOriginalAgentPermissionMode,
  setOriginalAgentPermissionMode,
} from "../../agent/originalAgentPermissionMode";
import {
  clearAgentTranscriptStore,
  readAgentConversationAnswer,
} from "../../agent/store/transcriptStore";

export async function exerciseAgentDeliveryReplay(
  panel: { body: HTMLElement; item: Zotero.Item },
  failFinalRefresh = false,
) {
  const { body, item } = panel;
  body.style.left = "0";
  body.style.width = "420px";
  body.style.zIndex = "99999";
  const key = getConversationKey(item);
  const deps = buildAgentEngineDepsForTests(
    item,
    "upstream",
    getConversationWriteGeneration(key),
  );
  const registry = new AgentToolRegistry(
    new ActionContractService(new ZoteroGateway()),
  );
  registry.register(deps.getAgentRuntime().getToolDefinition("note_write")!);
  const answer = "The requested note is saved under this paper.";
  const call = {
    id: "delivery-note",
    name: "note_write",
    arguments: {
      mode: "create",
      target: "item",
      targetItemId: item.id,
      content: "# Delivery fixture\n\nA complete, persisted note body.",
    },
  };
  const runtime = new AgentRuntime({
    registry,
    adapterFactory: () => {
      let round = 0;
      return {
        supportsTools: () => true,
        getCapabilities: () => ({
          streaming: true,
          toolCalls: true,
          multimodal: false,
          fileInputs: false,
          reasoning: false,
        }),
        runStep: async () =>
          ++round === 1
            ? {
                kind: "tool_calls" as const,
                calls: [call],
                assistantMessage: {
                  role: "assistant" as const,
                  content: "",
                  tool_calls: [call],
                },
              }
            : {
                kind: "final" as const,
                text: answer,
                assistantMessage: {
                  role: "assistant" as const,
                  content: answer,
                },
              },
      };
    },
  });
  deps.getAgentRuntime = () => runtime;
  let injected = false;
  const createHelpers = deps.createPanelUpdateHelpers;
  deps.createPanelUpdateHelpers = (...args) => {
    const helpers = createHelpers(...args);
    return {
      ...helpers,
      refreshAssistantMessageSafely: (message) => {
        if (failFinalRefresh && message.streaming === false && !injected) {
          injected = true;
          throw new Error("Recorded final presentation failure");
        }
        helpers.refreshAssistantMessageSafely(message);
      },
    };
  };
  const previousMode = getOriginalAgentPermissionMode();
  try {
    setOriginalAgentPermissionMode("auto");
    await sendAgentTurn(
      {
        body,
        item,
        question:
          "Create a note under this paper with the text 'Delivery fixture: A complete, persisted note body.' and confirm the saved result.",
      },
      deps,
    );
    const message = deps.chatHistory.get(key)?.at(-1);
    const runId = message?.agentRunId || "";
    const trace = await getAgentRunTrace(runId);
    const rows = await Zotero.DB.queryAsync(
      "SELECT text FROM llm_for_zotero_chat_messages WHERE conversation_key = ? AND role = 'assistant' ORDER BY id",
      [key],
    );
    clearAgentTranscriptStore();
    const retained = await readAgentConversationAnswer(
      key,
      `${runId}:answer`,
    ).catch((error) => String(error));
    await item.reload(["childItems"], true);
    return {
      injected,
      runStatus: trace.run?.status,
      finalText: trace.run?.finalText,
      retained,
      storedAnswers: (rows || []).map((row) => String(row.text || "")),
      messageText: message?.text,
      streaming: message?.streaming,
      summary: body.querySelector(".llm-agent-activity-summary")?.textContent,
      actionCards: body.querySelectorAll(".llm-agent-action-summary-card")
        .length,
      status: body.querySelector("#llm-status")?.textContent,
      noteIds: item.getNotes(),
      verified: trace.events.some(
        (event) =>
          event.payload.type === "tool_result" &&
          event.payload.actionReceipts?.some(
            (receipt) =>
              receipt.operation === "note_create" &&
              receipt.status === "applied" &&
              receipt.verification === "verified",
          ),
      ),
    };
  } finally {
    setOriginalAgentPermissionMode(previousMode);
  }
}
