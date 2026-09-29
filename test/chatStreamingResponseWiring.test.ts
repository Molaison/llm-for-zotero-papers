import { assert } from "chai";
import { describe, it } from "mocha";
import { readFileSync } from "node:fs";

import type { BlockStreamFlushReason } from "../src/modules/contextPanel/blockStreamCoalescer";

/**
 * Integration guards for the retry and send flows in chat.ts.
 *
 * Streaming behavior is exercised directly in streamingResponse.test.ts and
 * blockStreamCoalescer.test.ts. These source checks retain the distinct flow
 * wiring and finalization-order coverage until both live flows can be driven
 * through completion, cancellation, interruption, and retry restoration.
 */

const CHAT_SOURCE_PATH = "src/modules/contextPanel/chat.ts";

/** A flush of the streaming response, whatever object owns it today. */
const FLUSH_CALL = (reason: BlockStreamFlushReason) =>
  new RegExp(`(?:flushResponseStream|\\w+\\.flush)\\("${reason}"\\)`);
/** Reading everything the model streamed, flushed or not. */
const READ_STREAMED_TEXT = /\.(?:getFullText|getStreamedText)\(\)/;
/** Dropping the buffer and refusing later deltas. */
const DISCARD_STREAM = /\.(?:cancel|dispose|rollback)\(\)/;
/** Constructing the per-turn streaming response. */
const CREATE_STREAM =
  /create(?:BlockStreamCoalescer|StreamingResponse)(?:Owner)?\(/;

function readChatSource(): string {
  return readFileSync(CHAT_SOURCE_PATH, "utf8");
}

function sliceBetween(source: string, startMarker: string, endMarker: string) {
  const start = source.indexOf(startMarker);
  assert.isAtLeast(start, 0, `missing marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.isAtLeast(end, 0, `missing marker: ${endMarker}`);
  return source.slice(start, end);
}

function retryFlowSource(source: string): string {
  return sliceBetween(
    source,
    "export async function retryLatestAssistantResponse(",
    "async function detachProviderForEdit(",
  );
}

function sendFlowSource(source: string): string {
  return sliceBetween(
    source,
    "export async function sendQuestion(",
    "function buildInlineEditWidget(",
  );
}

function matchIndex(text: string, pattern: RegExp): number {
  const match = pattern.exec(text);
  return match ? match.index : -1;
}

describe("chat streaming-response wiring", function () {
  describe("flow order", function () {
    it("wires a streaming response in both the retry and the send flow", function () {
      const source = readChatSource();

      assert.match(retryFlowSource(source), CREATE_STREAM);
      assert.match(sendFlowSource(source), CREATE_STREAM);
    });

    it("hands the streaming repaint to the native trace controller in both flows", function () {
      const source = readChatSource();
      const wiring =
        "createCodexNativeActivityTraceController(assistantMessage, queueRefresh)";

      assert.include(retryFlowSource(source), wiring);
      assert.include(sendFlowSource(source), wiring);
    });

    it("flushes the streamed text before the cancelled turn is finalized", function () {
      const source = readChatSource();

      for (const flow of [retryFlowSource(source), sendFlowSource(source)]) {
        const flush = matchIndex(flow, FLUSH_CALL("cancel"));
        const traceFlush = flow.indexOf('flushBufferedProgress("cancel")');
        const finalize = flow.indexOf("finalizeCancelledAssistantMessage(");

        assert.isAtLeast(flush, 0);
        assert.isAtLeast(traceFlush, 0);
        assert.isAtLeast(finalize, 0);
        assert.isBelow(flush, traceFlush);
        assert.isBelow(traceFlush, finalize);
      }
    });

    it("flushes the streamed text before the completed turn is written", function () {
      const source = readChatSource();

      for (const flow of [retryFlowSource(source), sendFlowSource(source)]) {
        const flush = matchIndex(flow, FLUSH_CALL("final"));
        const completion = flow.indexOf(
          "assistantMessage.completionStatus = modelOutcome.completion.status;",
        );

        assert.isAtLeast(flush, 0);
        assert.isAtLeast(completion, 0);
        assert.isBelow(flush, completion);
      }
    });

    it("reads the streamed text before discarding it on the error path", function () {
      const source = readChatSource();

      for (const flow of [retryFlowSource(source), sendFlowSource(source)]) {
        const catchBlock = flow.slice(flow.indexOf("const partialText ="));
        const read = matchIndex(catchBlock, READ_STREAMED_TEXT);
        const discard = matchIndex(catchBlock, DISCARD_STREAM);

        assert.isAtLeast(read, 0);
        assert.isAtLeast(discard, 0);
        assert.isBelow(read, discard);
      }
    });

    it("drops the retry stream before the original turn is restored", function () {
      const source = readChatSource();
      const restore = sliceBetween(
        retryFlowSource(source),
        "const restoreOriginalTurn = () => {",
        "const stopRetryPreparation = () => {",
      );

      const discard = matchIndex(restore, DISCARD_STREAM);
      const snapshot = restore.indexOf("restoreAssistantSnapshot(");

      assert.isAtLeast(discard, 0);
      assert.isAtLeast(snapshot, 0);
      assert.isBelow(discard, snapshot);
    });
  });
});
