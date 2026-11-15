import { assert } from "chai";
import { strToU8, zipSync } from "fflate";

import {
  extractDocxPlainText,
  extractTextAttachmentContent,
} from "../src/services/paperContent/textAttachmentExtraction";

describe("text attachment extraction", function () {
  it("extracts plain paragraph and table text from DOCX bytes", function () {
    const docxBytes = zipSync({
      "word/document.xml": strToU8(
        [
          '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
          "<w:body>",
          "<w:p><w:r><w:t>Hello &amp; welcome</w:t></w:r></w:p>",
          "<w:p><w:r><w:t>Second</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>line</w:t></w:r></w:p>",
          "<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell A</w:t></w:r></w:p></w:tc></w:tr></w:tbl>",
          "</w:body>",
          "</w:document>",
        ].join(""),
      ),
    });

    assert.equal(
      extractDocxPlainText(docxBytes),
      "Hello & welcome\nSecond\tline\nCell A",
    );
  });

  it("strips HTML attachments to readable text", function () {
    const bytes = new TextEncoder().encode(
      "<html><body><h1>Title</h1><p>Alpha &amp; beta</p></body></html>",
    );

    assert.equal(
      extractTextAttachmentContent(bytes, "html"),
      "Title\n Alpha & beta",
    );
  });
});
