import { assert } from "chai";
import { createImportIdentifiersTool } from "../src/agent/tools/write/importIdentifiers";

describe("import_identifiers rejects page URLs", function () {
  it("validation fails with a message naming the DOI/arXiv alternative", function () {
    const tool = createImportIdentifiersTool({} as any);
    const v = tool.validate({
      identifiers: ["https://www.nature.com/articles/s41586-020-2649-2"],
    });
    assert.isFalse(v.ok);
    assert.match((v as any).error, /DOI|arXiv/);
  });

  it("still accepts a URL that carries a DOI, which the importer extracts", function () {
    const tool = createImportIdentifiersTool({} as any);
    const v = tool.validate({
      identifiers: ["https://doi.org/10.1038/s41586-020-2649-2"],
    });
    assert.isTrue(v.ok);
  });

  it("still accepts bare identifiers", function () {
    const tool = createImportIdentifiersTool({} as any);
    const v = tool.validate({
      identifiers: ["10.1234/example", "arXiv:2301.00001", "2301.00001"],
    });
    assert.isTrue(v.ok);
  });
});
