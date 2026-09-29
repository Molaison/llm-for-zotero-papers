import { assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

describe("workflow: background conversation activity", function () {
  this.timeout(60000);
  let api: WorkflowTestApi;
  let fixture: Awaited<
    ReturnType<WorkflowTestApi["createPaperWithPdfFixture"]>
  >;
  let win: Window;

  async function waitFor<T>(read: () => T | null | false): Promise<T> {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const result = read();
      if (result) return result;
      await Zotero.Promise.delay(25);
    }
    throw new Error("History activity UI did not settle");
  }

  beforeEach(async function () {
    api = (Zotero as any).LLMForZotero.api.workflowTest;
    await api.reset();
    fixture = await api.createPaperWithPdfFixture({
      title: "History activity",
      pdfTitle: "History activity PDF",
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

  it("keeps the background run visible in the sidebar and open dropdown without moving the selected chat", async function () {
    await api.clickStandaloneTab("open");
    await api.seedStandaloneConversation([
      { role: "user", text: "Read this earlier library conversation" },
      { role: "assistant", text: "Earlier paragraph.\n\n".repeat(120) },
    ]);
    const otherKey = (await api.getStandaloneDiagnostics()).conversationKey;
    const doc = win.document;
    doc
      .querySelector<HTMLButtonElement>('[data-sidebar-action="new-chat"]')!
      .click();
    await waitFor(() => {
      const key = doc.querySelector<HTMLElement>("#llm-main")?.dataset.itemId;
      return key && key !== String(otherKey) ? key : null;
    });
    await api.seedStandaloneConversation([
      { role: "user", text: "Background library activity" },
      { role: "assistant", text: "Ready for the next request." },
    ]);
    const runningKey = (await api.getStandaloneDiagnostics()).conversationKey;
    const rowSelector = `.llm-standalone-conv-item[data-conversation-key="${runningKey}"]`;
    const readSpinner = (root: ParentNode) =>
      root.querySelector<HTMLElement>(".llm-history-activity");
    let selectedView: {
      box: HTMLElement;
      message: Element | null;
      scrollTop: number;
    };

    await api.withPendingStandaloneSend(
      "Continue the background task",
      async () => {
        const row = await waitFor(() =>
          doc.querySelector<HTMLElement>(rowSelector),
        );
        const indicator = readSpinner(row)!;
        assert.isFalse(indicator.hidden);
        assert.equal(
          win.getComputedStyle(indicator)!.animationName,
          "llm-plan-progress-spin",
        );
        const otherRow = await waitFor(() =>
          doc.querySelector<HTMLElement>(
            `.llm-standalone-conv-item[data-conversation-key="${otherKey}"]`,
          ),
        );
        otherRow.click();
        await waitFor(() =>
          doc.querySelector<HTMLElement>(
            `#llm-main[data-item-id="${otherKey}"]`,
          ),
        ).catch(() => {
          throw new Error(
            JSON.stringify({
              expected: otherKey,
              runningKey,
              mounted:
                doc.querySelector<HTMLElement>("#llm-main")?.dataset.itemId,
              rowConnected: otherRow.isConnected,
              activeRow: doc.querySelector<HTMLElement>(
                ".llm-standalone-conv-item.active",
              )?.dataset.conversationKey,
              status: doc.querySelector("#llm-status")?.textContent,
            }),
          );
        });
        const box = doc.querySelector<HTMLElement>("#llm-chat-box")!;
        await waitFor(() => box.scrollHeight > box.clientHeight && box);
        doc.querySelector<HTMLButtonElement>("#llm-history-toggle")!.click();
        const menuRow = await waitFor(() =>
          doc.querySelector<HTMLElement>(
            `.llm-history-item[data-conversation-key="${runningKey}"]`,
          ),
        );
        assert.isFalse(readSpinner(menuRow)!.hidden);
        assert.isFalse(readSpinner(doc.querySelector(rowSelector)!)!.hidden);
        assert.isTrue(readSpinner(otherRow)!.hidden);
        // Let navigation and history-menu hydration finish before measuring
        // the effect of the background request's completion.
        await Zotero.Promise.delay(100);
        box.scrollTop = 120;
        box.dispatchEvent(new win.Event("scroll"));
        selectedView = {
          box,
          message: box.querySelector(".llm-message-wrapper"),
          scrollTop: box.scrollTop,
        };
      },
    );
    assert.isTrue(readSpinner(doc.querySelector(rowSelector)!)!.hidden);
    const completedMenuRow = doc.querySelector<HTMLElement>(
      `.llm-history-item[data-conversation-key="${runningKey}"]`,
    )!;
    assert.isTrue(readSpinner(completedMenuRow)!.hidden);
    assert.strictEqual(
      selectedView!.box.querySelector(".llm-message-wrapper"),
      selectedView!.message,
    );
    assert.closeTo(selectedView!.box.scrollTop, selectedView!.scrollTop, 1);
  });

  for (const [label, status] of [
    ["Working", "Reading the paper"],
    ["Planning", "Planning the request and reviewing context"],
    ["Executing plan", "Executing the approved plan"],
  ]) {
    it(`counts live elapsed time beside ${label} through redraw and completion`, async function () {
      const timestamp = Date.now();
      const seed = (streaming: boolean) =>
        api.seedStandaloneConversation([
          { role: "user", text: "Read the paper", timestamp: timestamp - 1000 },
          {
            role: "assistant",
            text: "",
            timestamp,
            waitingAnimationStartedAt: timestamp - 12_300,
            runMode: "agent",
            streaming,
            pendingAgentTraceEvents: [
              {
                runId: "workflow-working-shimmer",
                seq: 1,
                createdAt: timestamp,
                eventType: "status",
                payload: { type: "status", text: status },
              },
            ],
          },
        ]);
      await seed(true);
      const summary = win.document.querySelector<HTMLElement>(
        ".llm-agent-activity-summary",
      )!;
      const words = summary.querySelector<HTMLElement>(
        ".llm-agent-activity-label",
      )!;
      const elapsed = summary.querySelector<HTMLElement>(
        ".llm-agent-activity-elapsed",
      )!;
      assert.isNotNull(elapsed, "active status displays elapsed time");
      assert.equal(words.textContent, label);
      assert.match(elapsed.textContent!, /^\d+s$/);
      const initial = Number.parseFloat(elapsed.textContent!);
      assert.isAtLeast(
        initial,
        12,
        "uses the run start rather than mount time",
      );
      assert.equal(
        win.getComputedStyle(words)!.animationName,
        "llm-planning-text-shimmer",
      );
      assert.equal(
        win.getComputedStyle(summary, "::after")!.animationName,
        "none",
      );
      assert.notEqual(
        win.getComputedStyle(summary, "::after")!.color,
        "rgba(0, 0, 0, 0)",
      );
      assert.isNull(summary.querySelector(".llm-at-planning-drive"));
      assert.equal(win.getComputedStyle(elapsed)!.animationName, "none");
      assert.include(
        win.getComputedStyle(elapsed)!.fontVariantNumeric,
        "tabular-nums",
      );
      const height = summary.getBoundingClientRect().height;
      const box = win.document.querySelector<HTMLElement>("#llm-chat-box")!;
      const scrollTop = box.scrollTop;
      await Zotero.Promise.delay(1100);
      assert.isAbove(
        Number.parseFloat(elapsed.textContent!),
        initial,
        "ticks without another model event",
      );
      assert.strictEqual(
        win.document.querySelector(".llm-agent-activity-summary"),
        summary,
      );
      assert.equal(summary.getBoundingClientRect().height, height);
      assert.equal(box.scrollTop, scrollTop);
      const beforeRedraw = Number.parseFloat(elapsed.textContent!);
      api.refreshActiveConversationPanels(
        (await api.getStandaloneDiagnostics()).conversationKey!,
      );
      const remounted = win.document.querySelector<HTMLElement>(
        ".llm-agent-activity-elapsed",
      )!;
      assert.isAtLeast(Number.parseFloat(remounted.textContent!), beforeRedraw);
      await Zotero.Promise.delay(200);
      const detachedTime = elapsed.textContent;
      await Zotero.Promise.delay(200);
      assert.equal(elapsed.textContent, detachedTime, "detached timer stops");
      await seed(false);
      const completed = win.document.querySelector<HTMLElement>(
        ".llm-agent-activity-summary",
      )!;
      assert.match(
        completed.textContent || "",
        /^(Worked for|Planned in|Plan ran for) /,
      );
      assert.isNull(completed.querySelector(".llm-agent-activity-elapsed"));
      assert.equal(win.getComputedStyle(completed)!.animationName, "none");
      const completedText = completed.textContent;
      await Zotero.Promise.delay(200);
      assert.equal(completed.textContent, completedText);
    });
  }
});
