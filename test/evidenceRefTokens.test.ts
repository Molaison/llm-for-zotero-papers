import { assert } from "chai";
import {
  expandEvidenceRefs,
  shortEvidenceRef,
} from "../src/agent/context/evidenceRefTokens";

const DIGEST =
  "a88d71e2c5d1bfcf196ccd05f2066c88ba9b55538bdf9b2879106e7f514a45b5";
const OTHER =
  "3dcfeb201a698df611f54fc8cfbd283ae255a683db7c0de3a1f5c2b94e10f2aa";

describe("evidence ref tokens", function () {
  it("shortens a read observation id to its call digest's first twelve digits and row", function () {
    assert.equal(shortEvidenceRef(`sha256:${DIGEST}:12`), "a88d71e2c5d1:12");
    assert.equal(
      shortEvidenceRef("observation-1"),
      "observation-1",
      "an id of another shape is cited as it is",
    );
  });

  it("expands a short ref to the one observation it names, and leaves full and unknown refs as they are", function () {
    const ids = [
      `sha256:${DIGEST}:1`,
      `sha256:${DIGEST}:12`,
      `sha256:${OTHER}:1`,
    ];
    assert.deepEqual(
      expandEvidenceRefs(
        ["a88d71e2c5d1:12", `sha256:${OTHER}:1`, "a88d71e2c5d1:7", "made-up"],
        ids,
      ),
      [`sha256:${DIGEST}:12`, `sha256:${OTHER}:1`, "a88d71e2c5d1:7", "made-up"],
    );
  });

  it("never guesses between two observations a short ref could name", function () {
    const twin = `${DIGEST.slice(0, 12)}${"0".repeat(52)}`;
    assert.deepEqual(
      expandEvidenceRefs(
        ["a88d71e2c5d1:1"],
        [`sha256:${DIGEST}:1`, `sha256:${twin}:1`],
      ),
      ["a88d71e2c5d1:1"],
    );
  });
});
