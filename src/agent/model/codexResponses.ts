import { RequestExecution } from "../../utils/requestExecution";
import {
  buildReasoningPayload,
  buildPromptCachePayloadHints,
  postWithReasoningFallback,
  resolveRequestAuthState,
} from "../../utils/llmClient";
import { normalizeTemperature } from "../../utils/normalization";
import { resolveProviderTransportEndpoint } from "../../utils/providerTransport";
import type {
  AgentModelCapabilities,
  AgentRuntimeRequest,
  AgentModelStep,
} from "../types";
import type {
  AgentModelAdapter,
  AgentModelPreparation,
  AgentStepParams,
} from "./adapter";
import { buildAgentModelCapabilities } from "./contentCapabilities";
import {
  buildAgentRecoveryInstruction,
  resolveAgentRecoverableCompletion,
  type AgentRecoverableCompletionReason,
} from "./completion";
import { resolveRequestContentInputs } from "./messageBuilder";
import {
  buildResponsesContinuationInput,
  buildResponsesInitialInput,
  type ResponsesPayload,
  normalizeResponsesStepFromPayload,
  parseResponsesStepStream,
  replayableResponsesOutputItems,
  withoutTrailingReasoningItems,
} from "./responsesShared";
import { buildResponsesFunctionTools } from "./shared";
import {
  CODEX_DIRECT_RESPONSES_URL,
  isSameCodexAuthSession,
  type CodexAuthSession,
} from "../../codexAuth/auth";
import { captureCodexDirectRequestCatalog } from "../../codexAuth/modelCatalog";

type CodexRequestContext = {
  session?: CodexAuthSession;
  catalog?: ReturnType<typeof captureCodexDirectRequestCatalog>;
};

function isCodexAuthRequest(request: AgentRuntimeRequest): boolean {
  return (
    request.authMode === "codex_auth" ||
    /chatgpt\.com\/backend-api\/codex\/responses/i.test(
      (request.apiBase || "").trim(),
    )
  );
}

export {
  normalizeResponsesStepFromPayload as normalizeStepFromPayload,
  parseResponsesStepStream,
} from "./responsesShared";

export class CodexResponsesAgentAdapter implements AgentModelAdapter {
  private conversationItems: unknown[] | null = null;

  getCapabilities(request: AgentRuntimeRequest): AgentModelCapabilities {
    return buildAgentModelCapabilities({
      streaming: true,
      toolCalls: isCodexAuthRequest(request),
      contentInputs: resolveRequestContentInputs(request),
      fileInputs: false,
      reasoning: true,
    });
  }

  supportsTools(request: AgentRuntimeRequest): boolean {
    return this.getCapabilities(request).toolCalls;
  }

  resetState(): void {
    this.conversationItems = null;
  }

  async prepareRequest(params: {
    request: AgentRuntimeRequest;
    signal?: AbortSignal;
  }): Promise<AgentModelPreparation> {
    const execution = new RequestExecution(undefined, params.signal);
    return execution.run(async () => {
      const auth = await execution.wait(() =>
        resolveRequestAuthState({
          authMode: params.request.authMode || "api_key",
          apiKey: params.request.apiKey || "",
          signal: params.signal,
        }),
      );
      const session =
        auth.mode === "codex_auth" && auth.codex
          ? { ...auth.codex, token: auth.token }
          : undefined;
      const catalog =
        auth.mode === "codex_auth"
          ? captureCodexDirectRequestCatalog(session)
          : undefined;
      catalog?.assertModelAvailable(params.request.model || "");
      const limits = catalog?.getModelLimits(params.request.model || "");
      const context: CodexRequestContext = { session, catalog };
      return {
        requestModelLimits: limits ? { ...limits } : undefined,
        runStep: (stepParams: AgentStepParams) =>
          this.runStepWithContext(stepParams, context),
      };
    });
  }

  async runStep(params: AgentStepParams): Promise<AgentModelStep> {
    return this.runStepWithContext(params);
  }

  private async runStepWithContext(
    params: AgentStepParams,
    pinnedContext?: CodexRequestContext,
  ): Promise<AgentModelStep> {
    const execution = new RequestExecution(undefined, params.signal);
    return execution.run(async () => {
      const request = params.request;
      const auth = await execution.wait(() =>
        resolveRequestAuthState({
          authMode: request.authMode || "api_key",
          apiKey: request.apiKey || "",
          signal: params.signal,
        }),
      );
      const session =
        auth.mode === "codex_auth" && auth.codex
          ? { ...auth.codex, token: auth.token }
          : undefined;
      if (
        pinnedContext?.session &&
        (!session || !isSameCodexAuthSession(pinnedContext.session, session))
      ) {
        throw new Error(
          "Codex account changed while this run was active; start a new run.",
        );
      }
      const codexCatalog = pinnedContext
        ? pinnedContext.catalog
        : request.authMode === "codex_auth"
          ? captureCodexDirectRequestCatalog(session)
          : undefined;
      codexCatalog?.assertModelAvailable(request.model || "");
      const initialInput = await execution.wait(() =>
        buildResponsesInitialInput(params.messages, {
          resolveFilePart: async (part) => [
            {
              type: "input_text" as const,
              text: `[Prepared file: ${part.file_ref.name}]`,
            },
          ],
          signal: params.signal,
        }),
      );
      const instructions =
        initialInput.instructions?.trim() ||
        "You are the agent runtime inside a Zotero plugin.";
      const followupInput = this.conversationItems
        ? await execution.wait(() =>
            buildResponsesContinuationInput(params.continuationMessages || [], {
              resolveFilePart: async (part) => [
                {
                  type: "input_text" as const,
                  text: `[Prepared file: ${part.file_ref.name}]`,
                },
              ],
              signal: params.signal,
            }),
          )
        : [];
      const inputItems = this.conversationItems
        ? [...this.conversationItems, ...followupInput]
        : initialInput.input;
      const isCodexDirect = request.authMode === "codex_auth";
      const url = isCodexDirect
        ? CODEX_DIRECT_RESPONSES_URL
        : resolveProviderTransportEndpoint({
            protocol: "codex_responses",
            apiBase: request.apiBase || "",
          });
      const initialReasoning = codexCatalog
        ? codexCatalog.sanitizeReasoning(request.model || "", request.reasoning)
        : request.reasoning;
      const response = await execution.wait(() =>
        postWithReasoningFallback({
          url,
          scope: { conversationKey: request.conversationKey },
          auth,
          modelName: request.model,
          initialReasoning,
          buildPayload: (reasoningOverride) => {
            const reasoningPayload = buildReasoningPayload(
              codexCatalog
                ? codexCatalog.sanitizeReasoning(
                    request.model || "",
                    reasoningOverride,
                  )
                : reasoningOverride,
              true,
              request.model,
              request.apiBase,
              "codex_responses",
              isCodexDirect
                ? undefined
                : { profileOverride: request.advanced?.profileOverride },
            );
            return {
              model: request.model,
              instructions,
              input: inputItems,
              ...buildPromptCachePayloadHints(request.contextCache),
              include: ["reasoning.encrypted_content"],
              tools: buildResponsesFunctionTools(params.tools),
              tool_choice: params.toolChoice === "none" ? "none" : "auto",
              store: false,
              stream: true,
              ...reasoningPayload.extra,
              ...(isCodexDirect || reasoningPayload.omitTemperature
                ? {}
                : {
                    temperature: normalizeTemperature(
                      request.advanced?.temperature,
                    ),
                  }),
            };
          },
          signal: params.signal,
        }),
      );
      const body = response.body;
      const normalized = body
        ? await execution.wait(() =>
            parseResponsesStepStream(
              body,
              params.onTextDelta,
              params.onReasoning,
              params.onUsage,
              { signal: params.signal, stopAtTerminal: isCodexDirect },
            ),
          )
        : normalizeResponsesStepFromPayload(
            (await execution.wait(() => response.json())) as ResponsesPayload,
          );

      execution.assertActive();

      // The provider reports a reply it cut off mid-stream as incomplete with
      // reason "interrupted": a broken stream to ask again, not a block.
      const interrupted =
        normalized.completion.status === "blocked" &&
        normalized.completion.providerReason?.trim().toLowerCase() ===
          "interrupted";
      const recoveryReason: AgentRecoverableCompletionReason | null =
        interrupted
          ? "stream_interrupted"
          : resolveAgentRecoverableCompletion(normalized.completion);
      if (recoveryReason === "stream_interrupted") {
        // The broken step is discarded whole, as the recovery instruction says.
        this.conversationItems = [...inputItems];
        return {
          kind: "incomplete",
          reason: recoveryReason,
          providerReason: normalized.completion.providerReason,
          text: "",
          recoveryInstruction: buildAgentRecoveryInstruction(
            recoveryReason,
            "tool call",
          ),
          assistantMessage: { role: "assistant", content: "" },
        };
      }
      if (recoveryReason) {
        // A reasoning item must not end the replayed items: the recovery
        // message would follow it, and the provider rejects that request.
        this.conversationItems = [
          ...inputItems,
          ...withoutTrailingReasoningItems(
            normalized.outputItems.filter((item) => {
              if (!item || typeof item !== "object") return true;
              const type = String(
                (item as { type?: unknown }).type ?? "",
              ).toLowerCase();
              return type !== "function_call" && type !== "tool_call";
            }),
          ),
        ];
        return {
          kind: "incomplete",
          reason: recoveryReason,
          providerReason: normalized.completion.providerReason,
          text: normalized.text,
          recoveryInstruction: buildAgentRecoveryInstruction(
            recoveryReason,
            "tool call",
          ),
          assistantMessage: {
            role: "assistant",
            content: normalized.text,
          },
        };
      }
      this.conversationItems = [
        ...inputItems,
        ...replayableResponsesOutputItems(normalized),
      ];

      if (normalized.toolCalls.length) {
        return {
          kind: "tool_calls",
          calls: normalized.toolCalls,
          assistantMessage: {
            role: "assistant",
            content: normalized.text,
            tool_calls: normalized.toolCalls,
          },
        };
      }

      return {
        kind: "final",
        text: normalized.text,
        assistantMessage: {
          role: "assistant",
          content: normalized.text,
        },
      };
    });
  }
}
