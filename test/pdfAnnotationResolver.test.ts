import { assert } from "chai";
import { resolveHighlightInReader } from "../src/services/pdf/pdfAnnotationResolver";

function readerFor(linesByPage: string[][]) {
  const pages = linesByPage.map((lines) => ({
    chars: lines.flatMap((line, lineIndex) =>
      Array.from(line).map((c, i) => ({
        c,
        inlineRect: [
          20 + i * 5,
          700 - lineIndex * 20,
          25 + i * 5,
          712 - lineIndex * 20,
        ],
        lineBreakAfter: i === line.length - 1,
      })),
    ),
  }));
  return {
    _internalReader: {
      _primaryView: {
        _pdfPages: pages,
        _iframeWindow: {
          PDFViewerApplication: {
            pdfDocument: { numPages: pages.length, fingerprints: ["fixture"] },
          },
        },
        _ensureBasicPageData: async () => undefined,
        getAnnotationMeta: () => ({ sortIndex: "00000|000000|00080" }),
        _getAnnotationFromSelectionRanges: ([range]: any[]) => ({
          ...range,
          pageLabel: String(range.pageIndex + 1),
        }),
      },
    },
  };
}

async function refusal(reader: any, input: any) {
  try {
    await resolveHighlightInReader(reader, input);
    assert.fail("expected refusal");
  } catch (error) {
    return String(error);
  }
}

describe("native PDF passage resolution", function () {
  it("finds wrapped text and keeps each line's actual endpoint", async function () {
    const result = await resolveHighlightInReader(
      readerFor([["Our conclusion is", "supported."]]),
      {
        attachmentId: 1,
        text: "Our conclusion is supported.",
      },
    );
    assert.deepEqual(result.position.rects, [
      [20, 700, 105, 712],
      [20, 680, 70, 692],
    ]);
    assert.equal(result.text, "Our conclusion is supported.");
    assert.deepEqual(result.source, {
      documentFingerprint: "fixture",
      startChar: 0,
      endChar: 27,
    });
  });
  it("maps layout hyphenation and ligatures back to native character offsets", async function () {
    const result = await resolveHighlightInReader(
      readerFor([["A repre-", "sentation of ﬁsh."]]),
      {
        attachmentId: 1,
        text: "A representation of fish.",
      },
    );
    assert.lengthOf(result.position.rects, 2);
    assert.equal(result.source.startChar, 0);
    assert.equal(result.source.endChar, 25);
  });
  it("refuses ambiguous text and permits explicit page and occurrence", async function () {
    const reader = readerFor([
      ["Repeated result.", "Repeated result."],
      ["Repeated result."],
    ]);
    assert.include(
      await refusal(reader, { attachmentId: 1, text: "Repeated result." }),
      "3 matches",
    );
    const result = await resolveHighlightInReader(reader, {
      attachmentId: 1,
      text: "Repeated result.",
      pageIndex: 0,
      occurrence: 2,
    });
    assert.deepEqual(result.position.rects, [[20, 680, 100, 692]]);
  });
  it("refuses partial matches, invalid pages, missing geometry and unsupported readers", async function () {
    const reader = readerFor([["The complete result."]]);
    assert.include(
      await refusal(reader, {
        attachmentId: 1,
        text: "The complete result and more.",
      }),
      "not found",
    );
    assert.include(
      await refusal(reader, { attachmentId: 1, text: "result", pageIndex: 7 }),
      "outside",
    );
    reader._internalReader._primaryView._pdfPages[0].chars[0].inlineRect = [
      0, 0, 0, 0,
    ];
    assert.include(
      await refusal(reader, { attachmentId: 1, text: "The complete result." }),
      "geometry",
    );
    assert.include(
      await refusal({}, { attachmentId: 1, text: "result" }),
      "does not expose",
    );
  });
  it("uses PDF user-space rectangles unchanged on rotated/cropped pages", async function () {
    const reader = readerFor([["XY"]]);
    const chars = reader._internalReader._primaryView._pdfPages[0].chars;
    chars[0].inlineRect = [80, 120, 92, 126];
    chars[1].inlineRect = [80, 126, 92, 132];
    const result = await resolveHighlightInReader(reader, {
      attachmentId: 1,
      text: "XY",
    });
    assert.deepEqual(result.position.rects, [[80, 120, 92, 132]]);
  });
});
