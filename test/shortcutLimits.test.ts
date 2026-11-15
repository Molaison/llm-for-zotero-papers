import { assert } from "chai";
import {
  BUILTIN_SHORTCUT_FILES,
  MAX_EDITABLE_SHORTCUTS,
} from "../src/modules/contextPanel/constants";

describe("shortcut limits", function () {
  it("keeps enough custom slots after adding the Diagram shortcut", function () {
    const visibleCustomSlots =
      MAX_EDITABLE_SHORTCUTS - BUILTIN_SHORTCUT_FILES.length;

    assert.equal(MAX_EDITABLE_SHORTCUTS, 20);
    assert.equal(BUILTIN_SHORTCUT_FILES[4]?.id, "mermaid-diagram");
    assert.isAtLeast(visibleCustomSlots, 6);
  });
});
