import type { ReasoningEvent, UsageStats } from "../../utils/llmClient";
import type { ModelCapabilityLimits } from "../../modelCapabilities/types";
import type {
  AgentModelCapabilities,
  AgentToolCall,
  AgentModelMessage,
  AgentModelStep,
  AgentRuntimeRequest,
  ToolSpec,
} from "../types";

export type AgentAdapterToolContentItem =
  | { type: "inputText"; text: string }
  | { type: "inputImage"; imageUrl: string };

export type AgentAdapterToolCallResult = {
  contentItems: AgentAdapterToolContentItem[];
  success: boolean;
};

export type AgentStepParams = {
  request: AgentRuntimeRequest;
  messages: AgentModelMessage[];
  /** Messages appended after the preceding model response. */
  continuationMessages?: AgentModelMessage[];
  tools: ToolSpec[];
  /**
   * "none" asks for an answer without tool calls while keeping the tool
   * definitions (the history holds tool calls and results). An adapter
   * whose provider has no such control sends its default; the runtime then
   * rejects a tool call in that step (`turnBoundary.ts`, Rule 2).
   */
  toolChoice?: "auto" | "none";
  signal?: AbortSignal;
  onTextDelta?: (delta: string) => void | Promise<void>;
  onReasoning?: (event: ReasoningEvent) => void | Promise<void>;
  onUsage?: (usage: UsageStats) => void | Promise<void>;
  onToolCall?: (call: AgentToolCall) => Promise<AgentAdapterToolCallResult>;
};

export type AgentModelPreparation = {
  requestModelLimits?: ModelCapabilityLimits;
  runStep: (params: AgentStepParams) => Promise<AgentModelStep>;
};

export interface AgentModelAdapter {
  getCapabilities(request: AgentRuntimeRequest): AgentModelCapabilities;
  supportsTools(request: AgentRuntimeRequest): boolean;
  prepareRequest?(params: {
    request: AgentRuntimeRequest;
    signal?: AbortSignal;
  }): Promise<AgentModelPreparation>;
  resetState?(): void;
  runStep(params: AgentStepParams): Promise<AgentModelStep>;
}
