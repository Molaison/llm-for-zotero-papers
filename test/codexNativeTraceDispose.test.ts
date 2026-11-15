import { assert } from "chai";
import { createCodexNativeActivityTraceControllerForTests } from "../src/modules/contextPanel/codexNativeTrace/controller";
import {
  getAgentRunTrace,
  initAgentTraceStore,
} from "../src/agent/store/traceStore";
import { installMockDb } from "./helpers/agentRuntimeMockDb";

/**
 * End of life for one native Codex turn's trace controller.
 *
 * The controller buffers agent-message text in per-item coalescers that each
 * hold a pending timer, and it writes the turn's events straight onto the
 * assistant message it was built for. When the turn ends both have to stop:
 * a timer that fires afterwards would rewrite a message the panel has already
 * finalized and persisted, and a caller that keeps the handle must not be able
 * to reopen the trace.
 */
describe("codex native trace controller disposal", function () {
  it("drops buffered progress text instead of letting a timer deliver it after the turn", async function () {
    this.timeout(5000);
    const message: any = {
      role: "assistant",
      text: "",
      timestamp: 1,
      runMode: "agent",
    };
    let refreshes = 0;
    const controller = createCodexNativeActivityTraceControllerForTests(
      message,
      () => {
        refreshes += 1;
      },
    );

    // Short enough to stay in the coalescer's buffer behind its flush timer.
    controller.appendAgentMessageDelta({
      itemId: "assistant-commentary",
      delta: "still buffered",
    });
    assert.isUndefined(
      message.pendingAgentTraceEvents,
      "the delta is buffered, not yet delivered",
    );

    controller.dispose();
    await new Promise((resolve) => setTimeout(resolve, 800));

    assert.isUndefined(
      message.pendingAgentTraceEvents,
      "a disposed controller has no coalescer left to flush",
    );
    assert.equal(refreshes, 0, "and asks for no panel refresh after the turn");
  });

  it("detaches from its assistant message so later events cannot rewrite it", function () {
    const message: any = {
      role: "assistant",
      text: "",
      timestamp: 1,
      runMode: "agent",
    };
    let refreshes = 0;
    const controller = createCodexNativeActivityTraceControllerForTests(
      message,
      () => {
        refreshes += 1;
      },
    );
    controller.appendNativePlanProgress([
      { content: "Inspect the scope", status: "completed" },
    ]);
    const delivered = message.pendingAgentTraceEvents;
    assert.equal(refreshes, 1);
    assert.deepEqual(
      delivered.map((entry: any) => entry.eventType),
      ["codex_progress"],
    );

    controller.dispose();
    controller.appendNativePlanProgress([
      { content: "Inspect the scope again", status: "running" },
    ]);
    controller.finish("final answer");

    assert.strictEqual(
      message.pendingAgentTraceEvents,
      delivered,
      "the message keeps the events it had when the turn ended",
    );
    assert.equal(refreshes, 1, "and no further refresh is requested");
  });

  it("is safe to call twice", function () {
    const message: any = {
      role: "assistant",
      text: "",
      timestamp: 1,
      runMode: "agent",
    };
    const controller = createCodexNativeActivityTraceControllerForTests(
      message,
      () => {},
    );
    controller.dispose();
    controller.dispose();
    assert.isUndefined(message.pendingAgentTraceEvents);
  });
});

/**
 * A turn that is cancelled or fails never reaches finish(), so nothing flushes
 * the agent-message coalescers on the way out. The text they hold is real
 * commentary the model already sent, so the flows flush it before they persist
 * the turn -- otherwise the panel would show text the store never received, or
 * (after disposal) lose it entirely.
 */
describe("codex native trace controller flush before persisting", function () {
  let uninstallDb: ReturnType<typeof installMockDb> | null = null;

  before(async function () {
    uninstallDb = installMockDb();
    await initAgentTraceStore();
  });

  after(function () {
    uninstallDb?.();
    uninstallDb = null;
  });

  it("persists commentary that was still buffered when the turn was cancelled", async function () {
    const message: any = {
      role: "assistant",
      text: "[Cancelled]",
      timestamp: 1,
      runMode: "agent",
      agentRunId: "cancelled-native-turn",
      modelName: "gpt-5-codex",
    };
    const controller = createCodexNativeActivityTraceControllerForTests(
      message,
      () => {},
    );
    controller.appendAgentMessageDelta({
      itemId: "commentary",
      delta: "Half a sentence the model had already sent",
    });

    // The turn was interrupted: finish() never runs, so the cancel path has to
    // flush before it persists.
    controller.flushBufferedProgress("cancel");
    await controller.persist(9012, 0, "cancelled");

    const saved = await getAgentRunTrace("cancelled-native-turn");
    assert.equal(saved.run?.status, "cancelled");
    assert.deepEqual(
      saved.events.map((event: any) => event.payload.type),
      ["codex_progress"],
      "the buffered commentary reached the store",
    );
    assert.include(
      (saved.events[0].payload as any).text,
      "Half a sentence the model had already sent",
    );
    assert.deepEqual(
      message.pendingAgentTraceEvents.map((event: any) => event.payload),
      saved.events.map((event: any) => event.payload),
      "what the panel renders and what the store holds agree",
    );
  });

  it("repaints the complete question history after native completion replaces the run identity", async function () {
    const message: any = {
      role: "assistant",
      text: "Ready",
      timestamp: 2,
      runMode: "agent",
      agentRunId: "presentation-question-history",
    };
    const painted: string[] = [];
    const refresh = Object.assign(() => {}, {
      flush: () => painted.push(message.agentRunId),
    });
    const controller = createCodexNativeActivityTraceControllerForTests(
      message,
      refresh,
    );
    controller.noteMcpConfirmationRequired("question", {
      toolName: "request_user_input",
      title: "Review length?",
      fields: [],
    });
    controller.noteMcpConfirmationResolved("question", {
      approved: true,
      data: { length: "Short" },
    });
    controller.finish("Ready");
    message.agentRunId = "native-host-journal";
    painted.length = 0;

    await controller.persist(9013, 0, "completed");

    assert.deepEqual(painted, ["presentation-question-history"]);
    const saved = await getAgentRunTrace(message.agentRunId);
    assert.isTrue(
      saved.events.some(
        (event) =>
          event.payload.type === "confirmation_resolved" &&
          event.payload.data?.length === "Short",
      ),
    );
    controller.dispose();
    controller.noteMcpConfirmationResolved("late", { approved: false });
    assert.lengthOf(
      painted,
      1,
      "disposed traces must not repaint late answers",
    );
  });

  it("reads legacy saved questions using the current interaction contract", async function () {
    const message: any = {
      role: "assistant",
      text: "Ready",
      timestamp: 3,
      agentRunId: "legacy-question-history",
    };
    const controller = createCodexNativeActivityTraceControllerForTests(
      message,
      () => {},
    );
    controller.noteMcpConfirmationRequired("legacy-question", {
      toolName: "request_user_input",
      mode: "review",
      title: "Which length?",
      fields: [{ type: "text", id: "length", label: "Length" }],
    });
    controller.noteMcpConfirmationResolved("legacy-question", {
      approved: true,
      data: { length: "Short" },
    });
    await controller.persist(9014, 0, "completed");
    const saved = await getAgentRunTrace(message.agentRunId);
    const question = saved.events.find(
      (event) => event.payload.type === "confirmation_required",
    )!;
    assert.equal((question.payload as any).action.interaction, "user_input");
    const row = uninstallDb!.events.find(
      (event) =>
        event.runId === message.agentRunId &&
        event.eventType === "confirmation_required",
    )!;
    assert.isUndefined(
      JSON.parse(String(row.payloadJson)).action.interaction,
      "compatibility decoding must not rewrite saved trace evidence",
    );
    controller.dispose();
  });
});
