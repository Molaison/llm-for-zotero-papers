import { assert } from "chai";
import { createRetrieveServiceRig } from "./helpers/libraryRetrieveRig";
import { setAppLogSinkForTests, type AppLogLevel } from "../src/core/logging";

describe("library retrieve fallback cheap wins", function () {
  it("passes one precomputed query embedding to every candidate build", async function () {
    const rig = createRetrieveServiceRig({
      papers: 4,
      semantic: true,
      queryEmbedding: [0.1, 0.2],
    });
    await rig.service.retrieve({
      query: "method",
      depth: "evidence",
      methods: ["metadata", "fts", "semantic"],
    });
    assert.equal(rig.embeddingCalls(), 1, "query embedded once, not per paper");
    assert.isAbove(rig.candidateBuildCalls().length, 1);
    for (const call of rig.candidateBuildCalls()) {
      assert.deepEqual(call.options.precomputedQueryEmbedding, [0.1, 0.2]);
      assert.deepEqual(call.apiOverrides.precomputedQueryEmbedding, [0.1, 0.2]);
    }
  });

  it("does not retry a failed query embedding once per paper", async function () {
    const rig = createRetrieveServiceRig({
      papers: 4,
      semantic: true,
      queryEmbeddingFails: true,
    });
    const emitted: Array<{ level: AppLogLevel; args: readonly unknown[] }> = [];
    setAppLogSinkForTests((level, args) => emitted.push({ level, args }));
    try {
      await rig.service.retrieve({
        query: "method",
        depth: "evidence",
        methods: ["metadata", "fts", "semantic"],
      });
    } finally {
      setAppLogSinkForTests(null);
    }
    const warns = emitted.filter((entry) => entry.level === "warn");
    assert.lengthOf(warns, 1, "one warning for the failed query embedding");
    assert.match(String(warns[0].args[0]), /Query embedding failed/);
    assert.equal(rig.embeddingCalls(), 1);
    assert.isAbove(rig.candidateBuildCalls().length, 1);
    for (const call of rig.candidateBuildCalls()) {
      // An empty vector is the builder's "no query embedding" signal: it
      // ranks by BM25 alone instead of embedding the query again.
      assert.deepEqual(call.options.precomputedQueryEmbedding, []);
    }
  });

  it("spends no embedding call when semantic search is off", async function () {
    const rig = createRetrieveServiceRig({
      papers: 3,
      semantic: false,
      queryEmbedding: [0.1, 0.2],
    });
    await rig.service.retrieve({
      query: "method",
      depth: "evidence",
      methods: ["metadata", "fts", "semantic"],
    });
    assert.equal(rig.embeddingCalls(), 0);
    assert.isAbove(rig.candidateBuildCalls().length, 0);
    for (const call of rig.candidateBuildCalls()) {
      assert.isUndefined(call.options.precomputedQueryEmbedding);
    }
  });

  it("spends no embedding call when the semantic method is not requested", async function () {
    const rig = createRetrieveServiceRig({
      papers: 3,
      semantic: true,
      queryEmbedding: [0.1, 0.2],
    });
    await rig.service.retrieve({
      query: "method",
      depth: "evidence",
      methods: ["metadata", "fts"],
    });
    assert.equal(rig.embeddingCalls(), 0);
  });

  // One quicksearch probe per effective query, so the probe count comes from
  // caller-provided variants (which also keep the query planner offline).
  const PROBE_VARIANTS = [
    "alpha",
    "beta",
    "gamma",
    "delta",
    "epsilon",
    "zeta",
    "eta",
  ];

  it("runs quicksearch probes with at most four in flight", async function () {
    const rig = createRetrieveServiceRig({ papers: 2, quicksearchDelayMs: 5 });
    await rig.service.retrieve({
      query: "alpha beta gamma delta epsilon zeta eta theta",
      queryVariants: PROBE_VARIANTS,
      depth: "evidence",
    });
    assert.isAbove(rig.quicksearchCalls(), 4);
    // Eight probes, limit four, uniform delay: exactly four in flight.
    assert.equal(rig.maxConcurrentQuicksearch(), 4);
  });

  it("merges parallel probe matches in probe order, whatever order they answer in", async function () {
    const query = "alpha beta gamma delta epsilon zeta eta theta";
    const run = async (delayFor: (query: string) => number) => {
      const rig = createRetrieveServiceRig({
        papers: 2,
        unmatchedMetadata: true,
        quicksearchItemIds: () => [10],
        quicksearchDelayMs: delayFor,
      });
      const result = await rig.service.retrieve({
        query,
        queryVariants: PROBE_VARIANTS,
        depth: "evidence",
      });
      return { result, probes: rig.quicksearchQueries() };
    };
    const probeOrder = (await run(() => 0)).probes;
    assert.isAbove(probeOrder.length, 4);
    const rank = (probe: string) => probeOrder.indexOf(probe);
    // Earliest probes answer last, then first.
    const slowFirst = await run(
      (probe) => (probeOrder.length - rank(probe)) * 4,
    );
    const fastFirst = await run((probe) => rank(probe) * 4);
    const variantsOf = (result: typeof slowFirst.result) =>
      JSON.stringify(
        result.paperMatches.map((match) => [
          match.itemId,
          match.matchedQueryVariants,
        ]),
      );
    assert.equal(variantsOf(slowFirst.result), variantsOf(fastFirst.result));
    assert.include(variantsOf(slowFirst.result), probeOrder[0]);
  });
});
