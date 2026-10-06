import { isSinglePaperConversation } from "../src/agent/context/requestTurnPaperScope";
import { assert } from "chai";
import { preparePaperPromptContext } from "../src/agent/context/paperPromptContext";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";
import type { PdfContext } from "../src/services/paperContent/types";
import {
  renderAgentPromptEnvelope,
  composeAgentModelInput,
} from "../src/agent/model/messageBuilder";
import { buildAgentResourceContextPlan } from "../src/agent/context/resourceContextPlan";

const paper = {
  libraryID: 1,
  itemId: 20,
  contextItemId: 21,
  title: "Complete paper",
  firstCreator: "Kim",
  year: "2026",
};
const chunks = [
  "The introduction motivates an investigation of neural representations over extended periods of time.",
  "The methods measured the activity of individual neurons across twelve recording sessions in five animals.",
  "The results show that population decoding remained stable despite changing individual neural responses.",
  "The discussion identifies the small sample size as a limitation and recommends replication in other species.",
];
const context = {
  title: paper.title,
  chunks,
  chunkMeta: chunks.map((text, chunkIndex) => ({
    chunkIndex,
    text,
    normalizedText: text,
    chunkKind: "body",
  })),
  fullLength: chunks.join("\n").length,
} as PdfContext;
const request = (extra = {}) =>
  resolvedAgentRequest({
    conversationKey: 900451,
    mode: "agent",
    libraryID: 1,
    userText: "Explain the paper",
    activePaperContext: paper,
    conversationKind: "paper",
    ...extra,
  });

describe("default paper prompt context", function () {
  it("delivers all sections once with stable source anchors across follow-up retrieval", async function () {
    const firstRequest = request();
    const first = await preparePaperPromptContext(firstRequest, {
      tokenBudget: 5000,
      load: async () => context,
    });
    assert.lengthOf(first.quoteCitations, 4);
    for (const text of chunks) assert.include(first.blocks[0], text);
    assert.include(first.blocks[0], "Complete extracted paper");
    const nextRequest = request({
      userText: "Read one more snippet about the methods",
      history: [{ role: "assistant", content: "Prior answer" }],
    });
    const next = await preparePaperPromptContext(nextRequest, {
      tokenBudget: 5000,
      load: async () => context,
    });
    assert.deepEqual(next, first);
    const plan = buildAgentResourceContextPlan(firstRequest);
    plan.paperContext = first;
    const initial = await renderAgentPromptEnvelope(firstRequest, [], [], plan);
    const followup = await renderAgentPromptEnvelope(nextRequest, [], [], plan);
    assert.deepEqual(
      initial.envelope.systemMessages,
      followup.envelope.systemMessages,
    );
    const messages = composeAgentModelInput(followup.envelope, {
      transcriptMessages: [
        {
          role: "tool",
          tool_call_id: "read-1",
          name: "paper_read",
          content: "Extra methods evidence",
        },
      ],
    });
    const paperMessage = messages.findIndex((message) =>
      String(message.content).includes("Complete extracted paper text"),
    );
    assert.isAbove(paperMessage, 0);
    assert.isBelow(
      paperMessage,
      messages.findIndex((message) => message.role === "tool"),
    );
    assert.equal((messages[paperMessage] as any).cachePolicy, "stable-prefix");
  });

  it("preserves explicit slash skills for one paper and resumes with added scope", async function () {
    const single = request({ forcedSkillIds: ["evidence-based-qa"] });
    assert.isTrue(isSinglePaperConversation(single));
    assert.deepEqual(single.forcedSkillIds, ["evidence-based-qa"]);
    const multi = request({
      selectedPaperContexts: [
        { ...paper, itemId: 30, contextItemId: 31, title: "Second paper" },
      ],
    });
    assert.isFalse(isSinglePaperConversation(multi));
    const before = await preparePaperPromptContext(single, {
      tokenBudget: 5000,
      load: async () => context,
    });
    const after = await preparePaperPromptContext(multi, {
      tokenBudget: 5000,
      load: async () => context,
    });
    assert.equal(after.blocks[0], before.blocks[0]);
    assert.lengthOf(after.blocks, 2);
    assert.notEqual(after.quoteCitations[0].id, after.quoteCitations[4].id);
    assert.isFalse(
      isSinglePaperConversation(
        request({
          selectedCollectionContexts: [
            { libraryID: 1, collectionId: 4, name: "Added collection" },
          ],
        }),
      ),
    );
  });

  it("reports capacity limits and unavailable text without claiming full coverage", async function () {
    const partial = await preparePaperPromptContext(request(), {
      tokenBudget: 220,
      load: async () => context,
    });
    assert.include(partial.blocks[0], "Partial text:");
    assert.notInclude(partial.blocks[0], "Complete extracted paper");
    assert.isBelow(partial.quoteCitations.length, 4);
    const missing = await preparePaperPromptContext(request(), {
      load: async () => undefined,
    });
    assert.include(missing.blocks[0], "Full text unavailable");
    assert.isEmpty(missing.quoteCitations);
  });

  it("refreshes source text instead of retaining stale content by conversation identity", async function () {
    const revised = await preparePaperPromptContext(request(), {
      tokenBudget: 5000,
      load: async () => ({ ...context, chunks: [chunks[1]] }),
    });
    assert.notInclude(revised.blocks[0], chunks[0]);
    assert.include(revised.blocks[0], chunks[1]);
  });
});
