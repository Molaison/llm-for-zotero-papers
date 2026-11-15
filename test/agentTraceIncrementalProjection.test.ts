import { assert } from "chai";
import { createPaperReadTool } from "../src/agent/tools/read/paperRead";
import { setAgentToolPresentationResolverForTests } from "../src/modules/contextPanel/agentTrace/toolPresentation";
import {
  buildAgentTraceDisplayItems,
  buildAgentTraceDisplayItemsCanonical,
  disposeAgentTrace,
  renderAgentTrace,
  readAgentTraceProjectionCountersForTests,
  resetAgentTraceProjectionCountersForTests,
} from "../src/modules/contextPanel/agentTrace/render";
import {
  compactAgentTraceEvents,
  createAgentTraceCompactor,
} from "../src/modules/contextPanel/agentTrace/traceReducer";
import {
  scanAgentTraceEvents,
  createAgentTraceEventScan,
  applyAgentTraceEventToScan,
} from "../src/modules/contextPanel/agentTrace/traceEventScan";
import type { AgentEvent, AgentRunEventRecord } from "../src/agent/types";
import type { Message } from "../src/modules/contextPanel/types";
import { fakeDocument, type FakeElement } from "./helpers/fakeDom";

/** A deterministic stream, so a failure names the same step every run. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const PAPER_KEY = "ABCD1234";

/** About a megabyte of paper text, numbered by line like a file read. */
function largeNumberedText(lines: number): string {
  const out: string[] = [];
  for (let line = 1; line <= lines; line += 1)
    out.push(
      `${line}\tThe hippocampal replay evidence in paragraph ${line} supports consolidation.`,
    );
  return out.join("\n");
}

/**
 * A run shaped like a measured live one: two tool results of about a
 * megabyte each, thousands of thinking deltas, a streamed answer with a
 * rollback, stage, status and ledger events woven between them, and a final.
 */
function buildRealisticRun(): AgentEvent[] {
  const random = lcg(20261002);
  const events: AgentEvent[] = [];
  const reasoningBurst = (
    count: number,
    round: number,
    stepId: string | undefined,
    labelAt?: number,
  ) => {
    for (let n = 0; n < count; n += 1) {
      const word =
        random() < 0.05
          ? ` paper ${PAPER_KEY} `
          : random() < 0.5
            ? "evidence "
            : "replay ";
      events.push({
        type: "reasoning",
        round,
        ...(stepId ? { stepId } : {}),
        ...(labelAt === n ? { stepLabel: "Weighing the evidence" } : {}),
        ...(random() < 0.1 ? { details: word } : { summary: word }),
      });
      // A status or ledger event now and then splits the thinking block.
      if (random() < 0.004)
        events.push({ type: "status", text: `Checking source ${n}` });
    }
  };
  const answerBurst = (count: number) => {
    for (let n = 0; n < count; n += 1) {
      events.push({ type: "message_delta", text: `Answer part ${n}. ` });
      if (random() < 0.08)
        events.push({
          type: "reasoning",
          round: 9,
          summary: "interleaved thought ",
        });
    }
  };
  const ledger = (callId: string): AgentEvent => ({
    type: "paper_ledger_update",
    callId,
    delta: {
      version: 1,
      callId,
      toolName: "paper_read",
      papers: [],
      reads: [],
    },
  });

  events.push({ type: "status", text: "Running agent" });
  events.push({ type: "status", text: "Reading the attached paper" });
  reasoningBurst(600, 1, "plan", 200);
  events.push({
    type: "agent_stage",
    stage: "retrieval",
    status: "started",
    callId: "read-1",
    toolName: "paper_read",
  });
  events.push({
    type: "tool_call",
    callId: "read-1",
    name: "paper_read",
    args: { mode: "full", itemId: 1 },
    workCategory: "retrieval",
  });
  reasoningBurst(400, 2, undefined);
  events.push({
    type: "agent_stage",
    stage: "retrieval",
    status: "completed",
    callId: "read-1",
    toolName: "paper_read",
  });
  events.push({
    type: "tool_result",
    callId: "read-1",
    name: "paper_read",
    ok: true,
    workCategory: "retrieval",
    actionReceipts: [],
    content: {
      mode: "full",
      papers: [{ itemId: 1, title: "Replay", text: largeNumberedText(13000) }],
    },
  });
  events.push(ledger("read-1"));
  answerBurst(100);
  reasoningBurst(800, 3, "synthesis", 500);
  events.push({ type: "status", text: "Reading the methods file" });
  events.push({
    type: "agent_stage",
    stage: "retrieval",
    status: "started",
    callId: "read-2",
    toolName: "file_io",
  });
  events.push({
    type: "tool_call",
    callId: "read-2",
    name: "file_io",
    args: { action: "read", filePath: "/tmp/methods.md" },
    workCategory: "retrieval",
  });
  reasoningBurst(300, 4, undefined);
  events.push({
    type: "agent_stage",
    stage: "retrieval",
    status: "completed",
    callId: "read-2",
    toolName: "file_io",
  });
  events.push({
    type: "tool_result",
    callId: "read-2",
    name: "file_io",
    ok: true,
    workCategory: "retrieval",
    actionReceipts: [],
    // A string result: the shape the trace reads a line range and preview from.
    content: largeNumberedText(13000),
  });
  events.push(ledger("read-2"));
  // The run resolves its paper identities, so every later string is relabelled.
  events.push({
    type: "provider_event",
    providerType: "paper_display_labels",
    payload: {
      version: 1,
      displayLabels: { [`1:${PAPER_KEY}`]: "Smith 2020" },
    },
  });
  answerBurst(60);
  events.push({ type: "message_rollback", length: 24, text: "" });
  reasoningBurst(900, 5, "final-check", 10);
  answerBurst(40);
  events.push({ type: "final", text: "The final answer." });
  return events;
}

function paperReadPresentation() {
  return createPaperReadTool(
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
  ).presentation;
}

function record(payload: AgentEvent, seq: number): AgentRunEventRecord {
  return {
    runId: "live-run",
    seq,
    createdAt: 1_000 + seq,
    eventType: payload.type,
    payload,
  };
}

/** A fresh copy of the run, so nothing remembered for it can be reused. */
function cloneEvents(events: AgentRunEventRecord[]): AgentRunEventRecord[] {
  return events.map((entry) => ({
    ...entry,
    payload: JSON.parse(JSON.stringify(entry.payload)) as AgentEvent,
  }));
}

describe("incremental agent trace projection", function () {
  this.timeout(120_000);
  const presentations = { paper_read: paperReadPresentation() };

  beforeEach(function () {
    setAgentToolPresentationResolverForTests(
      (name) => presentations[name as keyof typeof presentations],
    );
  });
  afterEach(function () {
    setAgentToolPresentationResolverForTests(null);
  });

  it("equals the canonical projection after every event of a realistic run, reading each tool result once", function () {
    const run = buildRealisticRun();
    const counts = {
      reasoning: run.filter((event) => event.type === "reasoning").length,
      message: run.filter((event) => event.type === "message_delta").length,
      results: run.filter((event) => event.type === "tool_result").length,
    };
    assert.isAtLeast(counts.reasoning, 3000);
    assert.isAtLeast(counts.message, 200);
    assert.equal(counts.results, 2);

    const user: Message = {
      role: "user",
      text: "Summarize the replay evidence.",
      timestamp: 1,
    };
    const message: Message = {
      role: "assistant",
      text: "",
      timestamp: 2,
      runMode: "agent",
      streaming: true,
      agentRunId: "live-run",
    };
    const events: AgentRunEventRecord[] = [];
    resetAgentTraceProjectionCountersForTests();
    const copyReads = { toolResultTraceInfo: 0, toolResultCards: 0 };
    let refreshes = 0;
    let answer = "";
    for (const payload of run) {
      events.push(record(payload, events.length + 1));
      if (payload.type === "message_delta") answer += payload.text;
      if (payload.type === "message_rollback")
        answer = answer.slice(0, Math.max(0, answer.length - payload.length));
      if (payload.type === "final") {
        message.streaming = false;
        answer = payload.text;
      }
      message.text = answer;
      const incremental = buildAgentTraceDisplayItems(events, user, message);
      refreshes += 1;
      const canonical = buildAgentTraceDisplayItemsCanonical(
        events,
        user,
        message,
      );
      assert.deepEqual(
        incremental,
        canonical,
        `step ${events.length} (${payload.type})`,
      );
      // Nothing the projection remembers may stand in for reading the run:
      // at each tool result, the rollback and the final, a projection of a
      // fresh copy of the events must agree too.
      if (
        payload.type === "tool_result" ||
        payload.type === "message_rollback" ||
        payload.type === "provider_event" ||
        payload.type === "final"
      ) {
        const before = readAgentTraceProjectionCountersForTests();
        assert.deepEqual(
          buildAgentTraceDisplayItemsCanonical(cloneEvents(events), user, {
            ...message,
          }),
          canonical,
          `fresh copy at step ${events.length} (${payload.type})`,
        );
        const after = readAgentTraceProjectionCountersForTests();
        copyReads.toolResultTraceInfo +=
          after.toolResultTraceInfo - before.toolResultTraceInfo;
        copyReads.toolResultCards +=
          after.toolResultCards - before.toolResultCards;
      }
    }
    const total = readAgentTraceProjectionCountersForTests();
    const liveReads = {
      toolResultTraceInfo:
        total.toolResultTraceInfo - copyReads.toolResultTraceInfo,
      toolResultCards: total.toolResultCards - copyReads.toolResultCards,
    };
    assert.equal(refreshes, run.length);
    assert.isAtLeast(refreshes, 3200);
    // Each result's payload was read for the trace once, across every
    // refresh and both projections of the live list.
    assert.equal(liveReads.toolResultTraceInfo, counts.results);
    assert.isAtMost(liveReads.toolResultCards, counts.results);
    // The copies prove the reads were real: each one read its results anew.
    assert.isAbove(copyReads.toolResultTraceInfo, 0);
    // The live list was folded forward from its first event, never restarted,
    // and most refreshes only lengthened the last thinking block.
    assert.equal(total.liveResets, 1);
    assert.isAbove(total.liveReasoningPatches, total.liveWalks);
    Object.assign(measured, {
      refreshes,
      toolResultTraceInfo: liveReads.toolResultTraceInfo,
      patches: total.liveReasoningPatches,
      walks: total.liveWalks,
    });
  });

  function assertStepwiseEquivalence(
    run: AgentEvent[],
    message: Message,
    label: string,
  ): void {
    const events: AgentRunEventRecord[] = [];
    for (const payload of run) {
      events.push(record(payload, events.length + 1));
      assert.deepEqual(
        buildAgentTraceDisplayItems(events, null, message),
        buildAgentTraceDisplayItemsCanonical(events, null, message),
        `${label} step ${events.length} (${payload.type})`,
      );
    }
  }

  it("equals the canonical projection for a connected runtime's merged activity rows", function () {
    const activity = (
      itemId: string,
      phase: "started" | "completed",
      extra: Partial<Extract<AgentEvent, { type: "codex_tool_activity" }>> = {},
    ): AgentEvent => ({
      type: "codex_tool_activity",
      itemId,
      phase,
      toolName: "shell",
      args: { command: `ls ${itemId}` },
      ...extra,
    });
    assertStepwiseEquivalence(
      [
        { type: "agent_stage", stage: "retrieval", status: "started" },
        activity("a", "started"),
        { type: "reasoning", round: 1, summary: "Listing " },
        { type: "reasoning", round: 1, summary: "files." },
        activity("b", "started"),
        // Completes the first row after another row opened: rewrites an
        // earlier compacted entry rather than the last one.
        activity("a", "completed", { ok: true, text: "done" }),
        { type: "codex_progress", itemId: "p", text: "Still looking." },
        activity("b", "completed", { ok: false }),
        { type: "agent_stage", stage: "retrieval", status: "completed" },
        { type: "message_delta", text: "Here " },
        { type: "message_delta", text: "it is." },
        { type: "final", text: "Here it is." },
      ],
      {
        role: "assistant",
        text: "",
        timestamp: 1,
        runMode: "agent",
        modelProviderLabel: "Codex",
        streaming: true,
      },
      "codex",
    );
  });

  it("equals the canonical projection for a run that reports no stages of its own", function () {
    // Tool events without stage events: the projection reconstructs stages
    // from the whole list, so a live refresh must agree with it each time.
    assertStepwiseEquivalence(
      [
        { type: "reasoning", round: 1, summary: "Thinking first." },
        {
          type: "tool_call",
          callId: "c1",
          name: "paper_read",
          args: { mode: "overview" },
        },
        { type: "reasoning", round: 1, summary: "Waiting." },
        {
          type: "tool_result",
          callId: "c1",
          name: "paper_read",
          ok: true,
          actionReceipts: [],
          content: largeNumberedText(20),
          workCategory: "retrieval",
        },
        { type: "reasoning", round: 2, summary: "Then " },
        { type: "reasoning", round: 2, summary: "more." },
        { type: "message_delta", text: "Answer." },
      ],
      {
        role: "assistant",
        text: "",
        timestamp: 1,
        runMode: "agent",
        streaming: true,
      },
      "legacy",
    );
  });

  it("starts over when a folded record is removed or rewritten in place", function () {
    const message: Message = {
      role: "assistant",
      text: "",
      timestamp: 1,
      runMode: "agent",
      streaming: true,
    };
    const events: AgentRunEventRecord[] = [
      record({ type: "status", text: "Reading" }, 1),
      record({ type: "reasoning", round: 1, summary: "First idea. " }, 2),
      record({ type: "message_delta", text: "Draft answer." }, 3),
      record({ type: "reasoning", round: 2, summary: "Second idea." }, 4),
    ];
    const check = (label: string) =>
      assert.deepEqual(
        buildAgentTraceDisplayItems(events, null, message),
        buildAgentTraceDisplayItemsCanonical(events, null, message),
        label,
      );
    check("initial");
    resetAgentTraceProjectionCountersForTests();
    // A record in the middle is replaced; the list keeps its length and tail.
    events[1] = record(
      { type: "reasoning", round: 1, summary: "Revised. " },
      2,
    );
    check("rewritten in place");
    // The tail is withdrawn and something else arrives in its place.
    events.pop();
    events.push(record({ type: "status", text: "Retrying" }, 4));
    check("removed and replaced");
    events.splice(2, 1);
    check("removed from the middle");
    assert.equal(readAgentTraceProjectionCountersForTests().liveResets, 3);
    events.push(record({ type: "reasoning", round: 3, summary: "Go on." }, 5));
    check("appended after a restart");
    assert.equal(readAgentTraceProjectionCountersForTests().liveResets, 3);
  });

  it("projects again when the answer text changes with no new event", function () {
    const kept =
      "Smith 2021 reports that drift grows with time across recording days.";
    const message: Message = {
      role: "assistant",
      text: "An unrelated draft that does not repeat the kept text.",
      timestamp: 1,
      runMode: "agent",
      streaming: true,
    };
    const events: AgentRunEventRecord[] = [
      record({ type: "message_delta", text: kept }, 1),
      record(
        {
          type: "tool_call",
          callId: "read-1",
          name: "paper_read",
          args: {},
        } as AgentEvent,
        2,
      ),
      record(
        {
          type: "tool_result",
          callId: "read-1",
          name: "paper_read",
          ok: true,
          actionReceipts: [],
          content: { results: [] },
        },
        3,
      ),
      record({ type: "message_delta", text: "The rest of the answer." }, 4),
    ];
    const before = buildAgentTraceDisplayItems(events, null, message);
    assert.deepEqual(
      before,
      buildAgentTraceDisplayItemsCanonical(events, null, message),
    );
    // The bubble now shows the kept text, so the trace stops repeating it.
    message.text = `${kept}\n\nThe rest of the answer.`;
    const canonical = buildAgentTraceDisplayItemsCanonical(
      events,
      null,
      message,
    );
    assert.notDeepEqual(canonical, before, "the text decides what is shown");
    assert.deepEqual(
      buildAgentTraceDisplayItems(events, null, message),
      canonical,
    );
  });

  it("drops a run's live state once its message stops streaming", function () {
    const message: Message = {
      role: "assistant",
      text: "",
      timestamp: 1,
      runMode: "agent",
      streaming: true,
    };
    const events = [record({ type: "reasoning", round: 1, summary: "A" }, 1)];
    buildAgentTraceDisplayItems(events, null, message);
    resetAgentTraceProjectionCountersForTests();
    message.streaming = false;
    buildAgentTraceDisplayItems(events, null, message);
    // Streaming again (a retry reusing the bubble) folds the list anew.
    message.streaming = true;
    buildAgentTraceDisplayItems(events, null, message);
    assert.equal(readAgentTraceProjectionCountersForTests().liveResets, 1);
  });

  it("folds compaction and the whole-run scan one event at a time", function () {
    const run = buildRealisticRun()
      .slice(0, 1400)
      .map((payload, index) => record(payload, index + 1));
    const compactor = createAgentTraceCompactor();
    const scan = createAgentTraceEventScan();
    for (const entry of run) {
      compactor.push(entry);
      applyAgentTraceEventToScan(scan, entry);
    }
    assert.deepEqual(compactor.entries, compactAgentTraceEvents(run));
    assert.deepEqual(scan, scanAgentTraceEvents(run));
  });

  it("streams thinking into the same block without reading it back from the DOM", function () {
    const message: Message = {
      role: "assistant",
      text: "",
      timestamp: 1,
      runMode: "agent",
      streaming: true,
    };
    const events: AgentRunEventRecord[] = [
      record({ type: "reasoning", round: 1, summary: "Alpha " }, 1),
    ];
    const trace = renderAgentTrace({ doc: fakeDocument, message, events })!;
    try {
      const root = trace as unknown as FakeElement;
      const block = root.findByClass("llm-agent-reasoning-text")!;
      assert.isNotNull(block);
      let value = block.textContent;
      let reads = 0;
      Object.defineProperty(block, "textContent", {
        get: () => {
          reads += 1;
          return value;
        },
        set: (next: string) => {
          value = next;
        },
      });
      let expected = "Alpha ";
      for (let n = 0; n < 50; n += 1) {
        const delta = `beta${n} `;
        expected += delta;
        events.push(
          record({ type: "reasoning", round: 1, summary: delta }, n + 2),
        );
        renderAgentTrace({
          doc: fakeDocument,
          message,
          events,
          previous: trace,
        });
        assert.strictEqual(root.findByClass("llm-agent-reasoning-text"), block);
      }
      assert.equal(value, expected);
      assert.equal(reads, 0, "the committed text is remembered, not re-read");
    } finally {
      disposeAgentTrace(trace);
    }
  });

  it("times a finished run to its last event when the message is stamped earlier", function () {
    const message: Message = {
      role: "assistant",
      text: "Done.",
      timestamp: 10_000,
      runMode: "agent",
      streaming: false,
    };
    const events: AgentRunEventRecord[] = [
      { ...record({ type: "status", text: "Reading" }, 1), createdAt: 10_000 },
      {
        ...record({ type: "reasoning", round: 1, summary: "Thinking." }, 2),
        createdAt: 40_000,
      },
      { ...record({ type: "final", text: "Done." }, 3), createdAt: 70_000 },
    ];
    const trace = renderAgentTrace({ doc: fakeDocument, message, events })!;
    try {
      const summary = (trace as unknown as FakeElement).findByClass(
        "llm-agent-activity-summary",
      )!;
      assert.equal(summary.textContent, "Worked for 1m 0s");
    } finally {
      disposeAgentTrace(trace);
    }
  });

  after(function () {
    if (measured.refreshes)
      console.log(
        `      incremental projection: ${measured.refreshes} refreshes, ` +
          `${measured.toolResultTraceInfo} tool-result reads, ` +
          `${measured.patches} thinking patches, ${measured.walks} walks`,
      );
  });
});

/** Reported by the suite for the change's evidence. */
const measured = { refreshes: 0, toolResultTraceInfo: 0, patches: 0, walks: 0 };
