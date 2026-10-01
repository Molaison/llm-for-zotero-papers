import { assert } from "chai";
import { createNoteWriteTool } from "../src/agent/tools/write/noteWrite";
import {
  normalizeNoteSourceText,
  renderRawNoteHtml,
} from "../src/services/notes/noteRendering";
import type { AgentToolContext } from "../src/agent/types";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";

/**
 * The live run's summary note (stage "sized", find+summary+note), as the
 * model wrote it: "~" meaning "about", twice in one paragraph.
 */
const LIVE_NOTE = [
  "# Network mechanisms underlying representational drift in area CA1 of hippocampus",
  "",
  "## Summary",
  "",
  "Devalle and Roxin (2022) report that the statistics of representational drift in CA1 are quantitatively consistent with ongoing, random synaptic turnover in the two main excitatory inputs to the circuit, operating in a balanced regime. Fitting a spiking CA1 network model to chronic Ca²⁺-imaging data from mice exploring familiar tracks, they identify two distinct time-scales: fast turnover of spatially untuned entorhinal cortex inputs (characteristic time-scale ~2 days), which shifts overall excitability/mean firing rate, and much slower change in spatially tuned CA3 (Schaffer collateral) inputs (~1 month), which drifts place-field location.",
].join("\n");

/** The live run's first edit, which found nothing. */
const LIVE_PATCHES = [
  {
    find: "characteristic time-scale ~2 days)",
    replace: "characteristic time-scale of about two days)",
  },
  { find: "inputs (~1 month)", replace: "inputs (about one month)" },
];

const context: AgentToolContext = {
  request: resolvedAgentRequest({
    conversationKey: 15,
    mode: "agent",
    userText: "fix the note",
    libraryID: 1,
  }),
  item: null,
  currentAnswerText: "",
  modelName: "test",
};

function editPreview(html: string, patches: unknown[]) {
  const tool = createNoteWriteTool({
    getActiveNoteSnapshot: () => ({
      noteId: 15,
      title: "Network mechanisms",
      html,
      text: normalizeNoteSourceText(html),
      libraryID: 1,
      noteKind: "item",
    }),
  } as never);
  const validated = tool.validate({ mode: "edit", targetNoteId: 15, patches });
  assert.isTrue(validated.ok);
  if (!validated.ok) throw new Error("unreachable");
  const pending = tool.createPendingAction!(validated.value, context) as {
    fields: Array<{ type: string; after?: string }>;
  };
  return pending.fields.find((field) => field.type === "diff_preview")?.after;
}

describe("note_write edit patch matching", function () {
  it("applies the live run's patches to the live note as it is stored now", function () {
    const after = editPreview(renderRawNoteHtml(LIVE_NOTE), LIVE_PATCHES);
    assert.include(after, "characteristic time-scale of about two days)");
    assert.include(after, "inputs (about one month), which drifts");
    assert.notInclude(after, "~");
  });

  it("matches a find copied from library_read's note text, Markdown and all, exactly", function () {
    const stored = renderRawNoteHtml(
      "## Summary\n\n**Main finding.** Turnover drives drift.",
    );
    assert.include(
      normalizeNoteSourceText(stored),
      "**Main finding.** Turnover",
      "library_read shows the note this way",
    );
    const after = editPreview(stored, [
      {
        find: "**Main finding.** Turnover drives",
        replace: "Main finding: turnover drives",
      },
    ]);
    // The replacement keeps the matched text's own markup, as every patch does.
    assert.include(after, "Main finding: turnover drives");
    assert.notInclude(after, "Turnover drives");
  });

  it("still refuses a find the note contains in no form", function () {
    assert.throws(
      () =>
        editPreview(renderRawNoteHtml(LIVE_NOTE), [
          {
            find: "characteristic time-scale ~3 days)",
            replace: "anything",
          },
        ]),
      /Note patch text was not found/,
    );
  });

  it("never matches the live find inside the note the old converter struck through", function () {
    // What the old converter stored: everything between the tildes struck
    // through, the tildes themselves gone.
    const struck =
      "<h1>Network mechanisms</h1><p>fast turnover of spatially untuned entorhinal cortex inputs (characteristic time-scale <del>2 days), which shifts overall excitability/mean firing rate, and much slower change in spatially tuned CA3 (Schaffer collateral) inputs (</del>1 month), which drifts place-field location.</p>";
    assert.throws(
      () => editPreview(struck, [LIVE_PATCHES[0]]),
      /Note patch text was not found/,
    );
  });
});
