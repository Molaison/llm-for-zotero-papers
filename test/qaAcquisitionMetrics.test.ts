import { assert } from "chai";
import { measureAcquisition } from "./helpers/qaAcquisitionMetrics";

describe("acquisition evaluation metrics", function () {
  const entry = {
    evidence: ["24 sensors"],
    relevant: { lyra: ["Methods"] },
    onlySections: ["Methods"],
    acceptableFirstModes: ["targeted"],
  };
  const refs = [{ contextItemId: 10 }];
  const sources = [{ id: "lyra" }];
  const passage = (text: string, sectionLabel: string) => ({
    paperContext: { contextItemId: 10 },
    text,
    sectionLabel,
  });
  const call = (id: string, mode = "targeted") => ({
    type: "tool_call",
    callId: id,
    name: "paper_read",
    args: { mode },
  });
  const result = (id: string, results: unknown[], extras = {}) => ({
    type: "tool_result",
    callId: id,
    name: "paper_read",
    content: { results, ...extras },
  });
  it("does not count duplicate serialization or quote metadata as retrieved evidence", function () {
    const p = passage("We deployed 24 sensors.", "Methods");
    const m = measureAcquisition(
      entry,
      [
        call("1"),
        result("1", [p], {
          papers: [{ paperContext: p.paperContext, passages: [p] }],
          quoteCitations: [{ quoteText: "unretrieved text" }],
        }),
      ],
      refs,
      sources,
    );
    assert.equal(m.units, 1);
    assert.equal(m.found, 1);
    assert.equal(m.firstReadFound, 1);
    assert.equal(m.relevantUnits, 1);
    assert.equal(m.scopeCompliant, true);
  });
  it("separates initial miss, eventual recall, and irrelevant delivered text", function () {
    const m = measureAcquisition(
      entry,
      [
        call("1"),
        result("1", [
          passage("Earlier studies used 96 sensors.", "Related work"),
        ]),
        call("2"),
        result("2", [passage("We used 24 sensors.", "Methods")]),
      ],
      refs,
      sources,
    );
    assert.equal(m.firstReadFound, 0);
    assert.equal(m.found, 1);
    assert.equal(m.units, 2);
    assert.equal(m.relevantUnits, 1);
    assert.equal(m.scopeCompliant, false);
  });
  it("scores overview sections separately instead of calling the entire paper relevant", function () {
    const m = measureAcquisition(
      entry,
      [
        call("1", "overview"),
        result("1", [
          passage(
            "# Title\n\n## Methods\nWe used 24 sensors.\n\n## Telemetry\nNetwork delivery was 97%.",
            "",
          ),
        ]),
      ],
      refs,
      sources,
    );
    assert.equal(m.units, 2);
    assert.equal(m.relevantUnits, 1);
    assert.equal(m.routeCompliant, false);
  });
  it("does not infer no-retrieval success from a non-paper external tool", function () {
    const m = measureAcquisition(
      {
        ...entry,
        evidence: [],
        relevant: {},
        onlySections: undefined,
        acceptableFirstModes: ["none"],
      },
      [
        {
          type: "tool_call",
          name: "library_retrieve",
          workCategory: "retrieval",
          args: {},
        },
      ],
      refs,
      sources,
    );
    assert.equal(m.routeCompliant, false);
    assert.equal(m.retrievalCalls, 1);
  });
  it("does not give wrong-paper passages relevance credit", function () {
    const m = measureAcquisition(
      entry,
      [
        call("1"),
        result("1", [
          {
            ...passage("24 sensors", "Methods"),
            paperContext: { contextItemId: 99 },
          },
        ]),
      ],
      refs,
      sources,
    );
    assert.equal(m.relevantUnits, 0);
    assert.equal(m.sourcesCovered, 0);
  });
  it("counts page text recovered after a ranked miss without inventing section labels", function () {
    const m = measureAcquisition(
      entry,
      [
        call("1"),
        result("1", [
          passage("Earlier studies used 96 sensors.", "Related work"),
        ]),
        call("2", "visual"),
        {
          type: "tool_result",
          callId: "2",
          name: "paper_read",
          content: { pageTexts: { "2": "Methods: We deployed 24 sensors." } },
        },
      ],
      refs,
      sources,
    );
    assert.equal(m.firstReadFound, 0);
    assert.equal(m.found, 1);
    assert.equal(m.units, 1);
    assert.equal(m.relevantUnits, 0);
    assert.isAbove(m.pageTextCharacters, 0);
  });
});
