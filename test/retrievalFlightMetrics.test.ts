import { assert } from "chai";
import { describe, it } from "mocha";

import { summarizeAgentFlight } from "../src/agent/flightMetrics";
import {
  createRetrievalJourneyRig,
  installRetrievalJourneyEnvironment,
  runRetrievalJourney,
  runRetrievalTurn,
} from "./helpers/retrievalJourney";
import { eventsOfType } from "./helpers/materialJourneys";

/**
 * What a repeated read costs inside one run.
 *
 * An agent re-reads a paper it has already read whenever a later step needs
 * the passage again, so the question is not whether repeats happen but what
 * they cost. The journey asks one question of one paper twice and then asks it
 * of a second paper, and the counters sit at the two seams where the work
 * actually happens: the candidate builder the retrieval service ranks with,
 * and the PDF service it ensures paper contexts through.
 *
 * The mechanism under test is the retrieval service's evidence cache. What
 * this file asserts is what the second identical read actually did -- not what
 * it ought to do. If it built candidates again, that is the finding and it
 * belongs in the report, not in a production change.
 */

describe("retrieval flight metrics", function () {
  describe("the journey", function () {
    it("makes three retrieval calls over two papers, one of them a repeat", async function () {
      const run = await runRetrievalJourney();

      const stages = eventsOfType(run.events, "agent_stage").filter(
        (event) => event.stage === "retrieval",
      );
      assert.equal(
        stages.filter((event) => event.status === "started").length,
        3,
        "three retrieval calls must announce the retrieval stage",
      );
      assert.equal(
        stages.filter((event) => event.status === "failed").length,
        0,
        "a failed retrieval call would make every count below meaningless",
      );
      assert.deepEqual(run.modelCalls, [4], "three tool calls plus the answer");
    });

    it("answers the second identical read without building candidates again", async function () {
      const run = await runRetrievalJourney();

      assert.equal(
        run.candidateBuilds,
        2,
        "two papers were read, so exactly two ranking passes should run: the repeat is the evidence cache's job",
      );
    });

    it("ensures the paper context once per call in the tool and once in the service", async function () {
      const run = await runRetrievalJourney();

      // This is also what makes the count above mean something. Read tools may
      // be deduplicated before they execute, and a repeat that never ran would
      // build no candidates for a reason that has nothing to do with the
      // evidence cache. Six ensures over three calls says all three calls ran
      // and both ensure sites were reached, so the saving happened inside
      // retrieveEvidence, after the paper context had already been ensured.
      assert.equal(
        run.paperContextEnsures,
        6,
        "each retrieval call ensures its paper's context twice -- once in the tool's auto-index loop, once inside retrieveEvidence -- and the evidence cache does not shorten that",
      );
    });
  });

  describe("the summary", function () {
    it("reports the repeat and the hit rate it produced", async function () {
      const run = await runRetrievalJourney();

      const summary = summarizeAgentFlight(run.events, {
        modelCalls: run.modelCalls,
        nativeSaves: run.nativeSaves,
        turnEvents: run.turns.map((turn) => turn.events),
        retrievalCounters: {
          candidateBuilds: run.candidateBuilds,
          paperContextEnsures: run.paperContextEnsures,
        },
      });

      assert.deepEqual(summary.retrieval, {
        toolCalls: 3,
        candidateBuilds: 2,
        paperContextEnsures: 6,
        repeatedCallsForSameItem: 1,
        cacheHitRate: 0.33,
      });
      assert.deepEqual(
        summary.toolCallsByStage,
        { retrieval: 3 },
        "the journey does nothing but retrieve",
      );
      assert.equal(
        summary.nativeWrites,
        0,
        "a read-only journey writes nothing",
      );
      assert.isNull(summary.modelCallsPerBatchItem);
    });
  });

  describe("the evidence cache's lifetime", function () {
    it("still answers from cache in a second run on the same service instance", async function () {
      const environment = await installRetrievalJourneyEnvironment();
      try {
        const rig = createRetrievalJourneyRig();

        await runRetrievalTurn({ rig, conversationKey: 882_201 });
        const afterFirstRun = rig.candidateBuilds();
        await runRetrievalTurn({ rig, conversationKey: 882_202 });

        assert.equal(afterFirstRun, 2);
        assert.equal(
          rig.candidateBuilds(),
          2,
          "the evidence cache lives on the service instance, not on the run: a whole second run of the same three reads builds nothing",
        );
      } finally {
        environment.restore();
      }
    });

    it("builds again once the cache is cleared, so the cache is what saved the work", async function () {
      const environment = await installRetrievalJourneyEnvironment();
      try {
        const rig = createRetrievalJourneyRig();

        await runRetrievalTurn({ rig, conversationKey: 882_301 });
        rig.service.clearEvidenceCache();
        await runRetrievalTurn({ rig, conversationKey: 882_302 });

        assert.equal(
          rig.candidateBuilds(),
          4,
          "with the cache cleared the second run pays full price again, which is what proves the saving above came from the cache",
        );
      } finally {
        environment.restore();
      }
    });
  });
});
