/**
 * Which part of papers a question asks about, for questions in any
 * language, from the question embedding retrieval already computes.
 *
 * The question is compared, in the same embedding model, with short English
 * questions that each ask for one part of papers and with general questions
 * about papers that ask for none. The section it is closest to is wanted
 * when the question is closer to that section's examples than to the
 * general questions by SECTION_INTENT_MARGIN. Both sides of that comparison
 * carry the model's similarity scale and the cross-lingual gap of a
 * non-English question, so the rule does not depend on one absolute cosine,
 * which differs between embedding models.
 */
import { cosineSimilarity } from "../paperContent/pdfContext";
import {
  wantedSectionKinds,
  type EvidenceSectionKind,
} from "../../shared/libraryChatEvidencePolicy";

const SECTION_INTENT_KINDS = ["methods", "results", "limitations"] as const;
const EXAMPLE_GROUPS = [...SECTION_INTENT_KINDS, "general"] as const;

type SectionIntentKind = (typeof SECTION_INTENT_KINDS)[number];
type ExampleGroup = (typeof EXAMPLE_GROUPS)[number];

export const SECTION_INTENT_EXAMPLES: Readonly<
  Record<ExampleGroup, readonly string[]>
> = {
  methods: [
    "What methods did these papers use?",
    "How were the experiments designed?",
    "Which techniques and procedures did the studies use?",
  ],
  results: [
    "What did these papers find?",
    "What are the main results?",
    "What outcomes did the studies report?",
  ],
  limitations: [
    "What are the limitations of these papers?",
    "What weaknesses or caveats do the authors acknowledge?",
    "What future work do the authors suggest?",
  ],
  general: [
    "What are these papers about?",
    "Summarize these papers.",
    "How do these papers relate to each other?",
  ],
};

/**
 * How much closer to its best section's examples than to the general
 * questions a question must be. Calibrated with gemini-embedding-001 on the
 * live suite's 24 labelled questions in five languages
 * (test/fixtures/sectionIntentCalibration.json): each single-section
 * question beat general by 0.089 or more on its own section, and general and
 * unrelated questions by 0.005 at most. Only the best section counts:
 * wanting every section over the margin also took wrong ones, since a
 * results question reached 0.098 on methods and limitations questions 0.05
 * to 0.10 on methods and results. A question asking for two sections gets
 * the stronger one.
 */
export const SECTION_INTENT_MARGIN = 0.06;

type ExampleEmbeddings = Readonly<Record<ExampleGroup, readonly number[][]>>;

/**
 * The section a question asks for, from its closest similarity to each
 * example group: the best section, when it beats the general questions by
 * SECTION_INTENT_MARGIN.
 */
export function sectionKindsFromSimilarities(
  closest: Readonly<Record<ExampleGroup, number>>,
): EvidenceSectionKind[] {
  let best: SectionIntentKind = SECTION_INTENT_KINDS[0];
  for (const kind of SECTION_INTENT_KINDS)
    if (closest[kind] > closest[best]) best = kind;
  return closest[best] - closest.general >= SECTION_INTENT_MARGIN ? [best] : [];
}

function sectionKindsFromEmbedding(
  question: readonly number[],
  examples: ExampleEmbeddings,
): EvidenceSectionKind[] {
  const closest = (group: ExampleGroup) =>
    Math.max(
      ...examples[group].map((vector) => cosineSimilarity(question, vector)),
    );
  return sectionKindsFromSimilarities({
    methods: closest("methods"),
    results: closest("results"),
    limitations: closest("limitations"),
    general: closest("general"),
  });
}

/**
 * Section intent with the example embeddings cached per embedding model.
 * The examples are embedded on the first question that needs them; a
 * failed batch is remembered too, so no later turn pays for a retry.
 */
export function createSectionIntent(
  embed: (texts: string[]) => Promise<number[][]>,
) {
  const examplesByModel = new Map<string, Promise<ExampleEmbeddings | null>>();
  const examplesFor = (modelKey: string) => {
    let examples = examplesByModel.get(modelKey);
    if (!examples) {
      examples = embed(
        EXAMPLE_GROUPS.flatMap((group) => [...SECTION_INTENT_EXAMPLES[group]]),
      )
        .then((vectors) => {
          const byGroup: Partial<Record<ExampleGroup, number[][]>> = {};
          let offset = 0;
          for (const group of EXAMPLE_GROUPS) {
            const count = SECTION_INTENT_EXAMPLES[group].length;
            byGroup[group] = vectors.slice(offset, offset + count);
            offset += count;
          }
          // A batch that does not answer every example is no answer.
          return offset === vectors.length
            ? (byGroup as ExampleEmbeddings)
            : null;
        })
        .catch(() => null);
      examplesByModel.set(modelKey, examples);
    }
    return examples;
  };
  return {
    /**
     * The question's English cue words when it has any (plain chat's rule
     * so far); otherwise the sections its embedding is closest to.
     */
    async wantedSections(params: {
      question: string;
      questionEmbedding?: readonly number[];
      modelKey: string;
    }): Promise<EvidenceSectionKind[]> {
      const asked = wantedSectionKinds({ question: params.question });
      if (asked.length || !params.questionEmbedding?.length || !params.modelKey)
        return asked;
      const examples = await examplesFor(params.modelKey);
      return examples
        ? sectionKindsFromEmbedding(params.questionEmbedding, examples)
        : [];
    },
  };
}
