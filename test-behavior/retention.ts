import type { JourneyContext } from "./journeys";
import { assertExact, check } from "./core";
import { requireReceipt } from "./driver";
import { clearAgentTranscriptStore } from "../src/agent/store/transcriptStore";
import { getAgentRunTrace } from "../src/agent/store/traceStore";
import { canonicalNoteHtml } from "../src/utils/noteHtml";
import { renderRawNoteHtml } from "../src/services/notes/noteRendering";
import { snapshot, onlyChanges } from "./native";

declare const Zotero: any;

export async function retentionJourney(ctx: JourneyContext) {
  const { fixtures: f, harness, driver, write } = ctx;
  const id = "conversation.retention";
  await harness.openStandaloneForItem(f.items.metadata.id);
  await harness.clickStandaloneTab("paper");
  harness.enableLiveAgentSending();
  const request = {
    conversationKey: f.items.metadata.id,
    activeItemId: f.items.metadata.id,
  };
  const before = await snapshot();
  const prompt =
    "Using only these supplied synthetic descriptions, write a comparison of about 500 words with four sections: Overview, Mechanisms, Tradeoffs, and Limitations. A learns an initialization then adapts with gradient steps; B learns an update rule; C retrieves examples into a context window. Explain the differences, without inventing empirical results. End the Limitations section with the exact phrase 'copper-limitation: synthetic descriptions only'.";
  const first = await driver.turn(id, prompt, "auto", request, "none", () =>
    harness.askStandalone(prompt),
  );
  check(
    first.result.text.length > 1000,
    "The original answer must extend well past the old 260-character cutoff",
  );
  clearAgentTranscriptStore();
  const followup =
    "Explain the last section of your answer in two sentences, using what you already wrote.";
  const second = await driver.turn(id, followup, "auto", request, "none", () =>
    harness.askStandalone(followup),
  );
  check(
    !second.events.some(
      (event) =>
        event.type === "tool_call" &&
        ["paper_read", "web_search", "library_retrieve"].includes(event.name),
    ),
    "Follow-up explanation must not repeat source retrieval",
  );
  assertExact(
    await snapshot(),
    before,
    "Explanation leaves the library unchanged",
  );
  const revisePrompt =
    "Revise the Limitations section of your original comparison into one short paragraph. Return only that revised section, preserve the copper-limitation phrase, and use the existing discussion.";
  const revised = await driver.turn(
    id,
    revisePrompt,
    "auto",
    request,
    "none",
    () => harness.askStandalone(revisePrompt),
  );
  check(
    revised.result.text.includes("copper-limitation"),
    "The revision preserves the requested prior constraint",
  );
  check(
    !revised.events.some(
      (event) =>
        event.type === "tool_call" &&
        ["paper_read", "web_search", "library_retrieve"].includes(event.name),
    ),
    "Revision reuses the existing discussion",
  );
  const compacted = await driver.turn(
    id,
    "/compact",
    "auto",
    request,
    "none",
    () => harness.askStandalone("/compact"),
  );
  check(
    compacted.events.some((event) => event.type === "context_compacted"),
    "The original answer was removed from the full prompt by deliberate compaction",
  );
  clearAgentTranscriptStore();
  const savePrompt = `Save your original four-section comparison unchanged as a standalone Zotero note to the folder "${f.collections.destination.name}".`;
  const started = Date.now();
  const saved = await driver.turn(id, savePrompt, "auto", request, "none", () =>
    harness.askStandalone(savePrompt),
  );
  const elapsedMs = Date.now() - started;
  const calls = saved.events.filter((event) => event.type === "tool_call");
  const writes = calls.filter(
    (event) => event.type === "tool_call" && event.name === "note_write",
  );
  check(
    writes.length === 1 &&
      writes[0].type === "tool_call" &&
      Boolean((writes[0].args as any)?.sourceMessageId),
    "One note_write must reuse the original answer by message identity",
  );
  check(
    !calls.some(
      (event) =>
        event.type === "tool_call" &&
        [
          "paper_read",
          "run_command",
          "web_search",
          "library_retrieve",
        ].includes(event.name),
    ),
    "Saving must not reread papers, run a shell, or search external evidence",
  );
  await f.collections.destination.reload(undefined, true);
  const notes = f.collections.destination
    .getChildItems()
    .filter((item: any) => item.isNote());
  check(
    notes.length === 1,
    "Exactly one standalone note is filed in the destination",
  );
  await notes[0].reload(undefined, true);
  check(!notes[0].parentID, "The saved note is standalone");
  assertExact(
    canonicalNoteHtml(notes[0].getNote()),
    canonicalNoteHtml(renderRawNoteHtml(first.result.text)),
    "Native note preserves the complete original rendered answer",
  );
  requireReceipt(saved);
  onlyChanges(
    before,
    await snapshot(),
    (row) =>
      !row.before &&
      row.after?.itemType === "note" &&
      row.after.id === notes[0].id,
  );
  const trace = await getAgentRunTrace(saved.result.runId);
  await write(`${id}/metrics.json`, {
    elapsedMs,
    runtimeElapsedMs:
      trace.run?.completedAt && trace.run?.createdAt
        ? trace.run.completedAt - trace.run.createdAt
        : undefined,
    toolCalls: calls.map((event) => ({ name: event.name, args: event.args })),
    modelRounds: saved.events
      .filter((event) => event.type === "usage")
      .map((event) => ("round" in event ? event.round : undefined)),
    usage: saved.events.filter((event) => event.type === "usage"),
    noteId: notes[0].id,
    originalChars: first.result.text.length,
  });
  await write(`${id}/original.md`, first.result.text, true);
  await write(`${id}/native-note.html`, notes[0].getNote(), true);
  await harness.captureStandaloneScreenshot(
    `${ctx.request.reportDir}/${id}/saved.png`,
  );
}
