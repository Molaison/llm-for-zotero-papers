import { assert } from "chai";
import {
  buildQuoteCitation,
  isQuoteWorthySourceText,
} from "../src/services/quotes/quoteCitations";

// Real passages from the MinerU / Zotero full-text corpus. Each one is body
// text of a paper that a metadata keyword used to reject as a whole.
const REAL_PROSE_WITH_METADATA_KEYWORDS: Array<[string, string]> = [
  [
    "affiliation word plus commas inside methods prose",
    "Participants were recruited from the New Haven community via community recruitment and word of mouth (i.e., fliers, email lists). All participants provided informed consent to an experimental protocol approved by the Yale University Institutional Review Board. Participants completed four or five fMRI sessions on separate days.",
  ],
  [
    "affiliation word plus place name inside ethics prose",
    "Experimental procedures and animal use were performed in accordance with UK Home Office regulations of the UK Animals (Scientific Procedures) Act 1986, following ethical review by the University of Cambridge Animal Welfare and Ethical Review Body (AWERB). All animal procedures were authorized under a project licence held by the senior author.",
  ],
  [
    "bioRxiv running footer glued before a figure legend",
    "bioRxiv preprint doi: https://doi.org/10.1101/2022.11.10.515946; this version posted December 27, 2022. The copyright holder for this preprint (which was not certified by peer review) is the author/funder, who has granted bioRxiv a license to display the preprint in perpetuity. It is made available under aCC-BY-NC-ND 4.0 International license. Fig. 4 | Mean firing rate of cells predicts their stability. a, Firing rate distributions of stable and unstable cells across sessions. b, Cells with higher mean firing rates were more likely to remain stable across days.",
  ],
  [
    "Cell Press running footer glued after body prose",
    "We identified spatially tuned cells (place cells) by computing their spatial information content relative to an empirically generated shuffle distribution as described previously (Danielson et al., 2016; Zaremba et al., 2017). Spatial information has greater sensitivity for the detection of place cells with single- and multiple-place fields. Cell Reports 42, 112119, March 28, 2023 5 Article ll OPEN ACCESS",
  ],
  [
    "Nature running header glued inside prose",
    "Neurons with stable tuning were found in every animal. Nature Communications | (2023)14:4422 | https://doi.org/10.1038/s41467-023-40144-w The fraction of stable neurons did not differ between the two cohorts of mice that we imaged.",
  ],
  [
    "supplementary information mentioned inside body prose",
    "The presence of clutter makes the task much more difficult but the performance of the attention model is affected less than the performance of the other models. RAM with 4 glimpses reaches 7.1% error, which outperforms fully-connected models by a wide margin. Full learning curves for every model are given in the Supplementary Information.",
  ],
  [
    "summary heading glued to abstract prose",
    "SUMMARY The structure and function of the brain can be understood at multiple levels based on the questions that need to be answered. Nerve cells generate electrical signals to convey information over substantial distances and to transmit it to other cells by means of synaptic connections.",
  ],
  [
    "in brief used as an adverb",
    "In brief, calcium imaging movies from each session were pre-processed using a spatial downsampling of 4 and a temporal downsampling of 2, which was followed by motion correction.",
  ],
  [
    "single sentence with two capitalized words around a comma",
    "In Drosophila, Kenyon cells receive input from olfactory projection neurons and fire sparsely.",
  ],
  [
    "single sentence with a capitalized appendix reference",
    "This update can be interpreted as recursive Bayesian filtering of the weights (SI Appendix, Weight Filtering).",
  ],
  [
    "published by an author, not a publisher",
    "This ΔF/F₀ was then deconvolved using the algorithm published by Vogelstein et al. (2010).",
  ],
  [
    "caption that starts with the word Summary",
    "Summary of task settings utilized at each training stage. Performance criteria indicate the behavioral performance necessary to graduate to the next training stage.",
  ],
  [
    "short sentence ending in a capitalized region list",
    "Neurons in CA1 receive inputs from the DG, CA3 and CA2.",
  ],
  [
    "short sentence whose comma list ends in an acronym",
    "These projections were traced from the DG, CA3 and EC.",
  ],
  [
    "section word starting a short prose sentence",
    "Keywords were extracted from each abstract and ranked by frequency across the corpus.",
  ],
  [
    "sentence with a name-like comma pair and no final period",
    "Learning rates were matched across all models before training began. However, CA1 neurons in the model drift faster than those in the data across the full range of tested noise levels and network sizes we explored in these simulations, as the next figure shows for every condition",
  ],
  [
    "present-tense prose that mentions the place field center",
    "The vector mu gives the coordinates of the place field center and sigma sets its width in each direction of the arena for every model cell in the population of the network. Each neuron then fires according to a Gaussian tuning curve around that location.",
  ],
  [
    "Methods prose starting with Accepted",
    "Accepted trials were those in which the animal licked within one second of the reward cue and did not lick at any point during the delay period of the task in that session of training on the task across all of the recording days. Other trials were excluded from the analysis.",
  ],
  [
    "Methods prose starting with Received",
    "Received signals were band-pass filtered between 300 and 6000 Hz and then thresholded at four times the median absolute deviation of the noise on each channel of the probe across all of the recording sessions in every animal. Spikes were then sorted offline.",
  ],
  [
    "Methods prose starting with Published",
    "Published datasets from three earlier studies of mouse visual cortex were reanalyzed with the same decoder and the same cross-validation scheme that we used for our own recordings in all of the animals of this study. The results agreed with ours.",
  ],
  [
    "open access dataset mentioned in prose",
    "We used the open access dataset released by the Allen Institute, which contains two-photon recordings from six visual areas in awake mice.",
  ],
];

// Genuine metadata that must stay rejected.
const GENUINE_METADATA: Array<[string, string]> = [
  [
    "affiliation block with numbered institutions",
    "1School of Psychological and Cognitive Sciences, Peking University, China. 2 Peking-Tsinghua Center for Life Sciences, Academy for Advanced Interdisciplinary Studies, Peking University, China. 3Institute of Cognitive Neuroscience, University College London, London, UK.",
  ],
  [
    "title, byline and affiliations without sentence breaks",
    "Continual-learning rules shape representational drift Yikai Si1,2 and Shanshan Qin∗1,3 1School of Physics and Astronomy, Shanghai Jiao Tong University, Shanghai 200240, China 2Zhiyuan College, Shanghai Jiao Tong University, Shanghai 200240, China",
  ],
  [
    "bioRxiv running footer alone",
    "bioRxiv preprint doi: https://doi.org/10.1101/2023.12.21.572809; this version posted December 22, 2023. The copyright holder for this preprint (which was not certified by peer review) is the author/funder, who has granted bioRxiv a license to display the preprint in perpetuity. It is made available under aCC-BY-NC-ND 4.0 International license.",
  ],
  [
    "Cell Press running footer alone",
    "Cell Reports 42, 112119, March 28, 2023 5 Article ll OPEN ACCESS",
  ],
  [
    "open access licence paragraph",
    "Copyright: © 2022 Aitken et al. This is an open access article distributed under the terms of the Creative Commons Attribution License, which permits unrestricted use, distribution, and reproduction in any medium, provided the original author and source are credited.",
  ],
  [
    "eLife copyright notice",
    "© Copyright Rule et al. This article is distributed under the terms of the Creative Commons Attribution License, which permits unrestricted use and redistribution provided that the original author and source are credited.",
  ],
  [
    "supplementary information availability line",
    "Supplementary information The online version contains supplementary material available at https://doi.org/10.1038/s41467-023-37562-1.",
  ],
  [
    "supplementary material availability without a URL",
    "Supplementary material associated with this article can be found, in the online version, at the journal website.",
  ],
  [
    "keywords line",
    "Keywords: Dorsal hippocampus, place cells, reward expectation, representational drift, two-photon microscopy, longitudinal calcium imaging",
  ],
  ["short keywords line", "Keywords: drift, plasticity, decoding"],
  [
    "keywords line without a colon",
    "Keywords Representational drift · Bayesian learning · Neural networks · Representation learning",
  ],
  [
    "corresponding author and e-mail",
    "* Corresponding author. E-mail address: jane.doe@example.edu (J. Doe).",
  ],
  [
    "author byline with affiliation markers",
    "Daniel Bush5, Neil Burgess3,6,*, Si Wu1,2,7,8,*. 1School of Psychological and Cognitive Sciences, Peking University, China.",
  ],
  [
    "reference list entry",
    "Hansen, N., & Manahan-Vaughan, D. (2014). Dopamine D1/D5 receptors mediate informational saliency that promotes persistent hippocampal long-term plasticity. Cerebral Cortex, 24(4), 845–858.",
  ],
  [
    "Nature back-matter block",
    "Correspondence and requests for materials should be addressed to Jane Doe. Peer review information Nature Neuroscience thanks the anonymous reviewers for their contribution to the peer review of this work. Reprints and permissions information is available at www.nature.com/reprints.",
  ],
  [
    "numbered affiliations without commas or places",
    "1 Janelia Research Campus, Howard Hughes Medical Institute. 2 Allen Institute for Brain Science. 3 Department of Neuroscience, Johns Hopkins University. 4 Center for Neural Science, New York University. 5 Department of Physiology, University of Bern. 6 Max Planck Institute for Brain Research.",
  ],
  [
    "name list followed by short affiliations",
    "Alice Smith1, Bob Jones2, Carol White3, Dan Black4, Eve Green5, Frank Brown6, Grace Lee7, Henry King8, Ivy Young9, Jack Moore1. 1 Janelia Research Campus. 2 Allen Institute for Brain Science. 3 Department of Neuroscience, Johns Hopkins University.",
  ],
  [
    "author notes block",
    "These authors contributed equally to this work. Department of Neurobiology, Harvard Medical School, Boston, MA, USA. Present address: Allen Institute for Brain Science. These authors jointly supervised this work and are listed alphabetically. Lead contact.",
  ],
  [
    "editorial status block",
    "Received 3 May 2022. Accepted 1 March 2023. Published online 12 April 2023. Check for updates. Reviewed by John Doe and Jane Roe. Edited by Larry Abbott, Columbia University. Correspondence and requests for materials should be addressed to the lead contact.",
  ],
  [
    "publisher line",
    "© 2020 The Authors. Published by Elsevier Inc. This is an open access article under the CC BY license.",
  ],
];

describe("quote worthiness", function () {
  it("accepts real prose that only mentions a metadata keyword", function () {
    for (const [name, text] of REAL_PROSE_WITH_METADATA_KEYWORDS) {
      assert.isTrue(isQuoteWorthySourceText(text), name);
      assert.isDefined(
        buildQuoteCitation({
          quoteText: text,
          citationLabel: "(Example et al., 2024)",
          sourceMatchText: text,
          sourceMatchKind: "exact",
          sourceMatchSource: "context-text",
          contextItemId: 12,
          itemId: 11,
        }),
        name,
      );
    }
  });

  it("keeps rejecting genuine publication metadata", function () {
    for (const [name, text] of GENUINE_METADATA) {
      assert.isFalse(isQuoteWorthySourceText(text), name);
      assert.isFalse(
        isQuoteWorthySourceText(text, { allowShortQuoteText: true }),
        `${name} (short text allowed)`,
      );
    }
  });

  it("does not store the furniture-stripped text as the quote", function () {
    const text = REAL_PROSE_WITH_METADATA_KEYWORDS[3][1];
    const citation = buildQuoteCitation({
      quoteText: text,
      citationLabel: "(Example et al., 2024)",
      sourceMatchText: text,
      sourceMatchKind: "exact",
      sourceMatchSource: "context-text",
      contextItemId: 12,
    });
    assert.equal(citation?.quoteText, text);
    assert.equal(citation?.sourceMatchText, text);
  });

  it("rejects prose paragraphs made mostly of metadata sentences", function () {
    const text =
      "Correspondence should be addressed to J.D. (jane.doe@example.edu). Department of Neuroscience, University of Example, 1 Institute Road, Boston, MA 02115, USA. Received 3 May 2021; accepted 9 June 2022. This is an open access article distributed under the terms of the Creative Commons Attribution License.";
    assert.isFalse(isQuoteWorthySourceText(text));
  });
});
