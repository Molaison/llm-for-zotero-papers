/** Questions addressed to the user's own library.
 *
 * These cases are only meaningful against a snapshot of the real Zotero data
 * directory (`LLM_FOR_ZOTERO_QA_DATA_SNAPSHOT`): the harness creates nothing
 * and erases nothing, so every collection and paper named here must already
 * exist in that snapshot. Evidence fragments are chosen by reading the source
 * before the flight, exactly as for the authored corpus.
 */
export type RealCase = {
  id: string;
  category:
    | "clarification"
    | "factual"
    | "synthesis"
    | "verification"
    | "reasoning";
  question: string;
  provided?: string;
  /** Exact source fragments selected independently of retrieval. */
  evidence: string[];
  rubric: string[];
  /** How the turn is addressed: one named collection, the whole library, or
   * one paper. A real library repeats titles, so `paperItemId` names the item
   * outright when the title alone is ambiguous. */
  scope:
    | { collectionName: string }
    | { library: true }
    | { paperTitle: string; paperItemId?: number };
  history?: Array<{ role: "user" | "assistant"; content: string }>;
};

/** Real-data cases for the user's zotero-dev snapshot. Evidence fragments are
 * verbatim from the MinerU caches of the named papers; judged before any run.
 * The collection "Representation_Drift" holds ~130 cached papers. */
const RD = { collectionName: "Representation_Drift" } as const;
const PESCHKA = {
  paperTitle:
    "Numerics of thin-film free boundary problems for partial wetting",
  paperItemId: 4457,
} as const;

export const realCases: RealCase[] = [
  // ---- library scope: one collection of ~130 papers ----
  {
    id: "rl1",
    category: "factual",
    scope: RD,
    question:
      "Which papers in this collection analyze data from the Allen Brain Observatory? Name each paper.",
    evidence: ["Allen Brain Observatory"],
    rubric: [
      "Names 'Representational drift in the mouse visual cortex' (Deitch, Rubin, Ziv) and 'The geometry of representational drift in natural and artificial neural networks'",
      "Does not attribute the dataset to other papers in the collection",
    ],
  },
  {
    id: "rl2",
    category: "factual",
    scope: RD,
    question:
      "In this collection, which paper studied reward expectation and representational drift in hippocampal CA1, and what was its main finding?",
    evidence: ["high reward expectation limited drift"],
    rubric: [
      "Krishnan and Sheffield; high reward expectation limited drift; absence of reward expectation increased drift",
    ],
  },
  {
    id: "rl3",
    category: "synthesis",
    scope: RD,
    question:
      "Across this collection, what explanations are offered for how behaviour stays stable while neural representations drift? Cite the papers you rely on.",
    evidence: [
      "distributed nature of sensorimotor representations permits drift while limiting disruptive effects",
    ],
    rubric: [
      "Mentions distributed or population-level readout, a stable subspace or geometry, or compensation",
      "Attributes each explanation to a named paper",
      "Does not claim drift causes stable behaviour",
    ],
  },
  {
    id: "rl4",
    category: "verification",
    scope: RD,
    question:
      "Does any paper in this collection report measuring blood pressure? Answer yes or no and justify from the sources.",
    evidence: [],
    rubric: [
      "No paper reports measuring blood pressure",
      "If the homeostasis paper is mentioned, blood pressure is identified as an analogy, not a measurement",
    ],
  },
  {
    id: "rl5",
    category: "factual",
    scope: RD,
    question:
      "这个文集里，Deitch 等人关于小鼠视觉皮层表征漂移的论文使用了哪个公开数据集？漂移出现在什么时间尺度上？",
    evidence: ["Allen Brain Observatory", "minutes to days"],
    rubric: ["Allen Brain Observatory; minutes to days"],
  },
  {
    id: "rl6",
    category: "factual",
    scope: RD,
    question:
      "For the paper 'Stable task information from an unstable neural population' in this collection: which brain area was recorded, and what kind of decoder was fitted to each task variable?",
    evidence: ["posterior parietal cortex", "linear decoder"],
    rubric: [
      "Rule et al.; posterior parietal cortex in mice; a linear decoder per task variable (location, heading, velocity)",
    ],
  },
  {
    id: "rl7",
    category: "factual",
    scope: { library: true },
    question:
      "Which papers in my library are about representational drift in the olfactory or piriform cortex? Name them.",
    evidence: [
      "Representational drift in primary olfactory cortex",
      "odor mixture representations in piriform cortex",
    ],
    rubric: [
      "Names 'Representational drift in primary olfactory cortex' and 'Experience-dependent evolution of odor mixture representations in piriform cortex'",
    ],
  },
  {
    id: "rl8",
    category: "reasoning",
    scope: RD,
    question:
      "Based on this collection, why might representational drift not harm behaviour? Separate what the papers state from your own inference.",
    evidence: ["permits drift while limiting disruptive effects"],
    rubric: [
      "Distinguishes stated mechanisms (distributed codes, stable readout, compensation) from inference",
      "Cites at least two papers",
    ],
  },
  // ---- paper scope: real papers from the library ----
  {
    id: "rp1",
    category: "factual",
    scope: {
      paperTitle: "Representational drift in the mouse visual cortex",
      paperItemId: 57,
    },
    question:
      "What dataset does this paper analyze, and over what timescales does it report drift?",
    evidence: ["Allen Brain Observatory", "minutes to days"],
    rubric: [
      "Allen Brain Observatory; minutes to days; across multiple visual areas, cortical layers and cell types",
    ],
  },
  {
    id: "rp2",
    category: "factual",
    scope: {
      paperTitle:
        "Reward Expectation Reduces Representational Drift in the Hippocampus",
      paperItemId: 49,
    },
    question:
      "What did the authors find about the effect of reward expectation on representational drift?",
    evidence: ["high reward expectation limited drift"],
    rubric: [
      "High reward expectation limited drift; representations re-emerged over successive trials the next day; absence of reward expectation increased drift",
    ],
  },
  {
    id: "rp3",
    category: "clarification",
    scope: {
      paperTitle:
        "Reward Expectation Reduces Representational Drift in the Hippocampus",
      paperItemId: 49,
    },
    question: "只根据这句话，作者最初的假设是什么？一句话回答。",
    provided:
      "Memory retrieval is influenced by reward expectation during encoding, so we hypothesized that diminished reward expectation would exacerbate representational drift.",
    evidence: [],
    rubric: [
      "States the hypothesis: lower reward expectation worsens drift; no paper read needed",
    ],
  },
  {
    id: "rp4",
    category: "factual",
    scope: {
      paperTitle: "Stable task information from an unstable neural population",
      paperItemId: 52,
    },
    question:
      "Which brain area was recorded, and what kind of decoder did the authors fit to each task variable?",
    evidence: ["posterior parietal cortex", "linear decoder"],
    rubric: [
      "Posterior parietal cortex in mice; a linear decoder for each task variable (location, heading, velocity)",
    ],
  },
  {
    id: "rp5",
    category: "reasoning",
    scope: {
      paperTitle: "Causes and consequences of representational drift",
      paperItemId: 54,
    },
    question:
      "According to this review, what could drift be for, and what does the review say limits its disruptive effects? Distinguish the review's statements from your own inference.",
    evidence: [
      "recurrent and distributed nature of sensorimotor representations permits drift while limiting disruptive effects",
    ],
    rubric: [
      "Reports the review's stated argument (theoretical work suggests computational roles; recurrent, distributed representations limit disruption)",
      "Labels any added mechanism as inference",
    ],
  },
  {
    id: "rp6",
    category: "verification",
    scope: {
      paperTitle: "Representational drift in the mouse visual cortex",
      paperItemId: 57,
    },
    question:
      "Check this summary against the paper: 'Deitch et al. found that single-neuron responses were stable over days and that drift appeared only at the population level.' Is it accurate?",
    evidence: [
      "Despite the drift at the single-cell level, the relationships between population activity patterns remain stable",
    ],
    rubric: [
      "Rejects the summary: drift is at the single-cell level while population-level relationships remain stable",
    ],
  },
  {
    id: "rp7",
    category: "clarification",
    scope: PESCHKA,
    question:
      "Explain when m(h)/h tends to zero as h tends to zero from above, using only the supplied formula.",
    provided: "m(h)=h^alpha, so m(h)/h=h^(alpha-1).",
    evidence: [],
    rubric: [
      "Zero only for alpha>1; equals 1 for alpha=1; diverges for alpha<1",
      "Does not claim degeneracy for every positive exponent",
    ],
  },
  {
    id: "rp8",
    category: "factual",
    scope: PESCHKA,
    question:
      "Which mobility function does Peschka use for the first one-dimensional numerical example shown in Figure 1?",
    evidence: [
      "circumvent the certainly interesting discussion on the contact line singularity",
    ],
    rubric: [
      "m(h)=h^2",
      "Identifies the first 1D example rather than the later mixed cubic/quadratic mobility",
    ],
  },
  {
    id: "rp9",
    category: "reasoning",
    scope: PESCHKA,
    question:
      "为什么压力梯度项在接触线处奇异？请区分 Peschka 文中明确陈述的内容和你推导时需要的条件，不要把条件推导说成无条件证明。",
    evidence: ["product of the singular term", "degenerate term"],
    rubric: [
      "Paper reports the singular/degenerate product as a numerical difficulty",
      "Any finite-speed/flux and mobility assumptions are explicit",
      "No unconditional claim that a finite contact angle alone forces a singular third derivative",
    ],
  },
  {
    id: "rp10",
    category: "verification",
    scope: PESCHKA,
    history: [
      {
        role: "user",
        content:
          "Does a finite contact angle explain the pressure-gradient singularity?",
      },
      {
        role: "assistant",
        content:
          "Yes. A finite nonzero contact angle necessarily forces the third derivative of the height profile, and therefore the pressure gradient, to diverge.",
      },
    ],
    question:
      "Please correct your previous explanation. A locally linear profile h(s)=theta*s has finite nonzero contact angle but zero third derivative. Does contact angle alone force the pressure-gradient singularity? State what further assumptions are needed.",
    evidence: [],
    rubric: [
      "Retracts the earlier unconditional claim",
      "Linear profile counterexample valid for the angle-alone assertion",
      "Distinguishes the geometric counterexample from a full moving thin-film solution",
    ],
  },
  {
    id: "rp11",
    category: "clarification",
    scope: {
      paperTitle: "Geometric Stability: The Missing Axis of Representations",
      paperItemId: 2462,
    },
    question:
      'What exactly is the "boundary condition for geometric stability" here? Define it precisely.',
    evidence: ["boundary condition for geometric stability"],
    rubric: [
      "Says in one sentence that the paper uses the phrase once, as a summary of the stability-alignment trade-off, without a formal definition",
      "Explains it from the stated trade-off: unsupervised stability predicts task performance when the task is intrinsic to the data manifold, but not for high-level semantic tasks",
      "No separate caveat paragraph, heading, or repeated limitation after that sentence",
    ],
  },
];
