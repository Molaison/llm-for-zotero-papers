import { assert } from "chai";
import { getPdfPageTextContent } from "../src/services/pdf/pdfPageCapture";

describe("native PDF.js page text sandbox boundary", () => {
  const item = {str: "A: Source text", width: 220, height: 12, transform: [12, 0, 0, 12, 60, 655]};
  it("reads a normal document without changing source text or PDF coordinates", async () => {
    const content = await getPdfPageTextContent({pdfDocument: {
      async getPage(pageNumber: number) {
        assert.equal(pageNumber, 2);
        return {async getTextContent() {return {items: [item]};}};
      },
    }}, 2);
    assert.deepEqual(content.items, [item]);
  });
  it("unwraps document, hidden-then promises, page and text content before using them", async () => {
    const wrapped = (value: unknown) => ({wrappedJSObject: value});
    const page = {
      getTextContent() {
        assert.strictEqual(this, page);
        return wrapped(Promise.resolve(wrapped({items: wrapped([
          wrapped({...item, transform: wrapped(item.transform)}),
        ])})));
      },
    };
    const doc = {
      getPage(pageNumber: number) {
        assert.strictEqual(this, doc);
        assert.equal(pageNumber, 1);
        return wrapped(Promise.resolve(wrapped(page)));
      },
    };
    const content = await getPdfPageTextContent(wrapped({pdfDocument: wrapped(doc)}), 1);
    assert.deepEqual(content.items, [item]);
  });
  it("reports the actual missing page method rather than fabricating source context", async () => {
    let error: unknown;
    try {await getPdfPageTextContent({pdfDocument: {async getPage() {return {};}}}, 1);}
    catch (caught) {error = caught;}
    assert.instanceOf(error, Error);
    assert.include(String(error), "getTextContent=undefined, then=undefined");
  });
});
