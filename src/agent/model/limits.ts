import type { AgentRuntimeRequest } from "../types";
import {
  resolveOutputRequestPolicy,
  resolveTransmittedOutputPolicy,
  type OutputRequestPolicy,
} from "../../utils/outputTokenPolicy";
import { resolveModelInputTokenLimit } from "../../utils/modelInputCap";
import type { ProviderProtocol } from "../../utils/providerProtocol";

/**
 * Rounds per segment: how often the loop checks that the run still makes
 * progress (a new successful tool result, or a newly settled target). A run
 * that does goes on, so this is no cap on its rounds.
 */
export const MAX_AGENT_ROUNDS = 24;
/**
 * Tool calls an ordinary step may make. A step of item-scoped work may make
 * one for each of its job's open papers and one more
 * (`LongJobPager.stepLimit`); an ordinary turn has no item scope to derive a
 * limit from, and this one guards against runaway steps.
 */
export const MAX_AGENT_TOOL_CALLS_PER_ROUND = 8;

export const MAX_BULK_AGENT_ROUNDS = 32;
export const MAX_BULK_TOOL_CALLS_PER_ROUND = 10;

/** Words, as the answer-continuation check compares them. */
function answerWords(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
}

/** Runs of this many words compare one answer chunk with another. */
const ANSWER_RUN_WORDS = 4;

/**
 * Whether a continuation of a cut-off answer adds new text rather than
 * repeating what the answer already holds: at least half of its runs of four
 * words are new (a chunk shorter than one run: it does not occur already).
 * A model that starts over, or writes the same part again, adds nothing.
 */
export function addsNewAnswerText(chunk: string, before: string): boolean {
  const added = answerWords(chunk);
  if (!added.length) return false;
  const seen = answerWords(before);
  if (added.length < ANSWER_RUN_WORDS)
    return !` ${seen.join(" ")} `.includes(` ${added.join(" ")} `);
  const runs = (words: readonly string[]) =>
    words
      .slice(0, words.length - ANSWER_RUN_WORDS + 1)
      .map((_, index) =>
        words.slice(index, index + ANSWER_RUN_WORDS).join(" "),
      );
  const known = new Set(runs(seen));
  const chunkRuns = runs(added);
  const fresh = chunkRuns.filter((run) => !known.has(run)).length;
  return fresh * 2 >= chunkRuns.length;
}

/**
 * The most times a cut-off answer is asked to continue: as many full-size
 * answers (the output reserve) as the input budget left beside the prompt
 * holds, and at least one. Each continuation sends the answer so far again,
 * so past that the answer could no longer be seen whole.
 */
export function answerContinuationCeiling(params: {
  budgetTokens: number;
  promptTokens: number;
  outputTokens: number;
}): number {
  return Math.max(
    1,
    Math.floor(
      (params.budgetTokens - params.promptTokens) /
        Math.max(1, params.outputTokens),
    ),
  );
}

/**
 * Resolve one Agent inference's wire policy. Whole-run limits remain owned by
 * the runtime's rounds, progress checks, checkpoints, and context compaction.
 */
export function resolveAgentOutputRequestPolicy(
  request: AgentRuntimeRequest,
  protocol: ProviderProtocol,
): OutputRequestPolicy {
  const policy = resolveOutputRequestPolicy({
    setting: request.advanced?.outputTokenLimit,
    model: request.model || "",
    apiBase: request.apiBase,
    protocol,
    authMode: request.authMode,
    profileOverride: request.advanced?.profileOverride,
  });
  (
    globalThis as typeof globalThis & {
      ztoolkit?: { log?: (...args: unknown[]) => void };
    }
  ).ztoolkit?.log?.("LLM Agent: Resolved output policy", {
    settingMode: request.advanced?.outputTokenLimit?.mode || "auto",
    resolutionSource: policy.source,
    transmittedPolicy:
      policy.mode === "numeric"
        ? { mode: "numeric", tokens: policy.tokens }
        : { mode: policy.mode },
    protocol,
  });
  return policy;
}

/**
 * The cap transmitted for one Agent inference: the resolved policy, shrunk to
 * the room left beside this request's estimated input so the provider never
 * rejects `input + max_tokens > context window`.
 */
export function resolveAgentTransmittedOutputPolicy(
  request: AgentRuntimeRequest,
  protocol: ProviderProtocol,
  estimatedInputTokens: number,
): OutputRequestPolicy {
  const policy = resolveAgentOutputRequestPolicy(request, protocol);
  if (policy.mode !== "numeric") return policy;
  const contextWindow = resolveModelInputTokenLimit(
    request.model || "",
    request.advanced?.inputTokenCap,
    {
      apiBase: request.apiBase,
      protocol,
      authMode: request.authMode,
      profileOverride: request.advanced?.profileOverride,
    },
  ).limitTokens;
  const transmitted = resolveTransmittedOutputPolicy({
    policy,
    contextWindow,
    estimatedInputTokens,
  });
  if (transmitted !== policy) {
    (
      globalThis as typeof globalThis & {
        ztoolkit?: { log?: (...args: unknown[]) => void };
      }
    ).ztoolkit?.log?.("LLM Agent: Clamped output cap to the context window", {
      protocol,
      contextWindow,
      estimatedInputTokens,
      requestedTokens: policy.tokens,
      transmittedTokens:
        transmitted.mode === "numeric" ? transmitted.tokens : undefined,
    });
  }
  return transmitted;
}

export function resolveAgentLimits(isBulkOperation: boolean): {
  maxRounds: number;
  maxToolCallsPerRound: number;
} {
  if (isBulkOperation) {
    return {
      maxRounds: MAX_BULK_AGENT_ROUNDS,
      maxToolCallsPerRound: MAX_BULK_TOOL_CALLS_PER_ROUND,
    };
  }
  return {
    maxRounds: MAX_AGENT_ROUNDS,
    maxToolCallsPerRound: MAX_AGENT_TOOL_CALLS_PER_ROUND,
  };
}
