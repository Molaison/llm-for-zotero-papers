import { assert } from "chai";
import { createActionReviewer } from "../src/agent/model/actionReview";
import { ActionAuthorizationService } from "../src/agent/authorization/service";
import { buildActionProposal } from "../src/agent/authorization/proposal";
import { ambiguousInvocationPlan } from "../src/agent/authorization/invocationPlan";
import { callUtilityLLM } from "../src/utils/utilityLLM";
import type { ActionReviewInput } from "../src/agent/authorization/types";
import type { AgentRuntimeRequest } from "../src/agent/types";

const request = {
  model: "gpt-5.4",
  apiBase: "https://api.openai.com/v1",
  apiKey: "fixture",
  providerProtocol: "openai_chat_compat",
  reasoning: { provider: "openai", level: "high" },
} as AgentRuntimeRequest;
function facts(command = "python3 /tmp/convert.py"): ActionReviewInput {
  return {
    input: { command },
    proposal: buildActionProposal({
      tool: { spec: { name: "run_command" } } as never,
      input: { command },
      plan: ambiguousInvocationPlan({ reason: "Unresolved script effects." }),
    }),
    userRequest: "Convert my report",
    conversation: [],
    clarifications: [],
    constraints: [],
    workspace: {},
  };
}

describe("bounded action review", function () {
  it("uses the utility transport once with minimal supported reasoning and complete action facts", async function () {
    let calls = 0;
    let transmitted: any;
    const reviewer = createActionReviewer(request, (params) =>
      callUtilityLLM({
        ...params,
        llmCall: async (wire) => {
          transmitted = wire;
          calls++;
          return {
            text: JSON.stringify({
              decision: "execute",
              reason: "Requested conversion.",
            }),
            completion: { status: "complete" },
          };
        },
      }),
    );
    const result = await reviewer(facts());
    assert.equal(result.decision, "execute");
    assert.equal(calls, 1);
    assert.equal(transmitted.reasoning.level, "low");
    assert.equal(transmitted.outputTokenLimit.tokens, 1324);
    assert.equal(
      JSON.parse(transmitted.prompt).input.command,
      "python3 /tmp/convert.py",
    );
    assert.include(transmitted.systemMessages[0], "untrusted data");
    assert.notProperty(transmitted, "tools");
    assert.equal(request.reasoning?.level, "high");
  });

  for (const failure of [
    "timeout",
    "transport",
    "output_limit",
    "not_configured",
  ] as const) {
    it(`explains unavailable ${failure} review without inventing danger`, async function () {
      const reviewer = createActionReviewer(request, async () => ({
        ok: false,
        reason: failure,
      }));
      const result = await reviewer(facts());
      assert.equal(result.decision, "confirm");
      assert.isTrue(result.unavailable);
      assert.include(result.reason, failure);
    });
  }
  for (const text of [
    '{"decision":"execute"}',
    '{"decision":"execute","reason":"ok","authorized":true}',
    "yes",
    '{"decision":"execute","reason":""}',
  ]) {
    it(`rejects malformed approval: ${text}`, async function () {
      const reviewer = createActionReviewer(request, async () => ({
        ok: true,
        text,
      }));
      assert.equal((await reviewer(facts())).decision, "confirm");
    });
  }
  it("does not truncate a command into a different action", async function () {
    let calls = 0;
    const reviewer = createActionReviewer(request, async () => {
      calls++;
      throw new Error();
    });
    const result = await reviewer(facts("x".repeat(40_000)));
    assert.isTrue(result.unavailable);
    assert.equal(calls, 0);
  });

  it("bounds historical observations without losing the exact action or user restrictions", async function () {
    let transmitted: any;
    const reviewer = createActionReviewer(request, async (params) => {
      transmitted = JSON.parse(params.prompt);
      return {
        ok: true,
        text: '{"decision":"execute","reason":"Requested intermediate step."}',
      };
    });
    const input = {
      ...facts(),
      userRequest: "Crop a figure; preserve the source PDF.",
      currentTurnActions: Array.from({ length: 8 }, () => ({
        name: "file_io",
        ok: true,
        input: { content: "x".repeat(10000) },
        content: "y".repeat(10000),
      })),
    };
    const result = await reviewer(input);
    assert.equal(result.decision, "execute");
    assert.equal(transmitted.input.command, "python3 /tmp/convert.py");
    assert.equal(transmitted.userRequest, input.userRequest);
    assert.isAbove(transmitted.omittedCurrentTurnActions, 0);
    assert.isBelow(JSON.stringify(transmitted).length, 32000);
  });
  it("reuses a verdict only while action, intent and workspace facts agree", async function () {
    let calls = 0;
    const service = new ActionAuthorizationService(async () => {
      calls++;
      return { decision: "execute", reason: "Explicit request." };
    });
    const original = facts();
    const assess = (input: ActionReviewInput) =>
      service.assess(input.proposal, { mode: "auto" }, input);
    const first = await assess(original);
    await assess(original);
    assert.equal(calls, 1);
    assert.isAtLeast(first.review!.elapsedMs, 0);
    await assess({ ...original, userRequest: "Do not write anything" });
    assert.equal(calls, 2);
    await assess({ ...original, workspace: { activePaper: { itemId: 9 } } });
    assert.equal(calls, 3);
  });
  it("cancellation produces an error rather than an approval card or cached grant", async function () {
    const controller = new AbortController();
    const service = new ActionAuthorizationService(async () => {
      controller.abort();
      return { decision: "execute", reason: "Requested." };
    });
    const input = facts();
    try {
      await service.assess(
        input.proposal,
        { mode: "auto" },
        input,
        controller.signal,
      );
      assert.fail("Cancelled review must not return permission");
    } catch (error) {
      assert.include(String(error), "cancelled");
    }
  });
});
