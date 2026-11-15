import { PDFDocument, StandardFonts } from "pdf-lib";

/** A real PDF whose alternating fonts force separate PDF.js text items. */
export async function buildFragmentedQuotePdf(
  pages: readonly string[],
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const fonts = await Promise.all([
    pdf.embedFont(StandardFonts.Helvetica),
    pdf.embedFont(StandardFonts.Courier),
  ]);
  for (const text of pages) {
    const page = pdf.addPage([612, 792]);
    let x = 40;
    let y = 750;
    let characterIndex = 0;
    for (const word of text.split(/\s+/)) {
      if (x + word.length * 8 > 570) {
        x = 40;
        y -= 16;
      }
      for (const character of `${word} `) {
        const font = fonts[characterIndex++ % fonts.length];
        page.drawText(character, { x, y, font, size: 11 });
        x += font.widthOfTextAtSize(character, 11);
      }
    }
  }
  return pdf.save();
}
