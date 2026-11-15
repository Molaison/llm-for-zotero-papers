import { assert } from "chai";
import {
  buildInterruptedRunRecoveryMessage,
  buildTranscriptUserMessage,
  buildTurnStartRecoveryMessage,
  isCurrentTurnUserTranscriptMessage,
  isManualCompactRequest,
  readLatestTranscriptGoal,
} from "../src/agent/execution/transcriptRecovery";
import type { MaterialOutcomeEntry } from "../src/agent/execution/materialOutcomes";
import type { ResumableBatch } from "../src/agent/store/batchItemStore";

const interruptedBatch: ResumableBatch = {
  batchId: "batch-note_write_batch-abc123",
  conversationKey: 42,
  total: 3,
  saved: 1,
  failed: 1,
  pending: 1,
  createdAt: 1000,
  updatedAt: 1100,
};

const BATCH_HEADER = "Resumable note batches:";
const BATCH_LINE =
  "batchId=batch-note_write_batch-abc123 total=3 saved=1 failed=1 pending=1";
const BATCH_INSTRUCTION =
  "To continue, call note_write_batch with resumeBatchId=batch-note_write_batch-abc123; the saved items are skipped and no note is regenerated.";

const unsavedMaterial: MaterialOutcomeEntry = {
  materialRef: {
    documentId: "run-1:document:1",
    documentVersion: 1,
    contentHash: "sha256:guide",
  },
  materialKind: "guide",
  materialTitle: "Representational drift",
  runId: "run-1",
  status: "finalized",
};

describe("Agent transcript recovery", function () {
  const request = {
    userText: "  Summarize   this paper  ",
  } as never;

  it("recognizes manual compaction without changing ordinary requests", function () {
    assert.isTrue(
      isManualCompactRequest({ userText: "/compact now" } as never),
    );
    assert.isFalse(isManualCompactRequest(request));
  });

  it("uses one normalized user goal for transcript deduplication and recovery", function () {
    const message = buildTranscriptUserMessage(request);
    assert.isTrue(isCurrentTurnUserTranscriptMessage(message, request));
    assert.equal(readLatestTranscriptGoal([message]), "Summarize this paper");
  });

  it("summarizes durable journal outcomes without instructing a repeated write", function () {
    const message = buildInterruptedRunRecoveryMessage({
      run: { runId: "run-1" } as never,
      priorGoal: "Save a note",
      actions: [
        {
          actionId: "action-1",
          status: "verified",
          createdAt: 2,
          affectedCount: 1,
          reversibility: "reversible",
        } as never,
      ],
    });
    assert.equal(message.role, "user");
    assert.include(
      String(message.content),
      "Do not automatically repeat any prior write.",
    );
    assert.include(
      String(message.content),
      "actionId=action-1; status=verified",
    );
  });

  it("names finalized-but-unsaved material in the interrupted-run recovery note", function () {
    const message = buildInterruptedRunRecoveryMessage({
      run: { runId: "run-2" } as never,
      actions: [],
      materialOutcomes: [unsavedMaterial],
    });
    const content = String(message.content);
    assert.include(
      content,
      "Finalized material available (not saved as a note):",
    );
    assert.include(
      content,
      'documentId=run-1:document:1 version=1 hash=sha256:guide title="Representational drift" status=finalized',
    );
    assert.include(
      content,
      "If the user asks to save it, call note_write with that documentId; do not regenerate it.",
    );
  });

  it("builds a standalone host message for an uninterrupted next turn", function () {
    const message = buildTurnStartRecoveryMessage({
      materialOutcomes: [unsavedMaterial],
    });
    assert.exists(message);
    assert.equal(message?.role, "user");
    assert.include(String(message?.content), "documentId=run-1:document:1");
    assert.isNull(buildTurnStartRecoveryMessage({ materialOutcomes: [] }));
    assert.isNull(
      buildTurnStartRecoveryMessage({
        materialOutcomes: [{ ...unsavedMaterial, status: "saved" }],
      }),
    );
    assert.isNull(buildTurnStartRecoveryMessage({}));
  });

  it("names a batch the conversation can continue at its own item", function () {
    const message = buildTurnStartRecoveryMessage({
      resumableBatches: [interruptedBatch],
    });
    assert.exists(message);
    const content = String(message?.content);
    assert.include(content, BATCH_HEADER);
    assert.include(content, BATCH_LINE);
    assert.include(content, BATCH_INSTRUCTION);
    assert.isTrue(
      message?.transient,
      "the rows are read again at every turn start, so the block never persists",
    );
  });

  it("carries unsaved material and resumable batches in one host message", function () {
    const message = buildTurnStartRecoveryMessage({
      materialOutcomes: [unsavedMaterial],
      resumableBatches: [interruptedBatch],
    });
    const content = String(message?.content);
    // Two sections of one message: a second host message would stack another
    // block into every prompt for as long as either stayed outstanding.
    assert.isBelow(
      content.indexOf("Finalized material available (not saved as a note):"),
      content.indexOf(BATCH_HEADER),
    );
    assert.include(content, "documentId=run-1:document:1");
    assert.include(content, BATCH_LINE);
  });

  it("names resumable batches in the interrupted-run recovery note", function () {
    const message = buildInterruptedRunRecoveryMessage({
      run: { runId: "run-3" } as never,
      actions: [],
      resumableBatches: [interruptedBatch],
    });
    const content = String(message.content);
    assert.include(content, BATCH_HEADER);
    assert.include(content, BATCH_LINE);
    assert.include(content, BATCH_INSTRUCTION);
  });
});
