import { assert } from "chai";
import { buildQuoteCitation } from "../src/services/quotes/quoteCitations";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

describe("workflow: duplicate quote rendering", function () {
  this.timeout(60000);

  it("shows one card before validation and after loading the stored mixed-syntax answer", async function () {
    assert.isTrue(Zotero.DataDirectory.dir.endsWith("/.scaffold/test/data"));
    const api = (Zotero as any).LLMForZotero.api
      .workflowTest as WorkflowTestApi;
    await api.reset();
    const quote =
      "Traditional dogmas assume that executing a stable behavior requires neural circuits to remain in a fixed, steady state.";
    const followingProse =
      "The problem is that chronic population imaging contradicts this premise.";
    const fixture = await api.createPaperWithPdfFixture({
      title: "Duplicate quote regression",
      pages: [quote],
    });
    try {
      const item = Zotero.Items.get(fixture.parentItemId);
      item.setCreators([
        { creatorType: "author", firstName: "Test", lastName: "Kim" },
      ]);
      item.setField("date", "2026");
      await item.saveTx();
      const citation = buildQuoteCitation({
        quoteText: quote,
        citationLabel: "(Kim, 2026)",
        sourceMatchText: quote,
        sourceMatchKind: "exact",
        sourceMatchSource: "context-text",
        itemId: item.id,
        contextItemId: fixture.pdfAttachmentId,
      })!;
      const markdown = `The paper sets up the paradox:\n\n> ${quote}\n\n(Kim, 2026)\n\n[[quote:${citation.id}]] ${followingProse}`;
      const panel = await api.renderPanelForItem(item.id);
      // Exercise the native renderer directly with the raw provider layout,
      // without first running the finalizer that already handles this pair.
      const rendered = await api.renderAssistantForPanel(panel.panelId, {
        text: markdown,
        quoteCitations: [citation],
      });
      assert.lengthOf(rendered.quoteCardCitationTexts, 1);
      assert.deepEqual(rendered.quoteCardBodies, [quote]);
      assert.include(rendered.renderedText, followingProse);

      await api.openStandaloneForItem(item.id);
      const seeded = await api.seedStandaloneConversation([
        { role: "user", text: "What is the main idea of this paper?" },
        { role: "assistant", text: markdown, quoteCitations: [citation] },
      ]);
      const conversationKey = seeded.conversationKey!;
      // The seed helper persists plain text only. Add the original quote
      // metadata to the native fixture database before reopening the answer.
      await Zotero.DB.queryAsync(
        "UPDATE llm_for_zotero_chat_messages SET quote_citations_json = ? WHERE conversation_key = ? AND role = 'assistant'",
        [JSON.stringify([citation]), conversationKey],
      );
      await api.reset();
      await api.openStandaloneForItem(item.id);
      const win = (Zotero as any).LLMForZotero.data.standaloneWindow as Window;
      const cards = win.document.querySelectorAll(".llm-quote-card");
      assert.lengthOf(cards, 1, "reopened raw history contains one quote card");
      assert.include(cards[0].textContent || "", quote);
      const button = cards[0].querySelector<HTMLElement>(".llm-citation-icon");
      assert.isOk(button, "the retained card preserves source navigation");
      assert.include(
        win.document.querySelector(".llm-standalone-content")?.textContent ||
          "",
        followingProse,
      );
      assert.deepEqual(
        await Zotero.DB.columnQueryAsync<string>(
          "SELECT text FROM llm_for_zotero_chat_messages WHERE conversation_key = ? AND role = 'assistant' ORDER BY id",
          [conversationKey],
        ),
        [markdown],
        "rendering does not rewrite stored history",
      );
      await api.captureStandaloneScreenshot(
        `${Zotero.DataDirectory.dir}/duplicate-quote-rendering.png`,
      );
    } finally {
      await api.reset();
      await api.cleanupFixture(fixture);
    }
  });
});
