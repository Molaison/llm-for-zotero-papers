import { assert } from "chai";
import {
  createLlmBatchAnalyzer,
  readDocumentsExhaustively,
  type ExhaustiveBatchInput,
} from "../src/shared/exhaustiveDocumentReader";
import type { PaperContextRef } from "../src/modules/contextPanel/types";
import type { PdfContext } from "../src/services/paperContent/types";
import { buildChunkMetadata } from "../src/services/paperContent/pdfContext";
import { estimateTextTokens } from "../src/utils/modelInputCap";

function buildPaper(): {
  paperContext: PaperContextRef;
  pdfContext: PdfContext;
} {
  const chunks = Array.from(
    { length: 9 },
    (_, index) => `Section ${index + 1}\nEvidence from chunk ${index}.`,
  );
  return {
    paperContext: {
      itemId: 10,
      contextItemId: 11,
      title: "Coverage Paper",
    },
    pdfContext: {
      title: "Coverage Paper",
      chunks,
      chunkMeta: buildChunkMetadata(chunks),
      chunkStats: [],
      docFreq: {},
      avgChunkLength: 0,
      fullLength: chunks.join("\n\n").length,
    },
  };
}

describe("exhaustiveDocumentReader", function () {
  it("leaves a reasoning model room to think inside each digest's output limit", async function () {
    // DeepSeek at reasoning "high" spent the old fixed 700 tokens thinking,
    // so every batch came back truncated and every retry repeated it.
    const limits: unknown[] = [];
    const analyze = createLlmBatchAnalyzer(
      { model: "reasoner", reasoning: { level: "high" } } as never,
      (async (params: { outputTokenLimit?: unknown }) => {
        limits.push(params.outputTokenLimit);
        return {
          text: '{"digest":"Covered 0","relevantChunkIds":[0]}',
          completion: { status: "complete" },
        };
      }) as never,
    );
    const output = await analyze({
      question: "Summarize",
      chunks: [{ chunkIndex: 0, text: "Body" }],
    } as never);
    assert.equal(output.digest, "Covered 0");
    assert.deepEqual(limits, [{ mode: "custom", tokens: 700 + 4096 }]);
  });

  it("processes every source chunk and returns a complete coverage receipt", async function () {
    const seen = new Set<number>();
    const result = await readDocumentsExhaustively({
      papers: [buildPaper()],
      question: "Read the full text and explain the result.",
      batchTokenBudget: 24,
      finalTokenBudget: 1200,
      analyzeBatch: async (batch: ExhaustiveBatchInput) => {
        for (const chunk of batch.chunks) seen.add(chunk.chunkIndex);
        return {
          digest: `Covered ${batch.chunks.map((chunk) => chunk.chunkIndex).join(",")}`,
          relevantChunkIds: batch.chunks.map((chunk) => chunk.chunkIndex),
        };
      },
    });

    assert.deepEqual(
      [...seen].sort((a, b) => a - b),
      [0, 1, 2, 3, 4, 5, 6, 7, 8],
    );
    assert.equal(result.status, "complete");
    assert.equal(result.receipt.processedChunks, 9);
    assert.equal(result.receipt.totalChunks, 9);
    assert.isTrue(result.receipt.complete);
    assert.include(result.receipt.text, "9/9 chunks");
  });

  it("keeps every batch represented when the synthesis context is compacted", async function () {
    const batchCountPerPaper = 20;
    const buildLongPaper = (
      itemId: number,
      contextItemId: number,
      title: string,
    ): { paperContext: PaperContextRef; pdfContext: PdfContext } => {
      const chunks = Array.from(
        { length: batchCountPerPaper },
        (_, index) => `Chunk ${index} ${"source ".repeat(900)}`,
      );
      return {
        paperContext: { itemId, contextItemId, title },
        pdfContext: {
          title,
          chunks,
          chunkMeta: buildChunkMetadata(chunks),
          chunkStats: [],
          docFreq: {},
          avgChunkLength: chunks[0].length,
          fullLength: chunks.join("\n\n").length,
        },
      };
    };
    const papers = [
      buildLongPaper(30, 31, "First Long Paper"),
      buildLongPaper(40, 41, "Second Long Paper"),
    ];
    const result = await readDocumentsExhaustively({
      papers,
      question: "Read every section.",
      batchTokenBudget: 1024,
      finalTokenBudget: 1024,
      analyzeBatch: async (batch) => ({
        digest: `DIGEST_${batch.paperContext.itemId}_${batch.batchIndex} ${"detail ".repeat(120)}`,
        relevantChunkIds: batch.chunks.map((chunk) => chunk.chunkIndex),
      }),
    });

    assert.equal(result.status, "complete");
    assert.deepEqual(
      result.papers.map((paper) => paper.digests.length),
      [batchCountPerPaper, batchCountPerPaper],
    );
    for (const paper of papers) {
      assert.include(result.contextText, paper.paperContext.title);
      for (
        let batchIndex = 0;
        batchIndex < batchCountPerPaper;
        batchIndex += 1
      ) {
        assert.include(
          result.contextText,
          `DIGEST_${paper.paperContext.itemId}_${batchIndex}`,
        );
      }
    }
    assert.isAtMost(estimateTextTokens(result.contextText), 1024);
  });

  it("fails honestly when the synthesis budget cannot represent every digest", async function () {
    const batchCount = 120;
    const chunks = Array.from(
      { length: batchCount },
      (_, index) => `Chunk ${index} ${"source ".repeat(20)}`,
    );
    const paperContext: PaperContextRef = {
      itemId: 50,
      contextItemId: 51,
      title: "Oversized Digest Map",
    };
    const pdfContext: PdfContext = {
      title: paperContext.title,
      chunks,
      chunkMeta: buildChunkMetadata(chunks),
      chunkStats: [],
      docFreq: {},
      avgChunkLength: chunks[0].length,
      fullLength: chunks.join("\n\n").length,
    };

    let error: unknown;
    try {
      await readDocumentsExhaustively({
        papers: [{ paperContext, pdfContext }],
        question: "Read every section.",
        batchTokenBudget: 1,
        finalTokenBudget: 256,
        analyzeBatch: async (batch) => ({
          digest: `DIGEST_${batch.batchIndex}`,
          relevantChunkIds: [],
        }),
      });
    } catch (caught) {
      error = caught;
    }

    assert.instanceOf(error, Error);
    assert.include(
      (error as Error).message,
      "too small to preserve its coverage receipt and every batch digest",
    );
  });

  it("reports failed batches instead of claiming full coverage", async function () {
    let calls = 0;
    const result = await readDocumentsExhaustively({
      papers: [buildPaper()],
      question: "Read everything.",
      batchTokenBudget: 24,
      finalTokenBudget: 1200,
      retryCount: 0,
      analyzeBatch: async (batch) => {
        calls += 1;
        if (calls === 2) throw new Error("synthetic failure");
        return {
          digest: `Covered ${batch.batchIndex}`,
          relevantChunkIds: [],
        };
      },
    });

    assert.equal(result.status, "partial");
    assert.isFalse(result.receipt.complete);
    assert.isBelow(result.receipt.processedChunks, result.receipt.totalChunks);
    assert.isNotEmpty(result.receipt.missingChunkRanges);
  });

  it("retries failed batches and rejects model-invented chunk IDs", async function () {
    const attempts = new Map<number, number>();
    const result = await readDocumentsExhaustively({
      papers: [buildPaper()],
      question: "Read everything.",
      batchTokenBudget: 24,
      finalTokenBudget: 1200,
      retryCount: 1,
      analyzeBatch: async (batch) => {
        const attempt = (attempts.get(batch.batchIndex) || 0) + 1;
        attempts.set(batch.batchIndex, attempt);
        if (batch.batchIndex === 0 && attempt === 1) {
          throw new Error("transient failure");
        }
        return {
          digest: `Covered ${batch.batchIndex}`,
          relevantChunkIds: [batch.chunks[0].chunkIndex, 99999],
        };
      },
    });

    assert.equal(result.status, "complete");
    assert.equal(attempts.get(0), 2);
    assert.notInclude(
      result.papers[0].exactEvidence.map((chunk) => chunk.chunkIndex),
      99999,
    );
  });

  it("reports unreadable papers independently in a multi-paper receipt", async function () {
    const readable = buildPaper();
    const unreadable = {
      paperContext: {
        itemId: 20,
        contextItemId: 21,
        title: "Unreadable Paper",
      },
    };
    const result = await readDocumentsExhaustively({
      papers: [readable, unreadable],
      question: "Read all selected papers.",
      batchTokenBudget: 24,
      finalTokenBudget: 1200,
      analyzeBatch: async (batch) => ({
        digest: `Covered ${batch.batchIndex}`,
        relevantChunkIds: [],
      }),
    });

    assert.equal(result.status, "partial");
    assert.deepEqual(
      result.papers.map((paper) => paper.status),
      ["complete", "unreadable"],
    );
    assert.equal(result.receipt.completePaperCount, 1);
    assert.equal(result.receipt.paperCount, 2);
    assert.deepEqual(result.papers[1].missingChunkRanges, [
      "no extractable text",
    ]);
    assert.deepEqual(result.receipt.missingChunkRanges, [
      "Unreadable Paper: no extractable text",
    ]);
    assert.include(
      result.receipt.text,
      "Missing coverage: Unreadable Paper: no extractable text",
    );
    assert.include(
      result.contextText,
      "Missing coverage: Unreadable Paper: no extractable text",
    );
  });

  it("stops immediately when exhaustive reading is cancelled", async function () {
    const controller = new AbortController();
    let calls = 0;
    let error: unknown;
    try {
      await readDocumentsExhaustively({
        papers: [buildPaper()],
        question: "Read everything.",
        batchTokenBudget: 24,
        finalTokenBudget: 1200,
        signal: controller.signal,
        analyzeBatch: async () => {
          calls += 1;
          controller.abort();
          throw new Error("cancelled");
        },
      });
    } catch (caught) {
      error = caught;
    }

    assert.equal(calls, 1);
    assert.instanceOf(error, Error);
    assert.equal((error as Error).message, "cancelled");
  });
});
