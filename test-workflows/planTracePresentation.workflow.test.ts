import { assert } from "chai";
import type { AgentRunEventRecord } from "../src/agent/types";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";
import { createDocumentPlan } from "../test/helpers/documentPlan";
import { PlanDocumentFinalizer } from "../src/agent/documents/planFinalization";
import type { ZoteroGateway } from "../src/agent/services/zoteroGateway";

describe("workflow: Plan trace presentation", function () {
  this.timeout(30000);

  it("replaces a pending publication card in place when delivery commits", async function () {
    const plan = await createDocumentPlan(Date.now());
    const { document } = await new PlanDocumentFinalizer(
      {} as ZoteroGateway,
    ).finalize({
      executionId: plan.executionId,
      activeTaskId: plan.activeTaskId!,
      input: {
        title: "Guide",
        markdown:
          "# Guide\n\n" +
          "A preserved review paragraph with source context.\n\n".repeat(400),
        citations: [],
        quotes: [],
        assets: [],
        groundingReviewed: "passed",
        groundingIssues: [],
      },
    });
    const api = (Zotero as any).LLMForZotero.api
      .workflowTest as WorkflowTestApi;
    const {
      root: trace,
      dispose,
      deliver,
    } = api.mountPublicationTrace(
      document.documentId,
      document.visibleMarkdown,
    );
    const second = api.mountPublicationTrace(
      document.documentId,
      document.visibleMarkdown,
    );
    try {
      const waitFor = async (predicate: () => boolean) => {
        for (let i = 0; i < 100 && !predicate(); i++)
          await Zotero.Promise.delay(20);
        assert.isTrue(predicate());
      };
      await waitFor(() => trace.textContent!.includes("Publishing document…"));
      const card = trace.querySelector(".llm-plan-document-card");
      await deliver(plan.conversationKey);
      await waitFor(() =>
        Boolean(trace.querySelector(".llm-plan-document-action-expand")),
      );
      assert.strictEqual(trace.querySelector(".llm-plan-document-card"), card);
      assert.notInclude(card!.textContent!, "Publishing document…");
      assert.include(card!.textContent!, "A preserved review paragraph");
      await waitFor(() =>
        Boolean(second.root.querySelector(".llm-plan-document-action-expand")),
      );
      (
        trace.querySelector(".llm-plan-document-action-expand") as HTMLElement
      ).click();
      let documentWindow: Window | undefined;
      await waitFor(() => {
        const windows = (Services as any).wm.getEnumerator(null);
        while (windows.hasMoreElements()) {
          const candidate = windows.getNext() as Window;
          if (
            candidate.document.querySelector(
              ".llm-plan-document-window-content",
            )
          )
            documentWindow = candidate;
        }
        return Boolean(documentWindow);
      });
      try {
        assert.include(
          documentWindow!.document.body?.textContent ||
            documentWindow!.document.documentElement.textContent!,
          "A preserved review paragraph",
        );
        assert.isAbove(documentWindow!.innerWidth, 0);
        assert.isFalse(documentWindow!.closed);
      } finally {
        documentWindow?.close();
      }
    } finally {
      dispose();
      second.dispose();
    }
  });

  it("gives expanded trace JSON a distinct, theme-relative code surface", async function () {
    const api = (Zotero as any).LLMForZotero.api
      .workflowTest as WorkflowTestApi;
    const fixture = await api.createPaperWithPdfFixture({
      title: "Trace code surface",
      pages: ["Disposable UI fixture."],
    });
    try {
      const panel = await api.renderPanelForItem(fixture.parentItemId);
      await api.seedPanelStoredTurn(panel.panelId, "Inspect research", "", {
        runMode: "agent",
        modelProviderLabel: "Codex",
        pendingAgentTraceEvents: [
          {
            runId: "code-surface",
            seq: 1,
            createdAt: 1,
            eventType: "codex_tool_activity",
            payload: {
              type: "codex_tool_activity",
              itemId: "research",
              phase: "completed",
              toolName: "research_update",
              args: { operation: "next_work", view: "full" },
            },
          },
        ],
      });
      const doc = Zotero.getMainWindow().document;
      const root = doc.querySelector<HTMLElement>(
        `[data-workflow-panel-id="${panel.panelId}"] .llm-panel`,
      )!;
      const card = root.querySelector<HTMLElement>(
        ".llm-agent-trace-code .llm-codeblock-shell",
      )!;
      assert.exists(card);
      assert.exists(
        card.querySelector(".hljs-attr"),
        "JSON keys are syntax highlighted",
      );
      for (const [surface, background, foreground] of [
        [240, 255, 17],
        [48, 34, 238],
      ]) {
        root.style.setProperty(
          "--material-sidepane",
          `rgb(${surface}, ${surface}, ${surface})`,
        );
        root.style.setProperty(
          "--material-background",
          `rgb(${background}, ${background}, ${background})`,
        );
        root.style.setProperty(
          "--fill-primary",
          `rgb(${foreground}, ${foreground}, ${foreground})`,
        );
        const style = doc.defaultView!.getComputedStyle(card)!;
        const canvas = doc.createElement("canvas");
        canvas.width = canvas.height = 1;
        const context = canvas.getContext("2d")!;
        context.fillStyle = style.backgroundColor;
        context.fillRect(0, 0, 1, 1);
        const channel = context.getImageData(0, 0, 1, 1).data[0];
        assert.isAtLeast(
          Math.abs(channel - surface),
          10,
          "code surface must be visibly distinct from chat",
        );
        assert.isAtMost(
          Math.abs(channel - surface),
          30,
          "code surface stays within the active theme",
        );
        assert.equal(style.borderRadius, "14px");
      }
    } finally {
      await api.reset();
      await api.cleanupFixture(fixture);
    }
  });

  it("hides continuation bookkeeping and keeps the Resume label centered inside a properly sized button", async function () {
    const api = (Zotero as any).LLMForZotero.api
      .workflowTest as WorkflowTestApi;
    const fixture = await api.createPaperWithPdfFixture({
      title: "Plan trace presentation fixture",
      pages: ["Disposable trace presentation fixture."],
    });
    try {
      const panel = await api.renderPanelForItem(fixture.parentItemId);
      const doc = Zotero.getMainWindow().document;
      const events: AgentRunEventRecord[] = [
        {
          runId: "presentation",
          seq: 1,
          eventType: "status",
          createdAt: 1,
          payload: {
            type: "status",
            text: "Continuing agent (segment 2, 6/32)",
          },
        },
        {
          runId: "presentation",
          seq: 2,
          eventType: "status",
          createdAt: 2,
          payload: {
            type: "status",
            text: "Checkpointed agent segment 2; continuing",
          },
        },
        {
          runId: "presentation",
          seq: 3,
          eventType: "plan_execution_updated",
          createdAt: 3,
          payload: {
            type: "plan_execution_updated",
            ledger: {
              executionId: "presentation",
              status: "interrupted",
              tasks: [],
            } as any,
          },
        },
      ];
      await api.seedPanelStoredTurn(
        panel.panelId,
        "Execute the approved plan",
        "",
        {
          runMode: "agent",
          pendingAgentTraceEvents: events,
        },
      );
      const messages = doc.querySelector<HTMLElement>(
        `[data-workflow-panel-id="${panel.panelId}"] .llm-messages`,
      )!;
      assert.notInclude(messages.textContent || "", "Continuing agent");
      assert.notInclude(messages.textContent || "", "Checkpointed agent");
      const card = messages.querySelector<HTMLElement>(
        ".llm-plan-recovery-card",
      )!;
      assert.exists(card, "the latest interrupted execution offers recovery");
      const button = card.querySelector("button")!;
      const label = button.querySelector(".llm-plan-action-label-full")!;
      const root = doc.querySelector<HTMLElement>(
        `[data-workflow-panel-id="${panel.panelId}"] .llm-panel`,
      )!;
      const oldScale = root.style.getPropertyValue("--llm-font-scale");
      try {
        for (const [width, scale] of [
          [280, 1.5],
          [390, 1],
          [520, 1],
        ]) {
          card.style.width = `${width}px`;
          root.style.setProperty("--llm-font-scale", `${scale}`);
          await Zotero.Promise.delay(50);
          const action = button.getBoundingClientRect();
          const copy = label.getBoundingClientRect();
          assert.closeTo(
            copy.left + copy.width / 2,
            action.left + action.width / 2,
            1,
            `label horizontally centered inside the button at ${width}px`,
          );
          assert.closeTo(
            copy.top + copy.height / 2,
            action.top + action.height / 2 - 1,
            1,
            `label vertically centered with the existing Plan optical offset at ${width}px`,
          );
          const style = doc.defaultView!.getComputedStyle(button)!;
          assert.closeTo(
            parseFloat(style.fontSize),
            11 * scale,
            0.1,
            "the font scale changes the rendered button label size",
          );
          assert.equal(style.borderRadius, "7px");
          assert.equal(style.appearance, "none");
          assert.isAtLeast(
            action.height,
            copy.height + 8,
            `label retains vertical button padding: ${JSON.stringify({
              height: style.height,
              minHeight: style.minHeight,
              maxHeight: style.maxHeight,
              padding: style.padding,
              lineHeight: style.lineHeight,
              boxSizing: style.boxSizing,
            })}`,
          );
          assert.isAtLeast(
            action.width,
            copy.width + 20,
            "label retains horizontal button padding",
          );
          assert.equal(
            doc.defaultView!.getComputedStyle(button)!.alignItems,
            "center",
          );
          assert.equal(
            doc.defaultView!.getComputedStyle(button)!.justifyContent,
            "center",
          );
          assert.isAtMost(
            card.scrollWidth,
            card.clientWidth + 1,
            `no clipped recovery content at ${width}px`,
          );
        }
      } finally {
        if (oldScale) root.style.setProperty("--llm-font-scale", oldScale);
        else root.style.removeProperty("--llm-font-scale");
      }
    } finally {
      await api.reset();
      await api.cleanupFixture(fixture);
    }
  });
});
