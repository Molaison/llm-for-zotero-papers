import { createPreparePlanExecutionTool } from "../../agent/tools/plan/preparePlanExecution";
import { ZoteroGateway } from "../../agent/services/zoteroGateway";
import { finalizeNativePlanProposal } from "../../agent/plans/nativePlanning";
import {
  clearPlanConversationRowsInTransaction,
  loadPlanArtifact,
  loadLatestPlanExecutionForPlan,
} from "../../agent/plans/store";
import { renderAgentTrace } from "./agentTrace/render";
import { clearPlanModeState, takePendingPlanExecution } from "./planModeState";
import { resolveAgentRuntimeRequest } from "../../agent/context/resolvedAgentRequest";
import type { AgentRunEventRecord, AgentToolContext } from "../../agent/types";
import {
  resolveCodexNativeApprovalWithOptionalReviewCard,
  resolveCodexNativeHostInteractionWithTrace,
} from "./chat";
import { createCodexNativeActivityTraceControllerForTests } from "./codexNativeTrace/controller";
import type { Message } from "./types";
import { agentRunTraceCache } from "./agentState";
import { getConversationKey } from "./conversationIdentity";
import { getConversationWriteGeneration } from "../../shared/conversationWriteFence";
import {
  buildNativeQuestionAction,
  nativeQuestionAnswers,
} from "../../codexAppServer/nativeQuestions";

/** Reproduce native confirmation followed by the queued assistant trace render. */
export async function exerciseNativeQuestionReview(
  body: Element,
  item: Zotero.Item,
) {
  const doc = body.ownerDocument;
  const chat = body.querySelector<HTMLElement>("#llm-chat-box")!;
  const host = doc.createElement("div");
  chat.appendChild(host);
  const message: Message = {
    role: "assistant",
    text: "",
    timestamp: Date.now(),
    runMode: "agent",
    streaming: true,
  };
  let scheduled = false;
  const trace = createCodexNativeActivityTraceControllerForTests(
    message,
    () => {
      if (scheduled) return;
      scheduled = true;
      doc.defaultView!.setTimeout(() => {
        scheduled = false;
        const rendered = renderAgentTrace({
          doc,
          panelItem: item,
          message,
          events: message.streaming
            ? message.pendingAgentTraceEvents || []
            : agentRunTraceCache.get(message.agentRunId || "") || [],
        });
        host.replaceChildren(...(rendered ? [rendered] : []));
      }, 0);
    },
  );
  const questions = [
    {
      id: "audience",
      question: "Which audience?",
      options: [{ label: "Students" }, { label: "Researchers" }],
    },
  ];
  const pending = resolveCodexNativeHostInteractionWithTrace({
    body,
    trace,
    action: buildNativeQuestionAction(questions),
  });
  try {
    await Zotero.Promise.delay(50);
    const cardsWhilePending = chat.querySelectorAll(
      ".llm-planning-question-card",
    ).length;
    const card = chat.querySelector<HTMLElement>(
      ".llm-planning-question-card",
    )!;
    card
      .querySelector<HTMLButtonElement>('[data-option-id="option-1"]')!
      .click();
    card
      .querySelector<HTMLButtonElement>(".llm-planning-question-continue")!
      .click();
    const answer = nativeQuestionAnswers(questions, await pending);
    await Zotero.Promise.delay(50);
    trace.finish("The plan is ready for review.");
    // Native completion first supplies its durable host journal identity.
    // That journal does not contain the UI-owned clarification transcript.
    message.agentRunId = `native-host-question-${message.timestamp}`;
    agentRunTraceCache.set(message.agentRunId, [
      {
        runId: message.agentRunId,
        seq: 1,
        eventType: "final",
        payload: { type: "final", text: "The plan is ready for review." },
        createdAt: Date.now(),
      },
    ]);
    message.streaming = false;
    await Zotero.Promise.delay(50);
    const conversationKey = getConversationKey(item);
    await trace.persist(
      conversationKey,
      getConversationWriteGeneration(conversationKey),
    );
    await Zotero.Promise.delay(50);
    const historyRow = Array.from(
      chat.querySelectorAll<HTMLElement>(
        ".llm-agent-process-action-expandable",
      ),
    ).find((row) =>
      Boolean(row?.textContent?.includes("Answered 1 planning question")),
    );
    return {
      cardsWhilePending,
      answer,
      cardsAfterResolution: chat.querySelectorAll(".llm-planning-question-card")
        .length,
      activeControlsAfter: chat.querySelectorAll(
        ".llm-planning-question-card button:not(:disabled), .llm-planning-question-card input:not(:disabled)",
      ).length,
      questionHistoryText: historyRow?.textContent || "",
    };
  } finally {
    await pending;
    agentRunTraceCache.delete(`native-host-question-${message.timestamp}`);
    host.remove();
    chat
      .querySelectorAll(".llm-action-inline-card")
      .forEach((card) => card.remove());
  }
}

/** Exercise the loaded renderer against disposable native Zotero state. */
export async function exerciseNativePlanReview() {
  const collection = new Zotero.Collection();
  (collection as unknown as { libraryID: number }).libraryID =
    Zotero.Libraries.userLibraryID;
  collection.name = "Native planning workflow collection";
  await collection.saveTx();
  const item = new Zotero.Item("journalArticle");
  item.libraryID = Zotero.Libraries.userLibraryID;
  item.setField("title", "Native planning workflow fixture");
  await item.saveTx();
  item.addToCollection(collection.id);
  await item.saveTx();
  const key = item.id;
  const planId = `native-workflow-${Date.now()}`;
  const plan = {
    phase: "planning" as const,
    provider: "codex" as const,
    planId,
    revision: 1,
    nativePlanning: {
      attemptId: planId,
      threadId: "workflow-thread",
      turnId: "workflow-turn",
      ephemeral: false,
    },
  };
  const doc = Zotero.getMainWindow().document;
  let rendered: HTMLElement | null = null;
  try {
    const tool = createPreparePlanExecutionTool(new ZoteroGateway());
    const input = tool.validate({
      contract: {
        deliverable: {
          kind: "document",
          spec: {
            title: "Native proposal",
            format: "markdown",
            destination: "chat",
            requiredSections: ["Introduction", "Synthesis", "References"],
          },
        },
        investigation: {
          question: "How should the selected paper be explained?",
          subquestions: ["Which assumptions matter?"],
          criteria: { evidence: "Use the selected collection" },
          reviewMode: "narrative",
          readingStrategy: "adaptive",
          scopeAmendmentPolicy: "fixed",
          scope: {
            libraryID: item.libraryID,
            kind: "collection",
            collectionIds: [collection.id],
            items: [{ itemId: item.id, itemKey: item.key }],
          },
          requiredEvidenceDepth: "body",
          estimatedDeepReadPapers: 1,
          approvedLargeCorpus: false,
        },
      },
      steps: [
        {
          content: "Read the selected paper",
          activeForm: "Reading the selected paper",
          expectedEffect: "read",
          acceptanceCriteria: ["The selected paper has verified evidence"],
        },
        {
          content: "Explain the agreed concept",
          activeForm: "Explaining the concept",
          expectedEffect: "reasoning",
          acceptanceCriteria: ["The explanation remains evidence bounded"],
        },
        {
          content: "Publish the explanation",
          activeForm: "Publishing the explanation",
          expectedEffect: "artifact",
          acceptanceCriteria: ["The document is visible in chat"],
        },
      ],
    });
    if (!input.ok) throw new Error(input.error);
    await tool.execute(input.value, {
      request: resolveAgentRuntimeRequest({
        conversationKey: key,
        libraryID: item.libraryID,
        mode: "agent",
        userText: "Plan a conceptual explanation",
        planContext: plan,
      }),
      runId: "workflow-turn",
      item,
    } as AgentToolContext);
    const stagedStatus = (await loadPlanArtifact(planId, 1))?.status;
    const markdown =
      "# Native proposal\n\nExplain **representational drift** using a concrete example.\n\n- State the assumptions.\n- Explain the result.";
    const artifact = await finalizeNativePlanProposal({
      plan,
      conversationKey: key,
      proposal: {
        threadId: "workflow-thread",
        turnId: "workflow-turn",
        itemId: "proposal",
        text: markdown,
      },
    });
    const events: AgentRunEventRecord[] = [
      {
        runId: planId,
        seq: 1,
        eventType: "plan_ready",
        createdAt: Date.now(),
        payload: { type: "plan_ready", artifact },
      },
    ];
    rendered = renderAgentTrace({
      doc,
      panelItem: item,
      message: {
        role: "assistant",
        text: "The plan is ready for review.",
        timestamp: Date.now(),
        runMode: "agent",
        pendingAgentTraceEvents: events,
      },
      events,
    });
    if (!rendered) throw new Error("The native plan card did not render");
    doc.documentElement.appendChild(rendered);
    const heading = rendered.querySelector(
      ".llm-plan-markdown h2",
    )?.textContent;
    const strong = rendered.querySelector(
      ".llm-plan-markdown strong",
    )?.textContent;
    const summary = rendered.querySelector(
      ".llm-plan-contract-summary",
    )?.textContent;
    (rendered!.querySelector(".llm-plan-approve") as HTMLElement).click();
    const deadline = Date.now() + 5000;
    while (
      (await loadPlanArtifact(planId, 1))?.status !== "approved" &&
      Date.now() < deadline
    )
      await Zotero.Promise.delay(20);
    const approved = await loadPlanArtifact(planId, 1);
    const ledger = await loadLatestPlanExecutionForPlan(planId, 1);
    // Approval stages the execution only after its transaction commits, and
    // the stored copy alone does not run for an empty message.
    let executionContext = await takePendingPlanExecution(key, "");
    while (!executionContext && Date.now() < deadline) {
      await Zotero.Promise.delay(20);
      executionContext = await takePendingPlanExecution(key, "");
    }
    return {
      stagedStatus,
      heading,
      strong,
      summary,
      approvedStatus: approved?.status,
      markdown: approved?.nativePlanning?.proposal?.markdown,
      digestMatches:
        approved?.digest === artifact.digest &&
        ledger?.planDigest === artifact.digest,
      continuationId: ledger?.providerContinuationId,
      taskCount: ledger?.tasks.length,
      taskStatuses: ledger?.tasks.map((task) => task.status),
      executionPhase: executionContext?.phase,
      executionIdMatches:
        executionContext?.phase === "executing" &&
        executionContext.executionId === ledger?.executionId,
      frozenScopeCount:
        approved?.contract?.investigation?.scopeSnapshot?.itemCount,
      nativeTitle: Zotero.Items.get(key).getField("title"),
      cardText: rendered.textContent,
    };
  } finally {
    rendered?.remove();
    clearPlanModeState(key);
    await Zotero.DB.executeTransaction(() =>
      clearPlanConversationRowsInTransaction(key),
    );
    await item.eraseTx();
    await collection.eraseTx();
  }
}
