import { assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

/**
 * Issue #481: switching to another conversation while a send is still
 * preparing must not cancel it. The send is stalled at the final-request
 * boundary (after context assembly, before provider dispatch), the user acts,
 * and the stall is released.
 */
const INTERCEPTED_TEXT = "Workflow request intercepted before dispatch.";
const QUESTION = "Keep preparing this question in the background";

describe("workflow: switching conversations during send preparation", function () {
  this.timeout(60000);
  let api: WorkflowTestApi;
  let fixture: Awaited<
    ReturnType<WorkflowTestApi["createPaperWithPdfFixture"]>
  >;
  let win: Window;

  async function waitFor<T>(
    read: () => T | null | false,
    label: string,
  ): Promise<T> {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const result = read();
      if (result) return result;
      await Zotero.Promise.delay(25);
    }
    throw new Error(`Timed out waiting for ${label}`);
  }

  async function lastAssistantText(conversationKey: number) {
    const history = await api.getConversationHistoryTexts(conversationKey);
    const assistants = history.memory.filter(
      (entry) => entry.role === "assistant",
    );
    return {
      text: assistants[assistants.length - 1]?.text,
      history,
    };
  }

  /** Two library conversations; the second is mounted and gets the send. */
  async function seedTwoConversations() {
    await api.clickStandaloneTab("open");
    await api.seedStandaloneConversation([
      { role: "user", text: "An unrelated earlier conversation" },
      { role: "assistant", text: "Unrelated earlier answer." },
    ]);
    const otherKey = (await api.getStandaloneDiagnostics()).conversationKey!;
    const doc = win.document;
    doc
      .querySelector<HTMLButtonElement>('[data-sidebar-action="new-chat"]')!
      .click();
    await waitFor(() => {
      const key = doc.querySelector<HTMLElement>("#llm-main")?.dataset.itemId;
      return key && key !== String(otherKey) ? key : null;
    }, "the new conversation to mount");
    await api.seedStandaloneConversation([
      { role: "user", text: "Earlier question in the sending conversation" },
      {
        role: "assistant",
        text: "Earlier answer in the sending conversation.",
      },
    ]);
    const sendingKey = (await api.getStandaloneDiagnostics()).conversationKey!;
    return { doc, otherKey, sendingKey };
  }

  beforeEach(async function () {
    api = (Zotero as any).LLMForZotero.api.workflowTest;
    await api.reset();
    fixture = await api.createPaperWithPdfFixture({
      title: "Background send switch",
      pdfTitle: "Background send switch PDF",
    });
    await api.openStandaloneForItem(fixture.parentItemId);
    await api.resizeStandaloneWindow(1000, 700);
    win = (Zotero as any).LLMForZotero.data.standaloneWindow;
  });

  afterEach(async function () {
    await api.closeStandalone();
    if (fixture) await api.cleanupFixture(fixture);
    await api.reset();
  });

  it("finishes the request for its own conversation after the user switches away", async function () {
    const { doc, otherKey, sendingKey } = await seedTwoConversations();
    assert.notEqual(otherKey, sendingKey);

    await api.withPendingStandaloneSend(QUESTION, async () => {
      const otherRow = await waitFor(
        () =>
          doc.querySelector<HTMLElement>(
            `.llm-standalone-conv-item[data-conversation-key="${otherKey}"]`,
          ),
        "the other conversation's sidebar row",
      );
      otherRow.click();
      await waitFor(
        () =>
          doc.querySelector<HTMLElement>(
            `#llm-main[data-item-id="${otherKey}"]`,
          ),
        "the other conversation to mount",
      );
    });

    assert.equal(api.getLastFinalRequest()?.prompt, QUESTION);

    const { text, history } = await lastAssistantText(sendingKey);
    assert.equal(
      text,
      INTERCEPTED_TEXT,
      `sending conversation history: ${JSON.stringify(history)}`,
    );
    assert.notInclude(
      history.stored.map((entry) => entry.text),
      "[Cancelled]",
    );

    // The panel now shows the other conversation and must not render the
    // background request's content or its cancellation.
    assert.equal(
      doc.querySelector<HTMLElement>("#llm-main")?.dataset.itemId,
      String(otherKey),
    );
    const chatBoxText =
      doc.querySelector<HTMLElement>("#llm-chat-box")?.textContent || "";
    assert.notInclude(chatBoxText, INTERCEPTED_TEXT);
    assert.notInclude(chatBoxText, QUESTION);
    assert.notInclude(chatBoxText, "[Cancelled]");
    const status = doc.querySelector("#llm-status")?.textContent || "";
    assert.notInclude(status, "Cancelled");
    const otherHistory = await api.getConversationHistoryTexts(otherKey);
    assert.notInclude(
      otherHistory.memory.map((entry) => entry.text),
      INTERCEPTED_TEXT,
    );
  });

  it("still cancels when the user presses Cancel during preparation", async function () {
    const { doc, sendingKey } = await seedTwoConversations();

    await api.withPendingStandaloneSend(QUESTION, async () => {
      const cancel = await waitFor(
        () => doc.querySelector<HTMLButtonElement>("#llm-cancel"),
        "the Cancel button",
      );
      cancel.click();
    });

    const { text, history } = await lastAssistantText(sendingKey);
    assert.equal(
      text,
      "[Cancelled]",
      `sending conversation history: ${JSON.stringify(history)}`,
    );
  });
});
