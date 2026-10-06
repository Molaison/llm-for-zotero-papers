import { assert } from "chai";
import {
  buildBenchQuerySet,
  generateSyntheticCorpus,
} from "./helpers/syntheticLibraryCorpus";

describe("synthetic library corpus", function () {
  it("is deterministic for a seed and distinct across papers", function () {
    const a = generateSyntheticCorpus({ papers: 40, seed: 7 });
    const b = generateSyntheticCorpus({ papers: 40, seed: 7 });
    assert.deepEqual(
      a.papers.map((p) => p.markdown),
      b.papers.map((p) => p.markdown),
    );
    assert.equal(new Set(a.papers.map((p) => p.title)).size, 40);
    assert.notEqual(
      generateSyntheticCorpus({ papers: 40, seed: 8 }).papers[0].markdown,
      a.papers[0].markdown,
    );
  });

  it("plants two facts per paper whose tokens occur in no other paper", function () {
    const corpus = generateSyntheticCorpus({ papers: 60, seed: 7 });
    for (const paper of corpus.papers) {
      assert.equal(paper.facts.length, 2);
      for (const fact of paper.facts) {
        assert.include(paper.markdown, fact.sentence);
        const token = fact.query.split(" ")[0];
        const others = corpus.papers.filter(
          (p) => p.id !== paper.id && p.markdown.includes(token),
        );
        assert.lengthOf(
          others,
          0,
          `${token} leaks into ${others.map((p) => p.id).join(",")}`,
        );
      }
    }
  });

  it("writes 20% of papers as plain PDFs with page text and the rest as MinerU markdown with headings", function () {
    const corpus = generateSyntheticCorpus({ papers: 50, seed: 7 });
    const pdf = corpus.papers.filter((p) => p.mode === "pdf");
    assert.closeTo(pdf.length, 10, 3);
    assert.isAbove(pdf[0].pages.length, 2);
    const mineru = corpus.papers.find((p) => p.mode === "mineru")!;
    assert.match(mineru.markdown, /^# .+\n\n# Abstract\n/);
    assert.isAtLeast((mineru.markdown.match(/^# /gm) || []).length, 7);
    assert.isAbove(mineru.markdown.length, 6000);
  });

  it("builds a twelve-query bench set: six library keyword, three collection keyword, three paraphrase", function () {
    const corpus = generateSyntheticCorpus({ papers: 100, seed: 7 });
    const queries = buildBenchQuerySet(corpus);
    assert.lengthOf(queries, 12);
    assert.lengthOf(
      queries.filter((q) => q.kind === "keyword" && q.scope === "library"),
      6,
    );
    assert.lengthOf(
      queries.filter((q) => q.kind === "keyword" && q.scope === "collection30"),
      3,
    );
    assert.lengthOf(
      queries.filter((q) => q.kind === "paraphrase"),
      3,
    );
    for (const q of queries.filter((q) => q.scope === "collection30")) {
      assert.isBelow(
        corpus.papers.findIndex((p) => p.id === q.relevantPaperId),
        30,
      );
    }
  });
});
