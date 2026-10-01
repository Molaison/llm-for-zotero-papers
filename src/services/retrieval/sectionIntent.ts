/**
 * Which part of papers a question asks about, for questions in any
 * language, from the question embedding retrieval already computes.
 *
 * The question is compared, in the same embedding model, with short English
 * questions that each ask for one part of papers and with general questions
 * about papers that ask for none. A section is wanted when the question is
 * closer to its examples than to the general questions by
 * SECTION_INTENT_MARGIN. Both sides of that comparison carry the model's
 * similarity scale and the cross-lingual gap of a non-English question, so
 * the rule does not depend on one absolute cosine, which differs between
 * embedding models.
 */
import { cosineSimilarity } from "../paperContent/pdfContext";
import {
  wantedSectionKinds,
  type EvidenceSectionKind,
} from "../../shared/libraryChatEvidencePolicy";

const SECTION_INTENT_KINDS = ["methods", "results", "limitations"] as const;
const EXAMPLE_GROUPS = [...SECTION_INTENT_KINDS, "general"] as const;

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
 * How much closer to a section's examples than to the general questions a
 * question must be. The margin shrinks as a model's baseline similarity
 * rises, so it is kept low: a missed intent only falls back to the cue
 * words, which is what plain chat did before.
 */
export const SECTION_INTENT_MARGIN = 0.05;

type ExampleEmbeddings = Readonly<Record<ExampleGroup, readonly number[][]>>;

function sectionKindsFromEmbedding(
  question: readonly number[],
  examples: ExampleEmbeddings,
): EvidenceSectionKind[] {
  const closest = (vectors: readonly number[][]) =>
    Math.max(...vectors.map((vector) => cosineSimilarity(question, vector)));
  const general = closest(examples.general);
  return SECTION_INTENT_KINDS.filter(
    (kind) => closest(examples[kind]) - general >= SECTION_INTENT_MARGIN,
  );
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
