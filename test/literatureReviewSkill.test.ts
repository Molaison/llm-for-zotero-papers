/**
 * The literature-review skill runs a review as an ordinary Agent job: the
 * turn's papers, declared parts, capacity-sized reads, and one cited
 * document. Plan mode is retired, so the skill names no plan tool, no
 * research-loop operation, and no plan state.
 */
import { assert } from "chai";
import { BUILTIN_SKILL_FILES } from "../src/agent/skills";
import { parseSkill } from "../src/agent/skills/skillLoader";

const PLAN_ONLY_NAMES = [
  "research_update",
  "approve_research_expansion",
  "approve_research_mutation",
  "update_plan",
  "prepare_plan_execution",
  "amend_plan",
  "submit_plan_document",
  "inventory_scope",
  "record_papers",
  "record_edges",
  "list_findings",
  "list_graph",
  "next_screen_batch",
];

describe("literature-review skill", function () {
  const raw = BUILTIN_SKILL_FILES["literature-review.md"];
  const skill = parseSkill(raw);

  it("runs the review with ordinary tools and names no plan tool or plan state", function () {
    for (const tool of [
      "library_search",
      "task_update",
      "paper_read",
      "submit_document",
      "note_write",
    ]) {
      assert.include(skill.instruction, `\`${tool}`, tool);
    }
    for (const name of PLAN_ONLY_NAMES) assert.notInclude(raw, name, name);
    assert.notMatch(
      raw,
      /plan mode|approved plan|plan approval|approved (?:document )?contract/i,
    );
  });

  it("leaves reading capacity to paper_read and asks for an honest coverage line", function () {
    assert.notMatch(
      skill.instruction,
      /\b\d+\s+(?:papers?|items|groups?)\b/i,
      "no hard-coded paper count or group size",
    );
    assert.include(
      skill.instruction,
      "read in full, in part, and from metadata only",
    );
    assert.include(skill.instruction, "never imply an exhaustive review");
  });

  it("saves the review as a note only when the user asked", function () {
    assert.match(
      skill.instruction,
      /`note_write`[^\n]*only when the user asked/,
    );
  });

  it("hands per-paper work to a host digest part and never pages the same papers", function () {
    const text = skill.instruction;
    assert.include(text, "expectedEffect:'digest'");
    assert.include(
      text,
      "do not also declare a read part over the same papers",
    );
    assert.include(text, "do not read those papers with `paper_read` first");
    assert.include(text, "write from the digests the host returned");
    assert.match(
      text,
      /`paper_read\(\{ mode:'targeted'[^\n]*only to verify a decisive cross-paper claim/,
    );
    assert.include(
      text,
      "never re-read a paper whose digest succeeded in overview or full mode",
    );
    // A paper the host could not digest twice is read, not left unread.
    assert.include(
      text,
      "a paper whose digest failed twice may be read with an overview `paper_read` instead",
    );
    assert.notInclude(text, "a paper that still fails is named as not read");
    assert.include(text, "same `taskId` and no description");
  });

  it("puts the per-paper summaries into the submitted document", function () {
    const text = skill.instruction;
    assert.include(text, "'Paper summaries' section");
    assert.match(text, /`submit_document`[^\n]*`taskId`/);
    assert.include(
      text,
      "name each paper whose digest failed and the reason the host gave",
    );
  });
});

describe("compare-papers skill", function () {
  it("builds a comparison of three or more papers from a host digest part", function () {
    const text = parseSkill(
      BUILTIN_SKILL_FILES["compare-papers.md"],
    ).instruction;
    assert.include(text, "expectedEffect:'digest'");
    assert.include(text, "build the comparison from the returned digests");
  });
});
