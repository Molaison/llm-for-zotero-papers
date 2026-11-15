/** Authored evaluation sources, deliberately fictional: facts are fixed before implementation. */
export const papers = [
  {
    id: "orion",
    title: "Evaluation fixture: Orion observational drift study",
    author: "Orion",
    year: "2025",
    text: `# Orion observational drift study

## Abstract
We measured neural representational drift during a repeated visual discrimination task. Recordings changed across sessions while task accuracy remained approximately stable. This observational study describes co-occurrence; it does not establish that drift causes behavioral stability.

## Introduction
Representational drift means that the recorded population response to the same stimulus changes over time. Behavioral stability means that task performance remains similar across the measured sessions. These descriptions concern different measured quantities. Stable behavior does not imply that every neuron retains the same response. Nor does a changing response necessarily imply that the animal forgot the task. We restrict all conclusions to the measured visual task and observation interval.

## Methods
We recorded 200 tracked neurons in visual cortex from 10 adult mice over 10 daily sessions using two-photon calcium imaging. The animals performed the same visual discrimination task. There was no experimental intervention, no random assignment, and no human cohort. A fixed decoder was trained on day 1 and evaluated without retraining on later days. Behavioral accuracy was measured from the animals' responses rather than from decoder predictions. Population similarity was measured with a normalized correlation, a different quantity from task accuracy.

## Results
Median animal accuracy was 84% on day 1 and 85% on day 10. The difference is one percentage point, not a one-percent relative improvement. The normalized population-response correlation fell from 0.92 to 0.61. The fixed day-1 decoder declined from 80% to 62% accuracy by day 10. An independently retrained daily decoder remained at 81%. The decoder results concern the recorded neurons and the specified training procedure; they are not measurements of the animal's own decoder. Confidence intervals and a paired significance test for the 84% versus 85% comparison were not reported.

## Discussion
Stable animal performance coexisted with changing recorded activity. One possible explanation is downstream adaptation, but downstream weights were not measured. Another possibility is that behavior uses a stable subspace that the selected decoder does not isolate. Neither mechanism was tested directly. Our observations cannot establish that drift is necessary for stable behavior. They also cannot establish that every neural representation changes. A causal claim would require an appropriate intervention and controls.

## Limitations
This was an observational mouse study of one task over ten days. Calcium signals provide an indirect measure of neural activity. We did not measure downstream synaptic weights, working memory, sleep replay, or human clinical outcomes. We did not collect or report blood pressure. The excerpted results do not supply a p-value or confidence interval for the change in animal accuracy.

## Conclusion
The measured population representation changed while visual-task performance remained approximately stable. The mechanism preserving performance is unresolved.

## References
This is a self-contained fictional evaluation fixture and has no external references.`,
  },
  {
    id: "vega",
    title: "Evaluation fixture: Vega adaptation perturbation study",
    author: "Vega",
    year: "2026",
    text: `# Vega adaptation perturbation study

## Abstract
We tested whether temporarily suppressing a candidate adaptation process changes performance under a drifting neural input. The intervention reduced accuracy in the tested mouse task, with recovery after washout. These results support a role for the manipulated process in this setting, subject to the specificity limitations of the intervention.

## Background
An observational relationship cannot identify a mechanism by itself. A targeted intervention can test whether perturbing a candidate process changes an outcome. Even an intervention does not establish an unrestricted universal mechanism: its selectivity, controls, and measured population constrain interpretation.

## Methods
Twelve adult mice were randomly assigned to treatment and sham groups, with six mice in each group. Both groups performed the same visual discrimination task under a drifting input representation. We used electrophysiology, not calcium imaging. During treatment, a reversible intervention suppressed a candidate adaptation process. Sham animals received the matched control procedure. Accuracy was the percentage of correct choices. No human subjects were studied. The intervention did not directly manipulate the amount of representational drift.

## Results
During intervention, treatment-group accuracy was 63% and sham-group accuracy was 82%, a difference of 19 percentage points. After washout the treatment group recovered to 81%. The recorded population drift continued in both groups. The results concern the treatment period and the measured task. They do not show that all forms of adaptation were suppressed. No blood pressure or clinical outcomes were reported.

## Interpretation
The controlled perturbation supports a contribution of the manipulated process to performance under these conditions. It does not show that representational drift causes learning or that adaptation is the only mechanism supporting stable behavior. The experiment tests a candidate mechanism more directly than a purely observational design. Off-target effects of the intervention remain a possible explanation for part of the performance loss.

## Limitations
The sample was small and the intervention may have off-target effects. Recovery after washout argues against an irreversible loss but does not identify the molecular mechanism. We did not directly measure the downstream synaptic weights. Generalization to human memory, other tasks, or longer timescales remains untested.

## Conclusion
Suppressing the candidate adaptation process reduced task performance during intervention, followed by recovery after washout. The mechanism and generality remain limited by intervention specificity and sampling.`,
  },
];

export type QaCase = {
  id: string;
  category:
    | "clarification"
    | "factual"
    | "synthesis"
    | "verification"
    | "reasoning";
  question: string;
  provided?: string;
  multi?: boolean;
  library?: boolean;
  /** Exact source fragments selected independently of retrieval. */
  evidence: string[];
  rubric: string[];
};
export const cases: QaCase[] = [
  {
    id: "c1",
    category: "clarification",
    question: "What does representational drift mean here? One sentence.",
    provided:
      "Representational drift means that the recorded population response to the same stimulus changes over time.",
    evidence: [],
    rubric: [
      "Same stimulus; changing neural population response over time",
      "No unnecessary paper retrieval",
    ],
  },
  {
    id: "c2",
    category: "clarification",
    question:
      "Explain percentage points versus relative percent using these numbers. Keep it brief.",
    provided: "Accuracy increased from 84% to 85%.",
    evidence: [],
    rubric: ["1 percentage point", "Relative increase about 1.19%, not 1%"],
  },
  {
    id: "c3",
    category: "clarification",
    question: "把这句话用简单中文解释，不添加新结论。",
    provided:
      "Stable animal performance coexisted with changing recorded activity.",
    evidence: [],
    rubric: [
      "Behavior stable while measured neural activity changes",
      "No causal interpretation",
    ],
  },
  {
    id: "c4",
    category: "clarification",
    question: "Does this sentence establish causation? Briefly explain.",
    provided:
      "This observational study describes co-occurrence; it does not establish that drift causes behavioral stability.",
    evidence: [],
    rubric: ["No causation", "Observational co-occurrence only"],
  },
  {
    id: "c5",
    category: "clarification",
    question: "What is a fixed decoder in this description?",
    provided:
      "A fixed decoder was trained on day 1 and evaluated without retraining on later days.",
    evidence: [],
    rubric: ["Trained day 1; unchanged on later days"],
  },
  {
    id: "c6",
    category: "clarification",
    question: "Does unresolved mean the proposed mechanism was disproved?",
    provided:
      "The mechanism preserving performance is unresolved. Downstream adaptation is one possible explanation, but downstream weights were not measured.",
    evidence: [],
    rubric: [
      "Unresolved does not mean disproved",
      "Hypothesis remains untested",
    ],
  },
  {
    id: "c7",
    category: "clarification",
    question: "Rewrite this as one short, clear sentence.",
    provided:
      "The mechanism and generality remain limited by intervention specificity and sampling.",
    evidence: [],
    rubric: [
      "Preserves limitations from intervention specificity and sampling",
      "No new scientific claim",
    ],
  },
  {
    id: "c8",
    category: "clarification",
    question: "What does sham group mean in the sentence?",
    provided:
      "Sham animals received the matched control procedure rather than the active intervention.",
    evidence: [],
    rubric: ["Control procedure without active intervention"],
  },
  {
    id: "f1",
    category: "factual",
    question:
      "In the Orion paper, how many mice and neurons were studied, and for how long?",
    evidence: ["200 tracked neurons", "10 adult mice", "10 daily sessions"],
    rubric: ["200 neurons, 10 mice, 10 daily sessions"],
  },
  {
    id: "f2",
    category: "factual",
    question:
      "What was the fixed decoder accuracy on day 1 and day 10 in Orion?",
    evidence: ["80% to 62%"],
    rubric: [
      "80% day 1, 62% day 10",
      "Does not confuse animal and decoder accuracy",
    ],
  },
  {
    id: "f3",
    category: "factual",
    question: "Orion研究用了什么记录方法？只回答方法和研究对象。",
    evidence: ["two-photon calcium imaging", "10 adult mice"],
    rubric: ["Two-photon calcium imaging", "Adult mice"],
  },
  {
    id: "f4",
    category: "factual",
    question:
      "Read only Orion's Abstract and summarize its claim in two sentences.",
    evidence: ["observational study describes co-occurrence"],
    rubric: [
      "Changing neural representations with approximately stable performance",
      "Observational; no causal conclusion",
    ],
  },
  {
    id: "f5",
    category: "factual",
    question: "According to Orion's Limitations, was blood pressure measured?",
    evidence: ["did not collect or report blood pressure"],
    rubric: ["Explicitly not collected/reported"],
  },
  {
    id: "f6",
    category: "factual",
    question:
      "What p-value did Orion report for animal accuracy changing from 84% to 85%?",
    evidence: ["paired significance test", "were not reported"],
    rubric: ["No reported p-value", "Does not invent significance"],
  },
  {
    id: "s1",
    category: "synthesis",
    question:
      "Summarize Orion's result and its main limitation in three sentences.",
    evidence: [
      "84% on day 1 and 85%",
      "correlation fell from 0.92 to 0.61",
      "observational mouse study",
    ],
    rubric: [
      "Stable behavior versus changing representation",
      "Observational; mechanism unresolved",
    ],
  },
  {
    id: "s2",
    category: "synthesis",
    multi: true,
    question:
      "Compare only the Methods of the two selected papers: design, sample, and recording method. Keep the comparison compact.",
    evidence: [
      "200 tracked neurons",
      "two-photon calcium imaging",
      "Twelve adult mice",
      "electrophysiology",
    ],
    rubric: [
      "Orion observational 10 mice/200 neurons/calcium",
      "Vega randomized 12 mice/6 per group/electrophysiology",
    ],
  },
  {
    id: "s3",
    category: "synthesis",
    multi: true,
    question:
      "Which selected study offers stronger causal evidence for adaptation supporting performance, and what limits that claim?",
    evidence: [
      "Neither mechanism was tested directly",
      "controlled perturbation supports a contribution",
      "Off-target effects",
    ],
    rubric: [
      "Vega stronger causal evidence than Orion",
      "Specificity/off-target effects limit it",
      "Does not conclude drift causes stability",
    ],
  },
  {
    id: "s4",
    category: "synthesis",
    multi: true,
    question:
      "Do these studies disagree about whether drift itself causes stable behavior? Explain briefly.",
    evidence: [
      "cannot establish that drift is necessary",
      "does not show that representational drift causes learning",
    ],
    rubric: [
      "Neither demonstrates drift itself causes stability",
      "Complementary different designs; no manufactured contradiction",
    ],
  },
  {
    id: "v1",
    category: "verification",
    question:
      "Check this purported Orion quotation: 'We proved that drift causes behavioral stability.' Is it an exact quote and does it represent their conclusion?",
    evidence: ["does not establish that drift causes behavioral stability"],
    rubric: [
      "Rejects quote as not authentic",
      "Rejects unsupported causal conclusion",
    ],
  },
  {
    id: "v2",
    category: "verification",
    question:
      "Check my summary against Orion: 'The measured population representation changed while visual-task performance remained approximately stable.' Is it fair?",
    evidence: ["measured population representation changed"],
    rubric: ["Accepts correct summary", "Does not manufacture an error"],
  },
  {
    id: "v3",
    category: "verification",
    question:
      "I wrote that Orion measured a decline in the animals' accuracy from 80% to 62%. Please verify and correct if needed.",
    evidence: [
      "fixed day-1 decoder declined from 80% to 62%",
      "84% on day 1 and 85%",
    ],
    rubric: ["80 to 62 belongs to fixed decoder", "Animals 84 to 85"],
  },
  {
    id: "v4",
    category: "verification",
    multi: true,
    question:
      "Vega found 63% treatment versus 82% sham accuracy. Is my statement 'treatment was 19 percentage points lower during intervention' correct?",
    evidence: ["difference of 19 percentage points"],
    rubric: [
      "Accepts correct comparison",
      "Preserves during-intervention condition",
    ],
  },
  {
    id: "r1",
    category: "reasoning",
    question:
      "Does Orion prove downstream weights changed? If not, separate what was observed from the proposed explanation.",
    evidence: [
      "downstream weights were not measured",
      "One possible explanation is downstream adaptation",
    ],
    rubric: [
      "Weights not measured; no proof",
      "Separates observation from proposed adaptation",
    ],
  },
  {
    id: "r2",
    category: "reasoning",
    question:
      "Using Orion's 84% and 85%, calculate the relative increase. Does that establish a statistically significant improvement?",
    evidence: ["84% on day 1 and 85%", "paired significance test"],
    rubric: [
      "(85-84)/84 about 1.19%",
      "No significance conclusion without reported test/uncertainty",
    ],
  },
];

/** Optional real-paper transfer checks; source PDF/cache paths are supplied locally. */
export const realPaperCases: QaCase[] = [
  {
    id: "p1",
    category: "clarification",
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
    id: "p2",
    category: "factual",
    question:
      "Which mobility function does Peschka use for the first one-dimensional numerical example shown in Figure 1?",
    evidence: [
      "circumvent the certainly interesting discussion on the contact line singularity",
    ],
    rubric: [
      "m(h)=h^2",
      "Identifies first 1D example rather than later mixed cubic/quadratic mobility",
    ],
  },
  {
    id: "p3",
    category: "reasoning",
    question:
      "为什么压力梯度项在接触线处奇异？请区分 Peschka 文中明确陈述的内容和你推导时需要的条件，不要把条件推导说成无条件证明。",
    evidence: ["product of the singular term", "degenerate term"],
    rubric: [
      "Paper reports singular/degenerate product as numerical difficulty",
      "Any finite-speed/flux and mobility assumptions are explicit",
      "No unconditional claim that a finite contact angle alone forces singular third derivative",
    ],
  },
  {
    id: "p4",
    category: "verification",
    question:
      "Please correct your previous explanation. A locally linear profile h(s)=theta*s has finite nonzero contact angle but zero third derivative. Does contact angle alone force the pressure-gradient singularity? State what further assumptions are needed.",
    evidence: [],
    rubric: [
      "Retracts earlier unconditional claim",
      "Linear profile counterexample valid for angle-alone assertion",
      "Distinguishes geometric counterexample from a full moving thin-film solution",
    ],
  },
];

/** Library-chat cases: no active paper; the scope is a collection holding
 * Orion and Vega. Facts and fragments are fixed before any run. */
export const libraryCases: QaCase[] = [
  {
    id: "l1",
    category: "factual",
    library: true,
    question:
      "Which papers in this collection report blood pressure measurements? Name each paper and quote the sentence you rely on.",
    evidence: [
      "did not collect or report blood pressure",
      "No blood pressure or clinical outcomes were reported",
    ],
    rubric: [
      "States that neither paper reports blood pressure",
      "Does not turn 'not reported' into a measured value",
    ],
  },
  {
    id: "l2",
    category: "factual",
    library: true,
    question:
      "Across this collection, which paper used random assignment, and how many mice were in each group?",
    evidence: [
      "randomly assigned to treatment and sham groups",
      "six mice in each group",
    ],
    rubric: ["Vega; six per group; Orion had no random assignment"],
  },
  {
    id: "l3",
    category: "synthesis",
    library: true,
    question:
      "Compare the recording methods used by the papers in this collection.",
    evidence: [
      "two-photon calcium imaging",
      "electrophysiology, not calcium imaging",
    ],
    rubric: [
      "Orion calcium imaging; Vega electrophysiology; each attributed correctly",
    ],
  },
  {
    id: "l4",
    category: "synthesis",
    library: true,
    question:
      "What do the papers in this collection together say about whether representational drift causes stable behavior?",
    evidence: [
      "does not establish that drift causes behavioral stability",
      "does not show that representational drift causes learning",
    ],
    rubric: [
      "Neither establishes causation; Vega tests a candidate mechanism",
      "No causal overclaim",
    ],
  },
  {
    id: "l5",
    category: "verification",
    library: true,
    question:
      "One paper in this collection reports that the fixed decoder improved to 90% by day 10. Which paper, and is that correct?",
    evidence: ["declined from 80% to 62% accuracy by day 10"],
    rubric: ["Rejects the 90% claim; Orion's fixed decoder fell to 62%"],
  },
  {
    id: "l6",
    category: "factual",
    library: true,
    question:
      "这个文集中哪篇论文报告了冲洗期（washout）后的恢复？恢复后的准确率是多少？",
    evidence: ["recovered to 81%"],
    rubric: ["Vega; 81% after washout"],
  },
];
