/**
 * A built-in action's progress lives in the Task progress store, not in a
 * card in the chat: its steps, its summary, and how it ended.
 */
import { assert } from "chai";
import type { ActionProgressEvent } from "../src/agent/actions";
import { runAgentActionWithLifecycle } from "../src/modules/contextPanel/setupHandlers/controllers/actionExecutionRunner";
import type { ActionCommandLifecycle } from "../src/modules/contextPanel/setupHandlers/controllers/actionCommandLifecycle";
import type { ActionCompletionFeedback } from "../src/modules/contextPanel/actionStatusText";
import { getAbortController } from "../src/modules/contextPanel/state";
import {
  clearAllTaskProgress,
  getTaskProgress,
} from "../src/modules/contextPanel/taskProgress/store";

const KEY = 73001;

function fakeLifecycle(completions: ActionCompletionFeedback[]) {
  return {
    closeActionHitlPanel: () => undefined,
    showActionCompletionCard: (feedback: ActionCompletionFeedback) => {
      completions.push(feedback);
    },
    showActionHitlCard: async () => ({ approved: true }),
  } as unknown as ActionCommandLifecycle;
}

describe("built-in action progress in Task progress", function () {
  afterEach(function () {
    clearAllTaskProgress();
  });

  it("drives the row from the action's steps and ends completed", async function () {
    const completions: ActionCompletionFeedback[] = [];
    const seen: Array<{ state?: string; steps?: string; summary?: string }> =
      [];
    const snapshot = () => {
      const record = getTaskProgress(KEY);
      seen.push({
        state: record?.runState,
        steps: record?.checklist?.steps
          .map((step) => `${step.label}:${step.status}`)
          .join(","),
        summary: record?.checklist?.summary,
      });
    };
    await runAgentActionWithLifecycle({
      actionName: "auto_tag",
      input: {},
      requestContext: { mode: "paper", activeItemId: 5 },
      libraryID: 1,
      conversationKey: KEY,
      lifecycle: fakeLifecycle(completions),
      setStatus: () => undefined,
      logError: () => undefined,
      runAction: async (_name, _input, options) => {
        snapshot();
        const progress = (event: ActionProgressEvent) =>
          options.onProgress?.(event);
        progress({ type: "step_start", step: "Reading", index: 1, total: 2 });
        snapshot();
        progress({ type: "step_done", step: "Reading", summary: "Read 3" });
        snapshot();
        progress({ type: "step_start", step: "Tagging", index: 2, total: 2 });
        snapshot();
        return { ok: true, output: { tagged: 3 } };
      },
    });
    assert.deepEqual(seen, [
      { state: "working", steps: "", summary: "" },
      { state: "working", steps: "Reading:in_progress", summary: "" },
      { state: "working", steps: "Reading:in_progress", summary: "Read 3" },
      {
        state: "working",
        steps: "Reading:completed,Tagging:in_progress",
        summary: "",
      },
    ]);
    const record = getTaskProgress(KEY)!;
    assert.equal(record.runState, "completed");
    assert.equal(record.checklist!.title, "Auto Tag");
    assert.equal(record.checklist!.outcome, "completed");
    assert.equal(record.checklist!.detail, "Tagged 3 items");
    assert.isTrue(record.planSeen, "the row stays after the action");
    assert.lengthOf(completions, 1, "the completion card still reports");
    assert.isNull(
      getAbortController(KEY),
      "the stop button's slot is released",
    );
  });

  it("files the action under its title, with the request typed with it", async function () {
    await runAgentActionWithLifecycle({
      actionName: "auto_tag",
      input: { userQuery: "  tag the drift papers " },
      requestContext: { mode: "paper", activeItemId: 5 },
      libraryID: 1,
      conversationKey: KEY,
      lifecycle: fakeLifecycle([]),
      setStatus: () => undefined,
      logError: () => undefined,
      runAction: async () => ({ ok: true, output: { tagged: 1 } }),
    });
    assert.deepEqual(
      getTaskProgress(KEY)!.questions.map((entry) => [
        entry.turn,
        entry.title,
        entry.text,
      ]),
      [[0, "Auto Tag", "tag the drift papers"]],
    );
  });

  it("keeps the error text when the action fails", async function () {
    await runAgentActionWithLifecycle({
      actionName: "auto_tag",
      input: {},
      requestContext: { mode: "paper", activeItemId: 5 },
      libraryID: 1,
      conversationKey: KEY,
      lifecycle: fakeLifecycle([]),
      setStatus: () => undefined,
      logError: () => undefined,
      runAction: async () => ({ ok: false, error: "offline" }),
    });
    const record = getTaskProgress(KEY)!;
    assert.equal(record.runState, "failed");
    assert.equal(record.checklist!.detail, "Auto Tag failed: offline");
  });

  it("ends cancelled when the stop button aborted it", async function () {
    await runAgentActionWithLifecycle({
      actionName: "auto_tag",
      input: {},
      requestContext: { mode: "paper", activeItemId: 5 },
      libraryID: 1,
      conversationKey: KEY,
      lifecycle: fakeLifecycle([]),
      setStatus: () => undefined,
      logError: () => undefined,
      runAction: async (_name, _input, options) => {
        // What the composer stop button does: abort the published slot.
        getAbortController(KEY)?.abort();
        assert.isTrue(Boolean(options.signal?.aborted));
        return { ok: false, error: "Cancelled" };
      },
    });
    const record = getTaskProgress(KEY)!;
    assert.equal(record.runState, "cancelled");
    assert.equal(record.checklist!.outcome, "cancelled");
  });

  it("ends failed when the action throws", async function () {
    await runAgentActionWithLifecycle({
      actionName: "auto_tag",
      input: {},
      requestContext: { mode: "paper", activeItemId: 5 },
      libraryID: 1,
      conversationKey: KEY,
      lifecycle: fakeLifecycle([]),
      setStatus: () => undefined,
      logError: () => undefined,
      runAction: async () => {
        throw new Error("boom");
      },
    });
    const record = getTaskProgress(KEY)!;
    assert.equal(record.runState, "failed");
    assert.equal(record.checklist!.detail, "Auto Tag failed: boom");
  });
});
