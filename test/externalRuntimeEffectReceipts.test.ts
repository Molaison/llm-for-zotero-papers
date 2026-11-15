import { assert } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import {
  buildExternalRuntimeEffectReceipt,
  externalRuntimeCommandEffect,
  externalRuntimeFileEffect,
  recordExternalRuntimeEffect,
} from "../src/agent/contracts/externalRuntimeEffects";
import { OPERATION_CATALOG } from "../src/agent/contracts/operationCatalog";
import {
  initAgentChangeJournal,
  JOURNAL_OBSERVATIONS_TABLE,
} from "../src/agent/store/changeJournal";
import { ChangeJournalTestDb } from "./helpers/changeJournalTestDb";

/**
 * Receipts for effects a connected client performed itself.
 *
 * Codex and Claude Code run their own file changes and shell commands; the
 * host only authorizes them. These receipts are what makes such a turn's audit
 * trail as long as an in-app one: the operation comes from the shared catalog,
 * the proof is `execution_only` because no post-state can be re-read on this
 * side, and `executionAuthority` says whose runtime ran it.
 */
describe("external runtime effect receipts", function () {
  it("mints an execution_only command receipt under the connected client's authority", function () {
    const receipt = buildExternalRuntimeEffectReceipt({
      effect: externalRuntimeCommandEffect("codex_native", "npm test"),
      outcome: "executed",
      callId: "approval-1",
    });
    assert.equal(receipt.version, 2);
    assert.equal(receipt.operation, "command_execute");
    assert.equal(
      receipt.capability,
      OPERATION_CATALOG.command_execute.capability,
    );
    assert.equal(
      receipt.proofDomain,
      OPERATION_CATALOG.command_execute.proofDomain,
    );
    assert.equal(receipt.verification, "execution_only");
    assert.equal(receipt.status, "observed");
    assert.equal(receipt.executionAuthority, "external_runtime");
    assert.equal(
      receipt.origin,
      "connected_runtime",
      "provenance is stamped here and nowhere else, so readers need not infer it",
    );
    assert.deepEqual(receipt.appliedTargets, []);
    assert.deepEqual(receipt.rejectedTargets, []);
    assert.deepEqual(receipt.verifiedFacts, []);
    assert.match(receipt.requestedTargets[0], /^command:fnv1a32:[0-9a-f]{8}$/);
    assert.notInclude(
      JSON.stringify(receipt),
      "npm test",
      "the raw command is fingerprinted, never republished as a durable target",
    );
  });

  it("mints an execution_only file receipt naming the paths the card showed", function () {
    const receipt = buildExternalRuntimeEffectReceipt({
      effect: externalRuntimeFileEffect("claude_code", [
        "/vault/Notes/drift.md",
      ]),
      outcome: "executed",
      callId: "action-1",
    });
    assert.equal(receipt.operation, "file_write");
    assert.equal(receipt.capability, OPERATION_CATALOG.file_write.capability);
    assert.equal(receipt.proofDomain, OPERATION_CATALOG.file_write.proofDomain);
    assert.equal(receipt.verification, "execution_only");
    assert.equal(receipt.status, "observed");
    assert.deepEqual(receipt.requestedTargets, ["file:/vault/Notes/drift.md"]);
    assert.deepEqual(receipt.appliedTargets, []);
  });

  it("reports a declined effect as cancelled and claims no proof for it", function () {
    const receipt = buildExternalRuntimeEffectReceipt({
      effect: externalRuntimeFileEffect("codex_native", ["/repo/notes.md"]),
      outcome: "declined",
      callId: "approval-2",
      reason: "The user denied the file change.",
    });
    assert.equal(receipt.verification, "not_applicable");
    assert.equal(receipt.status, "cancelled");
    assert.deepEqual(receipt.appliedTargets, []);
    assert.deepEqual(receipt.rejectedTargets, ["file:/repo/notes.md"]);
    assert.deepEqual(receipt.reasons, ["The user denied the file change."]);
  });

  it("reports a failed effect as unverified, never as executed", function () {
    const receipt = buildExternalRuntimeEffectReceipt({
      effect: externalRuntimeCommandEffect("claude_code", "false"),
      outcome: "failed",
      callId: "action-2",
      reason: "Command failed",
    });
    assert.equal(receipt.verification, "unverified");
    assert.equal(receipt.status, "failed");
    assert.deepEqual(receipt.appliedTargets, []);
  });

  describe("durable observation", function () {
    const originalZotero = globalThis.Zotero;
    let db: ChangeJournalTestDb;

    beforeEach(async function () {
      db = new ChangeJournalTestDb();
      globalThis.Zotero = {
        DB: db,
        Prefs: { get: () => "" },
        debug: () => undefined,
      } as never;
      await initAgentChangeJournal();
    });

    afterEach(function () {
      globalThis.Zotero = originalZotero;
    });

    it("journals the receipt so a connected client's effect survives the turn", async function () {
      const receipt = await recordExternalRuntimeEffect({
        effect: externalRuntimeCommandEffect("codex_native", "npm test"),
        outcome: "executed",
        callId: "approval-3",
        runId: "codex-turn-9",
      });
      const rows = [...db.observations.values()];
      assert.lengthOf(rows, 1);
      assert.equal(rows[0].event, "external_runtime_effect_observed");
      assert.equal(rows[0].object_type, "external_runtime_effect");
      assert.isNull(
        rows[0].action_id,
        "a client-side effect belongs to no inverse-replayable journal action",
      );
      assert.deepEqual(JSON.parse(String(rows[0].object_ids_json)), [
        "codex-turn-9",
        "approval-3",
      ]);
      const extra = JSON.parse(String(rows[0].extra_json));
      assert.equal(extra.source, "codex_native");
      assert.deepEqual(extra.receipt, receipt);
    });

    it("keeps a client's effect from failing when the audit store cannot record it", async function () {
      db.failWhen = (sql) =>
        sql.includes(JOURNAL_OBSERVATIONS_TABLE)
          ? new Error("disk full")
          : null;
      const receipt = await recordExternalRuntimeEffect({
        effect: externalRuntimeFileEffect("claude_code", ["/vault/a.md"]),
        outcome: "executed",
        callId: "action-3",
      });
      assert.equal(receipt.operation, "file_write");
    });
  });
});
