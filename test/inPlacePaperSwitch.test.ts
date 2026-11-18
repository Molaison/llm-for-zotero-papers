import { assert } from "chai";
import { afterEach, describe, it } from "mocha";

import {
  forceInPlacePaperSwitchFailuresForTests,
  runInPlacePaperSwitch,
  type InPlacePaperSwitchSteps,
} from "../src/modules/contextPanel/inPlacePaperSwitch";

type Trace = string[];

function steps(
  trace: Trace,
  overrides: Partial<InPlacePaperSwitchSteps> = {},
): InPlacePaperSwitchSteps {
  return {
    isLatest: () => true,
    switchConversation: async () => {
      trace.push("switch");
      return true;
    },
    canDrawFallback: () => true,
    drawFallback: async () => {
      trace.push("fallback");
      return true;
    },
    movedToOtherConversation: () => false,
    clearUndrawn: () => {
      trace.push("clear");
    },
    rebuild: () => {
      trace.push("rebuild");
    },
    release: () => {
      trace.push("release");
    },
    onError: () => {
      trace.push("error");
    },
    ...overrides,
  };
}

describe("runInPlacePaperSwitch", function () {
  afterEach(function () {
    forceInPlacePaperSwitchFailuresForTests(0);
  });

  it("a drawn switch releases the chat box and keeps it", async function () {
    const trace: Trace = [];
    assert.isTrue(await runInPlacePaperSwitch(steps(trace)));
    assert.deepEqual(trace, ["switch", "release"]);
  });

  it("the fallback draws when the conversation switch declines", async function () {
    const trace: Trace = [];
    const drawn = await runInPlacePaperSwitch(
      steps(trace, {
        switchConversation: async () => {
          trace.push("switch");
          return false;
        },
      }),
    );
    assert.isTrue(drawn);
    assert.deepEqual(trace, ["switch", "fallback", "release"]);
  });

  it("clears the previous paper's chat when nothing drew the next one", async function () {
    const trace: Trace = [];
    const drawn = await runInPlacePaperSwitch(
      steps(trace, {
        switchConversation: async () => {
          trace.push("switch");
          return false;
        },
        drawFallback: async () => {
          trace.push("fallback");
          return false;
        },
      }),
    );
    assert.isFalse(drawn);
    assert.deepEqual(trace, [
      "switch",
      "fallback",
      "clear",
      "rebuild",
      "release",
    ]);
  });

  it("clears when the fallback may not run (the host moved on)", async function () {
    const trace: Trace = [];
    const drawn = await runInPlacePaperSwitch(
      steps(trace, {
        switchConversation: async () => {
          trace.push("switch");
          return false;
        },
        canDrawFallback: () => false,
      }),
    );
    assert.isFalse(drawn);
    assert.deepEqual(trace, ["switch", "clear", "rebuild", "release"]);
  });

  it("clears when the switch throws", async function () {
    const trace: Trace = [];
    const drawn = await runInPlacePaperSwitch(
      steps(trace, {
        switchConversation: async () => {
          trace.push("switch");
          throw new Error("load failed");
        },
      }),
    );
    assert.isFalse(drawn);
    assert.deepEqual(trace, ["switch", "error", "clear", "rebuild", "release"]);
  });

  it("clears when the fallback throws", async function () {
    const trace: Trace = [];
    const drawn = await runInPlacePaperSwitch(
      steps(trace, {
        switchConversation: async () => false,
        drawFallback: async () => {
          throw new Error("load failed");
        },
      }),
    );
    assert.isFalse(drawn);
    assert.deepEqual(trace, ["error", "clear", "rebuild", "release"]);
  });

  it("a superseded switch touches nothing, drawn or not", async function () {
    for (const switched of [true, false]) {
      const trace: Trace = [];
      await runInPlacePaperSwitch(
        steps(trace, {
          isLatest: () => false,
          switchConversation: async () => switched,
          drawFallback: async () => false,
        }),
      );
      assert.notInclude(trace, "clear");
      assert.notInclude(trace, "rebuild");
      assert.notInclude(trace, "release");
    }
  });

  it("a superseded switch that throws stays a no-op", async function () {
    const trace: Trace = [];
    await runInPlacePaperSwitch(
      steps(trace, {
        isLatest: () => false,
        switchConversation: async () => {
          throw new Error("load failed");
        },
      }),
    );
    assert.deepEqual(trace, ["error"]);
  });

  it("asks whether it is still the latest switch only after the work settles", async function () {
    let latest = true;
    const trace: Trace = [];
    await runInPlacePaperSwitch(
      steps(trace, {
        isLatest: () => latest,
        switchConversation: async () => {
          // A newer switch starts while this one awaits.
          latest = false;
          return false;
        },
        drawFallback: async () => false,
      }),
    );
    assert.notInclude(trace, "clear");
    assert.notInclude(trace, "release");
  });

  it("keeps a conversation the user opened meanwhile instead of clearing it", async function () {
    const trace: Trace = [];
    const drawn = await runInPlacePaperSwitch(
      steps(trace, {
        switchConversation: async () => false,
        canDrawFallback: () => false,
        movedToOtherConversation: () => true,
      }),
    );
    assert.isFalse(drawn);
    assert.deepEqual(trace, ["release"]);
  });

  it("a forced test failure fails after the switch yields, as a real one does", async function () {
    forceInPlacePaperSwitchFailuresForTests(1);
    const failed: Trace = [];
    const run = runInPlacePaperSwitch(steps(failed));
    // Nothing happens in the task that started the switch.
    assert.deepEqual(failed, []);
    assert.isFalse(await run);
    assert.deepEqual(failed, ["error", "clear", "rebuild", "release"]);
    const next: Trace = [];
    assert.isTrue(await runInPlacePaperSwitch(steps(next)));
    assert.deepEqual(next, ["switch", "release"]);
  });
});
