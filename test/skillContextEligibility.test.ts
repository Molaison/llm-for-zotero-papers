import { assert } from "chai";
import {
  BUILTIN_SKILL_FILES,
  getMatchedSkillIds as getMatchedSkillIdsResolved,
  parseSkill,
  getAllSkills,
  setUserSkills,
} from "../src/agent/skills";
import type {
  CollectionContextRef,
  PaperContextRef,
  TagContextRef,
} from "../src/shared/types";
import type { AgentRuntimeRequestInput } from "../src/agent/types";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";

function getMatchedSkillIds(
  input: AgentRuntimeRequestInput,
  classifiedIds?: string[],
): string[] {
  return getMatchedSkillIdsResolved(
    resolvedAgentRequest({
      conversationKey: 1,
      mode: "agent",
      libraryID: 1,
      ...input,
    }),
    classifiedIds,
  );
}

const paperA: PaperContextRef = {
  itemId: 10,
  contextItemId: 100,
  title: "Paper A",
};
const paperB: PaperContextRef = {
  itemId: 11,
  contextItemId: 101,
  title: "Paper B",
};
const collection: CollectionContextRef = {
  collectionId: 5,
  libraryID: 1,
  name: "Collection",
};
const tag: TagContextRef = {
  name: "Stable",
  normalizedName: "stable",
  libraryID: 1,
};

function loadBuiltInSkills(): void {
  setUserSkills(
    Object.values(BUILTIN_SKILL_FILES).map((raw) => parseSkill(raw)),
  );
}

describe("skill context eligibility", function () {
  afterEach(function () {
    setUserSkills([]);
  });

  // A single-paper-only skill; no shipped skill is limited to one paper.
  function loadSkillsWithSinglePaperSkill(): void {
    setUserSkills([
      ...Object.values(BUILTIN_SKILL_FILES).map((raw) => parseSkill(raw)),
      parseSkill(
        [
          "---",
          "id: one-paper-digest",
          "description: Summarize the one paper in scope with its key findings",
          "version: 1",
          "contexts: single-paper",
          "activation: auto",
          "---",
          "Digest one paper.",
        ].join("\n"),
      ),
    ]);
  }

  it("activates a single-paper skill only for paper-targeted routes", function () {
    loadSkillsWithSinglePaperSkill();

    assert.include(
      getMatchedSkillIds(
        {
          userText: "summarize this paper",
          selectedPaperContexts: [paperA],
        },
        ["one-paper-digest"],
      ),
      "one-paper-digest",
    );
    assert.notInclude(
      getMatchedSkillIds({ userText: "summarize my library" }, [
        "one-paper-digest",
      ]),
      "one-paper-digest",
    );
    assert.notInclude(
      getMatchedSkillIds(
        {
          userText: "summarize these papers",
          selectedPaperContexts: [paperA, paperB],
        },
        ["one-paper-digest"],
      ),
      "one-paper-digest",
    );
  });

  it("prefers library skills for collection and tag summary routes", function () {
    loadSkillsWithSinglePaperSkill();

    const paperTargeted = getMatchedSkillIds(
      {
        userText: "summarize this paper",
        selectedPaperContexts: [paperA],
        selectedCollectionContexts: [collection],
      },
      ["one-paper-digest"],
    );
    assert.include(paperTargeted, "one-paper-digest");

    const collectionTargeted = getMatchedSkillIds(
      {
        userText: "summarize this collection",
        selectedPaperContexts: [paperA],
        selectedCollectionContexts: [collection],
      },
      ["library-analysis"],
    );
    assert.include(collectionTargeted, "library-analysis");
    assert.notInclude(collectionTargeted, "one-paper-digest");

    const tagTargeted = getMatchedSkillIds(
      {
        userText: "summarize this tag",
        selectedPaperContexts: [paperA],
        selectedTagContexts: [tag],
      },
      ["library-analysis"],
    );
    assert.include(tagTargeted, "library-analysis");
    assert.notInclude(tagTargeted, "one-paper-digest");
  });

  it("routes paper sets and library corpora to their matching skills", function () {
    loadBuiltInSkills();

    assert.include(
      getMatchedSkillIds(
        {
          userText: "compare these papers",
          selectedPaperContexts: [paperA, paperB],
        },
        ["compare-papers"],
      ),
      "compare-papers",
    );
    assert.include(
      getMatchedSkillIds(
        {
          userText: "write a literature review",
          selectedPaperContexts: [paperA, paperB],
        },
        ["literature-review"],
      ),
      "literature-review",
    );
    assert.include(
      getMatchedSkillIds(
        {
          userText: "conduct a literature review on drift",
          selectedCollectionContexts: [collection],
        },
        ["literature-review"],
      ),
      "literature-review",
    );
    assert.include(
      getMatchedSkillIds(
        {
          userText: "give me statistics",
          selectedCollectionContexts: [collection],
        },
        ["library-analysis"],
      ),
      "library-analysis",
    );
    assert.include(
      getMatchedSkillIds(
        {
          userText: "give me statistics",
          selectedTagContexts: [tag],
        },
        ["library-analysis"],
      ),
      "library-analysis",
    );
  });

  it("does not treat comparisons within one paper as paper comparisons", function () {
    loadBuiltInSkills();

    const onePaper = resolvedAgentRequest({
      conversationKey: 1,
      mode: "agent",
      libraryID: 1,
      userText: "compare the paper's local and long-range mechanisms",
      selectedPaperContexts: [paperA],
    });
    assert.notInclude(
      getMatchedSkillIdsResolved(onePaper, ["compare-papers"]),
      "compare-papers",
    );

    const paperSet = resolvedAgentRequest({
      conversationKey: 1,
      mode: "agent",
      libraryID: 1,
      userText: "compare these papers",
      selectedPaperContexts: [paperA, paperB],
    });
    assert.include(
      getMatchedSkillIdsResolved(paperSet, ["compare-papers"]),
      "compare-papers",
    );
  });

  it("discards legacy keyword rules while preserving readable skill instructions", function () {
    setUserSkills([
      parseSkill(
        [
          "---",
          "id: custom-summary",
          "description: Custom summary",
          "version: 1",
          "match: /summarize/i",
          "---",
          "Custom instructions.",
        ].join("\n"),
      ),
    ]);

    assert.notProperty(getAllSkills()[0], "patterns");
    assert.equal(getAllSkills()[0].instruction, "Custom instructions.");
    assert.notInclude(
      getMatchedSkillIds({ userText: "summarize anything" }),
      "custom-summary",
    );
  });

  it("always honors explicitly forced slash skills", function () {
    loadBuiltInSkills();

    assert.deepEqual(
      getMatchedSkillIds({
        userText: "answer this without any attached paper context",
        forcedSkillIds: ["evidence-based-qa"],
      }),
      ["evidence-based-qa"],
    );
  });

  it("routes broad single-paper summaries to evidence-based-qa", function () {
    loadBuiltInSkills();

    assert.deepEqual(
      getMatchedSkillIds(
        {
          userText: "summarize this paper",
          selectedPaperContexts: [paperA],
        },
        ["evidence-based-qa"],
      ),
      ["evidence-based-qa"],
    );
  });

  it("lists explicit skills before routed ones without dropping either", function () {
    loadBuiltInSkills();

    assert.deepEqual(
      getMatchedSkillIds(
        {
          userText: "compare these papers and save a note",
          selectedPaperContexts: [paperA, paperB],
          forcedSkillIds: ["write-note"],
        },
        ["compare-papers", "evidence-based-qa", "write-note"],
      ),
      ["write-note", "compare-papers", "evidence-based-qa"],
    );
  });
});
