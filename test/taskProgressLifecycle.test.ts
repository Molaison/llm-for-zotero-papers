/**
 * The request-lifecycle safety net: a request start marks the run working,
 * and a request that ends while its run is still live settles it from what
 * the turn left, so the row never spins after its request is gone.
 */
import { assert } from "chai";
import {
  chatHistory,
  finishRequest,
  setCancelledRequestId,
  tryBeginRequest,
} from "../src/modules/contextPanel/state";
import { installTaskProgressRequestLifecycle } from "../src/modules/contextPanel/taskProgress/panel";
import {
  applyTaskPaperUpdate,
  beginTaskRun,
  clearAllTaskProgress,
  completeTaskRun,
  getTaskProgress,
  markTaskWaiting,
} from "../src/modules/contextPanel/taskProgress/store";
import type { Message } from "../src/modules/contextPanel/types";
import { ledgerDelta, quoteCitation } from "./helpers/taskProgressFixtures";

const KEY = 551903;

function question(text: string, timestamp: number): Message {
  return { role: "user", text, timestamp };
}

describe("task progress request lifecycle", function () {
  before(function () {
    installTaskProgressRequestLifecycle();
    installTaskProgressRequestLifecycle();
  });
  afterEach(function () {
    finishRequest(KEY, 1);
    setCancelledRequestId(KEY, 0);
    chatHistory.delete(KEY);
    clearAllTaskProgress();
  });

  it("starts the run at the question's position when the request begins", function () {
    chatHistory.set(KEY, [
      question("first", 1),
      { role: "assistant", text: "done", timestamp: 2 },
      question("second", 3),
    ]);
    tryBeginRequest(KEY, 1, null);
    const record = getTaskProgress(KEY)!;
    assert.equal(record.runState, "working");
    assert.equal(record.turnIndex, 2);
  });

  it("names each plain-chat question once its request ends, and keeps the one before", function () {
    // As a send does: the request begins before its question is added.
    const history: Message[] = [];
    chatHistory.set(KEY, history);
    tryBeginRequest(KEY, 1, null);
    history.push(question("first", 1), {
      role: "assistant",
      text: "One.",
      timestamp: 2,
      runMode: "chat",
    });
    finishRequest(KEY, 1);
    tryBeginRequest(KEY, 2, null);
    history.push(question("second", 3), {
      role: "assistant",
      text: "Error: offline",
      timestamp: 4,
      runMode: "chat",
    });
    finishRequest(KEY, 2);
    const record = getTaskProgress(KEY)!;
    assert.equal(record.turnIndex, 2);
    assert.equal(record.runState, "failed");
    assert.deepEqual(
      record.questions.map((entry) => [entry.turn, entry.text, entry.state]),
      [
        [1, "first", "completed"],
        [2, "second", undefined],
      ],
    );
  });

  it("completes an agent run the runtime never settled, with its citations", function () {
    const answer: Message = {
      role: "assistant",
      text: "",
      timestamp: 2,
      runMode: "agent",
      streaming: true,
    };
    chatHistory.set(KEY, [question("q", 1), answer]);
    tryBeginRequest(KEY, 1, null);
    beginTaskRun(KEY, { runId: "run-x" });
    applyTaskPaperUpdate(KEY, ledgerDelta("c1", [[4, "read"]]), "run-x");
    answer.text = "Answer.";
    answer.streaming = false;
    answer.quoteCitations = [quoteCitation("q4", 4)];
    finishRequest(KEY, 1);
    const record = getTaskProgress(KEY)!;
    assert.equal(record.runState, "completed");
    assert.equal(record.ledger.papers["1:4"].state, "cited");
  });

  it("marks plain chat completed without citing anything", function () {
    chatHistory.set(KEY, [
      question("q", 1),
      {
        role: "assistant",
        text: "Answer.",
        timestamp: 2,
        runMode: "chat",
        quoteCitations: [quoteCitation("q4", 4)],
      },
    ]);
    tryBeginRequest(KEY, 1, null);
    finishRequest(KEY, 1);
    const record = getTaskProgress(KEY)!;
    assert.equal(record.runState, "completed");
    assert.deepEqual(record.ledger.papers, {});
  });

  it("settles cancelled when the request was cancelled", function () {
    chatHistory.set(KEY, [question("q", 1)]);
    tryBeginRequest(KEY, 1, null);
    setCancelledRequestId(KEY, 1);
    finishRequest(KEY, 1);
    assert.equal(getTaskProgress(KEY)!.runState, "cancelled");
  });

  it("settles cancelled from a [Cancelled] answer and failed from an error", function () {
    chatHistory.set(KEY, [
      question("q", 1),
      { role: "assistant", text: "[Cancelled]", timestamp: 2 },
    ]);
    tryBeginRequest(KEY, 1, null);
    finishRequest(KEY, 1);
    assert.equal(getTaskProgress(KEY)!.runState, "cancelled");
    clearAllTaskProgress();
    chatHistory.set(KEY, [
      question("q", 1),
      { role: "assistant", text: "Error: offline", timestamp: 2 },
    ]);
    tryBeginRequest(KEY, 1, null);
    finishRequest(KEY, 1);
    assert.equal(getTaskProgress(KEY)!.runState, "failed");
    clearAllTaskProgress();
    chatHistory.set(KEY, [question("q", 1)]);
    tryBeginRequest(KEY, 1, null);
    finishRequest(KEY, 1);
    assert.equal(
      getTaskProgress(KEY)!.runState,
      "failed",
      "a request that left no answer failed",
    );
  });

  it("settles interrupted from a stream-interrupted answer", function () {
    chatHistory.set(KEY, [
      question("q", 1),
      {
        role: "assistant",
        text: "A partial answer",
        timestamp: 2,
        interrupted: true,
      },
    ]);
    tryBeginRequest(KEY, 1, null);
    finishRequest(KEY, 1);
    assert.equal(getTaskProgress(KEY)!.runState, "interrupted");
  });

  it("settles a run that still waited on a decision when its request ended", function () {
    chatHistory.set(KEY, [
      question("q", 1),
      { role: "assistant", text: "Answer.", timestamp: 2, runMode: "agent" },
    ]);
    tryBeginRequest(KEY, 1, null);
    beginTaskRun(KEY, { runId: "run-w" });
    markTaskWaiting(KEY, "run-w", true);
    assert.equal(getTaskProgress(KEY)!.runState, "waiting");
    finishRequest(KEY, 1);
    assert.equal(getTaskProgress(KEY)!.runState, "completed");
  });

  it("leaves a run the runtime already settled as it was", function () {
    chatHistory.set(KEY, [
      question("q", 1),
      { role: "assistant", text: "Error: late", timestamp: 2 },
    ]);
    tryBeginRequest(KEY, 1, null);
    beginTaskRun(KEY, { runId: "run-y" });
    completeTaskRun(KEY, { runId: "run-y" });
    finishRequest(KEY, 1);
    assert.equal(getTaskProgress(KEY)!.runState, "completed");
  });
});
