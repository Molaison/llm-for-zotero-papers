import { assert } from "chai";
import { buildAssistantDisplayMarkdownForRender } from "../src/modules/contextPanel/assistantRichText";
import { buildRenderedMarkdownClipboardPayload } from "../src/modules/contextPanel/chat";
import {
  formatReceiptStatus,
  stripReceiptStatusForDisplay,
} from "../src/agent/contracts/actionEvaluation";
import type { AgentActionReceipt } from "../src/agent/contracts/types";

/**
 * The action-status block is written for the model, not for the reader.
 *
 * The runtime appends it to one string that reaches the transcript, the
 * correction channel and the answer bubble at once. The reader gets the same
 * facts from the trace's summary card, so the block is removed where the
 * answer is rendered and nowhere else: the persisted answer, the transcript
 * and the correction text must still carry it verbatim.
 */
describe("assistant rich text action-status block", function () {
  const receipt = (
    overrides: Partial<AgentActionReceipt> = {},
  ): AgentActionReceipt =>
    ({
      version: 2,
      id: "note_create:new:result",
      proposalId: "note_create:new",
      proofDomain: "zotero_state",
      capability: "zotero.notes",
      operation: "note_create",
      verification: "verified",
      status: "applied",
      requestedTargets: ["item:41"],
      appliedTargets: ["item:41"],
      alreadySatisfiedTargets: [],
      rejectedTargets: [],
      reasons: [],
      verifiedFacts: ["created_note:item:77"],
      ...overrides,
    }) as AgentActionReceipt;

  it("removes the block from the rendered answer while the message keeps it", function () {
    const block = formatReceiptStatus([receipt()]);
    const message = { text: `Saved the summary as a note.\n\n${block}` };

    const rendered = buildAssistantDisplayMarkdownForRender(message);

    assert.notInclude(rendered, "[Action status:");
    assert.equal(rendered.trim(), "Saved the summary as a note.");
    assert.include(
      message.text,
      "[Action status:",
      "the persisted answer is unchanged",
    );
  });

  it("removes every receipt line of a multi-receipt block", function () {
    const block = formatReceiptStatus([
      receipt(),
      receipt({
        id: "apply_tags:1:result",
        operation: "apply_tags",
        capability: "zotero.tags",
        status: "partial",
        verification: "execution_only",
      }),
    ]);
    assert.equal(block.split("\n").length, 2);

    const rendered = buildAssistantDisplayMarkdownForRender({
      text: `Done.\n\n${block}`,
    });

    assert.notInclude(rendered, "[Action status:");
    assert.equal(rendered.trim(), "Done.");
  });

  it("removes a block that is still arriving in the streaming render path", function () {
    const rendered = buildAssistantDisplayMarkdownForRender({
      text: "Done.\n\n[Action status: note_create — applied 1/1; Verifi",
      streaming: true,
    });

    assert.notInclude(rendered, "[Action status:");
    assert.equal(rendered.trim(), "Done.");
  });

  it("removes a block a trailing newline follows", function () {
    const block = formatReceiptStatus([receipt()]);

    assert.equal(
      stripReceiptStatusForDisplay(`Done.\n\n${block}\n`),
      "Done.",
      "a trailing break must not hide the block from the strip",
    );
  });

  it("keeps an action-status line the answer itself quotes", function () {
    const quoted =
      "The previous turn reported:\n\n" +
      "```\n[Action status: note_create — applied 1/1; Verified; proof:zotero_state]\n```\n\n" +
      "That block is documentation, not a receipt.";

    const rendered = buildAssistantDisplayMarkdownForRender({ text: quoted });

    assert.include(rendered, "[Action status: note_create");
  });

  it("keeps the block out of a copied response", function () {
    const block = formatReceiptStatus([receipt()]);

    const payload = buildRenderedMarkdownClipboardPayload(
      `Saved the summary as a note.\n\n${block}`,
    );

    assert.isNotNull(payload);
    assert.notInclude(payload!.plainText, "[Action status:");
    assert.notInclude(payload!.renderedHtml, "[Action status:");
    assert.equal(payload!.plainText, "Saved the summary as a note.");
  });

  it("leaves an answer with no block untouched", function () {
    assert.equal(
      stripReceiptStatusForDisplay("No actions were needed."),
      "No actions were needed.",
    );
    assert.equal(stripReceiptStatusForDisplay(""), "");
  });
});
