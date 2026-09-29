import { assert } from "chai";
import { selectAutomaticSkills } from "../src/agent/model/automaticSkillSelection";
import { parseSkill } from "../src/agent/skills/skillLoader";
import { resolveAgentRuntimeRequest } from "../src/agent/context/resolvedAgentRequest";

const skills = [
  parseSkill(
    "---\nid: analyze-figures\ndescription: Read figures and panels\ncontexts: single-paper\nactivation: auto\n---\nFigure instructions",
  ),
  parseSkill(
    "---\nid: write-note\ndescription: Save a Zotero note\ncontexts: any\nactivation: auto\n---\nNote instructions",
  ),
  parseSkill(
    "---\nid: manual\ndescription: Only explicitly selected\ncontexts: any\nactivation: manual\n---\nManual instructions",
  ),
];
const request = resolveAgentRuntimeRequest({
  conversationKey: 1,
  libraryID: 1,
  mode: "agent",
  userText: "Put the experimental diagram into my reading notes",
  selectedPaperContexts: [{ itemId: 1, contextItemId: 2, title: "Paper" }],
  selectedCollectionContexts: [
    { libraryID: 1, collectionId: 3, name: "Research" },
  ],
  model: "test",
  apiKey: "fixture",
  apiBase: "https://example.invalid",
});

describe("automatic semantic skill selection", function () {
  it("selects from meanings and descriptions without predicting tools or authority", async function () {
    let prompt = "";
    const result = await selectAutomaticSkills(
      request,
      skills,
      undefined,
      async (params) => {
        prompt = params.prompt;
        return {
          ok: true,
          text: '{"skillIds":["analyze-figures","write-note","manual","invented"]}',
        };
      },
    );
    assert.deepEqual(result.skillIds, ["analyze-figures", "write-note"]);
    assert.include(prompt, request.userText);
    assert.include(prompt, "Read figures and panels");
    assert.notInclude(prompt, "Figure instructions");
    assert.notInclude(prompt, '"manual"');
    assert.isUndefined(request.classifiedIntent);
    assert.isUndefined(request.actionContract);
  });

  it("leaves unavailable routing to the main model without inventing matches", async function () {
    const result = await selectAutomaticSkills(
      request,
      skills,
      undefined,
      async () => ({ ok: false, reason: "timeout" }),
    );
    assert.deepEqual(result, {
      skillIds: [],
      status: "unavailable",
      reason: "timeout",
    });
  });

  it("keeps main-model skill loading available after a transport exception", async function () {
    const result = await selectAutomaticSkills(
      request,
      skills,
      undefined,
      async () => {
        throw new Error("connection closed");
      },
    );
    assert.deepEqual(result, {
      skillIds: [],
      status: "unavailable",
      reason: "transport",
    });
  });

  it("rejects malformed output and excludes skills without their required context", async function () {
    const result = await selectAutomaticSkills(
      { ...request, turnPaperScope: { ...request.turnPaperScope, papers: [] } },
      skills,
      undefined,
      async () => ({
        ok: true,
        text: '{"skillIds":["analyze-figures","write-note"]}',
      }),
    );
    assert.deepEqual(result.skillIds, ["write-note"]);
    const invalid = await selectAutomaticSkills(
      request,
      skills,
      undefined,
      async () => ({ ok: true, text: '{"skillIds":"write-note"}' }),
    );
    assert.equal(invalid.status, "unavailable");
  });
});
