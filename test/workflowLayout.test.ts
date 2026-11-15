import { assert } from "chai";
import { waitForElementGeometrySettled } from "../src/modules/contextPanel/workflowLayout";

describe("native workflow layout synchronization", function () {
  it("does not treat repeated geometry between animation frames as a finished transition", async function () {
    let tick = 0;
    const element = {
      getAnimations: () => [
        { playState: tick < 4 ? "running" : "finished", pending: false },
      ],
    } as unknown as Element;
    await waitForElementGeometrySettled({
      element,
      sample: () => (tick < 4 ? "185" : "0"),
      delay: async () => {
        tick++;
      },
    });
    assert.isAtLeast(
      tick,
      4,
      "wait until the animation reaches its final geometry",
    );
  });

  it("waits for a pending transition and reports a transition that never settles", async function () {
    const element = {
      getAnimations: () => [{ playState: "paused", pending: true }],
    } as unknown as Element;
    try {
      await waitForElementGeometrySettled({
        element,
        sample: () => "185",
        delay: async () => {},
      });
      assert.fail("a pending transition must not be reported as settled");
    } catch (error) {
      assert.include(String(error), "did not settle");
    }
  });
});
