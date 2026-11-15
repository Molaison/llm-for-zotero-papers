import { zipSync } from "fflate";

/** Deliberately repeats headings, labels and asset names across chunk boundaries. */
export function mineruResultFixture(part: number): Uint8Array {
  const bytes = (s: string) => new TextEncoder().encode(s);
  return zipSync({
    "full.md": bytes(
      `# Introduction\n\nCHUNK ${part} START.\n\n![Figure 1](images/figure.png)\n\nFigure 1. Chunk ${part} figure.\n\nTable 1. Chunk ${part} table.\n\n<table><tr><td>Chunk ${part} value</td></tr></table>\n\nCHUNK ${part} END.\n`,
    ),
    "content_list.json": bytes(
      JSON.stringify([
        { type: "text", text_level: 1, text: "Introduction", page_idx: 0 },
        {
          type: "image",
          img_path: "images/figure.png",
          image_caption: [`Figure 1. Chunk ${part} figure.`],
          page_idx: 0,
          bbox: [0, 0, 100, 100],
        },
        {
          type: "table",
          table_body: `<table><tr><td>Chunk ${part} value</td></tr></table>`,
          table_caption: [`Table 1. Chunk ${part} table.`],
          page_idx: 0,
        },
      ]),
    ),
    "images/figure.png": new Uint8Array([137, 80, 78, 71, part]),
  });
}
