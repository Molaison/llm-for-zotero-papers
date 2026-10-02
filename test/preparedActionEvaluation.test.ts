import { assert } from "chai";
import {
  evaluatePreparedActionContract,
  formatReceiptStatus,
} from "../src/agent/contracts/actionEvaluation";

describe("prepared action completion", function () {
  it("accepts a fresh direct answer without predicted obligations", function () {
    const decision = evaluatePreparedActionContract([]);
    assert.equal(decision.state, "satisfied");
    assert.isUndefined(decision.correction);
  });
  function tagReceipt(
    status: import("../src/agent/contracts/types").AgentActionReceipt["status"],
  ): import("../src/agent/contracts/types").AgentActionReceipt {
    return {
      version: 2,
      id: "contract:unmatched:apply_tags",
      proposalId: "proposal:apply_tags",
      proofDomain: "zotero_state",
      capability: "zotero.tags",
      operation: "apply_tags",
      verification: "verified",
      status,
      requestedTargets: ["item:41"],
      appliedTargets: status === "applied" ? ["item:41"] : [],
      alreadySatisfiedTargets: [],
      rejectedTargets: [],
      reasons: [],
      verifiedFacts: [],
    };
  }

  it("reports delegated native receipts without rechecking Original Agent intent", function () {
    const receipt = {
      ...tagReceipt("applied"),
      executionAuthority: "external_runtime" as const,
    };
    assert.equal(evaluatePreparedActionContract([receipt]).state, "satisfied");
  });

  for (const status of ["partial", "failed", "unverified"] as const) {
    it(`reports delegated ${status} effects without automatically retrying`, function () {
      const receipt = {
        ...tagReceipt(status),
        executionAuthority: "external_runtime" as const,
      };
      const decision = evaluatePreparedActionContract([receipt]);
      assert.equal(decision.state, status);
      assert.include(decision.failure!, status);
      assert.isUndefined(decision.correction);
    });
  }

  it("excludes a client's own effect by provenance, not by which capability it used", function () {
    // A receipt is excluded because the connected client's runtime performed
    // the effect, which only the connected-runtime receipt owner can say. Any
    // other reading — "file.write means a bridge minted it" — is invalid now
    // that file_io and run_command are shared by internal and MCP callers.
    const base: import("../src/agent/contracts/types").AgentActionReceipt = {
      version: 2,
      executionAuthority: "external_runtime",
      id: "file-write-receipt",
      proposalId: "file-write-proposal",
      proofDomain: "file_state",
      capability: "file.write",
      operation: "file_write",
      verification: "verified",
      status: "applied",
      requestedTargets: ["file:/vault/a.md"],
      appliedTargets: ["file:/vault/a.md"],
      alreadySatisfiedTargets: [],
      rejectedTargets: [],
      reasons: [],
      verifiedFacts: [],
    };
    // A host tool the client drove over MCP: the host ran it, verified it, and
    // it is delegated action evidence like any other.
    assert.equal(
      evaluatePreparedActionContract([
        { ...base, verification: "unverified", status: "unverified" },
      ]).state,
      "unverified",
    );
    // The same capability, minted by the connected-runtime owner: excluded.
    assert.equal(
      evaluatePreparedActionContract([
        {
          ...base,
          origin: "connected_runtime",
          verification: "unverified",
          status: "unverified",
        },
      ]).state,
      "satisfied",
    );
  });

  it("does not let an effect the client ran in its own runtime answer for a Zotero action", function () {
    // Phase 3 task 5 receipts Codex's and Claude Code's own file changes and
    // shell commands. They are audit evidence: they must neither satisfy a
    // Zotero obligation nor report an otherwise complete turn as unverified.
    const runtimeEffect: import("../src/agent/contracts/types").AgentActionReceipt =
      {
        version: 2,
        executionAuthority: "external_runtime",
        id: "external_runtime:claude_code:command_execute:call-1:executed",
        proposalId: "external_runtime:claude_code:command_execute:call-1",
        origin: "connected_runtime",
        proofDomain: "execution",
        capability: "command.execute",
        operation: "command_execute",
        verification: "execution_only",
        status: "observed",
        requestedTargets: ["command:fnv1a32:0000dead"],
        appliedTargets: [],
        alreadySatisfiedTargets: [],
        rejectedTargets: [],
        reasons: [],
        verifiedFacts: [],
      };
    const zoteroWrite = {
      ...tagReceipt("applied"),
      executionAuthority: "external_runtime" as const,
    };
    assert.equal(
      evaluatePreparedActionContract([zoteroWrite, runtimeEffect]).state,
      "satisfied",
      "an execution_only shell effect must not spoil a verified delegated write",
    );
  });

  it("accepts a delegated effect that proved everything its proof domain can prove", function () {
    // Task 3's ruling: `execution_only` means the effect ran and there is no
    // state to re-read, and the host's own final gate lets such a receipt
    // pass. The delegated branch read anything short of `verified` as a
    // failure, so the identical receipt — a script an MCP client drove
    // through the host's own zotero_script — reported an otherwise complete
    // turn as unverified and invited a replay of a command that already ran.
    const scriptRun: import("../src/agent/contracts/types").AgentActionReceipt =
      {
        version: 2,
        executionAuthority: "external_runtime",
        id: "zotero_script:executed",
        proposalId: "zotero_script:proposal",
        proofDomain: "execution",
        capability: "zotero.script",
        operation: "zotero_script_execute",
        verification: "execution_only",
        status: "observed",
        requestedTargets: [],
        appliedTargets: [],
        alreadySatisfiedTargets: [],
        rejectedTargets: [],
        reasons: [],
        verifiedFacts: [],
      };
    const decision = evaluatePreparedActionContract([scriptRun]);
    assert.equal(decision.state, "satisfied");
    assert.isUndefined(decision.failure);
    // A verified delegated write alongside it still reads as satisfied.
    assert.equal(
      evaluatePreparedActionContract([
        scriptRun,
        { ...tagReceipt("applied"), executionAuthority: "external_runtime" },
      ]).state,
      "satisfied",
    );
    // `unverified` keeps failing: there a re-read was possible and either did
    // not match or never happened.
    assert.equal(
      evaluatePreparedActionContract([
        { ...scriptRun, verification: "unverified", status: "unverified" },
      ]).state,
      "unverified",
    );
  });
});

describe("receipt status vocabulary", function () {
  type Receipt = import("../src/agent/contracts/types").AgentActionReceipt;

  function receipt(
    verification: Receipt["verification"],
    extra: Partial<Receipt> = {},
  ): Receipt {
    return {
      version: 2,
      id: "contract:unmatched:apply_tags",
      proposalId: "proposal:apply_tags",
      proofDomain: "zotero_state",
      capability: "zotero.tags",
      operation: "apply_tags",
      verification,
      status: "applied",
      requestedTargets: ["item:41"],
      appliedTargets: ["item:41"],
      alreadySatisfiedTargets: [],
      rejectedTargets: [],
      reasons: [],
      verifiedFacts: [],
      ...extra,
    };
  }

  // The status block is appended to the answer the user reads, so it names a
  // verification value the same way the trace chip does.
  it("names every verification value in the words the trace uses", function () {
    assert.equal(
      formatReceiptStatus([receipt("verified")]),
      "[Action status: apply_tags — applied 1/1; Verified; proof:zotero_state]",
    );
    assert.equal(
      formatReceiptStatus([receipt("execution_only")]),
      "[Action status: apply_tags — applied 1/1; Ran (no state proof); proof:zotero_state]",
    );
    assert.equal(
      formatReceiptStatus([receipt("unverified")]),
      "[Action status: apply_tags — applied 1/1; Unverified; proof:zotero_state]",
    );
    assert.equal(
      formatReceiptStatus([
        receipt("not_applicable", {
          status: "cancelled",
          appliedTargets: [],
        }),
      ]),
      "[Action status: apply_tags — cancelled 0/1; Not applicable; proof:zotero_state]",
    );
  });

  it("keeps a receipt written before the value existed readable", function () {
    const legacy = receipt("verified");
    delete (legacy as { verification?: unknown }).verification;
    assert.equal(
      formatReceiptStatus([legacy]),
      "[Action status: apply_tags — applied 1/1; proof:zotero_state]",
    );
  });

  it("reports one line per receipt", function () {
    assert.equal(
      formatReceiptStatus([receipt("verified"), receipt("unverified")]),
      [
        "[Action status: apply_tags — applied 1/1; Verified; proof:zotero_state]",
        "[Action status: apply_tags — applied 1/1; Unverified; proof:zotero_state]",
      ].join("\n"),
    );
  });
});
