import { assert } from "chai";
import { createUndoTool } from "../src/agent/tools/write/undo";
import { createTestActionContractService } from "./helpers/actionContractService";

/**
 * The multi-revert form of `undo` (count/actionIds/dryRun). These pin the frozen proposal and
 * the receipt rule: `verification` comes from the per-step native re-read
 * `revertActions` reports, never from the tool's own counters. The end-to-end
 * evidence for that re-read lives in `undoLastAction.test.ts`, which drives the
 * same replay through a real journal.
 */
describe("undo multi-revert effect path", function () {
  const tool = createUndoTool({} as never);
  const service = createTestActionContractService();

  const validated = (args: Record<string, unknown>) => {
    const input = tool.validate(args);
    if (!input.ok) throw new Error(input.error);
    return input.value;
  };

  it("freezes the revert budget and any explicitly named actions", async function () {
    const proposals = await tool.describeAction!(
      validated({ actionIds: ["action-1", "action-2"] }),
    );
    assert.lengthOf(proposals, 1);
    assert.equal(proposals[0].operation, "revert");
    assert.equal(proposals[0].capability, "zotero.undo");
    assert.equal(proposals[0].proofDomain, "zotero_state");
    assert.equal(proposals[0].parameters?.revertCount, 1);
    assert.deepEqual(proposals[0].requestedTargets, [
      "journal-action:action-1",
      "journal-action:action-2",
    ]);
  });

  it("proposes nothing for a dry run", async function () {
    const proposals = await tool.describeAction!(
      validated({ count: 3, dryRun: true }),
    );
    assert.deepEqual(proposals, []);
  });

  it("verifies a revert whose every replayed step re-read as restored", async function () {
    const prepared = await service.prepare(
      tool,
      validated({ actionIds: ["action-1"] }),
    );
    const receipts = await service.finalize(prepared, {
      ok: true,
      effect: "applied",
      content: {
        reverted: 1,
        partiallyReverted: 0,
        actionIds: ["action-1"],
        revertedSteps: [
          { actionId: "action-1", sequence: 2, verification: "matched" },
          { actionId: "action-1", sequence: 1, verification: "matched" },
        ],
      },
    });
    assert.lengthOf(receipts, 1);
    assert.equal(receipts[0].verification, "verified");
    assert.equal(receipts[0].status, "applied");
    assert.deepEqual(receipts[0].appliedTargets, ["journal-action:action-1"]);
    assert.deepEqual(receipts[0].verifiedFacts, [
      "reverted_step:action-1:2:matched",
      "reverted_step:action-1:1:matched",
    ]);
  });

  it("refuses to verify a revert whose counters are clean but whose step could not be read back", async function () {
    const prepared = await service.prepare(
      tool,
      validated({ actionIds: ["action-1"] }),
    );
    const receipts = await service.finalize(prepared, {
      ok: true,
      effect: "applied",
      content: {
        reverted: 1,
        partiallyReverted: 0,
        actionIds: ["action-1"],
        revertedSteps: [
          {
            actionId: "action-1",
            sequence: 1,
            verification: "not_re_readable",
            reason: "the target could not be read back: gateway unavailable",
          },
        ],
      },
    });
    assert.equal(receipts[0].verification, "unverified");
    assert.equal(receipts[0].status, "unverified");
    assert.deepEqual(receipts[0].verifiedFacts, []);
    assert.match(
      receipts[0].reasons.join(" "),
      /re-read as not_re_readable: the target could not be read back/,
    );
  });

  it("refuses to verify a revert that left one of its actions behind", async function () {
    const prepared = await service.prepare(
      tool,
      validated({ actionIds: ["action-1", "action-2"] }),
    );
    const receipts = await service.finalize(prepared, {
      ok: true,
      effect: "partial",
      content: {
        reverted: 1,
        partiallyReverted: 0,
        actionIds: ["action-1", "action-2"],
        revertedSteps: [
          { actionId: "action-1", sequence: 1, verification: "matched" },
        ],
        skipped: [
          {
            entryId: "action-2",
            reason: "The object changed after the action",
          },
        ],
        conflicts: [],
      },
    });
    assert.equal(receipts[0].verification, "unverified");
    assert.equal(receipts[0].status, "unverified");
    assert.deepEqual(receipts[0].verifiedFacts, [
      "reverted_step:action-1:1:matched",
    ]);
  });

  it("refuses to call a revert that reverted nothing already satisfied", async function () {
    const prepared = await service.prepare(
      tool,
      validated({ actionIds: ["action-1"] }),
    );
    const receipts = await service.finalize(prepared, {
      ok: true,
      // Every step conflicted, so nothing was replayed and nothing changed.
      // "No effect" here means the library was left as it was, not that the
      // revert was unnecessary.
      effect: "none",
      content: {
        reverted: 0,
        partiallyReverted: 0,
        actionIds: ["action-1"],
        revertedSteps: [],
        conflicts: [
          {
            actionId: "action-1",
            reason: "The object changed after the action",
          },
        ],
      },
    });
    assert.equal(receipts[0].verification, "unverified");
    assert.equal(receipts[0].status, "unverified");
  });

  it("still treats an empty history as already satisfied", async function () {
    const prepared = await service.prepare(tool, validated({ count: 1 }));
    const receipts = await service.finalize(prepared, {
      ok: true,
      effect: "none",
      content: {
        reverted: 0,
        partiallyReverted: 0,
        skipped: [],
        message: "There are no recorded changes left to undo.",
      },
    });
    assert.equal(receipts[0].verification, "verified");
    assert.equal(receipts[0].status, "already_satisfied");
  });

  it("refuses to verify a revert that left a step partially applied", async function () {
    const prepared = await service.prepare(
      tool,
      validated({ actionIds: ["action-1"] }),
    );
    const receipts = await service.finalize(prepared, {
      ok: true,
      effect: "partial",
      content: {
        reverted: 1,
        partiallyReverted: 1,
        actionIds: ["action-1"],
        revertedSteps: [
          { actionId: "action-1", sequence: 1, verification: "matched" },
        ],
      },
    });
    assert.equal(receipts[0].verification, "unverified");
    assert.equal(receipts[0].status, "unverified");
    assert.deepEqual(receipts[0].rejectedTargets, ["journal-action:action-1"]);
  });

  it("reports a cancelled revert as not_applicable", async function () {
    const prepared = await service.prepare(tool, validated({ count: 1 }));
    const receipts = await service.finalize(prepared, {
      ok: false,
      cancelled: true,
      reason: "The user declined the revert.",
    });
    assert.equal(receipts[0].verification, "not_applicable");
    assert.equal(receipts[0].status, "cancelled");
  });
});
