/**
 * The library-analysis skill describes what library results show the model:
 * a result sized to the request, its paper ledger and passages, and a handle
 * for everything it left out. It names no field the views omit.
 */
import { assert } from "chai";
import { BUILTIN_SKILL_FILES } from "../src/agent/skills";
import { parseSkill } from "../src/agent/skills/skillLoader";

describe("library-analysis skill", function () {
  const raw = BUILTIN_SKILL_FILES["library-analysis.md"];
  const skill = parseSkill(raw);

  it("reads library_retrieve's paperMatches as the ledger and its snippets as the body evidence", function () {
    assert.include(skill.instruction, "`paperMatches` as the paper ledger");
    assert.include(skill.instruction, "snippets as the body evidence");
  });

  it("pages what a sized result left out with context_read, and names no field the views omit", function () {
    assert.include(skill.instruction, "`omitted`");
    assert.include(skill.instruction, "`context_read`");
    assert.include(skill.instruction, "`toolResultHandle`");
    assert.notMatch(
      raw,
      /synthesis digest|evidenceLedgerText|surroundingText/i,
    );
  });

  it("ships as version 5", function () {
    assert.equal(skill.version, 5);
  });
});
