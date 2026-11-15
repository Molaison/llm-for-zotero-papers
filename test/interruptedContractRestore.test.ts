/**
 * A run interrupted before the semantic classifier was removed may end with
 * a stored action contract. The next turn reads that run to recover from the
 * interruption, and the contract never comes back: the tool the model calls
 * sees no contract, progress or preparation, its write runs once, the model
 * is never shown the old contract, and the turn records no contract of its own.
 */
import { assert } from "chai";
import { stateChangeInvocationPlan } from "../src/agent/authorization/invocationPlan";
import type { AgentModelStep } from "../src/agent/model/adapter";
import { AgentRuntime } from "../src/agent/runtime";
import { initAgentChangeJournal } from "../src/agent/store/changeJournal";
import {
  appendAgentRunEvent,
  createAgentRun,
  INTERRUPTED_AGENT_RUN_MARKER,
  initAgentTraceStore,
} from "../src/agent/store/traceStore";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import type { AgentEvent, AgentModelMessage } from "../src/agent/types";
import { createTestActionContractService } from "./helpers/actionContractService";
import { installMockDb } from "./helpers/agentRuntimeMockDb";

const CONVERSATION_KEY = 704;
const LEGACY_CONTRACT_ID = "legacy-contract-704";

/** A contract checkpoint as the classifier-era runtime stored it. */
const legacyContract = {
  version: 4,
  id: LEGACY_CONTRACT_ID,
  writeDisposition: "required",
  interpretationSource: "classifier",
  hardConstraints: [],
  obligations: [
    {
      id: "legacy-obligation",
      operation: "command_execute",
      proofDomain: "execution",
      capability: "command.execute",
      coverage: "one",
      targetKind: "command",
    },
  ],
};
const legacyProgress = {
  version: 1,
  contractId: LEGACY_CONTRACT_ID,
  state: "pending",
  correctionCount: 0,
  obligations: [
    {
      obligationId: "legacy-obligation",
      status: "open",
      verifiedTargetIds: [],
      unresolvedTargetIds: [],
      journalStepIds: [],
      failureReasons: [],
    },
  ],
  appliedReceiptKeys: [],
  authorizationGrants: [],
  updatedAt: 1,
};

describe("an interrupted run's stored action contract", function () {
  it("does not reach the next turn, its tools, or its model", async function () {
    const installed = installMockDb();
    try {
      await initAgentChangeJournal();
      await createAgentRun({
        runId: "legacy-run",
        conversationKey: CONVERSATION_KEY,
        mode: "agent",
        status: "running",
        createdAt: 1,
      });
      await appendAgentRunEvent("legacy-run", 1, {
        type: "provider_event",
        providerType: "agent_action_contract",
        payload: { contract: legacyContract, progress: legacyProgress },
      });
      // A restart marks the run that was still running as interrupted.
      await initAgentTraceStore();
      const legacyRun = installed.runs.get("legacy-run");
      assert.equal(legacyRun?.finalText, INTERRUPTED_AGENT_RUN_MARKER);

      const seen: Array<Record<string, unknown>> = [];
      let writes = 0;
      const registry = new AgentToolRegistry(createTestActionContractService());
      registry.register({
        effectOperations: ["command_execute"],
        spec: {
          name: "legacy_write",
          description: "write",
          inputSchema: { type: "object" },
          executionClass: "external_effect",
          requiresConfirmation: false,
        },
        validate: () => ({ ok: true, value: {} }),
        describeAction: () => [
          {
            id: "command_execute:legacy-write",
            proofDomain: "execution" as const,
            capability: "command.execute" as const,
            operation: "command_execute" as const,
            source: "command" as const,
            requestedTargets: [],
            destinationCollectionIds: [],
          },
        ],
        planInvocation: () =>
          stateChangeInvocationPlan({
            domains: ["local_execution"],
            reversibility: "full",
            reason: "Test write after an interrupted legacy run.",
          }),
        execute: async (_input, context) => {
          writes += 1;
          const request = context.request as unknown as Record<string, unknown>;
          seen.push({
            actionContract: request.actionContract,
            actionProgress: request.actionProgress,
            actionPreparation: request.actionPreparation,
          });
          return { content: { status: "saved" }, effect: "applied" };
        },
      });

      const prompts: AgentModelMessage[][] = [];
      let step = 0;
      const runtime = new AgentRuntime({
        registry,
        adapterFactory: () => ({
          getCapabilities: () => ({
            streaming: false,
            toolCalls: true,
            multimodal: false,
            fileInputs: false,
            reasoning: true,
          }),
          supportsTools: () => true,
          async runStep(params): Promise<AgentModelStep> {
            prompts.push(params.messages);
            step += 1;
            if (step === 1) {
              const call = {
                id: "legacy-call",
                name: "legacy_write",
                arguments: {},
              };
              return {
                kind: "tool_calls",
                calls: [call],
                assistantMessage: {
                  role: "assistant",
                  content: "",
                  tool_calls: [call],
                },
              };
            }
            return {
              kind: "final",
              text: "Done.",
              assistantMessage: { role: "assistant", content: "Done." },
            };
          },
        }),
      });
      const events: AgentEvent[] = [];
      const outcome = await runtime.runTurn({
        request: {
          conversationKey: CONVERSATION_KEY,
          mode: "agent",
          userText: "continue",
          model: "gpt-4o-mini",
          apiBase: "https://api.openai.com/v1/chat/completions",
          apiKey: "test",
        },
        onEvent: (event) => events.push(event),
      });

      assert.equal(outcome.kind, "completed");
      assert.equal(writes, 1, "the write runs once, under no old contract");
      assert.deepEqual(seen, [
        {
          actionContract: undefined,
          actionProgress: undefined,
          actionPreparation: undefined,
        },
      ]);
      assert.notInclude(
        JSON.stringify(prompts),
        LEGACY_CONTRACT_ID,
        "the model is never shown the old contract",
      );
      assert.isFalse(
        events.some(
          (event) =>
            event.type === "provider_event" &&
            event.providerType === "agent_action_contract",
        ),
        "the turn records no contract of its own",
      );
    } finally {
      installed();
    }
  });
});
