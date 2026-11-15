/**
 * A paper_read overview result the size of the one that froze the panel:
 * twelve papers, about 110 KB of text each, with their passage ids and the
 * run's quote citations, 1.3 MB of JSON in all.
 */
export function bigPaperReadOverview(papers = 12): Record<string, unknown> {
  const results = Array.from({ length: papers }, (_, index) => {
    const itemId = 100 + index;
    return {
      paperContext: {
        itemId,
        contextItemId: itemId + 1000,
        title: `Paper ${itemId}: ${"a long descriptive title ".repeat(12)}`,
        firstCreator: `Author${itemId}`,
        year: "2024",
      },
      citationLabel: `(Author${itemId}, 2024)`,
      sourceLabel: `Author${itemId} 2024`,
      displayLabel: `Author${itemId} 2024`,
      backend: "mineru",
      coverage: "capacity_sampled",
      totalChunks: 240,
      chunkIndexes: Array.from({ length: 200 }, (_, chunk) => chunk),
      quoteCitationIds: Array.from(
        { length: 30 },
        (_, quote) => `q${itemId}_${quote}`,
      ),
      text: `Paper ${itemId} body. `.repeat(6_000),
    };
  });
  return {
    mode: "overview",
    results,
    quoteCitations: results.flatMap((result) =>
      (result.quoteCitationIds as string[]).map((id) => ({
        id,
        quoteText: `${id} ${"quoted sentence text ".repeat(15)}`,
        citationLabel: result.citationLabel,
        itemId: result.paperContext.itemId,
        contextItemId: result.paperContext.contextItemId,
      })),
    ),
    readingReceipt: {
      strategy: "capacity_adaptive",
      requestedPapers: papers,
      returnedPapers: papers,
      completePapers: 0,
      capacitySampledPapers: papers,
      abstractOnlyPapers: 0,
      metadataOnlyPapers: 0,
      maxCharactersPerPaper: 110_000,
    },
    paperEvidenceProgress: { heldPapers: papers, advanced: true },
  };
}
