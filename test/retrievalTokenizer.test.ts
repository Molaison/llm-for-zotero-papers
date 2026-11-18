import { assert } from "chai";
import {
  extractCjkKeywordProbes,
  findFirstIndexTermMatch,
  isCjkDominantText,
  LATEX_FORMATTING_COMMANDS,
  MATH_SYMBOL_TOKENS,
  RETRIEVAL_STEM_EXCLUSIONS,
  stripTerminalPunctuation,
  toRetrievalIndexTerm,
  toRetrievalIndexTerms,
  tokenizeRetrievalDiversity,
  tokenizeRetrievalQuery,
  tokenizeRetrievalText,
} from "../src/services/retrieval/retrievalTokenizer";
import { porterStem } from "../src/services/retrieval/porterStemmer";
import {
  buildFixturePdfContext,
  restoreTestGlobals,
  snapshotTestGlobals,
  type TestGlobalSnapshot,
} from "./helpers/retrievalCorpus";

describe("retrievalTokenizer", function () {
  it("preserves academic compounds and indexes their split parts", function () {
    const tokens = tokenizeRetrievalText(
      "Self-supervised p-value β-amyloid IL-6 GPT-4 analysis",
    );

    assert.include(tokens, "self-supervised");
    assert.include(tokens, "self");
    assert.include(tokens, "supervised");
    assert.include(tokens, "p-value");
    assert.include(tokens, "value");
    assert.include(tokens, "β-amyloid");
    assert.include(tokens, "β");
    assert.include(tokens, "amyloid");
    assert.include(tokens, "il-6");
    assert.include(tokens, "il");
    assert.include(tokens, "gpt-4");
    assert.include(tokens, "gpt");
  });

  it("keeps CJK and kana bigrams for languages without whitespace", function () {
    const tokens = tokenizeRetrievalText("神经网络モデル");

    assert.include(tokens, "神经");
    assert.include(tokens, "经网");
    assert.include(tokens, "网络");
    assert.include(tokens, "モデ");
    assert.include(tokens, "デル");
  });

  it("adds Hangul bigrams for Korean text", function () {
    const tokens = tokenizeRetrievalText("표현학습방법");

    assert.include(tokens, "표현");
    assert.include(tokens, "현학");
    assert.include(tokens, "학습");
    assert.include(tokens, "습방");
    assert.include(tokens, "방법");
  });

  it("retains non-English Unicode words", function () {
    const tokens = tokenizeRetrievalText("résumé naïve модель aprendizaje");

    assert.include(tokens, "résumé");
    assert.include(tokens, "naïve");
    assert.include(tokens, "модель");
    assert.include(tokens, "aprendizaje");
  });

  it("filters English stopwords without dropping protected identifiers", function () {
    const tokens = tokenizeRetrievalText("the and with GPT-4 use-case");

    assert.notInclude(tokens, "the");
    assert.notInclude(tokens, "and");
    assert.notInclude(tokens, "with");
    assert.include(tokens, "gpt-4");
    assert.include(tokens, "use-case");
  });

  it("falls query tokenization back to unfiltered tokens when needed", function () {
    assert.deepEqual(tokenizeRetrievalQuery("the"), ["the"]);
  });

  it("maps unicode math operators to word tokens", function () {
    assert.includeMembers(tokenizeRetrievalQuery("why is ∇π singular at ∂ω"), [
      "nabla",
      "partial",
      "singular",
    ]);
    assert.includeMembers(tokenizeRetrievalQuery("the term ∇Δh"), [
      "nabla",
      "delta",
    ]);
    assert.includeMembers(tokenizeRetrievalQuery("why is ∇Δh singular at ∂ω"), [
      "nabla",
      "delta",
      "partial",
      "singular",
    ]);

    for (const [symbol, token] of Object.entries(MATH_SYMBOL_TOKENS)) {
      assert.include(
        tokenizeRetrievalText(`the operator ${symbol} appears twice`),
        token,
        `symbol ${symbol} should tokenize as ${token}`,
      );
    }

    // Plain Greek letters are not operators and keep their own token.
    assert.include(tokenizeRetrievalText("the σ term"), "σ");

    // U+2206 INCREMENT is a different character from Δ and survives NFKC;
    // PDF extraction emits it often.
    assert.include(
      tokenizeRetrievalText("the increment ∆h across the film"),
      "delta",
    );
  });

  it("keeps Greek-letter compounds intact instead of rewriting them", function () {
    const tokens = tokenizeRetrievalText("δ-opioid receptor binding");

    assert.include(tokens, "δ-opioid");
    assert.include(tokens, "opioid");
  });

  it("keeps semantic LaTeX commands and drops formatting commands", function () {
    const tokens = tokenizeRetrievalText(
      "$\\dot{\\mathbf{x}} = (m/h)\\nabla\\Delta h$ with $\\mathrm{d}\\gamma$",
    );

    assert.includeMembers(tokens, ["nabla", "delta", "dot", "m/h"]);
    assert.notInclude(tokens, "mathbf");
    assert.notInclude(tokens, "mathrm");
    assert.include(tokens, "gamma");

    for (const command of LATEX_FORMATTING_COMMANDS) {
      const wrapped = tokenizeRetrievalText(
        `inline \\${command}{argument} tail`,
      );
      assert.notInclude(wrapped, command, `\\${command} should be dropped`);
      assert.include(
        wrapped,
        "argument",
        `\\${command} should keep its argument`,
      );
    }
  });

  it("uses multilingual tokens for diversity overlap", function () {
    const first = tokenizeRetrievalDiversity(
      "이 논문은 표현학습 방법을 제안한다",
    );
    const second = tokenizeRetrievalDiversity("표현학습 접근법을 비교한다");

    assert.isTrue(first.has("표현"));
    assert.isTrue(first.has("학습"));
    assert.isTrue(second.has("표현"));
    assert.isTrue(second.has("학습"));
  });
});

describe("quicksearch probe helpers", function () {
  it("strips trailing fullwidth and ascii terminal punctuation", function () {
    assert.equal(
      stripTerminalPunctuation("哪些论文讨论了神经形态计算？"),
      "哪些论文讨论了神经形态计算",
    );
    assert.equal(
      stripTerminalPunctuation("What methods do they use?  "),
      "What methods do they use",
    );
    assert.equal(stripTerminalPunctuation("GPT-4: a study."), "GPT-4: a study");
    assert.equal(
      stripTerminalPunctuation("表現学習とは何か。"),
      "表現学習とは何か",
    );
  });

  it("detects CJK-dominant text", function () {
    assert.isTrue(isCjkDominantText("这些论文讨论了什么方法"));
    assert.isTrue(isCjkDominantText("使用GPT-4的论文"));
    assert.isFalse(isCjkDominantText("calcium imaging analysis"));
    assert.isFalse(isCjkDominantText("A GPT-4 study of neural imaging (中文)"));
  });

  it("segments a CJK question into keyword probes instead of one sentence", function () {
    const question = "这些论文中哪些讨论了神经形态计算";
    const probes = extractCjkKeywordProbes(question);

    assert.isAbove(probes.length, 1);
    for (const probe of probes) {
      assert.isAtLeast(probe.length, 2);
      assert.isBelow(probe.length, question.length);
      assert.notMatch(probe, /[？?]/);
    }
    assert.isTrue(
      probes.some((probe) => probe.includes("计算") || probe.includes("形态")),
    );
  });

  it("keeps protected compounds intact in CJK probes", function () {
    const probes = extractCjkKeywordProbes("使用GPT-4的脑机接口研究");

    assert.include(probes, "gpt-4");
  });

  it("caps the probe count", function () {
    const probes = extractCjkKeywordProbes(
      "神经形态计算与脉冲神经网络在类脑芯片中的应用研究进展综述",
      3,
    );

    assert.lengthOf(probes, 3);
  });
});

describe("retrieval tokenizer over the chunk index", function () {
  let globalsBefore: TestGlobalSnapshot;

  before(function () {
    globalsBefore = snapshotTestGlobals();
  });

  after(function () {
    restoreTestGlobals(globalsBefore);
  });

  it("indexes an equation-dense chunk with operator tokens and no formatting noise", async function () {
    const ctx = await buildFixturePdfContext("mathDoubleHash", 9301);
    const chunkIndex = ctx.chunkMeta.findIndex((meta) =>
      meta.text.includes("kinematic relation between the film height"),
    );
    assert.isAtLeast(chunkIndex, 0, "section 2.2 chunk not found");

    const tf = ctx.chunkStats[chunkIndex]?.tf || {};
    assert.isAbove(tf["nabla"] || 0, 0, "section 2.2 chunk should index nabla");
    assert.isAbove(
      tf["partial"] || 0,
      0,
      "section 2.2 chunk should index partial",
    );
    for (const command of ["mathbf", "operatorname", "quad", "qquad", "text"]) {
      assert.isUndefined(
        tf[command],
        `LaTeX formatting token ${command} should not be indexed`,
      );
    }
  });
});

describe("porterStem", function () {
  // Porter (1980)'s own examples, run through the whole algorithm as in his
  // reference implementation's vocabulary and output files.
  const CLASSIC: Record<string, string> = {
    caresses: "caress",
    ponies: "poni",
    ties: "ti",
    caress: "caress",
    cats: "cat",
    feed: "feed",
    agreed: "agre",
    disabled: "disabl",
    matting: "mat",
    mating: "mate",
    meeting: "meet",
    milling: "mill",
    messing: "mess",
    meetings: "meet",
    plastered: "plaster",
    bled: "bled",
    motoring: "motor",
    sing: "sing",
    conflated: "conflat",
    troubled: "troubl",
    sized: "size",
    hopping: "hop",
    tanned: "tan",
    falling: "fall",
    hissing: "hiss",
    fizzed: "fizz",
    failing: "fail",
    filing: "file",
    happy: "happi",
    sky: "sky",
    relational: "relat",
    conditional: "condit",
    rational: "ration",
    valenci: "valenc",
    hesitanci: "hesit",
    digitizer: "digit",
    conformabli: "conform",
    radicalli: "radic",
    differentli: "differ",
    vileli: "vile",
    analogousli: "analog",
    vietnamization: "vietnam",
    predication: "predic",
    operator: "oper",
    feudalism: "feudal",
    decisiveness: "decis",
    hopefulness: "hope",
    callousness: "callous",
    formaliti: "formal",
    sensitiviti: "sensit",
    sensibiliti: "sensibl",
    triplicate: "triplic",
    formative: "form",
    formalize: "formal",
    electriciti: "electr",
    electrical: "electr",
    hopeful: "hope",
    goodness: "good",
    revival: "reviv",
    allowance: "allow",
    inference: "infer",
    airliner: "airlin",
    gyroscopic: "gyroscop",
    adjustable: "adjust",
    defensible: "defens",
    irritant: "irrit",
    replacement: "replac",
    adjustment: "adjust",
    dependent: "depend",
    adoption: "adopt",
    homologou: "homolog",
    communism: "commun",
    activate: "activ",
    angulariti: "angular",
    homologous: "homolog",
    effective: "effect",
    bowdlerize: "bowdler",
    probate: "probat",
    rate: "rate",
    cease: "ceas",
    controll: "control",
    roll: "roll",
    generalizations: "gener",
    oscillators: "oscil",
    connection: "connect",
    connected: "connect",
    connecting: "connect",
    connections: "connect",
    // The reference implementation's two departures from the paper.
    possibly: "possibl",
    analogy: "analog",
  };

  it("stems Porter's classic examples", function () {
    const wrong = Object.entries(CLASSIC)
      .map(([word, stem]) => [word, porterStem(word), stem])
      .filter(([, got, want]) => got !== want);
    assert.deepEqual(wrong, []);
  });

  it("leaves words of one or two letters alone", function () {
    for (const word of ["a", "is", "as", "ys"])
      assert.equal(porterStem(word), word);
  });

  it("conflates the inflections retrieval cares about", function () {
    assert.equal(porterStem("errors"), porterStem("error"));
    assert.equal(porterStem("encoding"), porterStem("encode"));
    assert.equal(porterStem("encoded"), porterStem("encodes"));
  });
});

describe("retrieval index terms", function () {
  it("stems plain English words only and keeps compounds, digits, Greek and CJK whole", function () {
    const text =
      "Encoding errors in IL-6 GPT-4 self-supervised models: β 2024 神经网络";
    const surface = tokenizeRetrievalText(text);
    const stemmed = tokenizeRetrievalText(text, { stem: true });
    assert.lengthOf(stemmed, surface.length, "one index term per token");
    assert.deepEqual(stemmed, surface.map(toRetrievalIndexTerm));
    assert.includeMembers(stemmed, [
      "encod",
      "error",
      "il-6",
      "gpt-4",
      "self-supervised",
      "supervis",
      "model",
      "β",
      "2024",
      "神经",
      "网络",
    ]);
    assert.notInclude(stemmed, "errors");
    assert.includeMembers(surface, ["encoding", "errors", "supervised"]);
  });

  it("keeps the tokenizer's operator names and LaTeX notation names whole", function () {
    const stemmed = tokenizeRetrievalText(
      "∇ ∂ Δ ∑ ∫ ∞ $a \\times b$ $\\infty$ $\\cdots$ integral partial",
      { stem: true },
    );
    for (const name of Object.values(MATH_SYMBOL_TOKENS))
      assert.include(stemmed, name);
    assert.includeMembers(stemmed, ["times", "infty", "cdots"]);
    assert.notInclude(stemmed, "time");
    assert.notInclude(stemmed, "integr");
    for (const name of RETRIEVAL_STEM_EXCLUSIONS)
      assert.equal(toRetrievalIndexTerm(name), name, name);
  });

  it("filters stopwords on the surface form, the same with stemming on or off", function () {
    const text = "the errors of these models were being studied";
    assert.deepEqual(tokenizeRetrievalText(text), [
      "errors",
      "these",
      "models",
      "studied",
    ]);
    assert.deepEqual(tokenizeRetrievalText(text, { stem: true }), [
      "error",
      "these",
      "model",
      "studi",
    ]);
  });

  it("leaves the default output unstemmed, as surface-word callers need", function () {
    assert.deepEqual(tokenizeRetrievalQuery("encoding errors"), [
      "encoding",
      "errors",
    ]);
    assert.isTrue(tokenizeRetrievalDiversity("encoding errors").has("errors"));
  });

  it("maps surface terms to distinct index terms in first-seen order", function () {
    assert.deepEqual(
      toRetrievalIndexTerms(["errors", "error", "il-6", "encoding", "encode"]),
      ["error", "il-6", "encod"],
    );
  });

  it("finds the first word that shares an index term, at its surface offsets", function () {
    const text =
      "Results. The Encoder made one ERROR; later encoding errors grew.";
    const hit = findFirstIndexTermMatch(text, ["errors"]);
    assert.isOk(hit);
    assert.equal(text.slice(hit!.start, hit!.end), "ERROR");
    // "Encoder" shares the index term "encod" too, and comes first.
    const encode = findFirstIndexTermMatch(text, ["encoded"]);
    assert.equal(text.slice(encode!.start, encode!.end), "Encoder");
    assert.isNull(findFirstIndexTermMatch(text, ["il-6", "神经"]));
    assert.isNull(findFirstIndexTermMatch(text, ["terror"]));
  });
});
