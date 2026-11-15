import { assert } from "chai";
import {
  createReasoningRefreshCoalescer,
  REASONING_REFRESH_MAX_CHARS,
  REASONING_REFRESH_MAX_WAIT_MS,
} from "../src/modules/contextPanel/agentTrace/reasoningRefreshCoalescer";
import {
  createAgentTurnEventHandler,
  type AgentEngineDeps,
} from "../src/modules/contextPanel/agentMode/agentEngine";
import type { Message } from "../src/modules/contextPanel/types";

/** A clock the test advances, with timers that fire when it passes them. */
function createManualClock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    setTimer: (callback: () => void, delayMs: number) => {
      nextId += 1;
      timers.set(nextId, { at: now + delayMs, callback });
      return nextId;
    },
    clearTimer: (timer: unknown) => {
      timers.delete(timer as number);
    },
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].callback();
      }
      now = target;
    },
    pendingTimers: () => timers.size,
  };
}

describe("reasoning refresh coalescer", function () {
  it("turns 500 deltas in 50 ms into a handful of repaints with the text intact", function () {
    const clock = createManualClock();
    const flushed: string[] = [];
    const coalescer = createReasoningRefreshCoalescer({
      onFlush: (text) => flushed.push(text),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    let streamed = "";
    for (let n = 0; n < 500; n += 1) {
      // Provider-sized deltas: a word or two, 2-6 characters.
      const delta = ["a ", "the ", "replay ", "of "][n % 4];
      streamed += delta;
      coalescer.push(delta);
      clock.advance(0.1);
    }
    clock.advance(REASONING_REFRESH_MAX_WAIT_MS);
    // 1,950 characters: four size flushes plus the trailing timer flush.
    assert.isAtMost(flushed.length, 6);
    assert.isAtLeast(flushed.length, 2);
    assert.equal(flushed.join(""), streamed);
    assert.isFalse(coalescer.hasPending());
    assert.equal(clock.pendingTimers(), 0);
  });

  it("repaints a slow trickle once per wait window, measured from the oldest delta", function () {
    const clock = createManualClock();
    const flushed: string[] = [];
    const coalescer = createReasoningRefreshCoalescer({
      onFlush: (text) => flushed.push(text),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    // One short delta every 10 ms for a second: never enough text to flush
    // on size, so the timer alone decides, and it is never pushed back.
    for (let n = 0; n < 100; n += 1) {
      coalescer.push("x");
      clock.advance(10);
    }
    clock.advance(REASONING_REFRESH_MAX_WAIT_MS);
    assert.equal(flushed.join(""), "x".repeat(100));
    assert.isAtMost(
      flushed.length,
      Math.ceil(1000 / REASONING_REFRESH_MAX_WAIT_MS) + 1,
    );
    assert.isAtLeast(flushed.length, 7);
  });

  it("flushes on size without waiting for the timer", function () {
    const clock = createManualClock();
    const flushed: string[] = [];
    const coalescer = createReasoningRefreshCoalescer({
      onFlush: (text) => flushed.push(text),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    coalescer.push("y".repeat(REASONING_REFRESH_MAX_CHARS - 1));
    assert.deepEqual(flushed, []);
    coalescer.push("y");
    assert.lengthOf(flushed, 1);
    assert.equal(clock.pendingTimers(), 0);
  });

  it("flushes waiting thinking first when anything else happens, and cancel drops it", function () {
    const clock = createManualClock();
    const log: string[] = [];
    const coalescer = createReasoningRefreshCoalescer({
      onFlush: (text) => log.push(`reasoning:${text}`),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    coalescer.push("thinking ");
    coalescer.push("more");
    coalescer.flushNow();
    log.push("tool_call");
    coalescer.flushNow();
    assert.deepEqual(log, ["reasoning:thinking more", "tool_call"]);
    coalescer.push("dropped");
    coalescer.cancel();
    clock.advance(1000);
    assert.deepEqual(log, ["reasoning:thinking more", "tool_call"]);
  });
});

describe("agent turn reasoning refreshes", function () {
  it("batches a burst of thinking deltas and paints them before the next event", async function () {
    const log: string[] = [];
    const assistantMessage: Message = {
      role: "assistant",
      text: "",
      timestamp: 2,
      runMode: "agent",
      streaming: true,
    };
    const deps = {
      appendReasoningPart: (base: string | undefined, next?: string) =>
        `${base || ""}${next || ""}`,
      sanitizeText: (text: string) => text,
    } as unknown as AgentEngineDeps;
    const handle = createAgentTurnEventHandler({
      deps,
      body: {} as Element,
      ui: {} as never,
      conversationKey: 1,
      runtimeRequest: { conversationKey: 1, mode: "agent", userText: "Q" },
      assistantMessage,
      pairedUserMessage: { role: "user", text: "Q", timestamp: 1 },
      history: [],
      isCompactCommand: false,
      compactStyle: "keep-assistant",
      messageDeltaCoalescer: { pushText: () => {} },
      flushMessageDeltas: () => {},
      queueRefresh: () =>
        log.push(`refresh:${(assistantMessage.reasoningSummary || "").length}`),
      refreshAssistant: () => {},
      refreshChatSafely: () => {},
      setStatusSafely: (text) => log.push(`status:${text}`),
      pushTraceEvent: () => {},
      scheduleQueueDrain: () => {},
    });
    let streamed = "";
    for (let n = 0; n < 500; n += 1) {
      const delta = `w${n % 10} `;
      streamed += delta;
      await handle({ type: "reasoning", round: 1, summary: delta });
    }
    const reasoningRefreshes = log.filter((entry) =>
      entry.startsWith("refresh:"),
    );
    // 1,500 characters arrive far inside one wait window: size alone flushes.
    assert.isAtMost(reasoningRefreshes.length, 4);
    await handle({ type: "status", text: "Reading the paper" });
    const statusIndex = log.indexOf("status:Reading the paper");
    assert.isAbove(statusIndex, 0);
    // The waiting thinking was painted, complete, before the status landed.
    assert.equal(log[statusIndex - 1], `refresh:${streamed.length}`);
    assert.equal(assistantMessage.reasoningSummary, streamed);
    assert.isAtMost(
      log.filter((entry) => entry.startsWith("refresh:")).length,
      6,
    );
  });

  it("paints waiting thinking at the final event and never again from a timer", async function () {
    const clock = createManualClock();
    let refreshes = 0;
    const assistantMessage: Message = {
      role: "assistant",
      text: "",
      timestamp: 2,
      runMode: "agent",
      streaming: true,
    };
    const queueRefresh = () => {
      refreshes += 1;
    };
    const handle = createAgentTurnEventHandler({
      deps: {
        appendReasoningPart: (base: string | undefined, next?: string) =>
          `${base || ""}${next || ""}`,
        sanitizeText: (text: string) => text,
      } as unknown as AgentEngineDeps,
      body: {} as Element,
      ui: {} as never,
      conversationKey: 1,
      runtimeRequest: { conversationKey: 1, mode: "agent", userText: "Q" },
      assistantMessage,
      pairedUserMessage: { role: "user", text: "Q", timestamp: 1 },
      history: [],
      isCompactCommand: false,
      compactStyle: "keep-assistant",
      messageDeltaCoalescer: { pushText: () => {} },
      flushMessageDeltas: () => {},
      reasoningRefreshes: createReasoningRefreshCoalescer({
        onFlush: queueRefresh,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
      }),
      queueRefresh,
      refreshAssistant: () => {},
      refreshChatSafely: () => {},
      setStatusSafely: () => {},
      pushTraceEvent: () => {},
      scheduleQueueDrain: () => {},
    });
    await handle({ type: "reasoning", round: 1, summary: "Last thought." });
    assert.equal(refreshes, 0);
    try {
      await handle({ type: "final", text: "Answer." });
    } catch {
      // The final branch reaches services this stub does not provide; the
      // flush under test happens before the branch runs.
    }
    const atFinal = refreshes;
    assert.isAtLeast(atFinal, 1);
    assert.equal(clock.pendingTimers(), 0);
    clock.advance(1000);
    assert.equal(refreshes, atFinal);
  });
});
