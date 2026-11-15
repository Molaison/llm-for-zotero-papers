/**
 * Advisory evidence progress. Read counts describe work, not completeness;
 * the model chooses whether the requested answer needs further source text.
 */

export type EvidenceCoverage = "overview" | "targeted" | "exhaustive";

export type ReadStopPolicy = {
  coverage: EvidenceCoverage;
  /** Legacy telemetry threshold; never a restriction on further reading. */
  readBudget: number;
};

export type ReadStopRecommendation =
  | "answer_now"
  | "answer_or_self_check"
  | "name_a_specific_missing_dimension"
  | "answer_with_source_limitation";

export type ReadStopGuidance = {
  recommendation: ReadStopRecommendation;
  reason: string;
};

export const READ_BUDGET_BY_COVERAGE: Record<EvidenceCoverage, number> = {
  overview: 1,
  targeted: 2,
  exhaustive: Number.POSITIVE_INFINITY,
};

export function resolveReadStopGuidance(
  policy: ReadStopPolicy,
  state: {
    frontier: "advanced" | "unchanged" | "unavailable";
    readsThisTurn: number;
  },
): ReadStopGuidance {
  if (state.frontier === "unavailable") {
    return {
      recommendation: "answer_with_source_limitation",
      reason:
        "The requested textual source was unavailable. Give the best supported answer and disclose the source limitation.",
    };
  }
  if (policy.coverage === "exhaustive") {
    return state.frontier === "advanced"
      ? {
          recommendation: "answer_or_self_check",
          reason:
            "New source occurrences were delivered. Evaluate the accumulated evidence and either answer or identify one concrete missing dimension.",
        }
      : {
          recommendation: "name_a_specific_missing_dimension",
          reason:
            "This read added no new source occurrence. Do not repeat it; retrieve again only for a specifically named unresolved method, result, qualification, section, or comparison dimension.",
        };
  }
  if (state.frontier === "unchanged") {
    return {
      recommendation: "name_a_specific_missing_dimension",
      reason:
        "This read added no new source text. Avoid repeating it; choose another passage or section if needed to support the answer.",
    };
  }
  return {
    recommendation: "answer_or_self_check",
    reason:
      "New source text was delivered. Decide whether it supports the requested explanation; choose further reads for missing methods, results, qualifications, or other relevant evidence. Read counts do not establish sufficient coverage.",
  };
}
