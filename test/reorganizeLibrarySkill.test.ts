/**
 * The reorganize-library skill: a large reorganization shows its proposed
 * grouping in the chat before the first change, then moves the papers batch
 * by batch with library_update assignments, and declares the moves as one
 * part over the papers so Task progress counts them. Every tool and
 * parameter it names exists in the model-facing schemas.
 */
import { assert } from "chai";
import { BUILTIN_SKILL_FILES } from "../src/agent/skills";
import {
  getSkillRoutingDiagnostics,
  parseSkill,
} from "../src/agent/skills/skillLoader";
import { createBuiltInToolRegistry } from "../src/agent/tools";

type Schema = {
  properties?: Record<string, Schema>;
  items?: Schema;
  enum?: string[];
};

describe("reorganize-library skill", function () {
  const raw = BUILTIN_SKILL_FILES["reorganize-library.md"];
  const skill = parseSkill(raw || "");

  function schemaOf(toolName: string): Schema {
    const registry = createBuiltInToolRegistry({
      zoteroGateway: {} as never,
      pdfService: {} as never,
      pdfPageService: {} as never,
      retrievalService: {} as never,
    });
    const tool = registry.getTool(toolName);
    assert.exists(tool, `${toolName} is a model-facing tool`);
    return tool!.spec.inputSchema as Schema;
  }

  it("ships as an automatic skill for paper sets and library scopes", function () {
    assert.isString(raw, "bundled as reorganize-library.md");
    assert.equal(skill.id, "reorganize-library");
    assert.equal(skill.version, 1);
    assert.deepEqual(skill.contexts, ["paper-set", "library-corpus"]);
    assert.equal(skill.activation, "auto");
    assert.deepEqual(getSkillRoutingDiagnostics(skill), []);
  });

  it("shows the proposed grouping in the chat before creating or moving anything", function () {
    assert.include(
      skill.instruction,
      "Before creating or moving anything, show the proposed grouping in the chat",
    );
    assert.include(skill.instruction, "`request_user_input`");
  });

  it("surveys titles, metadata and abstracts in pages, not full texts", function () {
    assert.include(skill.instruction, "not their full texts");
    const search = schemaOf("library_search").properties!;
    assert.include(search.include.items!.enum!, "abstract");
    assert.containsAllKeys(search.filters.properties!, [
      "collectionId",
      "unfiled",
    ]);
    assert.containsAllKeys(search, ["limit", "offset"]);
    assert.include(
      schemaOf("library_retrieve").properties!.depth.enum!,
      "metadata",
    );
  });

  it("declares the moves as one part over the papers, and no read part for the survey", function () {
    assert.include(skill.instruction, "`scope:true`");
    assert.include(skill.instruction, "`targetIds`");
    assert.include(
      skill.instruction,
      "`expectedCapability:'zotero.collections'`",
    );
    assert.include(skill.instruction, "Declare no read part for the survey");
    const task = schemaOf("task_update").properties!.tasks.items!.properties!;
    assert.containsAllKeys(task, [
      "scope",
      "targetIds",
      "expectedEffect",
      "expectedCapability",
    ]);
  });

  it("creates folders, then moves papers in batches of assignments, and never repeats a declined batch", function () {
    for (const phrase of [
      "`kind:'collection'`",
      "`parentCollectionId`",
      "`kind:'collections'`",
      "`assignments`",
      "`mode:'move'`",
      "`from`",
      "Do not repeat a batch the user declined",
    ])
      assert.include(skill.instruction, phrase);
    const update = schemaOf("library_update").properties!;
    assert.includeMembers(update.kind.enum!, ["collection", "collections"]);
    assert.includeMembers(update.action.enum!, ["create", "add"]);
    assert.include(update.mode.enum!, "move");
    assert.containsAllKeys(update, ["parentCollectionId", "from"]);
    assert.containsAllKeys(update.assignments.items!.properties!, [
      "itemId",
      "targetCollectionId",
    ]);
  });

  it("reports what moved and what did not, from the receipts", function () {
    assert.include(skill.instruction, "Report from the receipts");
    assert.include(skill.instruction, "did not move and why");
  });
});
