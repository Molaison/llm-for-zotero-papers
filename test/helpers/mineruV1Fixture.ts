import { zipSync } from "fflate";

// Released MinerU 4.0.6 / docvortex 0.4.22+ pages/blocks contract.
export const mineruV1StructuredFixture = {
  pages: [
    {
      page_idx: 0,
      blocks: [
        { type: "paragraph_title", level: 2, content: "Results" },
        { type: "text", content: "A reproducible extraction." },
        {
          type: "image",
          content: "",
          image_source: "images/figure.png",
          captions: [{ content: "Figure 1. Test image." }],
          footnotes: [],
        },
        {
          type: "table",
          content: "<table><tr><td>42</td></tr></table>",
          captions: [{ content: "Table 1. Counts." }],
          footnotes: [{ content: "Measured once." }],
        },
        { type: "equation_interline", content: "x=1" },
      ],
    },
    { page_idx: 1, blocks: [{ type: "text", content: "Second page." }] },
  ],
  metadata: { producer: { name: "mineru", version: "4.0.6" } },
  is_full_document: true,
};
export function createMineruV1Zip(
  structured: unknown = mineruV1StructuredFixture,
  extra: Record<string, Uint8Array> = {},
) {
  const encode = (text: string) => new TextEncoder().encode(text);
  return zipSync({
    "markdown.md": encode(
      "## Results\n\nA reproducible extraction.\n\n![](images/figure.png)\n\nFigure 1. Test image.\n\n<table><tr><td>42</td></tr></table>\n\nTable 1. Counts.\n\n$$x=1$$\n\nSecond page.",
    ),
    "structured_content.json": encode(JSON.stringify(structured)),
    "images/figure.png": Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/e8AAAAASUVORK5CYII=",
      ),
      (char) => char.charCodeAt(0),
    ),
    ...extra,
  });
}
