import { assert } from "chai";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";
import { DirectDocumentFinalizer } from "../src/agent/documents/directFinalization";
import type { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import type { AgentRuntimeRequest } from "../src/agent/types";

describe("workflow: Plan trace presentation", function () {
  this.timeout(30000);

  it("replaces a pending publication card in place when delivery commits", async function () {
    const conversationKey = Date.now();
    const { document } = await new DirectDocumentFinalizer(
      {} as ZoteroGateway,
    ).finalize({
      request: {
        conversationKey,
        mode: "agent",
        userText: "Write the guide",
        documentOutcomePolicy: {
          required: true,
          documentKind: "guide",
          integrityPolicy: "authored",
          trigger: "document_intent",
        },
      } as unknown as AgentRuntimeRequest,
      runId: `publication-trace-${conversationKey}`,
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
      await deliver(conversationKey);
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
              toolName: "inspect_records",
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

  it("reopens an old plan read-only: its steps, how it ended, and no control", async function () {
    const api = (Zotero as any).LLMForZotero.api
      .workflowTest as WorkflowTestApi;
    const fixture = await api.createPaperWithPdfFixture({
      title: "Old plan fixture",
      pages: ["Disposable old plan fixture."],
    });
    try {
      const panel = await api.renderPanelForItem(fixture.parentItemId);
      const doc = Zotero.getMainWindow().document;
      const stamp = Date.now();
      const planRun = `old-plan-${stamp}`;
      const executionRun = `old-plan-execution-${stamp}`;
      const step = (id: string, content: string) => ({
        planStepId: id,
        content,
        activeForm: content,
        acceptanceCriteria: [],
        expectedEffect: "reasoning",
      });
      const task = (index: number, status: string, content: string) => ({
        version: 2,
        taskId: `${executionRun}:task-${index}`,
        executionId: executionRun,
        planStepId: `step-${index}`,
        kind: "required_step",
        content,
        activeForm: content,
        acceptanceCriteria: [],
        expectedEffect: "reasoning",
        obligationIds: [],
        status,
        attemptCount: 1,
        evidenceIds: [],
        failureReasons: [],
        createdAt: 1,
        updatedAt: 1,
      });
      await api.seedTaskProgressConversation({
        panelId: panel.panelId,
        turns: [
          {
            runId: planRun,
            user: { text: "/plan Compare the two drift papers" },
            answer: "The plan is ready for review.",
            events: [
              {
                type: "status",
                text: "Continuing agent (segment 2, 6/32)",
              },
              {
                type: "plan_ready",
                artifact: {
                  version: 1,
                  planId: planRun,
                  revision: 1,
                  digest: "sha256:old-plan",
                  provider: "original",
                  conversationKey: 1,
                  status: "awaiting_approval",
                  explanation: "Compare how the two cohorts drift.",
                  steps: [
                    step("step-1", "Read both papers"),
                    step("step-2", "Write the comparison"),
                  ],
                  createdAt: 1,
                  updatedAt: 1,
                },
              },
              { type: "final", text: "The plan is ready for review." },
            ] as never,
          },
          {
            runId: executionRun,
            user: { text: "Approved plan" },
            answer: "I read both papers before the run stopped.",
            events: [
              {
                type: "status",
                text: "Checkpointed agent segment 2; continuing",
              },
              {
                type: "plan_execution_updated",
                ledger: {
                  version: 2,
                  executionId: executionRun,
                  planId: planRun,
                  revision: 1,
                  planDigest: "sha256:old-plan",
                  conversationKey: 1,
                  attempt: 1,
                  provider: "original",
                  status: "interrupted",
                  tasks: [
                    task(1, "completed", "Read both papers"),
                    task(2, "interrupted", "Write the comparison"),
                  ],
                  createdAt: 1,
                  updatedAt: 2,
                },
              },
              {
                type: "final",
                text: "I read both papers before the run stopped.",
              },
            ] as never,
          },
        ],
      });
      await api.reopenTaskProgressConversation({ panelId: panel.panelId });
      const messages = doc.querySelector<HTMLElement>(
        `[data-workflow-panel-id="${panel.panelId}"] .llm-messages`,
      )!;
      const cards = () =>
        Array.from(
          messages.querySelectorAll<HTMLElement>(
            ".llm-plan-container:not(.llm-plan-document-card)",
          ),
        ) as HTMLElement[];
      const deadline = Date.now() + 15000;
      while (cards().length < 2 && Date.now() < deadline)
        await Zotero.Promise.delay(40);
      const [proposal, execution] = cards();
      assert.exists(proposal, "the planning turn shows its plan");
      assert.exists(execution, "the execution turn shows how the plan ended");
      const status = (card: HTMLElement) =>
        card.querySelector(".llm-plan-status")?.textContent;
      assert.equal(status(proposal), "Proposed");
      const proposed =
        proposal.querySelector(".llm-plan-markdown")?.textContent || "";
      assert.include(proposed, "Read both papers");
      assert.include(proposed, "Write the comparison");
      assert.equal(status(execution), "Interrupted");
      assert.deepEqual(
        (
          Array.from(
            execution.querySelectorAll(".llm-plan-task-label"),
          ) as HTMLElement[]
        ).map((label) => label.textContent),
        ["Read both papers", "Write the comparison"],
      );
      for (const card of [proposal, execution]) {
        assert.lengthOf(
          card.querySelectorAll(
            "button:not(:disabled), textarea, input:not(:disabled)",
          ),
          0,
          "no plan control is offered",
        );
      }
      assert.notExists(messages.querySelector(".llm-plan-recovery-card"));
      const text = messages.textContent || "";
      assert.notInclude(text, "Resume");
      assert.notInclude(text, "Continuing agent");
      assert.notInclude(text, "Checkpointed agent");
      assert.include(text, "I read both papers before the run stopped.");
      // A screenshot of both cards, for a reviewer (in the data directory).
      execution.scrollIntoView({ block: "end" });
      await Zotero.Promise.delay(200);
      const rect = messages.getBoundingClientRect();
      const win = doc.defaultView as any;
      const canvas = doc.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "canvas",
      ) as HTMLCanvasElement;
      const scale = win.devicePixelRatio || 1;
      canvas.width = Math.ceil(rect.width) * scale;
      canvas.height = Math.ceil(rect.height) * scale;
      const context = canvas.getContext("2d") as any;
      context.scale(scale, scale);
      context.drawWindow(
        win,
        rect.left,
        rect.top,
        Math.ceil(rect.width),
        Math.ceil(rect.height),
        "#ffffff",
      );
      const binary = win.atob(canvas.toDataURL("image/png").split(",")[1]);
      await win.IOUtils.write(
        `${Zotero.DataDirectory.dir}/old-plan-cards.png`,
        Uint8Array.from(binary, (char: string) => char.charCodeAt(0)),
      );
      await api.clickPanelDelete(panel.panelId);
    } finally {
      await api.reset();
      await api.cleanupFixture(fixture);
    }
  });
});
