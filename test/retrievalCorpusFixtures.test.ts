import { assert } from "chai";
import {
  buildFixturePdfContext,
  restoreTestGlobals,
  snapshotTestGlobals,
  type TestGlobalSnapshot,
} from "./helpers/retrievalCorpus";

describe("retrieval corpus fixtures", function () {
  let globalsBefore: TestGlobalSnapshot;

  before(function () {
    globalsBefore = snapshotTestGlobals();
  });

  after(function () {
    restoreTestGlobals(globalsBefore);
  });

  it("builds a MinerU-backed context for the math fixture", async function () {
    const ctx = await buildFixturePdfContext("mathDoubleHash", 9001);
    assert.equal(ctx.sourceType, "mineru");
    assert.isAtLeast(ctx.chunks.length, 10);
    assert.isTrue(
      ctx.chunks.some((c) =>
        c.includes("kinematic relation between the film height"),
      ),
    );
  });

  it("builds a MinerU-backed context for the bio fixture", async function () {
    const ctx = await buildFixturePdfContext("bioSingleHash", 9002);
    assert.isAtLeast(ctx.chunks.length, 4);
    assert.include(
      ctx.chunkMeta.map((m) => m.sectionLabel),
      "Results",
    );
  });

  it("labels every chunk of a ##-heading paper from the manifest with a section path", async function () {
    const ctx = await buildFixturePdfContext("mathDoubleHash", 9101);
    const afterFirstHeading = ctx.chunkMeta.filter(
      (m) => (m.sourceStart ?? 0) >= ctx.chunks[0].length,
    );
    assert.isNotEmpty(afterFirstHeading);
    assert.isTrue(
      afterFirstHeading.every(
        (m) => m.sectionLabel && m.sectionPath && m.sectionIndex !== undefined,
      ),
    );
    const kin = ctx.chunkMeta.find((m) =>
      m.text.includes("kinematic relation between the film height"),
    );
    // MinerU marks every section of this paper `##`, so the path is flat.
    assert.equal(kin?.sectionLabel, "2.2 Kinematic condition");
    assert.equal(kin?.sectionPath, "2.2 Kinematic condition");
    assert.equal(kin?.sectionLevel, 2);
    assert.equal(kin?.kindSource, "heuristic");
  });

  it("maps the numbered headings of the math fixture to section kinds", async function () {
    const ctx = await buildFixturePdfContext("mathDoubleHash", 9102);
    const intro = ctx.chunkMeta.find(
      (m) => m.sectionLabel === "1 Introduction and model statement",
    );
    assert.equal(intro?.chunkKind, "introduction");
    assert.equal(intro?.kindSource, "manifest");
    const conclusion = ctx.chunkMeta.find(
      (m) => m.sectionLabel === "5 Conclusion",
    );
    assert.equal(conclusion?.chunkKind, "conclusion");
    assert.equal(conclusion?.kindSource, "manifest");
  });
});
