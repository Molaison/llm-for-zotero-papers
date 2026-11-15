import { assert } from "chai";
import {
  buildFixturePdfContext,
  loadRetrievalCorpusFixture,
  measureCorpus,
  restoreTestGlobals,
  snapshotTestGlobals,
  type CorpusName,
  type TestGlobalSnapshot,
} from "./helpers/retrievalCorpus";
import type { PaperContextRef } from "../src/modules/contextPanel/types";

/**
 * Structure benchmark. The numbers describe how the shipped retrieval path
 * labels and ranks the chunks of a `##`-heading maths paper and a `#`-heading
 * life-science paper. Milestone 0 recorded them as a baseline; task 2.2 turned
 * them into thresholds. The printed values still matter: they are the record of
 * how far above the floor the current pipeline sits.
 */
const ATTACHMENT_IDS: Record<CorpusName, number> = {
  mathDoubleHash: 9201,
  bioSingleHash: 9202,
};

function fixturePaperRef(attachmentId: number): PaperContextRef {
  return {
    itemId: 100,
    contextItemId: attachmentId,
    title: "Mock",
    firstCreator: "Tester",
    year: "2026",
  };
}

describe("retrieval structure benchmark", function () {
  this.timeout(120000);

  let globalsBefore: TestGlobalSnapshot;

  before(function () {
    globalsBefore = snapshotTestGlobals();
  });

  after(function () {
    restoreTestGlobals(globalsBefore);
  });

  for (const name of ["mathDoubleHash", "bioSingleHash"] as CorpusName[]) {
    it(`meets the structure thresholds for ${name}`, async function () {
      const attachmentId = ATTACHMENT_IDS[name];
      const ctx = await buildFixturePdfContext(name, attachmentId);
      const metrics = await measureCorpus(ctx, fixturePaperRef(attachmentId), {
        fullMarkdown: loadRetrievalCorpusFixture(name).md,
      });
      console.log(`${name} ${JSON.stringify(metrics)}`);

      // Every corpus: the label must name the enclosing heading, and a
      // chunk's own text must retrieve that chunk — the floor that the loose
      // reference heuristic used to break on author-year papers.
      assert.isAtLeast(metrics.labelAccuracy ?? 0, 0.95, "labelAccuracy");
      assert.isAtLeast(metrics.selfRetrievalTop1, 0.5, "selfRetrievalTop1");
      if (name !== "mathDoubleHash") return;

      assert.isAtLeast(metrics.labelCoverage, 0.95, "labelCoverage");
      assert.isAtLeast(metrics.selfRetrievalTop1, 0.7, "selfRetrievalTop1");
      assert.isAtMost(metrics.conclusionFirstCount, 1, "conclusionFirstCount");

      // A query that matches nothing must spread across the document instead of
      // returning chunk-index order.
      const sections = new Set(
        metrics.nonsenseQueryChunkIndexes.map(
          (chunkIndex) => ctx.chunkMeta[chunkIndex]?.sectionIndex ?? -1,
        ),
      );
      assert.isAtLeast(
        sections.size,
        4,
        `nonsense query covers ${sections.size} sections`,
      );
    });
  }
});
