import { assert } from "chai";
import {
  OPERATION_CATALOG,
  OPERATION_LABELS,
  operationAuthorityIsConsistent,
  operationLabel,
} from "../src/agent/contracts/operationCatalog";

/**
 * The words a person reads for an operation belong to the operation.
 *
 * Receipts outlive the tools that produced them, so the catalog that already
 * owns an operation's capability and proof domain owns its reader-facing name
 * too. `satisfies Record` makes a missing label a compile error; what needs
 * proving here is that no label is the internal token and that a replayed
 * trace naming an operation this build has dropped still reads as something.
 */
describe("operation catalog labels", function () {
  it("gives every operation words of its own", function () {
    for (const operation of Object.keys(OPERATION_CATALOG)) {
      const label = operationLabel(operation);
      assert.equal(
        label,
        OPERATION_LABELS[operation as keyof typeof OPERATION_LABELS],
      );
      assert.notEqual(label, operation, `${operation} reads as its token`);
      assert.match(label, /^[A-Z]/, `${operation} is not written for a reader`);
    }
  });

  it("spells out an operation the catalog no longer knows", function () {
    assert.equal(operationLabel("retire_shelf"), "Retire shelf");
    assert.equal(operationLabel(""), "Action");
  });
});

// Moved from test/planResearchArchitectureV3.test.ts with the research engine.
describe("operation catalog authority", function () {
  it("defines one exhaustive capability and proof domain for every operation", function () {
    for (const [operation, authority] of Object.entries(OPERATION_CATALOG)) {
      assert.isTrue(
        operationAuthorityIsConsistent({
          operation,
          capability: authority.capability,
          proofDomain: authority.proofDomain,
        }),
        operation,
      );
      assert.isFalse(
        operationAuthorityIsConsistent({
          operation,
          capability: authority.capability,
          proofDomain:
            authority.proofDomain === "execution"
              ? "zotero_state"
              : "execution",
        }),
        operation,
      );
    }
  });
});
