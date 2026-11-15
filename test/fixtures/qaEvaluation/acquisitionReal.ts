import type { AcquisitionCase } from "./acquisition";

/** Transfer questions for the explicitly approved Peschka paper. */
export const acquisitionRealCases: AcquisitionCase[] = [
  {
    id: "p5",
    category: "supplied",
    question:
      "Using only the supplied formula, when does m(h)/h tend to zero as h tends to zero from above?",
    provided: "m(h)=h^alpha, for positive h.",
    evidence: [],
    relevant: {},
    acceptableFirstModes: ["none"],
    rubric: ["alpha > 1; does not require a paper read"],
  },
  {
    id: "p6",
    category: "section",
    question:
      "Read only the Abstract of Peschka's paper. Which numerical method is coupled to the motion of the support, and in how many spatial dimensions is the algorithm applied?",
    evidence: [
      "finite element method based on a gradient formulation",
      "arbitrary Lagrangian-Eulerian method",
      "1D and 2D",
    ],
    relevant: { peschka: ["Abstract"] },
    onlySections: ["Abstract"],
    acceptableFirstModes: ["targeted"],
    rubric: [
      "Gradient-formulation finite elements coupled to ALE; applications in 1D and 2D",
    ],
  },
  {
    id: "p7",
    category: "lookup",
    question:
      "In Peschka's first one-dimensional example shown in Figure 1, which mobility m(h) is used? Give the value and supporting text; no derivation is needed.",
    evidence: ["m ( h ) = h ^ { 2 }"],
    relevant: { peschka: ["3 Examples in 1D"] },
    acceptableFirstModes: ["targeted"],
    rubric: ["m(h)=h^2, attributed to first example"],
  },
  {
    id: "p8",
    category: "lookup",
    question:
      "在Peschka的Introduction and model statement中，无滑移和滑移条件分别对应哪个alpha值？",
    evidence: ["noslip boundary condition", "slip condition"],
    relevant: { peschka: ["1 Introduction and model statement"] },
    acceptableFirstModes: ["targeted"],
    rubric: ["No-slip alpha3; slip alpha2; no reversal"],
  },
  {
    id: "p9",
    category: "lookup",
    question:
      "For the stationary-droplet simulation in Figure 1, how many elements were used and was the time-step size uniform?",
    evidence: ["n = 1 0 0", "nonuniform time-step size"],
    relevant: { peschka: ["3 Examples in 1D"] },
    acceptableFirstModes: ["targeted"],
    rubric: [
      "100 elements and nonuniform time steps; distinguish later coarse/fine examples",
    ],
  },
  {
    id: "p10",
    category: "section",
    question:
      "Using only section 5 Conclusion, state what the tangential motion can sometimes be used to improve.",
    evidence: ["mesh update", "mesh quality does not degrade too quick"],
    relevant: { peschka: ["5 Conclusion"] },
    onlySections: ["5 Conclusion"],
    acceptableFirstModes: ["targeted"],
    rubric: [
      "Mesh update that slows degradation of mesh quality; retains sometimes qualification",
    ],
  },
];
