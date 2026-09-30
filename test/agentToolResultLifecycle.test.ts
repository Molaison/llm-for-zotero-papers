import { assert } from "chai";
import {
  buildToolProgressFingerprint,
  isUserDeniedToolResult,
  setToolResultReadAvailability,
} from "../src/agent/execution/toolResultLifecycle";

describe("Agent tool-result lifecycle", function () {
  it("recognizes an explicit user denial without treating other errors as denial", function () {
    assert.isTrue(
      isUserDeniedToolResult({
        callId: "1",
        name: "note_write",
        ok: false,
        content: { error: "User denied action" },
      }),
    );
    assert.isFalse(
      isUserDeniedToolResult({
        callId: "2",
        name: "note_write",
        ok: false,
        content: { error: "Native verification failed" },
      }),
    );
  });

  it("updates transient read availability without replacing other request metadata", function () {
    const request = { metadata: { preserved: true } } as never;
    setToolResultReadAvailability(request, true);
    assert.deepEqual((request as any).metadata, {
      preserved: true,
      agentToolResultReadAvailable: true,
    });
    setToolResultReadAvailability(request, false);
    assert.deepEqual((request as any).metadata, { preserved: true });
  });

  it("builds the same fingerprint for object keys in a different order", function () {
    const left = buildToolProgressFingerprint({
      name: "paper_read",
      input: { b: 2, a: 1 },
      content: { y: 2, x: 1 },
    });
    const right = buildToolProgressFingerprint({
      name: "paper_read",
      input: { a: 1, b: 2 },
      content: { x: 1, y: 2 },
    });
    assert.equal(left, right);
  });
});
