/**
 * Native acceptance fixture for a long job: only the model is scripted. The
 * runtime pages a folder's papers through the real task_update tool, the
 * real event handling and the real Task progress view; paper_read is a stub
 * that returns each paper's text, sized to the page share the host sets.
 */
import { sendAgentTurn } from "./agentMode/agentEngine";
import { buildAgentEngineDepsForTests, getConversationKey } from "./chat";
import { flushTaskProgressPanels } from "./taskProgress/panel";
import { getConversationWriteGeneration } from "../../shared/conversationWriteFence";
import { getAgentRunTrace } from "../../agent/store/traceStore";
import { AgentRuntime } from "../../agent/runtime";
import { AgentToolRegistry } from "../../agent/tools/registry";
import { ActionContractService } from "../../agent/contracts/actionContract";
import { ZoteroGateway } from "../../agent/services/zoteroGateway";
import type { CollectionContextRef } from "../../shared/types";
import type {
  AgentModelMessage,
  AgentModelStep,
  AgentToolCall,
  AgentToolContext,
} from "../../agent/types";

/** About this many characters of text per paper, before the page share. */
const PAPER_TEXT_CHARACTERS = 16_000;

function contentText(message: AgentModelMessage): string {
  return typeof message.content === "string"
    ? message.content
    : message.content
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("\n");
}

export async function exerciseLongJobReplay(
  panel: { body: HTMLElement; item: Zotero.Item },
  input: {
    collection: CollectionContextRef;
    papers: Array<{ itemId: number; title: string }>;
    /** The model's input cap, which sets how many papers a page holds. */
    inputTokenCap: number;
  },
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
  registry.register(deps.getAgentRuntime().getToolDefinition("task_update")!);
  registry.register({
    spec: {
      name: "paper_read",
      description: "Read one paper",
      inputSchema: { type: "object" },
      executionClass: "read",
      workCategory: "retrieval",
    },
    validate: (args: unknown) => ({ ok: true, value: args as never }),
    execute: async (args: unknown, context: AgentToolContext) => {
      const target = (args as { target?: { itemId?: number } }).target;
      const itemId = Number(target?.itemId);
      // An overview read takes no more than the page share the host set.
      const share = context.request.runtimeContextBudget?.maxTokensPerPaper;
      const characters = Math.min(
        PAPER_TEXT_CHARACTERS,
        share ? share * 4 : PAPER_TEXT_CHARACTERS,
      );
      const text =
        `Finding ${itemId}: drift was measured in this paper. ${"Representational drift details. ".repeat(
          characters / 31,
        )}`.slice(0, characters);
      return {
        mode: "targeted",
        results: [],
        papers: [
          {
            paperContext: {
              itemId,
              contextItemId: itemId,
              libraryID: item.libraryID,
            },
            passages: [{ text, sectionLabel: "Results", pageLabel: "2" }],
          },
        ],
      };
    },
  } as never);

  // What Task progress showed before each model step: the row's count and
  // the job's step label, as a reader would see them.
  const rowCounts: string[] = [];
  const stepLabels: string[] = [];
  const observe = () => {
    flushTaskProgressPanels();
    const row = body.querySelector("#llm-task-progress") as HTMLElement | null;
    const drawer = body.querySelector(
      "#llm-task-progress-drawer",
    ) as HTMLElement | null;
    if (row && !row.hidden && drawer?.hidden) {
      row.click();
      flushTaskProgressPanels();
    }
    const count =
      body.querySelector(".llm-task-progress-count")?.textContent || "";
    if (count && rowCounts[rowCounts.length - 1] !== count)
      rowCounts.push(count);
    const label =
      body.querySelector(".llm-task-progress-steps .llm-plan-task-label")
        ?.textContent || "";
    if (label && stepLabels[stepLabels.length - 1] !== label)
      stepLabels.push(label);
  };

  const asked = new Set<number>();
  const answer = "Each paper of the folder is summarized from its results.";
  const runtime = new AgentRuntime({
    registry,
    resolveTurnScopePapers: async () => ({
      wholeLibrary: false,
      itemIds: input.papers.map((paper) => paper.itemId),
      withText: input.papers.length,
      papers: Object.fromEntries(
        input.papers.map((paper) => [
          paper.itemId,
          { title: paper.title, text: "pdf" as const },
        ]),
      ),
    }),
    adapterFactory: () => {
      let round = 0;
      const step = (calls: AgentToolCall[]): AgentModelStep => ({
        kind: "tool_calls",
        calls,
        assistantMessage: { role: "assistant", content: "", tool_calls: calls },
      });
      return {
        supportsTools: () => true,
        getCapabilities: () => ({
          streaming: false,
          toolCalls: true,
          multimodal: false,
          fileInputs: false,
          reasoning: false,
        }),
        runStep: async ({ messages }): Promise<AgentModelStep> => {
          observe();
          round += 1;
          if (round === 1)
            return step([
              {
                id: "declare-1",
                name: "task_update",
                arguments: {
                  tasks: [
                    {
                      taskId: "read-all",
                      description: `Read each paper in ${input.collection.name}`,
                      expectedEffect: "read",
                      scope: true,
                    },
                  ],
                },
              },
            ]);
          const host = [...messages]
            .reverse()
            .map(contentText)
            .find((text) => text.startsWith("Long job"));
          const page = host
            ? [...host.matchAll(/^- itemId=(\d+)/gm)]
                .map((match) => Number(match[1]))
                .filter((itemId) => !asked.has(itemId))
                .slice(0, 8)
            : [];
          if (!host || host.startsWith("Long job complete") || !page.length) {
            return {
              kind: "final",
              text: answer,
              assistantMessage: { role: "assistant", content: answer },
            };
          }
          for (const itemId of page) asked.add(itemId);
          return step(
            page.map((itemId) => ({
              id: `read-${itemId}`,
              name: "paper_read",
              arguments: {
                target: {
                  itemId,
                  contextItemId: itemId,
                  libraryID: item.libraryID,
                },
              },
            })),
          );
        },
      };
    },
  });
  deps.getAgentRuntime = () => runtime;
  await sendAgentTurn(
    {
      body,
      item,
      question: `Read every paper in ${input.collection.name} and summarize each`,
      selectedCollectionContexts: [input.collection],
      advanced: {
        temperature: 0,
        outputTokenLimit: { mode: "auto" },
        inputTokenCap: input.inputTokenCap,
      },
    },
    deps,
  );
  observe();
  const message = deps.chatHistory.get(key)?.at(-1);
  const trace = await getAgentRunTrace(message?.agentRunId || "");
  return {
    rowCounts,
    stepLabels,
    runStatus: trace.run?.status,
    finalText: trace.run?.finalText,
    pages: trace.events.flatMap((event) =>
      event.payload.type === "provider_event" &&
      event.payload.providerType === "agent_long_job_page"
        ? [event.payload.payload || {}]
        : [],
    ),
  };
}
