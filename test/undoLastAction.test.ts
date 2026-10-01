import { assert } from "chai";
import { createUndoTool } from "../src/agent/tools/write/undo";
import {
  initAgentChangeJournal,
  listJournalActions,
  prepareJournalAction,
  prepareJournalStep,
  selectUndoJournalAction,
  updateJournalAction,
  updateJournalStep,
} from "../src/agent/store/changeJournal";
import type { AgentToolContext } from "../src/agent/types";
import { createTestActionContractService } from "./helpers/actionContractService";
import { ChangeJournalTestDb } from "./helpers/changeJournalTestDb";

/**
 * The single-undo form of `undo` (no count/actionIds/dryRun). The first block pins the
 * proposal it freezes. The second is the evidence half: it runs the real
 * journal, the real inverse replay and the real receipt minting, so what it
 * asserts about `verification` is what a user's undo produces.
 */
describe("undo single-action effect path", function () {
  const tool = createUndoTool({} as never);
  const service = createTestActionContractService();

  const validated = (args: Record<string, unknown>) => {
    const input = tool.validate(args);
    if (!input.ok) throw new Error(input.error);
    return input.value;
  };

  it("freezes the journal action it targets", async function () {
    const proposals = await tool.describeAction!(
      validated({ actionId: "action-42" }),
    );
    assert.lengthOf(proposals, 1);
    assert.equal(proposals[0].operation, "undo");
    assert.equal(proposals[0].capability, "zotero.undo");
    assert.equal(proposals[0].proofDomain, "zotero_state");
    assert.equal(proposals[0].source, "zotero_native");
    assert.deepEqual(proposals[0].requestedTargets, [
      "journal-action:action-42",
    ]);
  });

  it("names no target when the newest reversible action is chosen at run time", async function () {
    const proposals = await tool.describeAction!(validated({}));
    assert.lengthOf(proposals, 1);
    assert.equal(proposals[0].id, "undo:latest");
    assert.deepEqual(proposals[0].requestedTargets, []);
  });

  it("refuses to verify an undo that reports only its own status", async function () {
    const prepared = await service.prepare(
      tool,
      validated({ actionId: "action-42" }),
    );
    const receipts = await service.finalize(prepared, {
      ok: true,
      effect: "applied",
      content: { status: "undone", actionId: "action-42", reverted: 1 },
    });
    assert.lengthOf(receipts, 1);
    assert.equal(receipts[0].verification, "unverified");
    assert.equal(receipts[0].status, "unverified");
    assert.equal(receipts[0].evidenceRef, "action-42");
    assert.deepEqual(receipts[0].appliedTargets, []);
    assert.match(
      receipts[0].reasons.join(" "),
      /No reverted step re-read its target/,
    );
  });

  it("reports a partial undo as unverified and rejects its target", async function () {
    const prepared = await service.prepare(
      tool,
      validated({ actionId: "action-42" }),
    );
    const receipts = await service.finalize(prepared, {
      ok: true,
      effect: "partial",
      content: {
        status: "partially_undone",
        actionId: "action-42",
        reverted: 0,
        partiallyReverted: 1,
      },
    });
    assert.equal(receipts[0].verification, "unverified");
    assert.equal(receipts[0].status, "unverified");
    assert.deepEqual(receipts[0].rejectedTargets, ["journal-action:action-42"]);
  });

  it("treats nothing-to-undo as already satisfied, not as a failed write", async function () {
    const prepared = await service.prepare(tool, validated({}));
    const receipts = await service.finalize(prepared, {
      ok: true,
      effect: "none",
      content: { status: "nothing_reversible", reverted: 0 },
    });
    assert.equal(receipts[0].verification, "verified");
    assert.equal(receipts[0].status, "already_satisfied");
  });
});

/**
 * The native half of the undo receipt.
 *
 * The gateway below is the seam: it can be told to ignore one preference
 * restore, which is how a step's post-revert re-read is made to disagree with
 * the replay without faking the tool's own result.
 */
describe("undo single-action native re-read", function () {
  const originalZotero = globalThis.Zotero;
  const service = createTestActionContractService();
  let settings: Record<string, string>;
  let refuseRestoreFor: string | null;

  const context = {
    request: { conversationKey: 77, libraryID: 1 },
    item: null,
    currentAnswerText: "",
    modelName: "test-model",
  } as AgentToolContext;

  const gateway = {
    listSettings: () =>
      Object.entries(settings).map(([key, value]) => ({
        key,
        value,
        type: "string",
        description: key,
      })),
    restoreSetting: (input: {
      key: string;
      existed: boolean;
      value?: unknown;
    }) => {
      if (input.key === refuseRestoreFor) return;
      settings[input.key] = String(input.value);
    },
  } as never;

  const tool = createUndoTool(gateway);

  async function seedTwoStepAction(actionId: string): Promise<void> {
    await prepareJournalAction({
      actionId,
      runId: "run-77",
      conversationKey: 77,
      toolName: "library_settings",
      description: "Changed two preferences",
      effect: "write",
      reversibility: "full",
      now: 100,
    });
    for (const [sequence, key] of [
      [1, "pref.a"],
      [2, "pref.b"],
    ] as const) {
      await prepareJournalStep({
        stepId: `${actionId}:${sequence}`,
        actionId,
        sequence,
        operation: "update_preference",
        forward: { key },
        inverse: {
          version: 1,
          kind: "preference",
          key,
          existed: true,
          value: `before:${key}`,
        },
        reversibility: "full",
        now: 100,
      });
      await updateJournalStep({
        stepId: `${actionId}:${sequence}`,
        status: "applied",
        reversibility: "full",
        expectedPostcondition: {
          kind: "preference",
          key,
          existed: true,
          value: `after:${key}`,
        },
        now: 100,
      });
    }
    await updateJournalAction({
      actionId,
      status: "applied",
      reversibility: "full",
      affectedCount: 2,
      now: 100,
    });
  }

  async function undoReceipt(actionId: string) {
    const input = tool.validate({ actionId });
    if (!input.ok) throw new Error(input.error);
    const prepared = await service.prepare(tool, input.value, context);
    const result = await tool.execute(input.value, context);
    const receipts = await service.finalize(prepared, {
      ok: true,
      effect: result.effect,
      content: result.content,
    });
    return { content: result.content as Record<string, unknown>, receipts };
  }

  beforeEach(async function () {
    settings = { "pref.a": "after:pref.a", "pref.b": "after:pref.b" };
    refuseRestoreFor = null;
    globalThis.Zotero = {
      DB: new ChangeJournalTestDb(),
      Items: { get: () => null },
      debug: () => undefined,
    } as never;
    await initAgentChangeJournal();
  });

  afterEach(function () {
    globalThis.Zotero = originalZotero;
  });

  it("verifies a clean undo from the per-step native re-read", async function () {
    await seedTwoStepAction("undo-clean");

    const { content, receipts } = await undoReceipt("undo-clean");

    assert.deepEqual(settings, {
      "pref.a": "before:pref.a",
      "pref.b": "before:pref.b",
    });
    assert.deepEqual(content.revertedSteps, [
      { actionId: "undo-clean", sequence: 2, verification: "matched" },
      { actionId: "undo-clean", sequence: 1, verification: "matched" },
    ]);
    assert.equal(receipts[0].verification, "verified");
    assert.equal(receipts[0].status, "applied");
    assert.deepEqual(receipts[0].verifiedFacts, [
      "reverted_step:undo-clean:2:matched",
      "reverted_step:undo-clean:1:matched",
    ]);
  });

  it("refuses to verify an undo whose step did not re-read as restored", async function () {
    await seedTwoStepAction("undo-drifted");
    refuseRestoreFor = "pref.b";

    const { content, receipts } = await undoReceipt("undo-drifted");

    assert.equal(
      settings["pref.b"],
      "after:pref.b",
      "the inverse for pref.b did not land",
    );
    assert.deepEqual(
      (content.revertedSteps as Array<Record<string, unknown>>).map(
        (step) => step.verification,
      ),
      ["mismatched", "matched"],
    );
    assert.equal(receipts[0].verification, "unverified");
    assert.equal(receipts[0].status, "unverified");
    // The matched step is still named: the receipt says how much of the undo
    // was proven, not only that it was not all of it.
    assert.deepEqual(receipts[0].verifiedFacts, [
      "reverted_step:undo-drifted:1:matched",
    ]);
    assert.deepEqual(receipts[0].rejectedTargets, [
      "journal-action:undo-drifted",
    ]);
    assert.match(
      receipts[0].reasons.join(" "),
      /Reverted step 2 of undo-drifted re-read as mismatched/,
    );
  });

  it("leaves a mismatched undo in the history so it can be undone again", async function () {
    await seedTwoStepAction("undo-retryable");
    refuseRestoreFor = "pref.b";

    const first = await undoReceipt("undo-retryable");

    // The journal must agree with the receipt. Marking the action `reverted`
    // here would have taken it out of every pending query, leaving the user
    // told the change did not go back and no way to try again.
    assert.equal(first.receipts[0].verification, "unverified");
    assert.deepEqual(first.receipts[0].verifiedFacts, [
      "reverted_step:undo-retryable:1:matched",
    ]);
    const afterFirst = await listJournalActions({
      actionId: "undo-retryable",
      conversationKey: 77,
      limit: 1,
      pendingOnly: true,
    });
    assert.lengthOf(afterFirst, 1, "the action must stay selectable");
    assert.equal(afterFirst[0].status, "revert_failed");
    assert.equal(
      (await selectUndoJournalAction({ conversationKey: 77 })).action?.actionId,
      "undo-retryable",
      "a second undo must be able to select it",
    );

    // Second attempt, with the gateway no longer refusing the restore.
    refuseRestoreFor = null;
    const second = await undoReceipt("undo-retryable");

    assert.equal(settings["pref.b"], "before:pref.b");
    assert.equal(second.receipts[0].verification, "verified");
    assert.equal(second.receipts[0].status, "applied");
    assert.deepEqual(second.receipts[0].verifiedFacts, [
      "reverted_step:undo-retryable:2:matched",
    ]);
    const afterSecond = await listJournalActions({
      actionId: "undo-retryable",
      conversationKey: 77,
      limit: 1,
    });
    assert.equal(afterSecond[0].status, "reverted");
  });
});
