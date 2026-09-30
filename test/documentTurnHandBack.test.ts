import { assert } from "chai";
import { createTaskUpdateTool } from "../src/agent/tools/plan/taskUpdate";
import {
  DOCUMENT_TITLE,
  PARENT_ITEM_ID,
  createDirectJourneyRegistry,
  finalStep,
  installDirectJourneyEnvironment,
  runJourneyTurn,
  toolCallStep,
  toolResultFor,
} from "./helpers/materialJourneys";
import type {
  DirectJourneyEnvironment,
  JourneyTurn,
} from "./helpers/materialJourneys";
import type {
  AgentModelMessage,
  AgentModelStep,
  AgentToolCall,
} from "../src/agent/types";

/**
 * A finalized document ends the turn only when nothing else was requested.
 *
 * "Summarize this paper and save it as a note": the model finalizes the
 * summary with submit_document and saves it with note_write, either in the
 * same step or after declaring the save with task_update. Ending the turn on
 * the document skipped the save, and the note silently never existed.
 */

const SUMMARY_MARKDOWN = `# ${DOCUMENT_TITLE}\n\nA complete summary.`;
const SAVE_TASK = "Save the summary as a note on the paper";

function submitDocumentCall(id: string): AgentToolCall {
  return {
    id,
    name: "submit_document",
    arguments: {
      documentKind: "report",
      integrityPolicy: "authored",
      title: DOCUMENT_TITLE,
      markdown: SUMMARY_MARKDOWN,
      citations: [],
      quotes: [],
      assets: [],
      groundingReviewed: "passed",
      groundingIssues: [],
    },
  };
}

function inlineNoteCall(id: string): AgentToolCall {
  return {
    id,
    name: "note_write",
    arguments: {
      mode: "create",
      content: SUMMARY_MARKDOWN,
      targetItemId: PARENT_ITEM_ID,
    },
  };
}

/** One model step that batches several calls. */
function stepOf(...calls: AgentToolCall[]): AgentModelStep {
  return {
    kind: "tool_calls",
    calls,
    assistantMessage: { role: "assistant", content: "", tool_calls: calls },
  };
}

/** The result of a tool call, as the model read it in its next step. */
function deliveredContent(
  messages: AgentModelMessage[],
  toolName: string,
): Record<string, any> {
  const message = messages.findLast(
    (entry) => entry.role === "tool" && entry.name === toolName,
  );
  assert.exists(message, `the model must have received ${toolName}'s result`);
  return JSON.parse(String(message!.content));
}

/** The finalized document text submit_document returned in this turn. */
function documentText(turn: JourneyTurn): string {
  const submitted = toolResultFor(turn.events, "submit_document");
  assert.isTrue(submitted?.ok, "submit_document must finalize the document");
  return (submitted!.content as { visibleMarkdown: string }).visibleMarkdown;
}

function answerText(turn: JourneyTurn): string | undefined {
  return turn.outcome.kind === "completed" ? turn.outcome.text : undefined;
}

describe("a finalized document hands the turn back while requested work remains", function () {
  let environment: DirectJourneyEnvironment;
  let conversationKey = 882_000;

  beforeEach(async function () {
    environment = await installDirectJourneyEnvironment();
    conversationKey += 1;
  });

  afterEach(function () {
    environment.restore();
  });

  function runTurn(
    steps: Parameters<typeof runJourneyTurn>[0]["steps"],
  ): Promise<JourneyTurn> {
    const registry = createDirectJourneyRegistry();
    registry.register(createTaskUpdateTool());
    return runJourneyTurn({
      registry,
      conversationKey,
      userText: "Summarize this paper and save it as a note",
      sourceMessageTimestamp: 100,
      steps,
    });
  }

  it("runs a note write batched with submit_document and answers with the document", async function () {
    const turn = await runTurn([
      stepOf(submitDocumentCall("submit-1"), inlineNoteCall("note-1")),
      finalStep("I saved the summary as a note on the paper."),
    ]);

    assert.equal(turn.outcome.kind, "completed");
    const note = toolResultFor(turn.events, "note_write");
    assert.isTrue(note?.ok, "the note write in the same step must run");
    assert.equal(
      environment.library.nativeSaves(),
      1,
      "the requested note must exist in Zotero",
    );
    assert.equal(
      [...environment.library.notes.values()][0]?.parentID,
      PARENT_ITEM_ID,
    );
    assert.equal(
      turn.steps,
      2,
      "the turn continues to one more model step after the batched calls",
    );
    const handBack = deliveredContent(turn.prompts[1], "submit_document");
    assert.equal(
      handBack.finalizedDocumentId,
      (toolResultFor(turn.events, "submit_document")!.content as any)
        .documentId,
    );
    assert.notProperty(
      handBack,
      "remainingWork",
      "no declared task is open, so none is named",
    );
    assert.equal(
      answerText(turn),
      documentText(turn),
      "the answer is still the finalized document",
    );
  });

  it("continues past submit_document while a declared task is open, and the next step's note write runs", async function () {
    const turn = await runTurn([
      toolCallStep("task-1", "task_update", {
        tasks: [
          { taskId: "save-note", description: SAVE_TASK, status: "pending" },
        ],
      }),
      stepOf(submitDocumentCall("submit-1")),
      // The model saves the document it was handed back, by its identity.
      (messages) =>
        toolCallStep("note-1", "note_write", {
          mode: "create",
          documentId: deliveredContent(messages, "submit_document")
            .finalizedDocumentId,
          targetItemId: PARENT_ITEM_ID,
        }),
      finalStep("I saved the summary as a note on the paper."),
    ]);

    assert.equal(turn.outcome.kind, "completed");
    assert.equal(
      turn.steps,
      4,
      "declare, finalize, save, answer: the document did not end the turn",
    );
    const handBack = deliveredContent(turn.prompts[2], "submit_document");
    assert.equal(
      handBack.remainingWork,
      SAVE_TASK,
      "the hand-back names the task that is still open",
    );
    assert.include(handBack.instruction, "finalized and preserved");
    assert.include(handBack.instruction, "do not regenerate it");
    const note = toolResultFor(turn.events, "note_write");
    assert.isTrue(note?.ok, "the next step's note write must run");
    assert.equal(
      (note!.content as { documentId?: string }).documentId,
      handBack.finalizedDocumentId,
      "the note saves the finalized document, not a regenerated one",
    );
    assert.equal(environment.library.nativeSaves(), 1);
    assert.equal(answerText(turn), documentText(turn));
  });

  it("ends a document-only turn on submit_document, as before", async function () {
    const turn = await runTurn([stepOf(submitDocumentCall("submit-1"))]);

    assert.equal(turn.outcome.kind, "completed");
    assert.equal(
      turn.steps,
      1,
      "a document-only turn costs exactly one model step",
    );
    assert.equal(answerText(turn), documentText(turn));
  });

  it("ends the turn on submit_document when every declared task is completed, waiting, or blocked", async function () {
    // A completed task needs host-verified evidence, so the note is written
    // first and its receipt closes the save task. Only one ordinary task may
    // be in progress at a time, so the others close over three steps.
    const turn = await runTurn([
      stepOf(inlineNoteCall("note-1"), {
        id: "task-1",
        name: "task_update",
        arguments: {
          tasks: [
            {
              taskId: "ask",
              description: "Ask which collection to use",
              status: "in_progress",
            },
          ],
        },
      }),
      (messages) =>
        toolCallStep("task-2", "task_update", {
          tasks: [
            { taskId: "ask", status: "waiting_for_user" },
            {
              taskId: "save-note",
              description: SAVE_TASK,
              status: "completed",
              verifiedReceiptIds: deliveredContent(
                messages,
                "note_write",
              ).actionReceipts.map((receipt: { id: string }) => receipt.id),
            },
            {
              taskId: "check",
              description: "Check the citation style",
              status: "in_progress",
            },
          ],
        }),
      toolCallStep("task-3", "task_update", {
        tasks: [{ taskId: "check", status: "blocked" }],
      }),
      stepOf(submitDocumentCall("submit-1")),
    ]);

    assert.equal(turn.outcome.kind, "completed");
    assert.deepEqual(
      turn.request?.executionCheckpoint?.tasks.map((task) => task.status),
      ["waiting_for_user", "completed", "blocked"],
      "the checkpoint holds no pending or in-progress task",
    );
    assert.equal(
      turn.steps,
      4,
      "no requested work remains, so the document ends the turn",
    );
    assert.equal(answerText(turn), documentText(turn));
  });
});
