import { assert } from "chai";
import {
  clearRetrievalTimingsForTests,
  createRetrievalTimer,
  getRecentRetrievalTimings,
  recordRetrievalTiming,
} from "../src/services/retrieval/retrievalTiming";

describe("retrieval timing", function () {
  beforeEach(function () {
    clearRetrievalTimingsForTests();
  });

  it("accumulates phase durations from an injected clock", async function () {
    let tick = 1000;
    const timer = createRetrievalTimer(() => tick);
    const value = await timer.span("scope", async () => {
      tick += 25;
      return "ok";
    });
    timer.spanSync("rank", () => {
      tick += 5;
    });
    timer.count("papersTouched", 3);
    timer.count("papersTouched");
    tick += 10;
    const report = timer.finish();
    assert.equal(value, "ok");
    assert.equal(report.startedAt, 1000);
    assert.equal(report.totalMs, 40);
    assert.deepEqual(report.phases, { scope: 25, rank: 5 });
    assert.deepEqual(report.counters, { papersTouched: 4 });
  });

  it("adds repeated spans of the same phase", async function () {
    let tick = 0;
    const timer = createRetrievalTimer(() => tick);
    await timer.span("paper_snippets", async () => {
      tick += 7;
    });
    await timer.span("paper_snippets", async () => {
      tick += 3;
    });
    assert.equal(timer.finish().phases.paper_snippets, 10);
  });

  it("records a phase even when the work throws", async function () {
    let tick = 0;
    const timer = createRetrievalTimer(() => tick);
    await timer
      .span("plan", async () => {
        tick += 4;
        throw new Error("boom");
      })
      .catch(() => undefined);
    assert.equal(timer.finish().phases.plan, 4);
  });

  it("keeps the most recent twenty reports, newest first", function () {
    for (let i = 0; i < 25; i += 1) {
      recordRetrievalTiming({
        startedAt: i,
        totalMs: i,
        phases: {},
        counters: {},
      });
    }
    const recent = getRecentRetrievalTimings();
    assert.equal(recent.length, 20);
    assert.equal(recent[0].startedAt, 24);
    assert.equal(getRecentRetrievalTimings(2).length, 2);
  });
});
