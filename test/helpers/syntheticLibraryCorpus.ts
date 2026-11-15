/**
 * A deterministic library of invented papers for latency benchmarks. No real
 * paper text. Every paper carries two planted facts built from tokens that
 * appear nowhere else in the corpus, so recall can be scored without a model.
 */
export type PlantedFact = {
  query: string;
  paraphrase: string;
  sentence: string;
  sectionLabel: string;
};
export type SyntheticPaper = {
  id: number;
  title: string;
  authors: string[];
  year: string;
  markdown: string;
  contentList: unknown[];
  facts: PlantedFact[];
  mode: "mineru" | "pdf";
  pages: string[];
};
export type SyntheticCorpus = { seed: number; papers: SyntheticPaper[] };
export type BenchQuery = {
  id: string;
  kind: "keyword" | "paraphrase";
  scope: "library" | "collection30";
  query: string;
  relevantPaperId: number;
  sentence: string;
};

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOPICS = [
  "place cell stability",
  "sleep pressure",
  "contact line dynamics",
  "thin film rupture",
  "synaptic tagging",
  "cortical oscillation",
  "drift correction",
  "viscous fingering",
  "grid cell remapping",
  "reward prediction",
  "capillary pinning",
  "dendritic integration",
  "population coding",
  "phase precession",
  "wetting transition",
  "memory consolidation",
  "attractor dynamics",
  "surface tension gradient",
  "spike timing",
  "replay sequence",
];
const VERBS = [
  "reshapes",
  "constrains",
  "predicts",
  "stabilizes",
  "degrades",
  "amplifies",
  "decouples",
  "tracks",
];
const OBJECTS = [
  "field width",
  "burst rate",
  "front velocity",
  "pinning force",
  "decoding error",
  "phase offset",
  "film thickness",
  "trial variance",
];
const SECTIONS = [
  "Abstract",
  "Introduction",
  "Methods",
  "Results",
  "Discussion",
  "Conclusion",
];
const CONSONANTS = "bdfgklmnprstvz";
const VOWELS = "aeiou";

function inventToken(random: () => number, used: Set<string>): string {
  for (;;) {
    let word = "";
    for (let i = 0; i < 3; i += 1) {
      word += CONSONANTS[Math.floor(random() * CONSONANTS.length)];
      word += VOWELS[Math.floor(random() * VOWELS.length)];
    }
    word += "x";
    if (!used.has(word)) {
      used.add(word);
      return word;
    }
  }
}

function paragraph(
  random: () => number,
  topic: string,
  sentences: number,
): string {
  const out: string[] = [];
  for (let i = 0; i < sentences; i += 1) {
    const verb = VERBS[Math.floor(random() * VERBS.length)];
    const object = OBJECTS[Math.floor(random() * OBJECTS.length)];
    const other = TOPICS[Math.floor(random() * TOPICS.length)];
    out.push(
      `We find that ${topic} ${verb} ${object} when ${other} is held fixed across sessions.`,
    );
  }
  return out.join(" ");
}

export function generateSyntheticCorpus(options: {
  papers: number;
  seed?: number;
  pdfShare?: number;
}): SyntheticCorpus {
  const seed = options.seed ?? 7;
  const random = mulberry32(seed);
  const used = new Set<string>();
  const pdfShare = options.pdfShare ?? 0.2;
  const papers: SyntheticPaper[] = [];
  for (let index = 0; index < options.papers; index += 1) {
    const topic = TOPICS[index % TOPICS.length];
    const second = TOPICS[(index * 7 + 3) % TOPICS.length];
    const title = `${topic[0].toUpperCase()}${topic.slice(1)} under ${second}: study ${index + 1}`;
    const facts: PlantedFact[] = [];
    const sectionsText: Record<string, string> = {};
    for (const section of SECTIONS) {
      sectionsText[section] = paragraph(
        random,
        topic,
        section === "Abstract" ? 4 : 12,
      );
    }
    for (const sectionLabel of ["Methods", "Results"]) {
      const noun = inventToken(random, used);
      const adjective = inventToken(random, used);
      const value = (Math.floor(random() * 900) / 100).toFixed(2);
      const sentence = `The ${noun} coefficient was ${value} in the ${adjective} condition.`;
      sectionsText[sectionLabel] += ` ${sentence}`;
      facts.push({
        query: `${noun} coefficient`,
        paraphrase: `what value did the ${noun} measurement give in the ${adjective} setting`,
        sentence,
        sectionLabel,
      });
    }
    const markdown =
      [
        `# ${title}`,
        ...SECTIONS.map((s) => `# ${s}\n\n${sectionsText[s]}`),
      ].join("\n\n") + "\n";
    const contentList = SECTIONS.map((s, i) => ({
      type: "text",
      text: s,
      text_level: 1,
      page_idx: i,
    }));
    const mode: "mineru" | "pdf" = random() < pdfShare ? "pdf" : "mineru";
    const pages = SECTIONS.map((s) => `${s}\n${sectionsText[s]}`);
    papers.push({
      id: index + 1,
      title,
      authors: [`Author${(index % 37) + 1}`, `Coauthor${(index % 11) + 1}`],
      year: String(1995 + (index % 30)),
      markdown,
      contentList,
      facts,
      mode,
      pages,
    });
  }
  return { seed, papers };
}

export function buildBenchQuerySet(corpus: SyntheticCorpus): BenchQuery[] {
  const pick = (paperIndex: number, factIndex: number) => {
    const paper = corpus.papers[paperIndex];
    return { paper, fact: paper.facts[factIndex] };
  };
  const queries: BenchQuery[] = [];
  const libraryKeyword = [5, 41, 77, 120, 233, 380].map(
    (i) => i % corpus.papers.length,
  );
  libraryKeyword.forEach((paperIndex, n) => {
    const { paper, fact } = pick(paperIndex, n % 2);
    queries.push({
      id: `lib-kw-${n + 1}`,
      kind: "keyword",
      scope: "library",
      query: fact.query,
      relevantPaperId: paper.id,
      sentence: fact.sentence,
    });
  });
  [2, 11, 27].forEach((paperIndex, n) => {
    const { paper, fact } = pick(paperIndex, n % 2);
    queries.push({
      id: `col-kw-${n + 1}`,
      kind: "keyword",
      scope: "collection30",
      query: fact.query,
      relevantPaperId: paper.id,
      sentence: fact.sentence,
    });
  });
  [9, 150, 301]
    .map((i) => i % corpus.papers.length)
    .forEach((paperIndex, n) => {
      const { paper, fact } = pick(paperIndex, 1);
      queries.push({
        id: `lib-para-${n + 1}`,
        kind: "paraphrase",
        scope: "library",
        query: fact.paraphrase,
        relevantPaperId: paper.id,
        sentence: fact.sentence,
      });
    });
  return queries;
}
