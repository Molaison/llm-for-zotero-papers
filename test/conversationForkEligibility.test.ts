import { assert } from "chai";
import { evaluateConversationForkEligibility } from "../src/core/conversations/forkEligibility";

const user = (timestamp: number, extra: Record<string, unknown> = {}) => ({
  role: "user",
  timestamp,
  ...extra,
});
const assistant = (timestamp: number, extra: Record<string, unknown> = {}) => ({
  role: "assistant",
  timestamp,
  ...extra,
});

describe("conversation fork eligibility", function () {
  it("allows upstream chat and agent turns", function () {
    for (const runMode of ["chat", "agent"]) {
      const result = evaluateConversationForkEligibility({
        system: "upstream",
        assistantTimestamp: 200,
        assistantMessage: assistant(200, { runMode }),
        history: [user(100, { runMode }), assistant(200, { runMode })],
      });

      assert.equal(result.allowed, true);
      assert.equal(result.visible, true);
    }
  });

  it("allows latest Codex chat and agent turns", function () {
    for (const runMode of ["chat", "agent"]) {
      const result = evaluateConversationForkEligibility({
        system: "codex",
        assistantTimestamp: 200,
        assistantMessage: assistant(200, { runMode }),
        history: [user(100, { runMode }), assistant(200, { runMode })],
        requireProviderSession: true,
        sourceProviderSessionId: "thread-source",
      });

      assert.equal(result.allowed, true);
      assert.equal(result.visible, true);
    }
  });

  it("rejects older Codex turns", function () {
    const result = evaluateConversationForkEligibility({
      system: "codex",
      assistantTimestamp: 200,
      assistantMessage: assistant(200),
      history: [user(100), assistant(200), user(300), assistant(400)],
      requireProviderSession: true,
      sourceProviderSessionId: "thread-source",
    });

    assert.equal(result.allowed, false);
    assert.equal(result.visible, false);
    assert.equal(result.reason, "codex_older_turn");
  });

  it("rejects Claude Code, webchat, compact, pending, and missing native thread states", function () {
    assert.equal(
      evaluateConversationForkEligibility({
        system: "claude_code",
        assistantTimestamp: 200,
      }).reason,
      "claude_code",
    );
    assert.equal(
      evaluateConversationForkEligibility({
        system: "upstream",
        assistantTimestamp: 200,
        webchatMode: true,
      }).reason,
      "webchat",
    );
    assert.equal(
      evaluateConversationForkEligibility({
        system: "upstream",
        assistantTimestamp: 200,
        assistantMessage: assistant(200, { compactMarker: true }),
      }).reason,
      "compact_marker",
    );
    assert.equal(
      evaluateConversationForkEligibility({
        system: "upstream",
        assistantTimestamp: 200,
        pendingResponse: true,
      }).reason,
      "pending_response",
    );
    assert.equal(
      evaluateConversationForkEligibility({
        system: "codex",
        assistantTimestamp: 200,
        assistantMessage: assistant(200),
        history: [user(100), assistant(200)],
        requireProviderSession: true,
      }).reason,
      "missing_provider_session",
    );
  });
});
