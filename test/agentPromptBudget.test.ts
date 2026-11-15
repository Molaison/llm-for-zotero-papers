import { assert } from "chai";
import {
  AgentPromptBudgetError,
  enforceAgentPromptBudget,
  resolveAgentPromptBudgetLimits,
} from "../src/agent/context/promptBudget";
import {
  buildOpenAIFunctionTools,
  buildResponsesFunctionTools,
} from "../src/agent/model/shared";
import { buildResponsesContinuationInput } from "../src/agent/model/responsesShared";
import {
  estimateContextMessagesTokens,
  estimateTextTokens,
} from "../src/utils/modelInputCap";
import type { AgentModelMessage, ToolSpec } from "../src/agent/types";
import {
  buildAgentSemanticCheckpoint,
  readAgentTaskContext,
} from "../src/agent/context/transcriptCompactor";

describe("budget task context repair", function () {
  it("execution task context: survives budget/semantic/Continue without mixing execution A, B or unknown history", function () {
    let checkpoint = buildAgentSemanticCheckpoint({
      messages: [
        {
          role: "user",
          executionId: "execution-A",
          content: "User request:\nROOT_A",
        },
        {
          role: "user",
          executionId: "execution-B",
          content: "User request:\nROOT_B",
        },
        { role: "user", content: "User request:\nUNKNOWN_ROOT" },
      ],
      summaryTokens: 2000,
    }).checkpoint;
    for (let round = 0; round < 3; round += 1) {
      const result = enforceAgentPromptBudget({
        messages: [
          checkpoint,
          {
            role: "user",
            executionId: "execution-A",
            messageId: `exec-A-followup-${round}`,
            content: `User request:\nFOLLOWUP_A_${round}`,
          },
          { role: "assistant", content: "Old state. ".repeat(10000) },
          { role: "user", transient: true, content: "Prompt-only page state" },
        ],
        inputTokenCap: 8000,
        conversationKey: 919,
      });
      const context = readAgentTaskContext(result.messages, "execution-A")!;
      assert.include(context, "ROOT_A");
      assert.include(context, `FOLLOWUP_A_${round}`);
      assert.notInclude(context, "ROOT_B");
      assert.notInclude(context, "UNKNOWN_ROOT");
      checkpoint = buildAgentSemanticCheckpoint({
        messages: result.messages,
        summaryTokens: 2000,
      }).checkpoint;
      assert.equal(readAgentTaskContext([checkpoint], "execution-A"), context);
      assert.isAtMost(result.estimatedAfterTokens, result.softLimitTokens);
    }
  });

  it("clears only old evidence when many individually sub-floor replies exhaust the aggregate task budget", function () {
    const root: AgentModelMessage = {
      role: "user",
      executionId: "execution-A",
      content: "User request:\nCompare all nine papers.",
      messageId: "floor-root",
    };
    const checkpoint = buildAgentSemanticCheckpoint({
      messages: [root],
      summaryTokens: 1000,
    }).checkpoint;
    const messages: AgentModelMessage[] = [
      checkpoint,
      { role: "assistant", content: "Old state. ".repeat(10000) },
      { role: "user", transient: true, content: "Current page" },
    ];
    const originals: AgentModelMessage[] = [];
    for (let batch = 0; batch < 3; batch += 1) {
      const calls = Array.from({ length: 3 }, (_, offset) => ({
        id: `floor-${batch}-${offset}`,
        name: "paper_read",
        arguments: { itemId: batch * 3 + offset + 1 },
      }));
      messages.push({ role: "assistant", content: "", tool_calls: calls });
      for (const call of calls) {
        const message: AgentModelMessage = {
          role: "tool",
          name: call.name,
          tool_call_id: call.id,
          content: JSON.stringify({
            papers: [
              {
                paperContext: { itemId: call.arguments.itemId },
                passages: [{ text: "E".repeat(4700) }],
              },
            ],
          }),
        };
        assert.isBelow(estimateContextMessagesTokens([message]), 2048);
        originals.push(message);
        messages.push(message);
      }
    }
    const result = enforceAgentPromptBudget({
      messages,
      inputTokenCap: 8000,
      conversationKey: 919,
    });
    assert.isAtMost(result.estimatedAfterTokens, result.softLimitTokens);
    assert.include(
      readAgentTaskContext(result.messages, "execution-A")!,
      "Compare all nine papers.",
    );
    assert.deepEqual(
      result.messages.slice(-3),
      originals.slice(-3),
      "latest batch stays intact",
    );
    assert.isNotEmpty(result.handleRecords);
    for (const record of result.handleRecords) {
      const original = originals.find(
        (message) =>
          message.role === "tool" && message.tool_call_id === record.toolCallId,
      );
      assert.exists(original);
      assert.deepEqual(record.content, JSON.parse(String(original!.content)));
    }
    assert.throws(
      () => enforceAgentPromptBudget({ messages, inputTokenCap: 8000 }),
      /Cannot compact user task context/,
    );
  });

  const goal =
    "按原清单逐篇分析全文，保留具体结论和限制，不以标记存在替代内容。\n" +
    Array.from(
      { length: 24 },
      (_, index) =>
        `第${index + 1}篇：${"保留实验条件、方法、对照、结果数值和出处。".repeat(10)}`,
    ).join("\n") +
    "\n完整任务末尾约束：只读原集合，不新增写入权限。";
  const system: AgentModelMessage = { role: "system", content: "Use tools." };
  const longJob: AgentModelMessage = {
    role: "user",
    transient: true,
    content: "User request:\nHOST_ONLY_NOT_A_USER_TASK",
  };
  const seed = (text = goal) =>
    buildAgentSemanticCheckpoint({
      messages: [
        {
          role: "user",
          messageId: "budget-original-user",
          content: `User request:\n${text}`,
        },
      ],
      summaryTokens: 12000,
      conversationKey: 917,
    }).checkpoint;

  it("keeps complete structured tasks beyond the old 1200-token summary across budget/semantic/Continue", function () {
    let checkpoint = seed();
    assert.isAbove(estimateTextTokens(goal), 1200);
    const tools: ToolSpec[] = [
      {
        name: "read_paper",
        description: "Read only. ".repeat(100),
        inputSchema: { type: "object", properties: {} },
        executionClass: "read",
        requiresConfirmation: false,
      },
    ];
    for (let round = 0; round < 3; round += 1) {
      const messages: AgentModelMessage[] = [
        system,
        checkpoint,
        {
          role: "user",
          messageId: `budget-continue-${round}`,
          content: "User request:\n继续，并保留对照组。",
        },
        { role: "assistant", content: "Old visible state. ".repeat(12000) },
        longJob,
      ];
      const before = JSON.stringify(messages);
      const result = enforceAgentPromptBudget({
        messages,
        tools,
        inputTokenCap: 16000,
        conversationKey: 917,
      });
      assert.isTrue(result.changed);
      assert.equal(JSON.stringify(messages), before);
      assert.isAtMost(result.estimatedAfterTokens, result.softLimitTokens);
      const context = readAgentTaskContext(result.messages)!;
      assert.include(context, goal);
      assert.include(context, "继续，并保留对照组。");
      assert.notInclude(context, "HOST_ONLY_NOT_A_USER_TASK");
      checkpoint = buildAgentSemanticCheckpoint({
        messages: result.messages,
        summaryTokens: 12000,
        conversationKey: 917,
      }).checkpoint;
      assert.equal(readAgentTaskContext([checkpoint]), context);
    }
  });

  it("reduces tail tool data before replacing a task that fits the real message-plus-tools allowance", function () {
    const messages: AgentModelMessage[] = [
      system,
      seed(),
      { role: "user", content: "User request:\n继续" },
      { role: "assistant", content: "Old state. ".repeat(12000) },
      longJob,
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call-1", name: "library_search", arguments: {} }],
      },
      buildCatalogToolMessage(100),
    ];
    const result = enforceAgentPromptBudget({
      messages,
      inputTokenCap: 16000,
      conversationKey: 917,
    });
    assert.include(readAgentTaskContext(result.messages)!, goal);
    assert.isAtMost(result.estimatedAfterTokens, result.softLimitTokens);
    assert.isTrue(
      result.reductions.some((r) => r.kind === "catalog_compacted"),
    );
    assert.isNotEmpty(result.handleRecords);
  });

  it("keeps exact task pointers under true pressure and fails closed when even protected context cannot fit", function () {
    const messages: AgentModelMessage[] = [
      system,
      seed(goal.repeat(3)),
      { role: "assistant", content: "Old state. ".repeat(12000) },
      longJob,
      { role: "user", content: "User request:\nContinue" },
    ];
    const result = enforceAgentPromptBudget({
      messages,
      inputTokenCap: 4000,
      conversationKey: 917,
    });
    const context = readAgentTaskContext(result.messages)!;
    assert.include(context, "messageId=budget-original-user");
    assert.include(context, "not inline");
    assert.notInclude(context, "HOST_ONLY_NOT_A_USER_TASK");
    assert.isAtMost(result.estimatedAfterTokens, result.softLimitTokens);
    const resumed = buildAgentSemanticCheckpoint({
      messages: result.messages,
      summaryTokens: 1000,
    }).checkpoint;
    assert.equal(readAgentTaskContext([resumed]), context);
    const blocked: AgentModelMessage[] = [
      system,
      seed(),
      {
        role: "user",
        transient: true,
        content: "Protected host state. ".repeat(2000),
      },
    ];
    assert.throws(() =>
      enforceAgentPromptBudget({
        messages: blocked,
        inputTokenCap: 4000,
        conversationKey: 917,
      }),
    );
  });

  it("refits tasks to exact references after reserving an unchanged protected mutation receipt", function () {
    const inputTokenCap = 8000;
    const limit = resolveAgentPromptBudgetLimits({
      inputTokenCap,
    }).softLimitTokens;
    const receipt: AgentModelMessage = {
      role: "tool",
      name: "note_write",
      tool_call_id: "protected-write",
      content: JSON.stringify({
        ok: true,
        noteId: 87,
        text: "R".repeat(Math.floor(limit * 4 * 0.65)),
      }),
    };
    const result = enforceAgentPromptBudget({
      messages: [
        system,
        seed(),
        { role: "assistant", content: "Old state. ".repeat(12000) },
        longJob,
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "protected-write", name: "note_write", arguments: {} },
          ],
        },
        receipt,
      ],
      inputTokenCap,
      conversationKey: 917,
    });
    assert.deepEqual(result.messages.at(-1), receipt);
    assert.include(
      readAgentTaskContext(result.messages)!,
      "messageId=budget-original-user",
    );
    assert.isAtMost(result.estimatedAfterTokens, result.softLimitTokens);
  });
});

function buildRows(count: number, detailLength = 500) {
  return Array.from({ length: count }, (_, index) => ({
    itemId: 10_000 + index,
    itemType: "journalArticle",
    title: `Very detailed paper ${index}`,
    firstCreator: `Author ${index}`,
    year: "2026",
    abstract: "A".repeat(detailLength),
    tags: [`tag-${index % 3}`],
    collectionIds: [42],
    attachments: Array.from({ length: 3 }, (__, attachmentIndex) => ({
      title: `Attachment ${attachmentIndex}`,
      path: `/tmp/${index}-${attachmentIndex}.pdf`,
    })),
  }));
}

function buildCatalogToolMessage(rowCount = 80): AgentModelMessage {
  return {
    role: "tool",
    tool_call_id: "call-1",
    name: "library_search",
    content: JSON.stringify({
      entity: "items",
      mode: "list",
      filters: { collectionId: 42, hasPdf: true },
      limit: rowCount,
      totalCount: rowCount,
      returnedCount: rowCount,
      limited: false,
      results: buildRows(rowCount),
      warnings: ["broad catalog result"],
    }),
  };
}

function buildEvidenceToolMessage(snippetCount = 50): AgentModelMessage {
  return {
    role: "tool",
    tool_call_id: "call-1",
    name: "library_retrieve",
    content: JSON.stringify({
      intent: "enumerate",
      depth: "evidence",
      resourcePool: {
        totalItems: 120,
        queryCoverage: {
          metadataInspected: 120,
          indexedTextScanned: 90,
          snippetsReturned: snippetCount,
        },
      },
      answerContract: {
        coverage: "indexed/searchable text scanned for the scoped pool",
      },
      paperMatches: Array.from({ length: snippetCount }, (_, index) => ({
        itemId: 20_000 + index,
        contextItemId: 30_000 + index,
        title: `Evidence paper ${index}`,
        matchStatus: "matched",
        score: 0.9,
      })),
      snippets: Array.from({ length: snippetCount }, (_, index) => ({
        snippetId: `lr_${20_000 + index}_${30_000 + index}_${index}_bm25`,
        itemId: `${20_000 + index}`,
        contextItemId: `${30_000 + index}`,
        chunkIndex: index,
        title: `Evidence paper ${index}`,
        sourceKind: "pdf_text",
        matchMethod: "bm25",
        sectionLabel: "Results",
        snippet: `Evidence snippet ${index} ${"B".repeat(900)}`,
        surroundingText: `Surrounding evidence ${index} ${"C".repeat(900)}`,
        score: 0.9,
        whyMatched: "Full-text BM25 retrieval ranked this passage highly",
        matchedQueryVariant: "representational drift",
      })),
      warnings: ["coverage is bounded by indexed text availability"],
    }),
  };
}

describe("agent prompt budget", function () {
  it("budget feedback: counts normalized wire tools including schema keys", function () {
    const messages: AgentModelMessage[] = [{ role: "user", content: "Read." }];
    const tools: ToolSpec[] = [
      {
        name: "paper_read",
        description: "Read paper",
        inputSchema: {
          type: "object",
          properties: { veryLongSchemaPropertyName: { type: "string" } },
        },
        executionClass: "read",
        requiresConfirmation: false,
      },
    ];
    const result = enforceAgentPromptBudget({
      messages,
      tools,
      inputTokenCap: 16_000,
    });
    assert.isFalse(result.changed);
    assert.isAtLeast(
      result.estimatedAfterTokens,
      estimateContextMessagesTokens(messages) +
        Math.max(
          estimateTextTokens(JSON.stringify(buildOpenAIFunctionTools(tools))),
          estimateTextTokens(
            JSON.stringify(buildResponsesFunctionTools(tools)),
          ),
        ),
    );
    const withoutTools = enforceAgentPromptBudget({
      messages,
      inputTokenCap: 16_000,
    });
    assert.isAbove(
      result.estimatedAfterTokens,
      withoutTools.estimatedAfterTokens,
    );
  });

  it("budget feedback: rejects an oversized tools-only payload locally", function () {
    const tools: ToolSpec[] = [
      {
        name: "paper_read",
        description: "D".repeat(50_000),
        inputSchema: { type: "object" },
        executionClass: "read",
        requiresConfirmation: false,
      },
    ];
    assert.throws(
      () =>
        enforceAgentPromptBudget({
          messages: [{ role: "user", content: "Read." }],
          tools,
          inputTokenCap: 4_000,
        }),
      AgentPromptBudgetError,
    );
  });

  it("budget feedback: reserves tool definitions before reducing catalog results", function () {
    const messages: AgentModelMessage[] = [
      { role: "user", content: "Read the catalog." },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call-1", name: "library_search", arguments: {} }],
      },
      buildCatalogToolMessage(12),
    ];
    const tools: ToolSpec[] = [
      {
        name: "library_search",
        description: "D".repeat(16_000),
        inputSchema: { type: "object" },
        executionClass: "read",
        requiresConfirmation: false,
      },
    ];
    const without = enforceAgentPromptBudget({
      messages,
      inputTokenCap: 8_000,
    });
    assert.isFalse(without.changed);
    const result = enforceAgentPromptBudget({
      messages,
      tools,
      inputTokenCap: 8_000,
    });
    assert.isTrue(result.changed);
    assert.isAbove(result.estimatedBeforeTokens, result.softLimitTokens);
    assert.isAtMost(result.estimatedAfterTokens, result.softLimitTokens);
  });

  it("resolves context limits from the model input cap override", function () {
    const limits = resolveAgentPromptBudgetLimits({
      model: "claude-haiku-4-5",
      inputTokenCap: 12_000,
    });
    assert.equal(limits.contextWindow, 12_000);
    assert.equal(limits.inputLimitSource, "advanced");
    // 90% usable window minus the answer reserve (capped at a quarter of it).
    assert.equal(limits.softLimitTokens, 10_800 - 2_700);
    assert.notProperty(limits, "toolResultMaxTokens");
  });

  it("keeps one sized tool view for Claude Haiku 5.5 under its 100k-token price tier", async function () {
    const { MODEL_VIEW_ROOM_SHARE } =
      await import("../src/agent/tools/read/modelViewRoom");
    const limits = resolveAgentPromptBudgetLimits({
      model: "claude-haiku-5-5",
      apiBase: "https://api.anthropic.com/v1",
      providerProtocol: "anthropic_messages",
      authMode: "api_key",
    });
    // Haiku 5.5 bills every token at 5x once a prompt passes 100k; a 1M
    // registry limit sized library-wide views at 138k-158k tokens.
    assert.equal(limits.contextWindow, 200_000);
    assert.isBelow(limits.softLimitTokens * MODEL_VIEW_ROOM_SHARE, 50_000);
  });

  it("resolves the prompt budget from the matching profile override", function () {
    const limits = resolveAgentPromptBudgetLimits({
      model: "claude-haiku-4-5",
      profileOverride: {
        forModel: "claude-haiku-4-5",
        limits: { inputTokens: 18_000 },
      },
    });

    assert.equal(limits.contextWindow, 18_000);
    assert.equal(limits.inputLimitSource, "user");
    assert.equal(limits.softLimitTokens, 16_200 - 4_050);
  });

  it("leaves small prompts unchanged", function () {
    const messages: AgentModelMessage[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Summarize this paper." },
    ];
    const result = enforceAgentPromptBudget({
      messages,
      model: "claude-haiku-4-5",
      inputTokenCap: 12_000,
    });
    assert.isFalse(result.changed);
    assert.deepEqual(result.messages, messages);
    assert.deepEqual(result.reductions, []);
    assert.deepEqual(result.handleRecords, []);
  });

  it("keeps a full large tool result when the complete prompt fits a 200k budget", function () {
    const messages: AgentModelMessage[] = [
      { role: "system", content: "Use tools." },
      { role: "user", content: "Search my library." },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call-1",
            name: "library_search",
            arguments: { entity: "items", mode: "list" },
          },
        ],
      },
      buildCatalogToolMessage(120),
    ];
    const result = enforceAgentPromptBudget({
      messages,
      model: "claude-haiku-4-5",
      inputTokenCap: 200_000,
    });
    assert.isFalse(result.changed);
    assert.deepEqual(result.handleRecords, []);
    const serialized = JSON.stringify(result.messages);
    assert.include(serialized, "A".repeat(300));
    assert.notInclude(serialized, "modelContextCompacted");
  });

  it("compacts catalog rows only under actual send pressure", function () {
    const messages: AgentModelMessage[] = [
      { role: "system", content: "Use tools." },
      { role: "user", content: "Search my library." },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call-1",
            name: "library_search",
            arguments: { entity: "items", mode: "list" },
          },
        ],
      },
      buildCatalogToolMessage(160),
    ];
    const result = enforceAgentPromptBudget({
      messages,
      model: "claude-haiku-4-5",
      inputTokenCap: 8_000,
      conversationKey: 1,
      resourceSignature: "scope-a",
    });
    assert.isTrue(result.changed);
    assert.isAtMost(result.estimatedAfterTokens, result.softLimitTokens);
    assert.deepInclude(result.reductions, {
      kind: "catalog_compacted",
      count: 1,
    });
    const tool = result.messages.find((message) => message.role === "tool");
    assert.equal(tool?.role, "tool");
    const modelFacing = JSON.parse((tool as { content: string }).content);
    assert.isTrue(modelFacing.modelContextCompacted);
    assert.equal(modelFacing.totalCount, 160);
    assert.equal(modelFacing.filters.collectionId, 42);
    assert.isBelow(modelFacing.results.length, 160);
    assert.match(modelFacing.toolResultHandle, /^trh_/);
    assert.lengthOf(result.handleRecords, 1);
    assert.equal(result.handleRecords[0].handle, modelFacing.toolResultHandle);
    assert.equal(result.handleRecords[0].conversationKey, 1);
    assert.equal(result.handleRecords[0].toolName, "library_search");
    assert.lengthOf(
      (result.handleRecords[0].content as { results: unknown[] }).results,
      160,
    );
    assert.notInclude(JSON.stringify(modelFacing), "A".repeat(200));
  });

  for (const toolName of ["library_search"]) {
    it(`compacts ${toolName} catalog rows as catalog results`, function () {
      const catalog = buildCatalogToolMessage(160);
      catalog.name = toolName;
      const result = enforceAgentPromptBudget({
        messages: [
          { role: "system", content: "Use tools." },
          { role: "user", content: "Search my library." },
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call-1",
                name: toolName,
                arguments: { entity: "items", mode: "list" },
              },
            ],
          },
          catalog,
        ],
        model: "claude-haiku-4-5",
        inputTokenCap: 8_000,
        conversationKey: 1,
        resourceSignature: "scope-a",
      });
      assert.deepInclude(result.reductions, {
        kind: "catalog_compacted",
        count: 1,
      });
    });
  }

  for (const [toolName, args] of [
    ["paper_read", { mode: "targeted", query: "method" }],
    ["read_attachment", { attachmentId: 30_000 }],
  ] as const) {
    it(`prunes ${toolName} results under context pressure as paper evidence`, function () {
      const evidence = buildEvidenceToolMessage(80);
      evidence.name = toolName;
      const messages: AgentModelMessage[] = [
        { role: "system", content: "Use paper evidence." },
        { role: "user", content: "Answer from the paper." },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "call-1", name: toolName, arguments: args }],
        },
        evidence,
      ];
      const result = enforceAgentPromptBudget({
        messages,
        model: "claude-haiku-4-5",
        inputTokenCap: 10_000,
        conversationKey: 1,
        resourceSignature: "scope-a",
      });
      assert.isTrue(result.changed);
      assert.isBelow(result.estimatedAfterTokens, result.estimatedBeforeTokens);
      assert.deepInclude(result.reductions, {
        kind: "evidence_compacted",
        count: 1,
      });
    });
  }

  // Stored history written by older versions can still carry a retired tool
  // name. It is no longer recognised as paper evidence: it is compacted like
  // any other tool result, and never breaks the budget pass.
  it("compacts a retired read_paper result generically without throwing", function () {
    const retired = buildEvidenceToolMessage(80);
    retired.name = "read_paper";
    retired.tool_call_id = "call-old";
    const messages: AgentModelMessage[] = [
      { role: "system", content: "Use paper evidence." },
      { role: "user", content: "Answer from the paper." },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call-old",
            name: "read_paper",
            arguments: { chunkIndexes: [1] },
          },
        ],
      },
      retired,
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call-new",
            name: "paper_read",
            arguments: { mode: "targeted", query: "method" },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call-new",
        name: "paper_read",
        content: JSON.stringify({ passages: [{ text: "Short passage." }] }),
      },
    ];
    let result: ReturnType<typeof enforceAgentPromptBudget> | undefined;
    assert.doesNotThrow(() => {
      result = enforceAgentPromptBudget({
        messages,
        model: "claude-haiku-4-5",
        inputTokenCap: 10_000,
        conversationKey: 1,
        resourceSignature: "scope-a",
      });
    });
    assert.isTrue(result!.changed);
    assert.isBelow(result!.estimatedAfterTokens, result!.estimatedBeforeTokens);
    const kinds = result!.reductions.map((reduction) => reduction.kind);
    assert.notInclude(kinds, "evidence_compacted");
    assert.isTrue(
      kinds.includes("tool_result_cleared") ||
        kinds.includes("generic_compacted"),
      `expected generic compaction, got ${kinds.join(", ")}`,
    );
  });

  it("preserves assistant tool-call and tool-result ordering while reducing", function () {
    const messages: AgentModelMessage[] = [
      { role: "system", content: "Use tools." },
      { role: "user", content: "Search my library." },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call-1",
            name: "library_search",
            arguments: { entity: "items", mode: "list" },
          },
        ],
      },
      buildCatalogToolMessage(120),
    ];
    const result = enforceAgentPromptBudget({
      messages,
      model: "claude-haiku-4-5",
      inputTokenCap: 4_000,
    });
    assert.isTrue(result.changed);
    assert.deepEqual(
      result.messages.map((message) => message.role),
      ["system", "user", "assistant", "tool"],
    );
    const assistant = result.messages.find(
      (message) => message.role === "assistant",
    );
    const tool = result.messages.find((message) => message.role === "tool");
    assert.equal(assistant?.role, "assistant");
    assert.equal(tool?.role, "tool");
    assert.equal(tool?.tool_call_id, "call-1");
    assert.equal(assistant?.tool_calls?.[0]?.id, "call-1");
  });

  it("keeps the root user request when a tool follow-up user message exists", function () {
    const messages: AgentModelMessage[] = [
      { role: "system", content: "Use tools." },
      { role: "user", content: "Old context ".repeat(10_000) },
      { role: "assistant", content: "Old answer." },
      { role: "user", content: "Search my library for drift papers." },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call-1",
            name: "library_search",
            arguments: { entity: "items", mode: "list" },
          },
        ],
      },
      buildCatalogToolMessage(20),
      { role: "user", content: "Tool artifact summary." },
    ];
    const result = enforceAgentPromptBudget({
      messages,
      model: "claude-haiku-4-5",
      inputTokenCap: 3_200,
    });
    assert.isTrue(result.changed);
    assert.isAtMost(result.estimatedAfterTokens, result.softLimitTokens);
    assert.deepEqual(
      result.messages.map((message) => message.role),
      ["system", "user", "user", "assistant", "tool", "user"],
    );
    assert.include(
      String(result.messages[1].content),
      "Agent context checkpoint",
    );
    assert.equal(
      result.messages[2].content,
      "Search my library for drift papers.",
    );
  });

  it("preserves evidence snippets and anchors when evidence must be reduced", function () {
    const messages: AgentModelMessage[] = [
      { role: "system", content: "Use tools." },
      { role: "user", content: "Find evidence." },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call-1",
            name: "library_retrieve",
            arguments: { query: "representational drift" },
          },
        ],
      },
      buildEvidenceToolMessage(80),
    ];
    const result = enforceAgentPromptBudget({
      messages,
      model: "claude-haiku-4-5",
      inputTokenCap: 10_000,
      conversationKey: 2,
      resourceSignature: "scope-a",
    });
    assert.isTrue(result.changed);
    assert.isAtMost(result.estimatedAfterTokens, result.softLimitTokens);
    assert.deepInclude(result.reductions, {
      kind: "evidence_compacted",
      count: 1,
    });
    const tool = result.messages.find((message) => message.role === "tool");
    assert.equal(tool?.role, "tool");
    const modelFacing = JSON.parse((tool as { content: string }).content);
    assert.isTrue(modelFacing.modelContextCompacted);
    assert.match(modelFacing.toolResultHandle, /^trh_/);
    assert.lengthOf(result.handleRecords, 1);
    assert.equal(result.handleRecords[0].handle, modelFacing.toolResultHandle);
    assert.include(JSON.stringify(modelFacing), "queryCoverage");
    assert.include(modelFacing.snippets[0].text, "Evidence snippet 0");
    assert.equal(modelFacing.snippets[0].itemId, "20000");
    assert.equal(modelFacing.snippets[0].contextItemId, "30000");
    assert.equal(modelFacing.snippets[0].matchMethod, "bm25");
    assert.equal(modelFacing.snippets[0].paperContext.itemId, "20000");
    assert.equal(modelFacing.snippets[0].paperContext.contextItemId, "30000");
  });

  it("keeps paper rows when long snippets must be reduced", function () {
    const evidence = buildEvidenceToolMessage(80);
    const payload = JSON.parse(evidence.content as string);
    for (const snippet of payload.snippets) {
      snippet.snippet = `${snippet.snippet} ${"D".repeat(4_000)}`;
    }
    evidence.content = JSON.stringify(payload);
    const result = enforceAgentPromptBudget({
      messages: [
        { role: "system", content: "Use tools." },
        { role: "user", content: "Find evidence." },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call-1",
              name: "library_retrieve",
              arguments: { query: "representational drift" },
            },
          ],
        },
        evidence,
      ],
      model: "claude-haiku-4-5",
      inputTokenCap: 10_000,
      conversationKey: 2,
      resourceSignature: "scope-a",
    });
    const tool = result.messages.find((message) => message.role === "tool");
    const modelFacing = JSON.parse((tool as { content: string }).content);
    assert.isTrue(modelFacing.modelContextCompacted);
    assert.isNotEmpty(modelFacing.snippets, "snippets still fit");
    assert.isNotEmpty(modelFacing.paperMatches, "paper rows survive");
    const rowIds = new Set(
      modelFacing.paperMatches.map((row: { itemId: unknown }) =>
        String(row.itemId),
      ),
    );
    for (const snippet of modelFacing.snippets) {
      assert.isTrue(rowIds.has(String(snippet.itemId)), snippet.itemId);
    }
  });

  it("preserves the original paper-evidence handle and progress when reducing its payload", function () {
    const evidence = buildEvidenceToolMessage(80);
    evidence.name = "paper_read";
    const content = JSON.parse(String(evidence.content));
    content.toolResultHandle = "trh_original_paper_evidence";
    content.paperEvidenceProgress = {
      frontier: "advanced",
      coverage: "targeted",
      newOccurrenceIds: ["paper-occurrence:one"],
      repeatedOccurrenceIds: [],
      cumulativeOccurrenceCount: 1,
      recommendation: "answer_or_self_check",
      reason: "New source occurrences were delivered.",
    };
    content.paperEvidenceReferences = [
      {
        sourceToolCallId: "call-1",
        occurrenceId: "paper-occurrence:one",
        quoteCitationIds: ["quote-one"],
        toolResultHandle: "trh_original_paper_evidence",
      },
    ];
    evidence.content = JSON.stringify(content);
    const result = enforceAgentPromptBudget({
      messages: [
        { role: "system", content: "Use paper evidence." },
        { role: "user", content: "Answer from the paper." },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call-1",
              name: "paper_read",
              arguments: { mode: "targeted", query: "method" },
            },
          ],
        },
        evidence,
      ],
      model: "claude-haiku-4-5",
      inputTokenCap: 6_000,
      conversationKey: 1,
      resourceSignature: "scope-a",
    });

    assert.isTrue(result.changed);
    const toolMessage = result.messages.find(
      (message) => message.role === "tool",
    );
    assert.equal(toolMessage?.role, "tool");
    const modelFacing = JSON.parse(String(toolMessage?.content));
    assert.equal(modelFacing.toolResultHandle, "trh_original_paper_evidence");
    assert.equal(modelFacing.paperEvidenceProgress.frontier, "advanced");
    assert.equal(
      modelFacing.paperEvidenceReferences[0].occurrenceId,
      "paper-occurrence:one",
    );
  });

  it("strips orphan quote citation ids when evidence must be reduced", function () {
    const evidenceMessage = buildEvidenceToolMessage(80);
    const content = JSON.parse(String(evidenceMessage.content));
    content.snippets = content.snippets.map(
      (snippet: Record<string, unknown>, index: number) => ({
        ...snippet,
        quoteCitationId: `Q_orphan_${index}`,
      }),
    );
    evidenceMessage.content = JSON.stringify(content);
    const result = enforceAgentPromptBudget({
      messages: [
        { role: "system", content: "Use tools." },
        { role: "user", content: "Find evidence." },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call-1",
              name: "library_retrieve",
              arguments: { query: "representational drift" },
            },
          ],
        },
        evidenceMessage,
      ],
      model: "claude-haiku-4-5",
      inputTokenCap: 10_000,
      conversationKey: 2,
      resourceSignature: "scope-a",
    });
    const tool = result.messages.find((message) => message.role === "tool");
    assert.equal(tool?.role, "tool");
    const modelFacing = JSON.parse((tool as { content: string }).content);

    assert.isTrue(modelFacing.modelContextCompacted);
    assert.notProperty(modelFacing.snippets[0], "quoteCitationId");
    assert.notProperty(modelFacing, "quoteCitations");
  });

  it("keeps compacted quote ids only with matching quote metadata", function () {
    const evidenceMessage = buildEvidenceToolMessage(80);
    const content = JSON.parse(String(evidenceMessage.content));
    content.snippets = content.snippets.map(
      (snippet: Record<string, unknown>, index: number) => ({
        ...snippet,
        quoteCitationId: index === 0 ? "Q_valid_0" : `Q_orphan_${index}`,
      }),
    );
    content.quoteCitations = [
      {
        id: "Q_valid_0",
        quoteText: "Evidence snippet 0",
        citationLabel: "(Evidence Paper 0, 2026)",
        itemId: 20_000,
        contextItemId: 30_000,
      },
    ];
    evidenceMessage.content = JSON.stringify(content);
    const result = enforceAgentPromptBudget({
      messages: [
        { role: "system", content: "Use tools." },
        { role: "user", content: "Find evidence." },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call-1",
              name: "library_retrieve",
              arguments: { query: "representational drift" },
            },
          ],
        },
        evidenceMessage,
      ],
      model: "claude-haiku-4-5",
      inputTokenCap: 10_000,
      conversationKey: 2,
      resourceSignature: "scope-a",
    });
    const tool = result.messages.find((message) => message.role === "tool");
    assert.equal(tool?.role, "tool");
    const modelFacing = JSON.parse((tool as { content: string }).content);

    assert.isTrue(modelFacing.modelContextCompacted);
    assert.equal(modelFacing.quoteCitations[0].id, "Q_valid_0");
    assert.equal(modelFacing.snippets[0].quoteCitationId, "Q_valid_0");
    assert.notInclude(JSON.stringify(modelFacing), "Q_orphan_1");
  });

  it("keeps '.' and ':' in compacted quote ids", function () {
    const evidenceMessage = buildEvidenceToolMessage(80);
    const content = JSON.parse(String(evidenceMessage.content));
    content.snippets = content.snippets.map(
      (snippet: Record<string, unknown>, index: number) => ({
        ...snippet,
        quoteCitationId: index === 0 ? "Q1.a:p2" : `Q_orphan_${index}`,
      }),
    );
    content.quoteCitations = [
      {
        id: "Q1.a:p2",
        quoteText: "Evidence snippet 0",
        citationLabel: "(Evidence Paper 0, 2026)",
        itemId: 20_000,
        contextItemId: 30_000,
      },
    ];
    evidenceMessage.content = JSON.stringify(content);
    const result = enforceAgentPromptBudget({
      messages: [
        { role: "system", content: "Use tools." },
        { role: "user", content: "Find evidence." },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call-1",
              name: "library_retrieve",
              arguments: { query: "representational drift" },
            },
          ],
        },
        evidenceMessage,
      ],
      model: "claude-haiku-4-5",
      inputTokenCap: 10_000,
      conversationKey: 2,
      resourceSignature: "scope-a",
    });
    const tool = result.messages.find((message) => message.role === "tool");
    const modelFacing = JSON.parse((tool as { content: string }).content);

    assert.isTrue(modelFacing.modelContextCompacted);
    assert.equal(modelFacing.quoteCitations[0].id, "Q1.a:p2");
    assert.equal(modelFacing.snippets[0].quoteCitationId, "Q1.a:p2");
  });

  /**
   * Host state the model should see once is marked transient. The transcript
   * compactor already refuses to fold such a message into a durable summary;
   * the prompt budget builds its own checkpoint and must refuse it too, or a
   * compacted turn would keep telling the model to save material that has
   * since been written.
   */
  it("never folds a transient host message into the history checkpoint", function () {
    const blockHeader = "Finalized material available (not saved as a note):";
    const messages: AgentModelMessage[] = [
      { role: "system", content: "Use tools." },
      { role: "user", content: "Old context ".repeat(10_000) },
      { role: "assistant", content: "Old answer." },
      {
        role: "user",
        transient: true,
        content: `${blockHeader}\ndocumentId=doc-1 version=1 hash=sha256:guide title="Representational drift" status=finalized`,
      },
      { role: "user", content: "Save that as a note." },
    ];
    const result = enforceAgentPromptBudget({
      messages,
      model: "claude-haiku-4-5",
      inputTokenCap: 4_000,
    });
    assert.isTrue(result.changed);
    assert.include(
      String(result.messages[1].content),
      "Agent context checkpoint",
      "the older turns were reduced to a checkpoint",
    );
    assert.notInclude(
      result.messages.map((message) => String(message.content)).join("\n"),
      blockHeader,
      "a transient message must not survive compaction in any form",
    );
  });

  it("adds handles to history checkpoints for dropped older tool results", function () {
    const messages: AgentModelMessage[] = [
      { role: "system", content: "Use tools." },
      { role: "user", content: "Earlier catalog request." },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "old-call",
            name: "library_search",
            arguments: { entity: "items", mode: "list" },
          },
        ],
      },
      {
        ...buildCatalogToolMessage(80),
        tool_call_id: "old-call",
        content: JSON.stringify({
          results: buildRows(80),
          error:
            "Invalid tool input: limit does not apply to source:'conversation'.",
          unknown: "NOT_A_DIAGNOSTIC",
        }),
      } as AgentModelMessage,
      { role: "assistant", content: "Earlier synthesis." },
      { role: "user", content: "Current request." },
    ];
    const result = enforceAgentPromptBudget({
      messages,
      model: "claude-haiku-4-5",
      inputTokenCap: 4_000,
      conversationKey: 3,
      resourceSignature: "scope-a",
    });
    assert.isTrue(result.changed);
    assert.include(
      String(result.messages[1].content),
      "limit does not apply to source:'conversation'",
    );
    assert.notInclude(String(result.messages[1].content), "NOT_A_DIAGNOSTIC");
    assert.lengthOf(result.handleRecords, 1);
    assert.include(
      String(result.messages[1].content),
      result.handleRecords[0].handle,
    );
    assert.lengthOf(
      (result.handleRecords[0].content as { results: unknown[] }).results,
      80,
    );
  });

  it("preserves a small latest context read while reducing older tool output", function () {
    const latestReadContent = JSON.stringify({
      handle: "trh_latest",
      path: "results",
      returnedCount: 2,
      items: [
        { itemId: 51, title: "Stored row 50" },
        { itemId: 52, title: "Stored row 51" },
      ],
    });
    const messages: AgentModelMessage[] = [
      { role: "system", content: "Use tools." },
      { role: "user", content: "List papers, then inspect omitted rows." },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call-library",
            name: "library_search",
            arguments: { entity: "items", mode: "list" },
          },
        ],
      },
      {
        ...buildCatalogToolMessage(160),
        tool_call_id: "call-library",
      } as AgentModelMessage,
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call-read",
            name: "context_read",
            arguments: {
              source: "tool_result",
              handle: "trh_latest",
              path: "results",
              offset: 50,
              limit: 2,
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call-read",
        name: "context_read",
        content: latestReadContent,
      },
    ];

    const result = enforceAgentPromptBudget({
      messages,
      model: "claude-haiku-4-5",
      inputTokenCap: 8_000,
      conversationKey: 4,
      resourceSignature: "scope-b",
    });

    assert.isTrue(result.changed);
    const latestToolResult = result.messages.find(
      (message) =>
        message.role === "tool" && message.tool_call_id === "call-read",
    );
    assert.equal(latestToolResult?.content, latestReadContent);
  });

  it("reduces five latest context reads with schemas while preserving originals and a mutation receipt", async function () {
    const tools: ToolSpec[] = Array.from({ length: 32 }, (_, index) => ({
      name: `tool_${index}`,
      description: "Tool description ".repeat(40),
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      executionClass: "read",
      requiresConfirmation: false,
    }));
    const calls = Array.from({ length: 5 }, (_, index) => ({
      id: `read-${index}`,
      name: "context_read",
      arguments: { source: "tool_result", handle: `trh_source_${index}` },
    }));
    const originals = calls.map((call, index) => ({
      role: "tool" as const,
      name: call.name,
      tool_call_id: call.id,
      content: JSON.stringify({
        ok: true,
        handle: call.arguments.handle,
        path: "results",
        offset: index,
        nextOffset: index + 1,
        returnedCount: 1,
        items: [{ text: "R".repeat(16_000), anchor: `END_${index}` }],
      }),
    }));
    const receipt = {
      role: "tool" as const,
      name: "note_write",
      tool_call_id: "mutation",
      content: JSON.stringify({
        ok: true,
        noteId: 87,
        text: "receipt".repeat(700),
      }),
    };
    const messages: AgentModelMessage[] = [
      {
        role: "user",
        content: "Read persisted pages; preserve the write receipt.",
      },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          ...calls,
          { id: "mutation", name: "note_write", arguments: {} },
        ],
      },
      ...originals,
      receipt,
    ];
    const before = JSON.stringify(messages);
    const result = enforceAgentPromptBudget({
      messages,
      tools,
      inputTokenCap: 16_000,
      conversationKey: 31001,
    });
    assert.isAbove(result.estimatedBeforeTokens, result.softLimitTokens);
    assert.isAtMost(result.estimatedAfterTokens, result.softLimitTokens);
    assert.equal(JSON.stringify(messages), before);
    assert.isNotEmpty(result.handleRecords);
    assert.deepEqual(result.messages.at(-1), receipt);
    for (const record of result.handleRecords) {
      const original = originals.find(
        (m) => m.tool_call_id === record.toolCallId,
      )!;
      assert.deepEqual(record.content, JSON.parse(original.content));
      const view = JSON.parse(
        result.messages.find(
          (m) => m.role === "tool" && m.tool_call_id === record.toolCallId,
        )!.content as string,
      );
      assert.equal(view.toolResultHandle, record.handle);
      assert.equal(
        view.originalPage.handle,
        (record.content as { handle: string }).handle,
      );
      assert.notProperty(view, "items");
      assert.notProperty(view, "nextOffset");
      assert.include(view.notice, "does not deliver the original page");
    }
    assert.deepEqual(result.messages[1], messages[1]);
    const wire = await buildResponsesContinuationInput(
      result.messages.filter((m) => m.role === "tool"),
      {
        resolveFilePart: async () => {
          throw new Error("Unexpected file");
        },
      },
    );
    const outputIds = wire
      .filter((m) => m.type === "function_call_output")
      .map((m) => m.call_id);
    assert.deepEqual(outputIds, [...calls.map((c) => c.id), "mutation"]);
  });

  for (const page of [
    {
      handle: "trh_" + "exact".repeat(100),
      path: "p".repeat(600),
      offset: 7,
      nextOffset: 8,
      itemChunk: {
        format: "json",
        text: "C".repeat(20_000),
        textOffset: 501,
        nextTextOffset: 20_501,
        totalChars: 30_000,
      },
    },
    {
      messageId: "answer-very-long-" + "id".repeat(200),
      textOffset: 100,
      nextTextOffset: 20_100,
      totalChars: 30_000,
      text: "C".repeat(20_000),
    },
    {
      handle: "trh_error",
      path: "missing",
      ok: false,
      status: "scope_rejected",
      stale: true,
      error: { code: "stale_scope", message: "Actual error ".repeat(60) },
      warnings: ["Real scope warning ".repeat(40)],
      value: "C".repeat(20_000),
    },
    {
      messageId: "answer-error",
      ok: false,
      error: "Real error ".repeat(80),
      text: "C".repeat(20_000),
    },
  ]) {
    it("retains exact context-read cursors and real status without presenting an omitted page as delivered", function () {
      const messages: AgentModelMessage[] = [
        { role: "user", content: "Read stored context." },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "read", name: "context_read", arguments: {} }],
        },
        {
          role: "tool",
          name: "context_read",
          tool_call_id: "read",
          content: JSON.stringify(page),
        },
      ];
      const result = enforceAgentPromptBudget({
        messages,
        inputTokenCap: 4_000,
        conversationKey: 31002,
      });
      const view = JSON.parse(result.messages.at(-1)!.content as string);
      for (const key of [
        "handle",
        "path",
        "messageId",
        "offset",
        "textOffset",
        "nextOffset",
        "nextTextOffset",
        "totalChars",
      ] as const) {
        if (key in page)
          assert.deepEqual(
            view.originalPage[key],
            page[key as keyof typeof page],
          );
      }
      for (const key of [
        "ok",
        "status",
        "error",
        "warnings",
        "stale",
      ] as const) {
        if (key in page)
          assert.deepEqual(view[key], page[key as keyof typeof page]);
      }
      if (page.itemChunk) {
        const { text: _text, ...cursor } = page.itemChunk;
        assert.deepEqual(view.originalPage.itemChunk, cursor);
      }
      assert.deepEqual(result.handleRecords[0].content, page);
      assert.notProperty(view, "text");
      assert.notProperty(view, "value");
    });
  }

  it("fails closed without a recovery record or when a latest mutation alone cannot fit", function () {
    for (const name of ["context_read", "note_write"]) {
      const messages: AgentModelMessage[] = [
        { role: "user", content: "Do not lose the result." },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "latest", name, arguments: {} }],
        },
        {
          role: "tool",
          name,
          tool_call_id: "latest",
          content: JSON.stringify({ ok: true, text: "X".repeat(30_000) }),
        },
      ];
      const before = JSON.stringify(messages);
      assert.throws(
        () =>
          enforceAgentPromptBudget({
            messages,
            inputTokenCap: 4_000,
            ...(name === "note_write" ? { conversationKey: 31004 } : {}),
          }),
        AgentPromptBudgetError,
      );
      assert.equal(JSON.stringify(messages), before);
    }
  });

  it("throws a graceful local over-budget error when protected context cannot fit", function () {
    const messages: AgentModelMessage[] = [
      { role: "system", content: "Use tools." },
      { role: "user", content: "X".repeat(30_000) },
    ];
    assert.throws(
      () =>
        enforceAgentPromptBudget({
          messages,
          model: "claude-haiku-4-5",
          inputTokenCap: 2_000,
        }),
      AgentPromptBudgetError,
      "raise the Input cap",
    );
  });
});

describe("CJK convergence", function () {
  it("converges instead of throwing for CJK-heavy oversized tool results", function () {
    const messages: AgentModelMessage[] = [
      { role: "system", content: "System prompt" },
      { role: "user", content: "总结这些论文" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call-1", name: "library_retrieve", arguments: {} }],
      },
      {
        role: "tool",
        name: "library_retrieve",
        tool_call_id: "call-1",
        content: JSON.stringify({ text: "神经网络研究综述。".repeat(20000) }),
      },
      { role: "user", content: "继续" },
    ];

    const result = enforceAgentPromptBudget({
      messages,
      model: "gpt-4o-mini",
      inputTokenCap: 24_000,
    });

    assert.isAtMost(result.estimatedAfterTokens, result.softLimitTokens);
  });
});

describe("agent prompt budget and transmitted output cap", function () {
  it("keeps input plus the Anthropic cap inside the context window on a long transcript", async function () {
    const { resolveAgentPromptBudgetLimits } =
      await import("../src/agent/context/promptBudget");
    const { resolveOutputRequestPolicy, resolveTransmittedOutputPolicy } =
      await import("../src/utils/outputTokenPolicy");
    const identity = {
      model: "claude-opus-4-6",
      apiBase: "https://api.anthropic.com",
      protocol: "anthropic_messages" as const,
      authMode: "api_key" as const,
    };
    const limits = resolveAgentPromptBudgetLimits({
      model: identity.model,
      apiBase: identity.apiBase,
      providerProtocol: identity.protocol,
      authMode: identity.authMode,
      outputTokenLimit: { mode: "auto" },
    });
    const policy = resolveOutputRequestPolicy({
      setting: { mode: "auto" },
      ...identity,
    });
    assert.equal(policy.mode, "numeric");
    // Any prompt the budget lets through must still fit next to the cap we send.
    for (const estimatedInputTokens of [
      1_000,
      72_000,
      136_000,
      limits.softLimitTokens,
    ]) {
      const transmitted = resolveTransmittedOutputPolicy({
        policy,
        contextWindow: limits.contextWindow,
        estimatedInputTokens,
      });
      assert.equal(transmitted.mode, "numeric");
      if (transmitted.mode !== "numeric") continue;
      assert.isAtLeast(transmitted.tokens, 8_192);
      assert.isAtMost(
        estimatedInputTokens + transmitted.tokens,
        limits.contextWindow,
        `input ${estimatedInputTokens} + cap ${transmitted.tokens} exceeds the window`,
      );
    }
  });
});
