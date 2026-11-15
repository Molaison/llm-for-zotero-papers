import type { JourneyContext } from "./journeys";
import { assertExact, check } from "./core";
import { requireReceipt } from "./driver";
import { getAgentRunTrace } from "../src/agent/store/traceStore";
import {
  clearAgentTranscriptStore,
  readAgentConversationAnswer,
} from "../src/agent/store/transcriptStore";
import { getPendingRequestId } from "../src/modules/contextPanel/state";
import { snapshot, onlyChanges } from "./native";

declare const Zotero: any;

export async function deliveryJourney(ctx: JourneyContext) {
  const { fixtures: f, harness, driver, write } = ctx;
  const id = "conversation.delivery";
  const item = f.items.primary;
  await harness.openStandaloneForItem(item.id);
  await harness.clickStandaloneTab("paper");
  harness.enableLiveAgentSending();
  const before = await snapshot();
  const prompt =
    "Help me summarize this paper and save it as a note with this paper.";
  const turn = await driver.turn(
    id,
    prompt,
    "auto",
    {
      conversationKey: item.id,
      activeItemId: item.id,
    },
    "none",
    () => harness.askStandalone(prompt),
  );

  // Runtime completion precedes the UI owner's final chat write and redraw.
  const deadline = Date.now() + 15000;
  while (getPendingRequestId(item.id) && Date.now() < deadline)
    await Zotero.Promise.delay(50);
  check(
    !getPendingRequestId(item.id),
    "The completed request released the composer",
  );
  const trace = await getAgentRunTrace(turn.result.runId);
  assertExact(trace.run?.status, "completed", "Durable run status");
  const rows = await Zotero.DB.queryAsync(
    "SELECT text FROM llm_for_zotero_chat_messages WHERE conversation_key = ? AND role = 'assistant' AND agent_run_id = ?",
    [item.id, turn.result.runId],
  );
  assertExact(
    rows.map((row: any) => String(row.text)),
    [turn.result.text],
    "Exactly one complete chat answer is stored",
  );
  clearAgentTranscriptStore();
  assertExact(
    await readAgentConversationAnswer(item.id, `${turn.result.runId}:answer`),
    turn.result.text,
    "Exact answer reloads from durable conversation storage",
  );
  await item.reload(undefined, true);
  const notes = item
    .getNotes()
    .map((noteId: number) => Zotero.Items.get(noteId));
  assertExact(notes.length, 1, "One child note was created");
  await notes[0].reload(undefined, true);
  assertExact(notes[0].parentID, item.id, "Native note parent");
  check(
    notes[0]
      .getNote()
      .replace(/<[^>]*>/g, " ")
      .trim().length > 300,
    "The saved note contains a substantive paper summary",
  );
  requireReceipt(turn);
  onlyChanges(
    before,
    await snapshot(),
    (row) =>
      !row.before &&
      row.after?.id === notes[0].id &&
      row.after?.itemType === "note",
  );

  const ui = await harness.getStandaloneDiagnostics();
  assertExact(
    ui.conversationKey,
    item.id,
    "The inspected UI shows the tested conversation",
  );
  assertExact(ui.statusText, "Ready", "The delivered outcome is ready");
  const doc = Zotero.LLMForZotero.data.standaloneWindow.document as Document;
  const panel = doc.querySelector(".llm-standalone-content #llm-main")!;
  const summaries = [
    ...panel.querySelectorAll(".llm-agent-activity-summary"),
  ].map((node) => node?.textContent || "");
  check(
    summaries.length > 0 &&
      summaries.every((text) => text.startsWith("Worked for ")),
    "Every completed answer stops its Working indicator",
  );
  const cards = panel.querySelectorAll(".llm-agent-action-summary-card");
  assertExact(
    cards.length,
    1,
    "The visible answer includes its completed action card",
  );
  check(
    panel.textContent?.includes(turn.result.text.slice(0, 30)),
    "The visible conversation contains the saved answer",
  );
  await write(`${id}/delivery.json`, {
    runId: turn.result.runId,
    noteId: notes[0].id,
    runStatus: trace.run?.status,
    storedAnswerCount: rows.length,
    summaries,
    actionCardCount: cards.length,
    ui,
  });
  await write(`${id}/native-note.html`, notes[0].getNote(), true);
  await harness.captureStandaloneScreenshot(
    `${ctx.request.reportDir}/${id}/completed.png`,
  );
}
