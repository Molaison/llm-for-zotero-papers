/** Fresh acquisition evaluation. Fictional sources and relevance judgments are
 * fixed before the acquisition-only live comparison, not inferred from answers. */
export const acquisitionPapers = [
  {
    id: "lyra",
    title: "Evaluation fixture: Lyra coastal sensor calibration",
    author: "Lyra",
    year: "2025",
    text: `# Lyra coastal sensor calibration

## Abstract
We evaluated a calibration method for coastal temperature sensors. Calibration reduced held-out temperature error while leaving the sampling interval unchanged. The study concerns instrument measurement, not improved weather prediction. Deployment in polar water was not evaluated.

## Introduction
Temperature sensors can report biased measurements when their calibration ages. A lower measurement error does not by itself show that a forecast model became more accurate. This study separates sensor calibration from downstream forecasting. The deployment sites were selected for practical access rather than to represent every coastline. The word drift denotes a change in sensor offset, not ocean currents or neural activity.

## Related work
Earlier work by the fictional Atlas group used 96 sensors and a sampling interval of 30 seconds. Its temperature error was 0.8 degrees Celsius. These figures describe the earlier Atlas study, not the Lyra experiment. We use Atlas only as background and do not pool its measurements with our own. A second historical prototype transmitted packets at 4 Hz; that value is not a Lyra sampling rate.

## Methods
We deployed 24 temperature sensors at three coastal sites for 18 days. Each sensor sampled once every 45 seconds. Calibration used a reference thermometer rather than a satellite estimate. The first 12 days formed the calibration partition and the final six days formed the held-out evaluation partition. Site identity was retained when partitioning observations. The study did not randomly assign sensors to coastal sites.

## Calibration model
The correction was T_corrected = a*T_raw + b. The scale coefficient a was fixed at 1.04 and the offset b was -0.30 degrees Celsius. These coefficients describe the released calibration model. They are not the held-out error or the number of sites. Coefficients were fitted using the calibration partition only. No held-out observations were used to estimate a or b.

## Results
On the held-out partition, mean absolute temperature error decreased from 0.90 to 0.35 degrees Celsius after calibration. The sampling interval remained 45 seconds. Forecast accuracy was not evaluated. Two sensors lost network connectivity during storms, but their locally stored temperature records were recovered. The error statistic includes those recovered records. The improvement is a change in measurement error, not a percentage-point change in classification accuracy.

## Table 1: Site counts
| Site | Sensors | Days |
| --- | --- | --- |
| North inlet | 8 | 18 |
| East harbor | 10 | 18 |
| South pier | 6 | 18 |
The site counts sum to 24 sensors. These are deployed devices, not independent coastlines or human participants. All sites used the same sampling interval. Site labels are identifiers rather than geographical coordinates.

## Ablation
Removing the offset correction while retaining the scale correction gave a held-out mean absolute error of 0.52 degrees Celsius. Removing both corrections restored the uncalibrated error. This ablation changes the calibration equation, not the train/evaluation partition. It does not test a causal effect on weather forecasts.

## Telemetry
Successful packet delivery was 97% during the first week and 93% during the final week. These percentages measure network delivery and are not temperature accuracy. Local sensor storage retained the readings when packets were lost. The system transmitted a daily health summary. The study did not equate missing telemetry with missing temperature records.

## Power use
Median battery use was 14 milliwatts during sampling and 38 milliwatts during transmission. These values were engineering measurements under the test configuration. They do not estimate annual operating cost or carbon emissions. Battery replacement intervals were not evaluated.

## Discussion
The held-out evaluation supports improved temperature measurement in the tested setting. It does not establish improved storm forecasting. The unchanged sampling interval indicates that the gain was not obtained by sampling more frequently. Generalization requires testing additional environments and sensor models. Network reliability and measurement fidelity should be assessed separately.

## Limitations
The experiment covered only three accessible coastal sites and one sensor model. Polar water, deep-ocean deployment, and salinity effects were not tested. No p-value or confidence interval was reported for the held-out error reduction. No human participants or blood-pressure measurements were involved. The lack of a reported statistical interval does not establish that the effect is zero.

## Data availability
The fictional sensor records use the archive identifier LYRA-T24. The released table contains timestamps, raw temperatures, corrected temperatures, and site labels. It contains no real participant data. The identifier is an evaluation fixture and should not be looked up externally.

## Conclusion
Calibration reduced held-out temperature error without increasing sampling frequency. The evidence is limited to the tested coastal instrument setting. Weather prediction, polar performance, and long-term battery lifetime remain outside the study's evidence.

## References
Atlas is a fictional background reference included only to test source discrimination. Its 96 sensors, 30-second interval, and 0.8-degree error must not be attributed to Lyra.`,
  },
  {
    id: "mira",
    title: "Evaluation fixture: Mira inland sensor calibration",
    author: "Mira",
    year: "2026",
    text: `# Mira inland sensor calibration

## Abstract
We tested an offset-only calibration for inland temperature sensors. Held-out measurement error decreased after calibration. Our inland design differs from the coastal Lyra setting. The study does not establish which calibration is universally best.

## Background
Differences in environment and reference instruments constrain cross-study comparisons. Comparing raw error values without considering design does not establish a universal ranking. This paper distinguishes the local measurement experiment from prior coastal studies.

## Instrument selection
We selected one low-cost sensor model suitable for sheltered inland stations. The reference instrument was a laboratory-calibrated thermistor. Selection was based on availability, not random sampling across manufacturers. We did not use the reference thermometer from the Lyra study.

## Pilot study
A preliminary pilot used four sensors for two days. Pilot measurements were excluded from the main experiment. They should not be substituted for the main sample count or duration. The pilot was used to test data collection software, not to estimate final accuracy.

## Methods
The main experiment used 15 sensors at five inland stations for 20 days. Sensors sampled once every 60 seconds. A laboratory-calibrated thermistor supplied reference temperatures. The first 15 days were used to estimate a single offset; the last five days were held out. No scale coefficient was fitted. Devices were allocated by station availability rather than random assignment.

## Calibration model
The offset-only model was T_corrected = T_raw + 0.20 degrees Celsius. Its scale coefficient is implicitly one. The offset differs in sign from Lyra's released model. The calibration coefficient must not be confused with the held-out measurement error.

## Results
Mean absolute error on the held-out days decreased from 0.70 to 0.40 degrees Celsius. Sampling remained at 60 seconds. All 15 sensors supplied usable temperature records. The main experiment did not measure weather forecast accuracy or clinical outcomes. The number 0.20 refers to the fitted offset rather than the final error.

## Discussion
The data support an offset correction for this inland device configuration. They do not show that an offset-only method outperforms every scale-and-offset method. Differences from coastal tests may reflect environment, sensor model, reference instrument, or analysis design.

## Limitations
Only one inland sensor model and five accessible stations were tested. Polar environments and salinity effects were not evaluated. The paper reports no confidence interval or p-value for its error reduction. Long-term calibration stability remains unknown.

## Conclusion
The offset-only calibration reduced held-out measurement error in the tested inland setting. Cross-study superiority and performance outside this setting remain unresolved.`,
  },
];

export type AcquisitionCase = {
  id: string;
  category:
    | "supplied"
    | "lookup"
    | "section"
    | "comparison"
    | "broad"
    | "absence";
  question: string;
  provided?: string;
  history?: { role: "user" | "assistant"; content: string }[];
  multi?: boolean;
  evidence: string[];
  rubric: string[];
  /** Sections judged useful for this question, by source; not a claim-support certificate. */
  relevant: Record<string, string[]>;
  /** A user-mandated reading boundary, separate from relevance. */
  onlySections?: string[];
  acceptableFirstModes: string[];
};

export const acquisitionCases: AcquisitionCase[] = [
  {
    id: "a1",
    category: "supplied",
    question:
      "Explain calibration drift in one sentence using this definition.",
    provided:
      "Calibration drift is a change in a sensor's measurement offset over time.",
    evidence: [],
    relevant: {},
    acceptableFirstModes: ["none"],
    rubric: ["Changing sensor offset over time; no new paper facts"],
  },
  {
    id: "a2",
    category: "supplied",
    question:
      "Translate this sentence into Chinese without adding information.",
    provided: "Lower sensor error does not establish better weather forecasts.",
    evidence: [],
    relevant: {},
    acceptableFirstModes: ["none"],
    rubric: ["Preserves does not establish; faithful Chinese translation"],
  },
  {
    id: "a3",
    category: "supplied",
    question:
      "Using only these values, how much did the error fall in absolute units?",
    provided: "Mean absolute error changed from 0.90 to 0.35 degrees Celsius.",
    evidence: [],
    relevant: {},
    acceptableFirstModes: ["none"],
    rubric: ["0.55 degrees Celsius; not percentage points"],
  },
  {
    id: "a4",
    category: "supplied",
    question:
      "In your previous answer, does 'held out' mean these days helped fit the coefficients?",
    history: [
      { role: "user", content: "What is the evaluation partition?" },
      {
        role: "assistant",
        content:
          "The final six days were held out: their measurements were used to evaluate the calibration after the coefficients had been fitted on the earlier days.",
      },
    ],
    evidence: [],
    relevant: {},
    acceptableFirstModes: ["none"],
    rubric: ["No; evaluation only after fitting"],
  },
  {
    id: "a5",
    category: "lookup",
    question:
      "How many sensors did Lyra actually deploy, and for how many days? Exclude earlier studies.",
    evidence: ["24 temperature sensors", "18 days"],
    relevant: { lyra: ["Methods", "Table 1: Site counts"] },
    acceptableFirstModes: ["targeted"],
    rubric: ["24 sensors, 18 days; not Atlas 96 or Mira 15"],
  },
  {
    id: "a6",
    category: "lookup",
    question: "Lyra研究在校准后多久采样一次？只回答时间间隔。",
    evidence: ["sampling interval remained 45 seconds"],
    relevant: { lyra: ["Methods", "Results"] },
    acceptableFirstModes: ["targeted"],
    rubric: ["45 seconds, unchanged; not 30 or 60"],
  },
  {
    id: "a7",
    category: "lookup",
    question:
      "What are a and b in Lyra's released correction equation, including their signs?",
    evidence: ["a was fixed at 1.04", "b was -0.30"],
    relevant: { lyra: ["Calibration model"] },
    acceptableFirstModes: ["targeted"],
    rubric: ["a=1.04; b=-0.30 degrees Celsius"],
  },
  {
    id: "a8",
    category: "lookup",
    question: "In Lyra Table 1, how many sensors were at East harbor?",
    evidence: ["East harbor | 10"],
    relevant: { lyra: ["Table 1: Site counts"] },
    acceptableFirstModes: ["targeted"],
    rubric: ["10 sensors; table text sufficient"],
  },
  {
    id: "a9",
    category: "section",
    question:
      "Read only Lyra's Abstract. What improved and what prediction claim is outside its scope?",
    evidence: [
      "Calibration reduced held-out temperature error",
      "not improved weather prediction",
    ],
    relevant: { lyra: ["Abstract"] },
    onlySections: ["Abstract"],
    acceptableFirstModes: ["targeted"],
    rubric: [
      "Reduced held-out temperature error; no improved weather prediction claim",
    ],
  },
  {
    id: "a10",
    category: "section",
    question:
      "Using only Lyra's Methods, identify the training and evaluation split and its reference instrument.",
    evidence: ["first 12 days", "final six days", "reference thermometer"],
    relevant: { lyra: ["Methods"] },
    onlySections: ["Methods"],
    acceptableFirstModes: ["targeted"],
    rubric: ["12 training, six held out, reference thermometer"],
  },
  {
    id: "a11",
    category: "section",
    question: "只读Lyra的Limitations，列出没有测试的三种环境或效应。",
    evidence: [
      "Polar water, deep-ocean deployment, and salinity effects were not tested",
    ],
    relevant: { lyra: ["Limitations"] },
    onlySections: ["Limitations"],
    acceptableFirstModes: ["targeted"],
    rubric: ["Polar water, deep ocean, salinity effects"],
  },
  {
    id: "a12",
    category: "comparison",
    multi: true,
    question:
      "Read only Methods in both selected papers. Compare their main sample sizes, duration, and reference instruments.",
    evidence: [
      "24 temperature sensors",
      "18 days",
      "reference thermometer",
      "15 sensors",
      "20 days",
      "laboratory-calibrated thermistor",
    ],
    relevant: { lyra: ["Methods"], mira: ["Methods"] },
    onlySections: ["Methods"],
    acceptableFirstModes: ["targeted"],
    rubric: [
      "Lyra 24/18 days/thermometer; Mira 15/20 days/thermistor; no pilot counts",
    ],
  },
  {
    id: "a13",
    category: "comparison",
    multi: true,
    question:
      "What were the held-out errors before and after calibration in each selected paper? Keep the papers separate.",
    evidence: ["0.90 to 0.35", "0.70 to 0.40"],
    relevant: { lyra: ["Results"], mira: ["Results"] },
    acceptableFirstModes: ["targeted"],
    rubric: ["Lyra 0.90 to 0.35; Mira 0.70 to 0.40 degrees Celsius"],
  },
  {
    id: "a14",
    category: "broad",
    question:
      "Give a short overview of Lyra: its question, approach, main finding, and one limitation.",
    evidence: ["reference thermometer", "0.90 to 0.35", "Polar water"],
    relevant: {
      lyra: [
        "Abstract",
        "Introduction",
        "Methods",
        "Calibration model",
        "Results",
        "Discussion",
        "Limitations",
        "Conclusion",
      ],
    },
    acceptableFirstModes: ["overview"],
    rubric: [
      "Calibration experiment; reference instrument; lower held-out error; limited setting",
    ],
  },
  {
    id: "a15",
    category: "broad",
    question:
      "Read the entire Lyra paper exhaustively, not just an overview, and give a compact checklist of its distinct measured quantities and major untested outcomes.",
    evidence: [
      "0.90 to 0.35",
      "0.52",
      "97%",
      "14 milliwatts",
      "battery replacement intervals were not evaluated",
    ],
    relevant: {
      lyra: [
        "Abstract",
        "Introduction",
        "Related work",
        "Methods",
        "Calibration model",
        "Results",
        "Table 1: Site counts",
        "Ablation",
        "Telemetry",
        "Power use",
        "Discussion",
        "Limitations",
        "Data availability",
        "Conclusion",
        "References",
      ],
    },
    acceptableFirstModes: ["full"],
    rubric: [
      "Exhaustive read receipt; temperature, ablation, telemetry, power; untested forecasts/environments/lifetime",
    ],
  },
  {
    id: "a16",
    category: "absence",
    question:
      "What p-value does Lyra report for the reduction in held-out error?",
    evidence: ["No p-value or confidence interval was reported"],
    relevant: { lyra: ["Limitations"] },
    acceptableFirstModes: ["targeted"],
    rubric: ["No reported p-value; no invented value or significance claim"],
  },
  {
    id: "a17",
    category: "absence",
    question:
      "Does Lyra report performance in polar water? Please find the relevant qualification.",
    evidence: [
      "Polar water, deep-ocean deployment, and salinity effects were not tested",
    ],
    relevant: { lyra: ["Abstract", "Limitations", "Conclusion"] },
    acceptableFirstModes: ["targeted"],
    rubric: ["Not tested; no fabricated polar result"],
  },
  {
    id: "a18",
    category: "absence",
    question:
      "Read Lyra's nonexistent Human Participants section and tell me whether it reports blood pressure. If that section is absent, say so and use only explicitly relevant available text.",
    evidence: [
      "No human participants or blood-pressure measurements were involved",
    ],
    relevant: { lyra: ["Limitations"] },
    acceptableFirstModes: ["targeted", "outline"],
    rubric: [
      "Section absent; no human participants or blood-pressure measurement; fallback disclosed",
    ],
  },
  {
    id: "a19",
    category: "lookup",
    question:
      "Lyra reports 97% and 93%. Are these temperature accuracy numbers, and what happened to the locally stored readings?",
    evidence: [
      "percentages measure network delivery",
      "Local sensor storage retained the readings",
    ],
    relevant: { lyra: ["Telemetry", "Results"] },
    acceptableFirstModes: ["targeted"],
    rubric: ["Packet delivery, not temperature accuracy; readings retained"],
  },
  {
    id: "a20",
    category: "comparison",
    multi: true,
    question:
      "Compare the released equations in both selected papers: which fits a scale, what are the offsets, and are the two offsets the same sign?",
    evidence: [
      "a was fixed at 1.04",
      "b was -0.30",
      "T_corrected = T_raw + 0.20",
    ],
    relevant: { lyra: ["Calibration model"], mira: ["Calibration model"] },
    acceptableFirstModes: ["targeted"],
    rubric: [
      "Lyra scale1.04/offset-0.30; Mira scale1/offset+0.20; opposite signs",
    ],
  },
];
