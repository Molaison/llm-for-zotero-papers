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
    assert.include(text, "write from the results the host returned");
    // A digested paper is read again only by a targeted read: a decisive
    // claim, a contradiction, or a gap its result names; never in full.
    assert.include(
      text,
      "Read a digested paper again only with `paper_read({ mode:'targeted', query:'...' })`: to verify a decisive cross-paper claim, test an apparent contradiction, or close a gap its result names that the review needs; never re-read it in overview or full mode.",
    );
    // With nothing attached the agent chooses the papers before naming them.
    assert.include(
      text,
      "With nothing attached, choose the papers from `library_retrieve` results without opening them with `paper_read`, then declare the digest part with their `targetIds`.",
    );
    // A paper with no text is named as not read: no retry, read or search.
    assert.include(
      text,
      'A paper that failed with "No readable text" has no text to read: name it as not read, and do not retry it, read it with `paper_read`, or look for it outside the library.',
    );
    // A paper the host could not digest twice is read, not left unread.
    assert.include(
      text,
      "a paper whose digest failed twice may be read with an overview `paper_read` instead",
    );
    assert.notInclude(text, "a paper that still fails is named as not read");
    assert.include(text, "same `taskId` and no description");
  });

  it("asks the digest for the review question's per-paper result", function () {
    const text = skill.instruction;
    assert.include(
      text,
      `{ taskId:'papers', description:'For the review question "<question>": summarize each paper and judge how it bears on the question', expectedEffect:'digest', scope:true }`,
    );
    assert.include(
      text,
      "The host then analyzes each paper itself inside that call and returns the results",
    );
    assert.notInclude(text, "returns the summaries");
    assert.include(
      text,
      "a relevance line when the description names a question, facets, verified quotes with section labels, gaps",
    );
  });

  it("treats a folder as the source boundary and lets the agent select papers by content, with reasons", function () {
    const text = skill.instruction;
    assert.include(
      text,
      "A selected folder, tag or paper set is the source boundary: each paper in it is a candidate, and none is relevant only because it is there.",
    );
    assert.notInclude(text, "evidence pool, not as a sample");
    // Select sits between Read and Write.
    assert.match(
      text,
      /3\. \*\*Read\.\*\*[\s\S]*4\. \*\*Select\.\*\*[\s\S]*5\. \*\*Write\.\*\*[\s\S]*6\. \*\*Save\.\*\*/,
    );
    for (const rule of [
      "Include every paper whose content bears on the question, whatever its field.",
      "a relevance of none is a signal, not the decision",
      "List each paper you leave out under `excluded` in `submit_document` (or `task_update` for an answer without a document), with a one-sentence reason",
      "Never leave a paper out because its text could not be read; name it as not read.",
      "every paper keeps its summary in Paper summaries; flag one that does not fit the question instead of dropping it",
      "name it by title with that reason in Scope and method, without a citation: a citation means the review uses the paper",
      "In Scope and method, name each paper you left out by title, with the reason and without a citation.",
      "In narrative and scoping reviews, include papers by their relevance to the question and name each excluded paper with its reason.",
      "in other reviews, name each excluded paper with its reason",
    ]) {
      assert.include(text, rule, rule);
    }
    assert.notInclude(text, "they are not eligibility criteria");
    assert.notInclude(
      text,
      "exclusion accounting to systematic-review requests",
    );
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
    // The digest description names the dimensions; the facets come back
    // with those labels and become the comparison's rows.
    assert.include(text, "whose description names the comparison dimensions");
    assert.include(
      text,
      "Each result returns facets with those labels; they become the comparison's rows.",
    );
    assert.include(
      text,
      "state a commonality only where the facets of each paper support it",
    );
    assert.notInclude(text, "returned digests");
  });
});
