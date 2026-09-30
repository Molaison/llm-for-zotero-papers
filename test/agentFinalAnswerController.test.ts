import { semanticFixture } from "./helpers/semanticIntent";
import { assert } from "chai";
import { AgentFinalAnswerController } from "../src/agent/finalization/finalAnswerController";
import type { AgentFinalActionSession } from "../src/agent/finalization/finalAnswerController";
import {
  applyOutcomeEvidence,
  declareOutcomes,
} from "../src/agent/loop/outcomes";
import { createEmptyExecutionCheckpoint } from "../src/agent/execution/checkpoint";
import type {
  AgentRuntimeRequest,
  ExecutionCheckpoint,
} from "../src/agent/types";

function makeRequest(
  overrides: Partial<AgentRuntimeRequest> = {},
): AgentRuntimeRequest {
  return {
    conversationKey: 1,
    mode: "agent",
    userText: "Answer the question",
    model: "test-model",
    turnPaperScope: {
      active: [],
      added: [],
      pinned: [],
      selected: [],
      collections: [],
      tags: [],
    },
    ...overrides,
  } as AgentRuntimeRequest;
}

function acceptingActionSession(): AgentFinalActionSession {
  return {
    evaluateFinal: async () => ({ kind: "accept" as const }),
  };
}

describe("AgentFinalAnswerController", function () {
  for (const canCorrect of [true, false]) {
    it(`accepts the first grounded paper answer with canCorrect=${canCorrect}`, async function () {
      const controller = new AgentFinalAnswerController(
        makeRequest({
          conversationKind: "paper",
          classifiedIntent: {
            semantic: semanticFixture(),
            retrievalIntent: "none",
            wantedSections: ["results"],
            actionIntents: [],
          },
        }),
        acceptingActionSession(),
        [],
      );
      const decision = await controller.evaluate({
        candidateText:
          "The paper reports 0.80 intact and 0.52 shuffled accuracy. It supplies neither a class count nor a chance baseline.",
        canCorrect,
        toolExecutionRecords: [{ name: "paper_read", ok: true }],
      });
      assert.equal(decision.kind, "accept");
    });
  }

  it("accepts completed paper actions and finalized documents", async function () {
    for (const overrides of [
      { actionContract: { obligations: [{ operation: "note_create" }] } },
      { documentOutcomePolicy: { required: true } },
    ]) {
      const controller = new AgentFinalAnswerController(
        makeRequest({ conversationKind: "paper", ...overrides } as never),
        acceptingActionSession(),
        [],
      );
      const result = await controller.evaluate({
        candidateText: "Saved.",
        canCorrect: true,
        toolExecutionRecords: [
          { name: "paper_read", ok: true },
          { name: "submit_document", ok: true },
        ],
      });
      assert.equal(result.kind, "accept");
    }
  });
  it("allows one required-document correction and then fails closed", async function () {
    const controller = new AgentFinalAnswerController(
      makeRequest({
        documentOutcomePolicy: {
          required: true,
          documentKind: "report",
          integrityPolicy: "authored",
          trigger: "document_intent",
        },
      }),
      acceptingActionSession(),
      [],
    );

    const first = await controller.evaluate({
      candidateText: "A long prose answer that bypassed the artifact.",
      canCorrect: true,
      toolExecutionRecords: [],
    });
    assert.equal(first.kind, "correct");
    if (first.kind === "correct") {
      assert.include(first.correction, "call submit_document now");
    }

    const second = await controller.evaluate({
      candidateText: "Another prose answer.",
      canCorrect: true,
      toolExecutionRecords: [],
    });
    assert.deepEqual(second, {
      kind: "fail",
      userMessage:
        "The requested document was not finalized, so ordinary answer text cannot be accepted as the completed outcome.",
    });
  });

  it("accepts a required document only after submit_document succeeds", async function () {
    const controller = new AgentFinalAnswerController(
      makeRequest({
        documentOutcomePolicy: {
          required: true,
          documentKind: "guide",
          integrityPolicy: "authored",
          trigger: "document_intent",
        },
      }),
      acceptingActionSession(),
      [],
    );
    const decision = await controller.evaluate({
      candidateText: "# Complete guide",
      canCorrect: false,
      toolExecutionRecords: [
        { name: "submit_document", ok: true, content: { documentId: "d1" } },
      ],
    });
    assert.equal(decision.kind, "accept");
  });
  it("returns an uncommitted action-contract correction before other quality gates", async function () {
    const controller = new AgentFinalAnswerController(
      makeRequest({
        actionContract: { obligations: [{ operation: "note_create" }] },
      } as never),
      {
        evaluateFinal: async () => ({
          kind: "correct" as const,
          correction: "Complete the required action.",
        }),
      },
      [],
    );

    const decision = await controller.evaluate({
      candidateText: "Draft",
      canCorrect: true,
      toolExecutionRecords: [],
    });

    assert.deepEqual(decision, {
      kind: "correct",
      correction: "Complete the required action.",
      actionContractRejection: {
        kind: "correct",
        correction: "Complete the required action.",
      },
    });
  });

  it("returns a kind-matched uncommitted action-contract failure", async function () {
    const controller = new AgentFinalAnswerController(
      makeRequest({
        actionContract: { obligations: [{ operation: "note_create" }] },
      } as never),
      {
        evaluateFinal: async () => ({
          kind: "fail" as const,
          failure: "The action could not be verified.",
        }),
      },
      [],
    );

    const decision = await controller.evaluate({
      candidateText: "Draft",
      canCorrect: false,
      toolExecutionRecords: [],
    });

    assert.deepEqual(decision, {
      kind: "fail",
      userMessage: "The action could not be verified.",
      actionContractRejection: {
        kind: "fail",
        failure: "The action could not be verified.",
      },
    });
  });

  it("does not invent action obligations for a fresh direct turn", async function () {
    let legacyEvaluationCalls = 0;
    const controller = new AgentFinalAnswerController(
      makeRequest({
        executionContext: {
          version: 1,
          executionId: "direct-1",
          conversationKey: 1,
          conversationGeneration: 0,
          chatLibraryID: 1,
          permissionOwner: "original_agent",
          workspaceSnapshot: {
            selectedPapers: [],
            selectedCollections: [],
          },
          configuredAccess: { libraryIDs: [1], outputDirectories: [] },
        },
      }),
      {
        evaluateFinal: async () => {
          legacyEvaluationCalls += 1;
          return {
            kind: "fail" as const,
            failure: "A semantic action contract is unavailable.",
          };
        },
      },
      [],
    );

    const decision = await controller.evaluate({
      candidateText: "Here is the answer.",
      canCorrect: true,
      toolExecutionRecords: [],
    });

    assert.equal(decision.kind, "accept");
    assert.equal(legacyEvaluationCalls, 0);
  });

  it("fails a direct applied write whose concrete effect is unverified", async function () {
    const controller = new AgentFinalAnswerController(
      makeRequest(),
      acceptingActionSession(),
      [],
    );

    const decision = await controller.evaluate({
      candidateText: "Saved.",
      canCorrect: false,
      toolExecutionRecords: [
        {
          name: "library_mutation",
          ok: true,
          mutability: "write",
          effect: "applied",
          actionReceipts: [],
        },
      ],
    });

    assert.deepEqual(decision, {
      kind: "fail",
      userMessage:
        "library_mutation ran, but its concrete effect could not be verified. Inspect current state before retrying it.",
    });
  });

  /**
   * The two values the final gate treats differently, pinned side by side.
   *
   * `unverified` means a re-read was possible and did not confirm the effect,
   * so the turn cannot claim it. `execution_only` means there is no state to
   * re-read at all — a shell command — and failing every such turn would make
   * `run_command` unusable while proving nothing. Phase 3 keeps that split
   * deliberately, so changing it has to change this test.
   */
  for (const scenario of [
    {
      verification: "unverified" as const,
      expected: "fail" as const,
      why: "a re-read was possible and did not confirm the effect",
    },
    {
      verification: "execution_only" as const,
      expected: "accept" as const,
      why: "a shell command leaves no state to re-read",
    },
  ]) {
    it(`${scenario.expected}s an applied write whose receipt is ${scenario.verification} because ${scenario.why}`, async function () {
      const controller = new AgentFinalAnswerController(
        makeRequest(),
        acceptingActionSession(),
        [],
      );

      const decision = await controller.evaluate({
        candidateText: "Ran it.",
        canCorrect: false,
        toolExecutionRecords: [
          {
            name: "run_command",
            ok: true,
            mutability: "write",
            effect: "applied",
            actionReceipts: [
              {
                verification: scenario.verification,
                status: "observed",
              },
            ],
          } as never,
        ],
      });

      assert.equal(decision.kind, scenario.expected);
    });
  }

  it("allows one collection evidence correction then accepts the next final", async function () {
    const request = makeRequest({
      userText: "What methods do these papers share?",
      classifiedIntent: {
        semantic: semanticFixture(),
        retrievalIntent: "summarize",
        wantedSections: ["methods"],
        actionIntents: [],
      },
      turnPaperScope: {
        active: [],
        added: [],
        pinned: [],
        selected: [],
        collections: [{ collectionId: 3, name: "C", libraryID: 1 }],
        tags: [],
      },
    });
    const controller = new AgentFinalAnswerController(
      request,
      acceptingActionSession(),
      [],
    );

    const first = await controller.evaluate({
      candidateText: "Shallow answer.",
      canCorrect: true,
      toolExecutionRecords: [],
    });
    assert.equal(first.kind, "correct");
    if (first.kind === "correct") {
      assert.notProperty(first, "actionContractRejection");
    }

    const second = await controller.evaluate({
      candidateText: "Disclosed partial answer.",
      canCorrect: true,
      toolExecutionRecords: [],
    });
    assert.equal(second.kind, "accept");
  });

  it("returns a clean assistant copy for a web-attribution correction", async function () {
    const controller = new AgentFinalAnswerController(
      makeRequest(),
      acceptingActionSession(),
      [],
    );

    const decision = await controller.evaluate({
      candidateText: "An unsupported current claim.",
      canCorrect: true,
      toolExecutionRecords: [
        { name: "web_search", ok: true, content: { results: [] } },
      ],
    });

    assert.equal(decision.kind, "correct");
    if (decision.kind !== "correct") return;
    assert.notProperty(decision, "actionContractRejection");
    assert.equal(decision.assistantContent, "An unsupported current claim.");
    assert.include(decision.correction, "Correct the web attribution");
  });
});

describe("AgentFinalAnswerController declared outcomes", function () {
  const execution: NonNullable<AgentRuntimeRequest["executionContext"]> = {
    version: 1,
    executionId: "execution-gate",
    conversationKey: 1,
    conversationGeneration: 0,
    permissionOwner: "original_agent",
    workspaceSnapshot: { selectedPapers: [], selectedCollections: [] },
    configuredAccess: { libraryIDs: [1], outputDirectories: [] },
  };
  const SAVE = "Save it as a note on (Smith, 2021)";

  function declared(): ExecutionCheckpoint {
    return declareOutcomes(
      createEmptyExecutionCheckpoint(execution, 1),
      [
        {
          taskId: "save",
          description: SAVE,
          effect: "mutation",
          capability: "zotero.notes",
        },
        { taskId: "tag", description: "Tag it", effect: "mutation" },
        { taskId: "explain", description: "Explain it", effect: "answer" },
      ],
      2,
    );
  }

  async function decide(
    controller: AgentFinalAnswerController,
    canCorrect = true,
  ) {
    return controller.evaluate({
      candidateText: "Saved.",
      canCorrect,
      toolExecutionRecords: [],
    });
  }

  it("asks to finish the declared parts still open, quoting each", async function () {
    const controller = new AgentFinalAnswerController(
      makeRequest({
        executionContext: execution,
        executionCheckpoint: declared(),
      }),
      acceptingActionSession(),
      [],
    );
    const decision = await decide(controller);
    assert.equal(decision.kind, "correct");
    if (decision.kind !== "correct") return;
    assert.equal(
      decision.correction,
      `Before answering, finish the parts of this request you declared that are still open: “${SAVE}”; “Tag it”. Do them now with the tools. If one cannot be done, call task_update with status skipped or blocked and the reason, then answer.`,
    );
  });

  it("corrects again only after new evidence since the last correction", async function () {
    const request = makeRequest({
      executionContext: execution,
      executionCheckpoint: declared(),
    });
    const controller = new AgentFinalAnswerController(
      request,
      acceptingActionSession(),
      [],
    );
    assert.equal((await decide(controller)).kind, "correct");
    assert.equal(
      (await decide(controller)).kind,
      "accept",
      "nothing moved, so the answer is accepted",
    );
    request.executionCheckpoint = applyOutcomeEvidence(
      request.executionCheckpoint!,
      {
        kind: "receipt",
        receipt: {
          version: 2,
          id: "receipt-tags",
          proposalId: "proposal-tags",
          proofDomain: "zotero_state",
          capability: "zotero.tags",
          operation: "apply_tags",
          verification: "verified",
          status: "applied",
          requestedTargets: ["item:1"],
          appliedTargets: ["item:1"],
          alreadySatisfiedTargets: [],
          rejectedTargets: [],
          reasons: [],
          verifiedFacts: [],
        },
      },
      3,
    ).checkpoint;
    const again = await decide(controller);
    assert.equal(again.kind, "correct", "the tags receipt is new evidence");
    if (again.kind !== "correct") return;
    assert.include(again.correction, `“${SAVE}”`);
    assert.notInclude(again.correction, "“Tag it”");
  });

  it("never corrects for an answer part, or when it cannot correct", async function () {
    const answerOnly = declareOutcomes(
      createEmptyExecutionCheckpoint(execution, 1),
      [{ taskId: "explain", description: "Explain it", effect: "answer" }],
      2,
    );
    for (const [request, canCorrect] of [
      [
        makeRequest({
          executionContext: execution,
          executionCheckpoint: answerOnly,
        }),
        true,
      ],
      [
        makeRequest({
          executionContext: execution,
          executionCheckpoint: declared(),
        }),
        false,
      ],
    ] as const) {
      const controller = new AgentFinalAnswerController(
        request,
        acceptingActionSession(),
        [],
      );
      assert.equal((await decide(controller, canCorrect)).kind, "accept");
    }
  });
});
