import { assert } from "chai";
import { createFileIOTool } from "../src/agent/tools/write/fileIO";
import { createTestActionContractService } from "./helpers/actionContractService";

/**
 * file_io had no test file of its own. These pin the proposal it freezes for a
 * write (path plus the exact bytes' hash) and the receipt verification that
 * readback produces, so a later change to the evidence path has to move them
 * on purpose.
 */
describe("file_io effect path", function () {
  const tool = createFileIOTool();
  const service = createTestActionContractService();

  const validated = (args: Record<string, unknown>) => {
    const input = tool.validate(args);
    if (!input.ok) throw new Error(input.error);
    return input.value;
  };

  const writeInput = () =>
    validated({
      action: "write",
      filePath: "/tmp/file-io-audit.md",
      content: "audited",
    });

  it("freezes the path and the exact bytes it intends to write", async function () {
    const proposals = await tool.describeAction!(writeInput());
    assert.lengthOf(proposals, 1);
    const proposal = proposals[0];
    assert.equal(proposal.operation, "file_write");
    assert.equal(proposal.capability, "file.write");
    assert.equal(proposal.proofDomain, "file_state");
    assert.equal(proposal.source, "file_io");
    assert.deepEqual(proposal.requestedTargets, ["file:/tmp/file-io-audit.md"]);
    assert.equal(proposal.parameters?.filePath, "/tmp/file-io-audit.md");
    assert.lengthOf(proposal.expectedFiles || [], 1);
    assert.equal(proposal.expectedFiles![0].path, "/tmp/file-io-audit.md");
    assert.equal(
      proposal.expectedContentHash,
      proposal.expectedFiles![0].contentHash,
    );
    assert.equal(proposal.expectedFiles![0].byteLength, 7);
  });

  it("proposes nothing at all for a read", async function () {
    const proposals = await tool.describeAction!(
      validated({ action: "read", filePath: "/tmp/file-io-audit.md" }),
    );
    assert.deepEqual(proposals, []);
  });

  it("verifies the receipt only from a readback that matches the frozen hash", async function () {
    const prepared = await service.prepare(tool, writeInput());
    const expected = prepared.proposals[0].expectedFiles![0];
    const receipts = await service.finalize(prepared, {
      ok: true,
      effect: "applied",
      content: {
        filePath: expected.path,
        exists: true,
        contentHash: expected.contentHash,
        exportedFiles: [
          {
            filePath: expected.path,
            exists: true,
            contentHash: expected.contentHash,
            bytesWritten: expected.byteLength,
          },
        ],
      },
    });
    assert.lengthOf(receipts, 1);
    assert.equal(receipts[0].verification, "verified");
    assert.equal(receipts[0].status, "applied");
    assert.equal(receipts[0].evidenceRef, `sha256:${expected.contentHash}`);
    assert.include(
      receipts[0].verifiedFacts,
      `${expected.path}:sha256:${expected.contentHash}`,
    );
  });

  it("refuses to call a mismatched readback verified", async function () {
    const prepared = await service.prepare(tool, writeInput());
    const expected = prepared.proposals[0].expectedFiles![0];
    const receipts = await service.finalize(prepared, {
      ok: true,
      effect: "applied",
      content: {
        filePath: expected.path,
        exists: true,
        contentHash: "sha256-of-something-else",
      },
    });
    assert.equal(receipts[0].verification, "unverified");
    assert.equal(receipts[0].status, "unverified");
    assert.deepEqual(receipts[0].appliedTargets, []);
  });

  it("refuses to verify when nothing was read back", async function () {
    const prepared = await service.prepare(tool, writeInput());
    const receipts = await service.finalize(prepared, {
      ok: true,
      effect: "applied",
      content: { filePath: "/tmp/file-io-audit.md" },
    });
    assert.equal(receipts[0].verification, "unverified");
    assert.include(
      receipts[0].reasons.join(" "),
      "was not read back with an exact path and content hash",
    );
  });
});
