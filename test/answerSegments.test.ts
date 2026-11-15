import { assert } from "chai";
import {
  classifyStreamedText,
  isSubstantiveAnswerText,
  withoutLeadingRepeat,
} from "../src/agent/finalization/answerSegments";

const LEAD_IN_86 =
  "I'll start by reading all twelve papers in overview mode to gather their full text.";
const LEAD_IN_89 =
  "Skill loaded. Now let me read every paper in the folder before writing the summaries.";
function perPaperSummaries(): string {
  const parts = ["## Per-paper summaries", ""];
  for (let index = 1; index <= 12; index += 1) {
    parts.push(`**${index}. Author${index} et al. (202${index % 10})**`, "");
    parts.push(
      `This study recorded from ${100 + index} neurons over ${10 + index} days and reports that representational drift grew with time while population decoding stayed above chance; the authors argue that ${"stable readout ".repeat(41)}remains possible.`,
      "",
    );
  }
  return parts.join("\n");
}

describe("answerSegments", function () {
  it("rolls back the two recorded lead-ins and keeps the recorded summaries", function () {
    assert.isAtMost(LEAD_IN_86.length, 120);
    assert.isAtMost(LEAD_IN_89.length, 120);
    assert.isFalse(isSubstantiveAnswerText(LEAD_IN_86));
    assert.isFalse(isSubstantiveAnswerText(LEAD_IN_89));
    const summaries = perPaperSummaries();
    assert.isAbove(summaries.length, 10_000);
    assert.isTrue(isSubstantiveAnswerText(summaries));
    assert.equal(classifyStreamedText(summaries).reason, "heading");
  });

  it("keeps structure from 320 characters with two paragraphs or a citation, tables at any length, and plain text from 400", function () {
    const body =
      "A finding the reader needs, stated in a full sentence. ".repeat(3);
    assert.equal(
      classifyStreamedText(`## Findings\n\n${body}\n\n${body}`).reason,
      "heading",
    );
    assert.equal(
      classifyStreamedText(`- first: ${body}\n\n- second: ${body}`).reason,
      "list",
    );
    assert.equal(
      classifyStreamedText(`- first: ${body} [[quote:q1]]\n- second: ${body}`)
        .reason,
      "list",
      "one paragraph with a citation is content",
    );
    assert.equal(
      classifyStreamedText("| a | b |\n|---|---|\n| 1 | 2 |").reason,
      "table",
    );
    assert.equal(
      classifyStreamedText(`**1. Smith (2021)**\n\n${body}\n\n${body}`).reason,
      "bold_numbered",
    );
    // One paragraph of structure without a citation is a plan, not content.
    assert.equal(
      classifyStreamedText(`- first: ${body}\n- second: ${body}`).reason,
      "lead_in",
    );
    // Structure below 320 characters is a plan even with two paragraphs.
    assert.equal(
      classifyStreamedText(`## Findings\n\n${body}`).reason,
      "lead_in",
    );
    assert.equal(classifyStreamedText("x".repeat(400)).reason, "length");
    assert.equal(classifyStreamedText("x".repeat(399)).reason, "lead_in");
    assert.equal(classifyStreamedText("   \n").reason, "lead_in");
  });

  it("rolls back an opening plan written as a numbered list", function () {
    const plan =
      "I'll help you compare these two papers on representational drift. Let me start by:\n\n1. Searching your library for both papers\n2. Reading each paper's methods and results\n3. Comparing their main findings";
    // The recorded plan was 201 characters: past the old 160 floor.
    assert.isAtLeast(plan.length, 200);
    assert.equal(classifyStreamedText(plan).reason, "lead_in");
    assert.isFalse(isSubstantiveAnswerText(plan));
  });

  it("rolls back short structured lead-ins", function () {
    for (const leadIn of [
      "I'll do two things:\n- read the papers\n- write the note",
      "## Plan\nRead first.",
      "**1. Read the paper**",
      "## Findings\n\nOne line.",
    ]) {
      assert.isBelow(leadIn.trim().length, 320);
      assert.equal(classifyStreamedText(leadIn).reason, "lead_in", leadIn);
    }
  });

  it("does not treat a single list item or a lone bold word as structure", function () {
    assert.isFalse(isSubstantiveAnswerText("- reading the paper now"));
    assert.isFalse(isSubstantiveAnswerText("**Note:** reading now"));
  });
});

describe("withoutLeadingRepeat", function () {
  const prefix = "## Summaries\n\n**1. Smith**\n\nDrift grows.\n\n";
  it("cuts an exact, a whitespace-shifted or a citation-carrying repeat", function () {
    assert.equal(withoutLeadingRepeat(`${prefix}Next.`, prefix), "Next.");
    assert.equal(
      withoutLeadingRepeat(
        "## Summaries\n**1. Smith**\nDrift grows.\nNext.",
        prefix,
      ),
      "Next.",
    );
    assert.equal(
      withoutLeadingRepeat(
        "## Summaries **1. Smith** Drift grows. [[cite:c1]] [[quote:q2]]\n\nNext.",
        prefix,
      ),
      "Next.",
    );
  });
  it("leaves text that does not start with the prefix untouched", function () {
    assert.equal(
      withoutLeadingRepeat("## Review\n\nNext.", prefix),
      "## Review\n\nNext.",
    );
    assert.equal(withoutLeadingRepeat("Next.", ""), "Next.");
    assert.equal(withoutLeadingRepeat("## Summaries", prefix), "## Summaries");
  });
});
