import { assert } from "chai";
import {
  SECTION_INTENT_EXAMPLES,
  SECTION_INTENT_MARGIN,
  createSectionIntent,
} from "../src/services/retrieval/sectionIntent";
import {
  chunkKindFromSectionLabel,
  compareEvidenceCandidatesForSections,
  type EvidenceSectionKind,
} from "../src/shared/libraryChatEvidencePolicy";

const METHODS_ZH = "这些论文用了什么方法？";
const MIXED_ZH = "这些论文的方法和结果分别是什么？";
const GENERAL_ZH = "这些论文讲了什么？";
const UNRELATED_ZH = "把这段话翻译成英文";

/**
 * A fake embedding model. Axes: the three section intents, "a question
 * about papers", an off-topic axis, a Chinese axis every Chinese text
 * carries (the cross-lingual gap), and an axis every text shares with
 * weight `baseline` (models whose unrelated texts still score high
 * cosines). The geometry is assumed, not measured: it shows how the
 * decision rule behaves, not where a real model's similarities fall.
 */
function fakeModel(baseline: number) {
  const vectors = new Map<string, number[]>();
  const put = (texts: readonly string[], axes: number[]) => {
    for (const text of texts) vectors.set(text, [...axes, baseline]);
  };
  put(SECTION_INTENT_EXAMPLES.methods, [1, 0, 0, 0.4, 0, 0]);
  put(SECTION_INTENT_EXAMPLES.results, [0, 1, 0, 0.4, 0, 0]);
  put(SECTION_INTENT_EXAMPLES.limitations, [0, 0, 1, 0.4, 0, 0]);
  put(SECTION_INTENT_EXAMPLES.general, [0, 0, 0, 1, 0, 0]);
  put([METHODS_ZH], [0.7, 0, 0, 0.35, 0, 1]);
  put([MIXED_ZH], [0.6, 0.6, 0, 0.3, 0, 1]);
  put([GENERAL_ZH], [0, 0, 0, 0.8, 0, 1]);
  put([UNRELATED_ZH], [0, 0, 0, 0.1, 1, 1]);
  const calls: string[][] = [];
  return {
    calls,
    vectorOf: (text: string) => vectors.get(text)!,
    embed: async (texts: string[]) => {
      calls.push(texts);
      return texts.map((text) => {
        const vector = vectors.get(text);
        if (!vector) throw new Error(`unexpected text: ${text}`);
        return vector;
      });
    },
  };
}

function cosine(a: readonly number[], b: readonly number[]): number {
  const dot = a.reduce((sum, value, index) => sum + value * b[index], 0);
  const norm = (v: readonly number[]) =>
    Math.sqrt(v.reduce((sum, value) => sum + value * value, 0));
  return dot / (norm(a) * norm(b));
}

/** Two equally relevant chunks; the introduction comes first in the paper. */
function rankedSections(kinds: EvidenceSectionKind[]): string[] {
  return ["Introduction", "Methods"]
    .map((sectionLabel, index) => ({
      sectionLabel,
      chunkKind: chunkKindFromSectionLabel(sectionLabel),
      chunkIndex: index,
      score: 0.5,
    }))
    .sort(compareEvidenceCandidatesForSections(kinds, (row) => row.score))
    .map((row) => row.sectionLabel);
}

describe("section intent from a question embedding", function () {
  for (const [model, baseline] of [
    ["a low-baseline model", 0],
    ["a high-baseline model", 2],
  ] as const) {
    describe(`with ${model}`, function () {
      async function wanted(question: string) {
        const fake = fakeModel(baseline);
        const intent = createSectionIntent(fake.embed);
        return intent.wantedSections({
          question,
          questionEmbedding: fake.vectorOf(question),
          modelKey: "fake:model",
        });
      }

      it("steers a Chinese methods question to methods", async function () {
        const kinds = await wanted(METHODS_ZH);
        assert.deepEqual(kinds, ["methods"]);
        assert.deepEqual(rankedSections(kinds), ["Methods", "Introduction"]);
      });

      it("names both sections of a question that asks for two", async function () {
        assert.deepEqual(await wanted(MIXED_ZH), ["methods", "results"]);
      });

      it("leaves a general or unrelated question to the cue words and the base order", async function () {
        for (const question of [GENERAL_ZH, UNRELATED_ZH]) {
          const kinds = await wanted(question);
          assert.deepEqual(kinds, [], question);
          assert.deepEqual(rankedSections(kinds), ["Introduction", "Methods"]);
        }
      });
    });
  }

  it("needs a margin over general questions, because no one cosine threshold fits both models", function () {
    const best = (baseline: number, question: string) => {
      const fake = fakeModel(baseline);
      const q = fake.vectorOf(question);
      const closest = (texts: readonly string[]) =>
        Math.max(...texts.map((text) => cosine(q, fake.vectorOf(text))));
      const kinds = Math.max(
        closest(SECTION_INTENT_EXAMPLES.methods),
        closest(SECTION_INTENT_EXAMPLES.results),
        closest(SECTION_INTENT_EXAMPLES.limitations),
      );
      return {
        kinds,
        margin: kinds - closest(SECTION_INTENT_EXAMPLES.general),
      };
    };
    // The unrelated question sits closer to a section under the high-baseline
    // model than the methods question does under the low-baseline one, so
    // any absolute threshold misfires on one of the two models.
    assert.isAbove(best(2, UNRELATED_ZH).kinds, best(0, METHODS_ZH).kinds);
    // The margin over the general questions separates them under both, and
    // shrinks as the baseline rises, so it is set low: a missed intent only
    // falls back to the cue words, today's behaviour.
    for (const baseline of [0, 2]) {
      assert.isAtLeast(
        best(baseline, METHODS_ZH).margin,
        SECTION_INTENT_MARGIN,
      );
      assert.isBelow(best(baseline, UNRELATED_ZH).margin, 0);
      assert.isBelow(best(baseline, GENERAL_ZH).margin, 0);
    }
  });

  it("keeps an English cue question on its cue words without embedding anything", async function () {
    const fake = fakeModel(0);
    const intent = createSectionIntent(fake.embed);
    assert.deepEqual(
      await intent.wantedSections({
        question: "Compare the methods",
        questionEmbedding: fake.vectorOf(UNRELATED_ZH),
        modelKey: "fake:model",
      }),
      ["methods"],
    );
    assert.deepEqual(fake.calls, []);
  });

  it("falls back to the cue words without a question embedding", async function () {
    const fake = fakeModel(0);
    const intent = createSectionIntent(fake.embed);
    assert.deepEqual(
      await intent.wantedSections({
        question: METHODS_ZH,
        modelKey: "fake:model",
      }),
      [],
    );
    assert.deepEqual(fake.calls, []);
  });

  it("embeds the examples once per embedding model, and remembers a failure", async function () {
    const fake = fakeModel(0);
    const intent = createSectionIntent(fake.embed);
    const ask = (modelKey: string) =>
      intent.wantedSections({
        question: METHODS_ZH,
        questionEmbedding: fake.vectorOf(METHODS_ZH),
        modelKey,
      });
    assert.deepEqual(await ask("fake:one"), ["methods"]);
    assert.deepEqual(await ask("fake:one"), ["methods"]);
    assert.deepEqual(await ask("fake:two"), ["methods"]);
    assert.lengthOf(fake.calls, 2, "one example batch per model");
    assert.sameMembers(fake.calls[0], [
      ...SECTION_INTENT_EXAMPLES.methods,
      ...SECTION_INTENT_EXAMPLES.results,
      ...SECTION_INTENT_EXAMPLES.limitations,
      ...SECTION_INTENT_EXAMPLES.general,
    ]);

    let failures = 0;
    const failing = createSectionIntent(async () => {
      failures += 1;
      throw new Error("embedding endpoint down");
    });
    for (let turn = 0; turn < 2; turn += 1) {
      assert.deepEqual(
        await failing.wantedSections({
          question: METHODS_ZH,
          questionEmbedding: fake.vectorOf(METHODS_ZH),
          modelKey: "fake:one",
        }),
        [],
      );
    }
    assert.equal(
      failures,
      1,
      "a failed example batch is not retried each turn",
    );
  });
});
