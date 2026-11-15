import { assert } from "chai";
import {
  parseDocumentReferences,
  resolveDocumentReferenceMatches,
} from "../src/shared/documentReferences";
import type { PdfChunkMeta } from "../src/services/paperContent/types";

describe("documentReferences", function () {
  it("parses equivalent English and Chinese figure and table references", function () {
    assert.deepEqual(parseDocumentReferences("Explain Fig. 1a and Table 2"), [
      {
        kind: "figure",
        id: "1",
        panel: "a",
        surface: "Fig. 1a",
      },
      {
        kind: "table",
        id: "2",
        surface: "Table 2",
      },
    ]);
    assert.deepEqual(parseDocumentReferences("详细解释图1a和表2"), [
      {
        kind: "figure",
        id: "1",
        panel: "a",
        surface: "图1a",
      },
      {
        kind: "table",
        id: "2",
        surface: "表2",
      },
    ]);
  });

  it("treats document mappings as additive confidence-scored evidence", function () {
    const chunks: PdfChunkMeta[] = [
      {
        chunkIndex: 0,
        text: "Figure 1. Cross-language retrieval pipeline.",
        normalizedText: "Figure 1. Cross-language retrieval pipeline.",
        chunkKind: "figure-caption",
        references: [
          {
            kind: "figure",
            id: "1",
            confidence: "medium",
            provenance: ["caption-text"],
          },
        ],
      },
      {
        chunkIndex: 1,
        text: "Figure 3. An unrelated result.",
        normalizedText: "Figure 3. An unrelated result.",
        chunkKind: "figure-caption",
      },
    ];

    const matches = resolveDocumentReferenceMatches(
      parseDocumentReferences("帮我详细解释图1"),
      chunks,
    );

    assert.deepEqual(matches, [
      {
        chunkIndex: 0,
        confidence: "medium",
        references: [
          {
            kind: "figure",
            id: "1",
            surface: "图1",
          },
        ],
      },
    ]);
  });

  it("downgrades duplicated structural labels instead of hard-mapping them", function () {
    const chunks: PdfChunkMeta[] = [0, 1].map((chunkIndex) => ({
      chunkIndex,
      text: `Figure 1 duplicate ${chunkIndex}`,
      normalizedText: `Figure 1 duplicate ${chunkIndex}`,
      chunkKind: "figure-caption",
      references: [
        {
          kind: "figure",
          id: "1",
          confidence: "medium",
          provenance: ["caption-text"],
        },
      ],
    }));

    const matches = resolveDocumentReferenceMatches(
      parseDocumentReferences("解释图1"),
      chunks,
    );

    assert.deepEqual(
      matches.map((match) => match.confidence),
      ["low", "low"],
    );
  });
});
