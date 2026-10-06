import { assert } from "chai";
import {
  __setMarkdownParserDisabledForTest,
  renderMarkdown,
  renderMarkdownForNote,
} from "../src/utils/markdown";

/**
 * A tilde in model text usually means "about". GFM in marked also reads a
 * pair of single tildes as strikethrough, which struck through everything
 * between "~2 days" and "~1 month" in a note the live run saved. Only a
 * doubled tilde strikes text through.
 */
describe("markdown tildes", function () {
  for (const [name, render] of [
    ["chat", renderMarkdown],
    ["note", renderMarkdownForNote],
  ] as const) {
    it(`${name}: a single tilde is never strikethrough`, function () {
      // "(~" closes a single-tilde pair in GFM: this is the live shape.
      const html = render(
        "Turnover takes about ~2 days, and the field moves (~5 cm).",
      );
      assert.notInclude(html, "<del");
      assert.include(html, "~2 days");
      assert.include(html, "(~5 cm)");
    });

    it(`${name}: a doubled tilde strikes text through as before`, function () {
      assert.include(render("Keep ~~this~~ out."), "<del>this</del>");
    });

    it(`${name}: approximate values stay literal`, function () {
      const html = render(
        "Rates were ~0.5 Hz (≈ baseline), rose (~10%) after (~2 days).",
      );
      assert.notInclude(html, "<del");
      for (const literal of ["~0.5 Hz", "≈ baseline", "(~10%)", "(~2 days)"]) {
        assert.include(html, literal);
      }
    });
  }

  it("note: the live summary's two tildes stay literal", function () {
    const html = renderMarkdownForNote(
      "Fast turnover of untuned inputs (characteristic time-scale ~2 days), which shifts overall excitability, and much slower change in tuned CA3 inputs (~1 month), which drifts place-field location.",
    );
    assert.notInclude(html, "<del");
    assert.include(html, "(characteristic time-scale ~2 days), which shifts");
    assert.include(html, "inputs (~1 month), which drifts");
  });

  it("leaves tildes inside code alone", function () {
    assert.include(
      renderMarkdownForNote("Run `a~b~c` now."),
      "<code>a~b~c</code>",
    );
  });

  it("the fallback renderer reads a single tilde literally too", function () {
    __setMarkdownParserDisabledForTest(true);
    try {
      const html = renderMarkdownForNote("about ~2 days and ~5 cm");
      assert.notInclude(html, "<del");
      assert.include(html, "~2 days");
    } finally {
      __setMarkdownParserDisabledForTest(false);
    }
  });
});
