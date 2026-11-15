import { assert } from "chai";
import { OPERATION_CATALOG } from "../src/agent/contracts/operationCatalog";
import {
  OPERATION_VERBS,
  operationVerb,
} from "../src/modules/contextPanel/agentTrace/actionCardVocabulary";

describe("action card vocabulary", function () {
  it("gives every catalog operation a verb", function () {
    for (const operation of Object.keys(OPERATION_CATALOG)) {
      assert.property(OPERATION_VERBS, operation);
      assert.isObject(
        OPERATION_VERBS[operation as keyof typeof OPERATION_VERBS],
      );
    }
  });

  it("uses a glyph only where it carries meaning", function () {
    assert.equal(operationVerb("move_to_collection").glyph, "→");
    assert.equal(operationVerb("apply_tags").glyph, "+");
    assert.equal(operationVerb("remove_tags").glyph, "−");
    assert.isTrue(operationVerb("remove_tags").destructive);
    assert.equal(operationVerb("trash_items").glyph, "→");
    assert.isTrue(operationVerb("trash_items").destructive);
    assert.equal(operationVerb("restore_from_trash").glyph, "↺");
    assert.equal(operationVerb("command_execute").glyph, "›");
    for (const op of [
      "note_create",
      "note_edit",
      "note_append",
      "save_note",
      "file_write",
      "update_metadata",
    ]) {
      assert.isUndefined(
        operationVerb(op).glyph,
        `${op} shows the object chip alone`,
      );
    }
  });

  it("has no glyph for an unknown operation", function () {
    assert.deepEqual(operationVerb("frobnicate_items"), {});
  });
});
