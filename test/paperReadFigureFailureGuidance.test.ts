import { assert } from "chai";
import {
  createPaperReadTool,
  FIGURE_CROP_FAILURE_GUIDANCE,
  type PaperReadFigureExtractionResult,
} from "../src/agent/tools/read/paperRead";
import type { AgentToolContext } from "../src/agent/types";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";

const paper = { itemId: 10, contextItemId: 11, title: "Paper" };

function context(): AgentToolContext {
  return {
    request: resolvedAgentRequest({
      conversationKey: 1,
      mode: "agent",
      libraryID: 1,
      userText: "Show Figure 1",
      selectedPaperContexts: [paper],
    }),
  } as unknown as AgentToolContext;
}

function toolWith(result?: PaperReadFigureExtractionResult) {
  return createPaperReadTool(
    {} as never,
    {} as never,
    {} as never,
    { resolvePaperContextTarget: () => paper } as never,
    result ? { extractFigures: async () => result } : undefined,
  );
}

async function runFigures(result?: PaperReadFigureExtractionResult) {
  const output = (await toolWith(result).execute(
    { mode: "figures", figureLabels: ["Figure 1"], target: paper } as never,
    context(),
  )) as Record<string, unknown>;
  return (output.content as Record<string, unknown>) || output;
}

describe("paper_read figures failure guidance", function () {
  it("is one sentence carrying the analyze-figures failure rule", function () {
    assert.match(FIGURE_CROP_FAILURE_GUIDANCE, /^[^.]+\.$/);
    for (const term of [
      "captions",
      "surrounding",
      "screenshots",
      "source images",
      "placeholders",
    ])
      assert.include(FIGURE_CROP_FAILURE_GUIDANCE, term);
  });

  it("adds the rule to a failed extraction that carries no guidance", async function () {
    const content = await runFigures({
      mode: "figures",
      status: "no_figures",
      figures: [],
      warnings: ["Figure selection is unresolved."],
    });
    assert.equal(content.status, "no_figures");
    assert.equal(content.guidance, FIGURE_CROP_FAILURE_GUIDANCE);
    assert.deepEqual(content.warnings, ["Figure selection is unresolved."]);
  });

  it("adds the rule when the extraction service is unavailable", async function () {
    const content = await runFigures();
    assert.equal(content.status, "error");
    assert.equal(content.guidance, FIGURE_CROP_FAILURE_GUIDANCE);
  });

  it("keeps a failed extraction's own guidance and leaves success untouched", async function () {
    const own = await runFigures({
      mode: "figures",
      status: "no_figures",
      guidance: "Service-specific text-only guidance.",
    });
    assert.equal(own.guidance, "Service-specific text-only guidance.");
    const ok = await runFigures({
      mode: "figures",
      status: "ok",
      figures: [{ cropPath: "/tmp/crop.png" }],
    });
    assert.notProperty(ok, "guidance");
  });
});
