import { assert } from "chai";
import { createNoteWriteTool } from "../src/agent/tools/write/noteWrite";

describe("finalized material for existing notes", function () {
  for (const mode of ["edit", "append"] as const) {
    it(`allows source-based finalized material to ${mode} the exact note`, function () {
      const tool = createNoteWriteTool({} as never);
      assert.isTrue(
        tool.validate({
          mode,
          targetNoteId: 3,
          documentId: "finalized-reading-note",
        }).ok,
      );
      assert.isFalse(
        tool.validate({
          mode,
          targetNoteId: 3,
          documentId: "finalized-reading-note",
          content: "Substituted",
        }).ok,
      );
    });
  }
});
