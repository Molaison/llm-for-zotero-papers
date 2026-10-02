import { assert } from "chai";
import { createNoteWriteTool } from "../src/agent/tools/write/noteWrite";
import { buildAgentInitialMessages } from "../src/agent/model/messageBuilder";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";

const before =
  "<h2>Methodology</h2><ul><li>First method.</li><li>Second method.</li><li>Third method.</li></ul><p>Keep this.</p>";
function fixture(
  html = before,
  selected = "First method.\nSecond method.\nThird method.",
) {
  const tool = createNoteWriteTool({
    getActiveNoteSnapshot: () => ({
      noteId: 55,
      libraryID: 1,
      title: "Note",
      html,
      text: html,
      noteKind: "standalone",
    }),
  } as never);
  const request = resolvedAgentRequest({
    conversationKey: 55,
    libraryID: 1,
    mode: "agent",
    userText: "rewrite this part",
    activeItemId: 55,
    activeNoteContext: {
      noteId: 55,
      title: "Note",
      noteKind: "standalone",
      noteText: html,
      noteHtml: html,
    },
    selectedTexts: [selected],
    selectedTextSources: ["note-edit"],
    selectedTextNoteContexts: [
      {
        noteItemId: 55,
        noteItemKey: "NOTE55",
        libraryID: 1,
        noteKind: "standalone",
        title: "Note",
      },
    ],
  });
  const context = {
    request,
    runId: "selection-unit",
    item: null,
    modelName: "test",
    currentAnswerText: "",
  } as never;
  return { tool, context, request };
}

describe("selected note replacement contract", function () {
  it("binds selected text once and prepares structural replacement without copying find or the whole note", async function () {
    const { tool, context } = fixture();
    const input = tool.validate({
      mode: "edit",
      selection: { index: 1, replacement: "Revised method." },
    });
    assert.isTrue(input.ok);
    if (!input.ok) return;
    await tool.planInvocation(input.value, context);
    assert.equal(input.value.noteId, 55);
    assert.equal(input.value.expectedOriginalHtml, before);
    assert.include(input.value._patchedHtml, "<p>Revised method.</p>");
    assert.notInclude(input.value._patchedHtml, "<li>");
    assert.include(input.value._patchedHtml, "<h2>Methodology</h2>");
    assert.include(input.value._patchedHtml, "<p>Keep this.</p>");
  });
  it("never tells a supplied-prose note edit to read paper evidence", async function () {
    const { request } = fixture();
    const messages = await buildAgentInitialMessages({ ...request }, [], []);
    const text = JSON.stringify(messages);
    assert.notInclude(text, "Use paper_read mode");
    assert.notInclude(text, "TURN RULE");
  });
});

import {
  replaceNoteSelectionHtml,
  replaceTextContentInHtml,
} from "../src/utils/noteEdit";
import { noteHtmlMatches } from "../src/utils/noteHtml";
import { AgentToolRegistry } from "../src/agent/tools/registry";

describe("native selection structure and boundaries", function () {
  for (const [label, html, selected, replacement, expected] of [
    [
      "heading and bullets",
      before,
      "Methodology\nFirst method.\nSecond method.\nThird method.",
      "<h2>Methodology</h2><p>Revised.</p>",
      "<h2>Methodology</h2><p>Revised.</p><p>Keep this.</p>",
    ],
    [
      "middle ordered list items",
      '<ol start="3"><li>Keep A.</li><li>First.</li><li>Second.</li><li>Keep B.</li></ol>',
      "First.\nSecond.",
      "<p>Revised.</p>",
      '<ol start="3"><li>Keep A.</li></ol><p>Revised.</p><ol start="6"><li>Keep B.</li></ol>',
    ],
    [
      "inline style and Unicode",
      "<p><strong>Keep A &amp; 🧠. Revise this.</strong> Keep B.</p>",
      "Revise this.",
      "<p>Better.</p>",
      "<p><strong>Keep A &amp; 🧠. Better.</strong> Keep B.</p>",
    ],
    [
      "Markdown within a sentence",
      "<p>Before old text after.</p>",
      "old text",
      "<p><em>new text</em></p>",
      "<p>Before <em>new text</em> after.</p>",
    ],
    [
      "partial blocks",
      "<p>Keep A. First.</p><p>Second. Keep B.</p>",
      "First.\nSecond.",
      "<p>Revised.</p>",
      "<p>Keep A. </p><p>Revised.</p><p> Keep B.</p>",
    ],
    [
      "image outside selection",
      '<p><img data-attachment-key="ABC12345"></p><ul><li>First.</li><li>Second.</li></ul><p>Keep.</p>',
      "First.\nSecond.",
      "<p>Revised.</p>",
      '<p><img data-attachment-key="ABC12345"></p><p>Revised.</p><p>Keep.</p>',
    ],
    [
      "image inside text selection",
      '<p>First.<img data-attachment-key="ABC12345"></p><p>Second.</p><p>Keep.</p>',
      "First.\nSecond.",
      "<p>Revised.</p>",
      '<p><img data-attachment-key="ABC12345"></p><p>Revised.</p><p>Keep.</p>',
    ],
  ]) {
    it(`preserves ${label}`, function () {
      const result = replaceNoteSelectionHtml(html, selected, replacement);
      assert.isNotNull(result);
      assert.isTrue(noteHtmlMatches(result!, expected), result!);
    });
  }
  for (const html of [
    "<p>Repeated.</p><p>Repeated.</p>",
    "<p>Unrelated.</p>",
  ]) {
    it("rejects ambiguous or missing selections before preparing a write", function () {
      assert.isNull(replaceNoteSelectionHtml(html, "Repeated.", "<p>New.</p>"));
    });
  }
  it("rejects a target different from the selected note", async function () {
    const { tool, context } = fixture();
    const input = tool.validate({
      mode: "edit",
      targetNoteId: 66,
      selection: { index: 1, replacement: "New." },
    });
    assert.isTrue(input.ok);
    if (!input.ok) return;
    try {
      await tool.planInvocation(input.value, context);
      assert.fail("must reject");
    } catch (error) {
      assert.include(String(error), "must belong to the target note");
    }
  });
  it("rejects selection context from a PDF as an editing target", async function () {
    const { tool, context, request } = fixture();
    request.selectedTextContexts = request.selectedTextContexts!.map((c) => ({
      ...c,
      source: "pdf",
    }));
    const input = tool.validate({
      mode: "edit",
      selection: { index: 1, replacement: "New." },
    });
    if (!input.ok) return assert.fail(input.error);
    try {
      await tool.planInvocation(input.value, context);
      assert.fail("must reject");
    } catch (error) {
      assert.include(String(error), "must belong to the target note");
    }
  });
  it("keeps direct read, clarification, and document tools available for a note edit", function () {
    const registry = new AgentToolRegistry();
    for (const name of [
      "note_write",
      "library_read",
      "request_user_input",
      "paper_read",
      "library_search",
      "submit_document",
    ])
      registry.register({
        spec: {
          name,
          description: name,
          inputSchema: { type: "object" },
          executionClass: "read",
        },
        validate: () => ({ ok: true, value: {} }),
        execute: async () => ({}),
      } as never);
    const { request } = fixture();
    assert.deepEqual(
      registry.listToolsForRequest(request).map((t) => t.name),
      [
        "note_write",
        "library_read",
        "request_user_input",
        "paper_read",
        "library_search",
        "submit_document",
      ],
    );
  });
});

describe("verified selection edit completion", function () {
  it("returns a verified note edit to the model instead of ending the turn from its receipt", function () {
    // The receipt-only shortcut needed a classifier-produced semantic intent
    // outside a Plan; no current producer creates that combination.
    const { tool } = fixture();
    assert.isUndefined(tool.resolveTerminalResult);
  });
});

describe("selection recovery and embedded content", function () {
  it("does not leave empty bullets in a text patch that crosses an embedded image", function () {
    const html =
      '<ul><li><strong>First.</strong><img data-attachment-key="IMAGE123"></li><li>Second.</li></ul><p>Keep.</p>';
    const result = replaceTextContentInHtml(
      html,
      "First.\nSecond.",
      "Revised.",
    );
    assert.isTrue(
      noteHtmlMatches(
        result!,
        '<ul><li><strong>Revised.</strong><img data-attachment-key="IMAGE123"></li></ul><p>Keep.</p>',
      ),
      result!,
    );
  });
  it("escapes every HTML-significant character in replacement text", function () {
    const result = replaceTextContentInHtml(
      "<p>Replace me.</p>",
      "Replace me.",
      "a & b < c > d \" e ' f",
    );
    assert.strictEqual(
      result,
      "<p>a &amp; b &lt; c &gt; d &quot; e &#39; f</p>",
    );
  });
  it("rejects a note changed since selection instead of rebasing the edit", async function () {
    const { tool, context, request } = fixture();
    request.activeNoteContext!.noteHtml = before.replace(
      "Keep this.",
      "Older surrounding text.",
    );
    const input = tool.validate({
      mode: "edit",
      selection: { index: 1, replacement: "New." },
    });
    if (!input.ok) return assert.fail(input.error);
    try {
      await tool.planInvocation(input.value, context);
      assert.fail("must reject");
    } catch (error) {
      assert.include(String(error), "changed after the text was selected");
    }
  });
});

describe("table structure boundaries", function () {
  it("keeps a selected cell in its row and preserves the other columns", function () {
    const before =
      "<table><tbody><tr><td>First.</td><td>Keep.</td></tr></tbody></table>";
    const after = replaceNoteSelectionHtml(before, "First.", "<p>Revised.</p>");
    assert.isTrue(
      noteHtmlMatches(
        after!,
        "<table><tbody><tr><td><p>Revised.</p></td><td>Keep.</td></tr></tbody></table>",
      ),
      after!,
    );
  });
  it("rejects a structural replacement spanning cells rather than splitting the table", function () {
    const before =
      "<table><tbody><tr><td><p>First.</p></td><td><p>Second.</p></td><td><p>Keep.</p></td></tr></tbody></table>";
    assert.throws(
      () =>
        replaceNoteSelectionHtml(before, "First.\nSecond.", "<p>Combined.</p>"),
      /table cells/,
    );
  });
  it("keeps table cells when a precise text patch consumes their text", function () {
    const before =
      "<table><tbody><tr><td><p>First.</p></td><td><p>Second.</p></td><td><p>Third.</p></td><td><p>Keep.</p></td></tr></tbody></table>";
    const after = replaceTextContentInHtml(
      before,
      "First.\nSecond.\nThird.",
      "Combined.",
    );
    assert.isTrue(
      noteHtmlMatches(
        after!,
        "<table><tbody><tr><td><p>Combined.</p></td><td></td><td></td><td><p>Keep.</p></td></tr></tbody></table>",
      ),
      after!,
    );
  });
});
