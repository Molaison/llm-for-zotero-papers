import { assert } from "chai";
import {
  extractPdfPageCountFromBytes,
  extractPdfPageCountFromText,
} from "../src/utils/pdfPageCount";

describe("PDF page-count scanning", function () {
  it("uses the largest page-tree count", function () {
    assert.equal(
      extractPdfPageCountFromText(
        "/Type /Pages /Count 4\n/Type /Pages /Count 412",
      ),
      412,
    );
  });

  it("leaves absent and nonpositive counts unknown", function () {
    assert.isNull(extractPdfPageCountFromText("%PDF-1.7"));
    assert.isNull(extractPdfPageCountFromText("/Type /Pages /Count 0"));
    assert.isNull(extractPdfPageCountFromBytes(new Uint8Array()));
  });

  it("does not mistake a single page for a page-tree dictionary", function () {
    assert.isNull(extractPdfPageCountFromText("/Type /Page /Count 12"));
  });

  it("reads a dictionary spanning the byte-decoding boundary", function () {
    const bytes = new TextEncoder().encode(
      `${" ".repeat(0x8000 - 5)}/Type /Pages /Count 201`,
    );
    assert.equal(extractPdfPageCountFromBytes(bytes), 201);
  });
});
