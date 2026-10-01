import { assert } from "chai";
import {
  namedItemTargets,
  toolFailureReason,
} from "../src/agent/loop/paperFailures";

/**
 * A failed tool call, as the host reads it for a long job: the papers it
 * named and why it failed, so the same failure twice on one paper can be
 * told from a new one.
 */
describe("paper failures", function () {
  it("reads the papers a call names, in each argument shape the tools use", function () {
    assert.deepEqual(
      namedItemTargets({ target: { itemId: 12, contextItemId: 1012 } }),
      ["item:12"],
    );
    assert.deepEqual(
      namedItemTargets({ targets: [{ itemId: 12 }, { itemId: "13" }] }),
      ["item:12", "item:13"],
    );
    assert.deepEqual(namedItemTargets({ targetItemId: 7, mode: "create" }), [
      "item:7",
    ]);
    assert.deepEqual(namedItemTargets({ itemIds: [3, 4, 3] }), [
      "item:3",
      "item:4",
    ]);
    assert.deepEqual(namedItemTargets({ itemId: 5, parentItemId: 6 }), [
      "item:5",
      "item:6",
    ]);
    assert.deepEqual(namedItemTargets({ query: "drift" }), []);
    assert.deepEqual(namedItemTargets(undefined), []);
    assert.deepEqual(namedItemTargets({ target: { itemId: 0 } }), []);
  });

  it("says why a call failed in one line, the same way each time", function () {
    assert.equal(
      toolFailureReason({ error: " The PDF could not\n be opened " }),
      "The PDF could not be opened",
    );
    assert.equal(toolFailureReason("Timed out"), "Timed out");
    assert.equal(toolFailureReason({ error: { message: "Locked" } }), "Locked");
    assert.equal(toolFailureReason({ message: "Gone" }), "Gone");
    assert.equal(toolFailureReason(undefined), "The tool failed");
    assert.isAtMost(toolFailureReason({ error: "x".repeat(500) }).length, 200);
  });
});
