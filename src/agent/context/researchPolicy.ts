/**
 * How much the library-retrieval tools return per call. Chat is the one
 * profile: plan mode's research profile, its stage list and its expansion
 * checkpoint went with plan mode.
 */
export type ResearchPolicyProfile = "chat";

export type ResearchPolicySnapshot = Readonly<{
  profile: ResearchPolicyProfile;
  deepSynthesisMaxPapers: number;
  evidenceOverviewMaxPapers: number;
  defaultMetadataItems: number;
  defaultCollectionMetadataItems: number;
  defaultCandidatePapers: number;
  defaultEnumerateCandidatePapers: number;
  defaultFullTextPapers: number;
  defaultSnippetsPerPaper: number;
  defaultTotalSnippets: number;
  maxMetadataItemsPerCall: number;
  maxCandidatePapersPerCall: number;
  maxFullTextPapersPerCall: number;
  maxSnippetsPerPaper: number;
  maxTotalSnippetsPerCall: number;
}>;

const CHAT_POLICY: ResearchPolicySnapshot = Object.freeze({
  profile: "chat",
  deepSynthesisMaxPapers: 25,
  evidenceOverviewMaxPapers: 80,
  defaultMetadataItems: 500,
  defaultCollectionMetadataItems: 2000,
  defaultCandidatePapers: 80,
  defaultEnumerateCandidatePapers: 200,
  defaultFullTextPapers: 30,
  defaultSnippetsPerPaper: 3,
  defaultTotalSnippets: 80,
  maxMetadataItemsPerCall: 5000,
  maxCandidatePapersPerCall: 200,
  maxFullTextPapersPerCall: 100,
  maxSnippetsPerPaper: 5,
  maxTotalSnippetsPerCall: 200,
});

export function resolveResearchPolicy(
  _profile: ResearchPolicyProfile,
): ResearchPolicySnapshot {
  return CHAT_POLICY;
}
