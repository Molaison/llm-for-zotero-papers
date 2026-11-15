import { assert } from "chai";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recomputeQaSupport } from "../scripts/recompute-qa-support";

const quote =
  "The fixed day-1 decoder declined from 80% to 62% accuracy by day 10.";

describe("QA support recompute", function () {
  let directory: string | undefined;
  afterEach(async function () {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });
  it("rescores stored reports from their own answer and events", async function () {
    const reportDirectory = await mkdtemp(join(tmpdir(), "qa-recompute-"));
    directory = reportDirectory;
    const stale = {
      tokens: [],
      medianOverlap: null,
      lowOverlapTokens: 3,
      anchorMatchClaim: 0,
      anchorMatchPassage: 0,
    };
    await writeFile(
      join(reportDirectory, "before-1-f1.json"),
      JSON.stringify(
        {
          variant: "before",
          repeat: 1,
          id: "f1",
          elapsedMs: 42,
          answer: `The paper states:\n\n> ${quote} [[quote:q1]]`,
          support: stale,
          grounding: null,
          finalQuoteCitations: 7,
          events: [
            {
              type: "tool_result",
              name: "paper_read",
              ok: true,
              content: { quoteCitations: [{ id: "q1", quoteText: quote }] },
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );
    await writeFile(
      join(reportDirectory, "after-1-f2.json"),
      JSON.stringify(
        {
          variant: "after",
          repeat: 1,
          id: "f2",
          answer:
            "Median accuracy was 84% on day 1 and 85% on day 10 [[quote:q9]].",
          support: { ...stale, lowOverlapTokens: 1 },
          grounding: { sentences: 9, cited: 0 },
          finalQuoteCitations: 0,
          events: [
            {
              type: "tool_result",
              ok: true,
              content: { quoteCitations: [{ id: "q1", quoteText: quote }] },
            },
            {
              type: "final",
              quoteCitations: [
                {
                  id: "q9",
                  quoteText:
                    "Median animal accuracy was 84% on day 1 and 85% on day 10.",
                  anchorMatch: "claim",
                },
              ],
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );
    // A real-library case id has more than one letter; it is still a report.
    await writeFile(
      join(reportDirectory, "after-1-rl2.json"),
      JSON.stringify(
        {
          variant: "after",
          repeat: 1,
          id: "rl2",
          answer: `The paper states:\n\n> ${quote} [[quote:q1]]`,
          support: { ...stale, lowOverlapTokens: 2 },
          grounding: null,
          finalQuoteCitations: 0,
          events: [
            {
              type: "tool_result",
              name: "paper_read",
              ok: true,
              content: { quoteCitations: [{ id: "q1", quoteText: quote }] },
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );
    // Anything that is not a case report must be left alone.
    await writeFile(
      join(reportDirectory, "setup-before-1.json"),
      JSON.stringify({ untouched: true }),
      "utf8",
    );

    assert.deepEqual(await recomputeQaSupport(reportDirectory), [
      "after-1-f2.json: lowOverlapTokens 1 -> 0",
      "after-1-rl2.json: lowOverlapTokens 2 -> 0",
      "before-1-f1.json: lowOverlapTokens 3 -> 0",
    ]);

    const read = async (name: string) =>
      JSON.parse(await readFile(join(reportDirectory, name), "utf8"));
    const first = await read("before-1-f1.json");
    assert.equal(first.support.tokens.length, 1);
    assert.equal(first.support.tokens[0].claimSentence, quote);
    assert.equal(first.support.tokens[0].overlap, 1);
    assert.equal(first.support.lowOverlapTokens, 0);
    // The quoted block is not a sentence of the answer, and the lead-in is too
    // short to count, so this answer has nothing to ground.
    assert.isNull(first.grounding);
    assert.equal(first.finalQuoteCitations, 0);
    assert.equal(first.elapsedMs, 42, "unrelated fields survive");

    const second = await read("after-1-f2.json");
    assert.equal(second.support.tokens.length, 1);
    assert.equal(second.support.tokens[0].id, "q9");
    assert.equal(second.support.anchorMatchClaim, 1);
    assert.deepEqual(second.grounding, { sentences: 1, cited: 1 });
    assert.equal(second.finalQuoteCitations, 1);

    assert.deepEqual(await read("setup-before-1.json"), { untouched: true });
  });
});
