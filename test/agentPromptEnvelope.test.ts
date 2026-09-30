import { assert } from "chai";
import { createPaperReadTool } from "../src/agent/tools/read/paperRead";
import {
  buildAgentInitialMessages,
  buildAgentPromptInstructionInventory,
  composeAgentModelInput,
  renderAgentPromptEnvelope,
} from "../src/agent/model/messageBuilder";
import type {
  PlanExecutionLedger,
  PlanRuntimeContext,
} from "../src/agent/plans/types";
import { buildZoteroEnvironmentManifest } from "../src/codexAppServer/nativeClient";
import { AGENT_ACTION_CONTRACT } from "../src/shared/instructionContracts";
import { COVERAGE_DISCLOSURE_REQUIREMENT } from "../src/agent/documents/draftValidation";
import type { AgentModelMessage } from "../src/agent/types";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";
import {
  clearAgentMemory,
  recordAgentTurn,
} from "../src/agent/store/conversationMemory";
import { classifiedFixture, semanticFixture } from "./helpers/semanticIntent";

function messageText(message: AgentModelMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n");
}

describe("agent prompt envelope", function () {
  describe("conversation continuity", function () {
    const conversationKey = 810001;
    const question = "Summarize this paper";
    const answer = `The main finding is retained. ${"Detailed evidence. ".repeat(30)}Exact final sentence.`;
    const transcript: AgentModelMessage[] = [
      { role: "user", content: `User request:\n${question}` },
      {
        role: "tool",
        tool_call_id: "read-1",
        name: "paper_read",
        content: '{"text":"Source passage","quoteId":"Q1"}',
      },
      { role: "assistant", content: answer },
    ];

    beforeEach(async function () {
      await clearAgentMemory(conversationKey);
      await recordAgentTurn(conversationKey, question, ["paper_read"], answer);
    });

    afterEach(async function () {
      await clearAgentMemory(conversationKey);
    });

    function request(userText = "Explain that finding") {
      return resolvedAgentRequest({
        conversationKey,
        mode: "agent",
        model: "test-model",
        userText,
        history: transcript,
      });
    }

    it("omits duplicated notes on follow-up and preserves exact answers and evidence for saving", async function () {
      const followup = await buildAgentInitialMessages(request(), [], []);
      assert.notInclude(
        messageText(followup.at(-1)!),
        "Conversation continuity notes",
      );
      assert.equal(
        followup.find((message) => message.role === "assistant")?.content,
        answer,
      );

      const savingTranscript: AgentModelMessage[] = [
        ...transcript,
        { role: "user", content: "Explain that finding" },
        { role: "assistant", content: "The effect persists across sessions." },
      ];
      await recordAgentTurn(
        conversationKey,
        "Explain that finding",
        [],
        "The effect persists across sessions.",
      );
      const saving = await buildAgentInitialMessages(
        request("Save that answer as a note"),
        [],
        [],
        undefined,
        {
          transcriptMessages: savingTranscript,
        },
      );
      assert.notInclude(
        messageText(saving.at(-1)!),
        "Conversation continuity notes",
      );
      assert.deepEqual(
        JSON.parse(
          JSON.stringify(saving.slice(-savingTranscript.length - 1, -1)),
        ),
        savingTranscript,
      );
      assert.include(messageText(saving.at(-1)!), "Save that answer as a note");
    });

    it("restores notes when recomposition removes history without changing the rendered snapshot", async function () {
      const rendered = await renderAgentPromptEnvelope(request(), [], []);
      const full = composeAgentModelInput(rendered.envelope, {
        transcriptMessages: transcript,
      });
      assert.notInclude(
        messageText(full.at(-1)!),
        "Conversation continuity notes",
      );
      await clearAgentMemory(conversationKey);
      const compacted = composeAgentModelInput(rendered.envelope, {
        transcriptMessages: [],
        postTurnMessages: [
          {
            role: "user",
            content: "Agent semantic continuation checkpoint: continue safely.",
          },
        ],
      });
      assert.include(
        messageText(compacted.at(-2)!),
        "Conversation continuity notes",
      );
      assert.include(messageText(compacted.at(-2)!), answer.slice(0, 350));
      assert.deepEqual(
        composeAgentModelInput(rendered.envelope, {
          transcriptMessages: transcript,
        }),
        full,
      );
      await recordAgentTurn(conversationKey, question, ["paper_read"], answer);
      const explicitEmpty = await buildAgentInitialMessages(
        request(),
        [],
        [],
        undefined,
        { transcriptMessages: [] },
      );
      assert.include(
        messageText(explicitEmpty.at(-1)!),
        "Conversation continuity notes",
      );
    });

    it("matches clipped long questions and counts only the notes actually sent", async function () {
      await clearAgentMemory(conversationKey);
      const longQuestion = `${"Explain these results. ".repeat(20)}Include limitations.`;
      await recordAgentTurn(conversationKey, longQuestion, [], answer);
      const history: AgentModelMessage[] = [
        { role: "user", content: `User request:\n${longQuestion}` },
        { role: "assistant", content: answer },
      ];
      const rendered = await renderAgentPromptEnvelope(request(), [], []);
      const full = composeAgentModelInput(rendered.envelope, {
        transcriptMessages: history,
      });
      assert.notInclude(
        messageText(full.at(-1)!),
        "Conversation continuity notes",
      );
      const fullInventory = buildAgentPromptInstructionInventory(
        rendered,
        full,
        history,
      );
      const compacted = composeAgentModelInput(rendered.envelope);
      const compactedInventory = buildAgentPromptInstructionInventory(
        rendered,
        compacted,
        [],
      );
      await clearAgentMemory(conversationKey);
      const empty = await renderAgentPromptEnvelope(request(), [], []);
      const emptyInventory = buildAgentPromptInstructionInventory(
        empty,
        composeAgentModelInput(empty.envelope, { transcriptMessages: history }),
        history,
      );
      assert.equal(
        fullInventory.turnResourceTokens,
        emptyInventory.turnResourceTokens,
      );
      assert.isAbove(
        compactedInventory.turnResourceTokens,
        fullInventory.turnResourceTokens,
      );
    });

    it("retains only notes for turns no longer represented in the prompt", async function () {
      await recordAgentTurn(
        conversationKey,
        "An older omitted question",
        [],
        "An older finding",
      );
      const messages = await buildAgentInitialMessages(request(), [], []);
      const turn = messageText(messages.at(-1)!);
      assert.include(turn, 'User asked: "An older omitted question"');
      assert.notInclude(turn, `User asked: "${question}"`);
    });

    it("requires the matching user and answer in the same retained turn", async function () {
      const histories: AgentModelMessage[][] = [
        [transcript[0]],
        [transcript[2]],
        [
          transcript[0],
          { role: "user", content: "Different question" },
          transcript[2],
        ],
        [{ role: "user", content: question, transient: true }, transcript[2]],
        [
          {
            role: "user",
            content: question,
            retainedTool: { name: "paper_read", callId: "read-1" },
          },
          transcript[2],
        ],
        [transcript[0], { ...transcript[1], content: answer }],
        [
          {
            role: "user",
            content: `Agent semantic continuation checkpoint:\n${question}`,
          },
          transcript[2],
        ],
      ];
      for (const history of histories) {
        const messages = await buildAgentInitialMessages(
          request(),
          [],
          [],
          undefined,
          { transcriptMessages: history },
        );
        assert.include(
          messageText(messages.at(-1)!),
          "Conversation continuity notes",
          JSON.stringify(history),
        );
      }
    });

    it("handles multimodal history and keeps current images intact when restoring notes", async function () {
      const multimodal = transcript.map((message) => ({
        ...message,
        content: [{ type: "text" as const, text: messageText(message) }],
      })) as AgentModelMessage[];
      const rendered = await renderAgentPromptEnvelope(
        { ...request(), screenshots: ["data:image/png;base64,AA"] },
        [],
        [],
        undefined,
        {
          contentInputs: {
            images: true,
            pdfDocuments: false,
            nativeFiles: false,
          },
        },
      );
      const full = composeAgentModelInput(rendered.envelope, {
        transcriptMessages: multimodal,
      });
      assert.notInclude(
        messageText(full.at(-1)!),
        "Conversation continuity notes",
      );
      const compacted = composeAgentModelInput(rendered.envelope);
      assert.include(
        messageText(compacted.at(-1)!),
        "Conversation continuity notes",
      );
      assert.deepEqual(
        (compacted.at(-1)!.content as unknown[]).slice(1),
        (full.at(-1)!.content as unknown[]).slice(1),
      );
    });
  });

  it("tells the model that host-verifiable research and document tasks advance without task_update", async function () {
    const ledger: PlanExecutionLedger = {
      version: 1,
      executionId: "execution-host-owned",
      planId: "plan-host-owned",
      revision: 1,
      planDigest: "sha256:host-owned",
      conversationKey: 705,
      attempt: 1,
      provider: "original",
      grant: {
        version: 1,
        planId: "plan-host-owned",
        revision: 1,
        planDigest: "sha256:host-owned",
        conversationKey: 705,
        conversationGeneration: 1,
        approvedAt: 1,
      },
      status: "running",
      activeTaskId: "read",
      tasks: [
        {
          version: 2,
          taskId: "read",
          executionId: "execution-host-owned",
          planStepId: "s1",
          kind: "required_step",
          content: "Read every paper",
          activeForm: "Reading every paper",
          acceptanceCriteria: [],
          expectedEffect: "read",
          completionRequirements: [
            {
              requirementId: "read:verified",
              kind: "verified_read",
              criterionIds: [],
              contractDigest: "sha256:host-owned",
            },
          ],
          obligationIds: [],
          status: "in_progress",
          attemptCount: 1,
          evidenceIds: [],
          failureReasons: [],
          createdAt: 1,
          updatedAt: 1,
        },
        {
          version: 2,
          taskId: "document",
          executionId: "execution-host-owned",
          planStepId: "s2",
          kind: "required_step",
          content: "Publish the review",
          activeForm: "Publishing the review",
          acceptanceCriteria: [],
          expectedEffect: "artifact",
          completionRequirements: [
            {
              requirementId: "document:integrity",
              kind: "document_integrity",
              criterionIds: [],
              contractDigest: "sha256:host-owned",
            },
            {
              requirementId: "document:published",
              kind: "document_published",
              criterionIds: [],
              contractDigest: "sha256:host-owned",
            },
          ],
          obligationIds: [],
          status: "pending",
          attemptCount: 0,
          evidenceIds: [],
          failureReasons: [],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      createdAt: 1,
      updatedAt: 1,
    };
    const request = resolvedAgentRequest({
      conversationKey: 705,
      mode: "agent",
      userText: "Execute the approved review",
      model: "test-model",
      planContext: {
        phase: "executing",
        planId: ledger.planId,
        revision: ledger.revision,
        executionId: ledger.executionId,
        approvedDigest: ledger.planDigest,
        provider: "original",
      },
      metadata: { planExecutionLedger: ledger },
    });

    const messages = await buildAgentInitialMessages(request, [], []);
    const prompt = messages.map(messageText).join("\n");
    assert.include(prompt, "Do not call task_update for these tasks");
    assert.include(
      prompt,
      "verified reads, mutation receipts, and finalized material",
    );
    assert.notInclude(
      prompt,
      "After evidence exists, call task_update with only the task",
    );
  });

  it("keeps host-owned execution identities out of the final answer", async function () {
    const ledger: PlanExecutionLedger = {
      version: 1,
      executionId: "execution-secret",
      planId: "plan-secret",
      revision: 1,
      planDigest: "sha256:secret",
      conversationKey: 703,
      attempt: 1,
      provider: "original",
      grant: {
        version: 1,
        planId: "plan-secret",
        revision: 1,
        planDigest: "sha256:secret",
        conversationKey: 703,
        conversationGeneration: 1,
        approvedAt: 1,
      },
      status: "running",
      tasks: [],
      createdAt: 1,
      updatedAt: 1,
    };
    const request = resolvedAgentRequest({
      conversationKey: 703,
      mode: "agent",
      userText: "Execute the approved plan",
      model: "test-model",
      planContext: {
        phase: "executing",
        planId: ledger.planId,
        revision: ledger.revision,
        executionId: ledger.executionId,
        approvedDigest: ledger.planDigest,
        provider: "original",
      },
      metadata: { planExecutionLedger: ledger },
    });

    const messages = await buildAgentInitialMessages(request, [], []);
    const prompt = messages.map(messageText).join("\n");
    assert.include(
      prompt,
      "Your final answer should answer the original request naturally",
    );
    assert.include(prompt, "Do not expose plan IDs");
    assert.include(prompt, "the host renders progress separately");
  });

  it("exposes the exact approved document contract during execution", async function () {
    const ledger: PlanExecutionLedger = {
      version: 1,
      executionId: "execution-document",
      planId: "plan-document",
      revision: 1,
      planDigest: "sha256:document",
      conversationKey: 704,
      attempt: 1,
      provider: "original",
      grant: {
        version: 1,
        planId: "plan-document",
        revision: 1,
        planDigest: "sha256:document",
        conversationKey: 704,
        conversationGeneration: 1,
        approvedAt: 1,
      },
      status: "running",
      tasks: [],
      createdAt: 1,
      updatedAt: 1,
    };
    const request = resolvedAgentRequest({
      conversationKey: 704,
      mode: "agent",
      userText: "Execute the approved plan",
      model: "test-model",
      planContext: {
        phase: "executing",
        planId: ledger.planId,
        revision: ledger.revision,
        executionId: ledger.executionId,
        approvedDigest: ledger.planDigest,
        provider: "original",
      },
      metadata: {
        planExecutionLedger: ledger,
        approvedPlanContract: {
          deliverable: {
            kind: "document",
            spec: {
              kind: "literature_review",
              title: "Exact approved review title",
              requiredSections: ["Findings", "Scope and limitations"],
              requiresReferences: true,
              requiresCoverageSection: true,
              allowFigures: false,
              citationStyle: {
                styleId: "apa",
                styleTitle: "APA",
                locale: "en-US",
              },
            },
          },
        },
      },
    });
    const messages = await buildAgentInitialMessages(request, [], []);
    const prompt = messages.map(messageText).join("\n");
    assert.include(prompt, "Exact title: Exact approved review title");
    assert.include(
      prompt,
      "Required sections: Findings; Scope and limitations",
    );
    assert.include(prompt, "submit_document.title must match");
    assert.include(prompt, COVERAGE_DISCLOSURE_REQUIREMENT);
    assert.notInclude(prompt, "Coverage section required");
  });

  it("lets the approved investigation own reading guidance instead of the chat turn rule", async function () {
    const ledger: PlanExecutionLedger = {
      version: 1,
      executionId: "execution-investigation",
      planId: "plan-investigation",
      revision: 1,
      planDigest: "sha256:investigation",
      conversationKey: 706,
      attempt: 1,
      provider: "original",
      grant: {
        version: 1,
        planId: "plan-investigation",
        revision: 1,
        planDigest: "sha256:investigation",
        conversationKey: 706,
        conversationGeneration: 1,
        approvedAt: 1,
      },
      status: "running",
      tasks: [],
      createdAt: 1,
      updatedAt: 1,
    };
    const request = resolvedAgentRequest({
      conversationKey: 706,
      mode: "agent",
      userText: "Execute the approved plan",
      model: "test-model",
      planContext: {
        phase: "executing",
        planId: ledger.planId,
        revision: ledger.revision,
        executionId: ledger.executionId,
        approvedDigest: ledger.planDigest,
        provider: "original",
      },
      classifiedIntent: classifiedFixture({
        semantic: semanticFixture({
          reading: { source: "document_text", coverage: "targeted" },
        }),
      }),
      metadata: {
        planExecutionLedger: ledger,
        approvedPlanContract: {
          deliverable: { kind: "answer" },
          investigation: {
            question: "How is belief updating modeled?",
            subquestions: [],
            criteria: [],
            reviewMode: "narrative",
            readingStrategy: "adaptive",
            scopeAmendmentPolicy: "fixed",
            scope: { libraryID: 1, kind: "items", itemKeys: ["AAAA1111"] },
            requiredEvidenceDepth: "body",
            estimatedDeepReadPapers: 0,
            approvedLargeCorpus: false,
          },
        },
      },
    });
    const messages = await buildAgentInitialMessages(request, [], []);
    const prompt = messages.map(messageText).join("\n");
    assert.notInclude(prompt, "TURN RULE");
    assert.notInclude(prompt, "The shared reading intent requires");
    assert.include(
      prompt,
      "Reading guidance (owned by the approved investigation)",
    );
    assert.include(
      prompt,
      "narrative review, adaptive reading, body evidence depth",
    );
    assert.include(prompt, "paper_read mode 'overview'");
    assert.include(prompt, "No per-turn read budget applies");
  });

  it("distinguishes omitted transcript history from an explicit empty override", async function () {
    const request = resolvedAgentRequest({
      conversationKey: 701,
      mode: "agent",
      userText: "Current request",
      model: "test-model",
      history: [
        { role: "user", content: "Prior user message" },
        { role: "assistant", content: "Prior assistant message" },
      ],
    });

    const derivedHistory = await buildAgentInitialMessages(request, [], []);
    const noHistory = await buildAgentInitialMessages(
      request,
      [],
      [],
      undefined,
      { transcriptMessages: [] },
    );

    assert.include(JSON.stringify(derivedHistory), "Prior user message");
    assert.notInclude(JSON.stringify(noHistory), "Prior user message");
    assert.notInclude(JSON.stringify(noHistory), "Prior assistant message");
    assert.include(JSON.stringify(noHistory), "Current request");
  });

  it("freezes the rendered turn and composes fresh ordered message values", async function () {
    const request = resolvedAgentRequest({
      conversationKey: 702,
      mode: "agent",
      userText: "Inspect the supplied image",
      model: "test-model",
      systemPrompt: "SYSTEM_SENTINEL",
      customInstructions: "CUSTOM_SENTINEL",
      screenshots: ["data:image/png;base64,ZmFrZQ=="],
    });
    const rendered = await renderAgentPromptEnvelope(
      request,
      [],
      [],
      undefined,
      {
        contentInputs: {
          images: true,
          pdfDocuments: false,
          nativeFiles: false,
        },
      },
    );
    const transcript: AgentModelMessage[] = [
      { role: "assistant", content: "Prior answer" },
    ];
    const checkpoint: AgentModelMessage = {
      role: "user",
      content: "Agent semantic continuation checkpoint: continue safely.",
    };

    const first = composeAgentModelInput(rendered.envelope, {
      transcriptMessages: transcript,
      postTurnMessages: [checkpoint],
    });
    request.systemPrompt = "CHANGED_SYSTEM";
    request.customInstructions = "CHANGED_CUSTOM";
    request.userText = "Changed request";
    request.screenshots![0] = "data:image/png;base64,Y2hhbmdlZA==";
    const second = composeAgentModelInput(rendered.envelope, {
      transcriptMessages: transcript,
      postTurnMessages: [checkpoint],
    });

    assert.deepEqual(second, first);
    assert.notStrictEqual(second, first);
    for (let index = 0; index < first.length; index += 1) {
      assert.notStrictEqual(second[index], first[index]);
    }
    const turnIndex = first.length - 2;
    assert.equal(first[turnIndex - 1].role, "assistant");
    assert.equal(first[turnIndex].role, "user");
    assert.equal(first.at(-1)?.role, "user");
    assert.include(messageText(first[0]), "SYSTEM_SENTINEL");
    assert.include(messageText(first[0]), "CUSTOM_SENTINEL");
    assert.include(messageText(first[turnIndex]), "Inspect the supplied image");
    assert.equal(
      typeof first[turnIndex].content === "string"
        ? ""
        : first[turnIndex].content.find((part) => part.type === "image_url")
            ?.type,
      "image_url",
    );
    assert.include(
      messageText(first.at(-1)!),
      "Agent semantic continuation checkpoint",
    );

    if (typeof first[turnIndex].content !== "string") {
      const textPart = first[turnIndex].content.find(
        (part) => part.type === "text",
      );
      if (textPart?.type === "text") textPart.text = "Mutated composed copy";
    }
    const third = composeAgentModelInput(rendered.envelope);
    assert.include(messageText(third.at(-1)!), "Inspect the supplied image");
    assert.notInclude(messageText(third.at(-1)!), "Mutated composed copy");
  });

  describe("permission mode guidance", function () {
    const originalZotero = globalThis.Zotero;
    afterEach(function () {
      globalThis.Zotero = originalZotero;
    });

    function contentText(
      content: string | Array<{ type: string; text?: string }>,
    ) {
      return typeof content === "string"
        ? content
        : content
            .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
            .join("\n");
    }

    async function promptText(
      mode: "safe" | "auto" | "yolo",
      assumptions?: string[],
    ) {
      // Only the permission pref is stubbed; every other pref read stays undefined.
      globalThis.Zotero = {
        Prefs: {
          get: (key: string) =>
            key.endsWith("originalAgentPermissionMode") ? mode : undefined,
        },
      } as never;
      const request = resolvedAgentRequest({
        conversationKey: 9,
        mode: "agent",
        userText: "tidy this folder",
        classifiedIntent: classifiedFixture(),
        actionContract: {
          version: 4,
          id: "contract:mode",
          writeDisposition: "none",
          interpretationSource: "semantic",
          intent: classifiedFixture(),
          obligations: [],
          ...(assumptions ? { assumptions } : {}),
        },
      });
      const rendered = await renderAgentPromptEnvelope(request, [], []);
      return [
        ...rendered.envelope.systemMessages.map((message) =>
          contentText(message.content),
        ),
        contentText(rendered.envelope.turnMessage.content),
      ].join("\n");
    }

    it("tells the agent the current mode and how much to ask", async function () {
      const yolo = await promptText("yolo", ["Assumed append."]);
      assert.include(yolo, "Permission mode: yolo");
      assert.include(
        yolo,
        "The host does not run an approval model or ask for permission",
      );
      // The guidance must not read as unlimited authority: the rails that
      // still block in yolo belong in the same sentence.
      assert.include(yolo, "chat-only memory");
      assert.include(
        yolo,
        "importing discovered papers without the user's selection",
      );
      assert.notInclude(yolo, "Interpretation assumptions");
      const auto = await promptText("auto");
      assert.include(auto, "Permission mode: auto");
      assert.include(
        auto,
        "The host makes a bounded model review for other actions",
      );
      const safe = await promptText("safe");
      assert.include(safe, "Permission mode: safe");
      assert.include(safe, "Call the concrete tool");
      assert.include(safe, "host owns the review UI");
      assert.notInclude(safe, "Interpretation assumptions");
    });
  });
});

describe("agent prompt envelope evidence sufficiency", function () {
  const paperContext = {
    itemId: 3928,
    contextItemId: 3931,
    title: "Variability and stability in visual processing",
  };
  function request(withAnchor: boolean) {
    return resolvedAgentRequest({
      conversationKey: 4102,
      mode: "agent",
      conversationKind: "paper",
      libraryID: 1,
      activeItemId: paperContext.itemId,
      selectedPaperContexts: [paperContext],
      userText: "can you explain this part of result to me?",
      model: "test-model",
      ...(withAnchor
        ? {
            selectedTextContexts: [
              {
                text: "Consistency in categorization of object category over longer time scales",
                source: "pdf" as const,
                paperContext,
                contextItemId: 3931,
                pageIndex: 5,
                pageLabel: "6",
              },
            ],
            resolvedSelectedTextAnchors: [
              {
                contextIndex: 0,
                contextItemId: 3931,
                pageIndex: 5,
                pageLabel: "6",
                paperContext,
                resolution: "chunks" as const,
                primaryChunkIndex: 41,
                preferredChunkIndexes: [40, 41, 42],
                contextText:
                  "Consistency in categorization of object category over longer time scales. We asked whether...",
                injectedChars: 100,
              },
            ],
          }
        : {}),
      classifiedIntent: classifiedFixture({
        semantic: semanticFixture({
          reading: { source: "document_text", coverage: "targeted" },
        }),
      }),
    });
  }

  it("renders no per-turn reading rule for a targeted paper turn", async function () {
    for (const withAnchor of [true, false]) {
      const messages = await buildAgentInitialMessages(
        request(withAnchor),
        [],
        [],
      );
      const prompt = messages.map(messageText).join("\n");
      assert.notInclude(prompt, "TURN RULE");
      assert.notInclude(prompt, "The shared reading intent requires");
      assert.notInclude(prompt, "Already held");
    }
  });

  it("delivers paper_read guidance in a library chat with nothing selected", async function () {
    const paperRead = createPaperReadTool(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const messages = await buildAgentInitialMessages(
      resolvedAgentRequest({
        conversationKey: 4103,
        mode: "agent",
        conversationKind: "global",
        libraryID: 1,
        userText: "What does the Smith 2020 paper report?",
        model: "test-model",
      }),
      [paperRead],
      [],
    );
    const prompt = messages.map(messageText).join("\n");
    assert.include(prompt, paperRead.guidance!.instruction);
    assert.include(prompt, "recommendations are advisory");
  });

  it("keeps retrieval recommendations advisory in paper-scoped paper_read guidance", async function () {
    const paperRead = createPaperReadTool(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const withoutTool = await buildAgentInitialMessages(request(false), [], []);
    assert.notInclude(
      withoutTool.map(messageText).join("\n"),
      "recommendations are advisory",
    );
    const messages = await buildAgentInitialMessages(
      request(false),
      [paperRead],
      [],
    );
    const prompt = messages.map(messageText).join("\n");
    assert.include(prompt, "recommendations are advisory");
    assert.include(prompt, "freely retrieve missing methods, results");
    assert.notInclude(
      prompt,
      "when unchanged, do not repeat the read and retrieve again only for a specifically named missing dimension",
    );
  });
});

describe("agent prompt envelope direct workflow", function () {
  const RECEIPT_CONFIRMS =
    "A write result with a verified receipt already confirms the change; do not re-read the target to confirm it.";

  /** The Original Agent's "## Direct agent workflow" system block. */
  async function directWorkflowBlock(
    planContext?: PlanRuntimeContext,
  ): Promise<string> {
    const rendered = await renderAgentPromptEnvelope(
      resolvedAgentRequest({
        conversationKey: 912_101,
        mode: "agent",
        model: "test-model",
        userText: "Summarize this paper and save it as a note",
        ...(planContext ? { planContext } : {}),
      }),
      [],
      [],
    );
    const block = rendered.inventory.fixedPrompt
      .split("\n\n")
      .find((section) => section.startsWith("## Direct agent workflow"));
    assert.exists(block, "the Original Agent prompt has a direct workflow");
    return block!;
  }

  const executing: PlanRuntimeContext = {
    phase: "executing",
    planId: "plan-direct-workflow",
    revision: 1,
    executionId: "execution-direct-workflow",
    approvedDigest: "sha256:direct-workflow",
    provider: "original",
  };

  it("tells the model a verified write receipt already confirms the change", async function () {
    assert.include(await directWorkflowBlock(), RECEIPT_CONFIRMS);
    assert.include(await directWorkflowBlock(executing), RECEIPT_CONFIRMS);
  });

  it("keeps the receipt sentence out of the Codex client's instructions", function () {
    const codexManifest = buildZoteroEnvironmentManifest({
      scope: { kind: "global", libraryID: 1, conversationKey: 1 } as never,
      mcpEnabled: true,
      mcpReady: true,
    });
    assert.include(codexManifest, AGENT_ACTION_CONTRACT);
    assert.notInclude(codexManifest, RECEIPT_CONFIRMS);
  });
});
