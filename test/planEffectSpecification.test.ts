import { assert } from "chai";
import {
  decodePlanArtifact,
  decodePlanEffectSpecification,
} from "../src/agent/plans/decoders";
import { decodeResearchMutationApprovalGrant } from "../src/agent/research/decoders";
import {
  freezePlanEffectSpecification,
  projectLegacyPlanArtifactV5,
  projectLegacyPlanEffects,
} from "../src/agent/plans/effectSpecification";
import type { PlanArtifact } from "../src/agent/plans/types";

function effectSpecification() {
  return {
    version: 1 as const,
    constraints: [],
    effects: [
      {
        effectId: "effect:create-destination",
        approval: "initial" as const,
        operation: "create_collection" as const,
        targets: [
          {
            domain: "zotero" as const,
            libraryID: 1,
            targetIds: ["library:1"],
            scopeDigest: "sha256:library-1",
          },
        ],
        parameters: { collectionName: "Reviewed" },
        review: "default" as const,
        targetBindings: [],
        restrictions: [],
        dependsOnEffectIds: [],
        materialBindings: [],
      },
      {
        effectId: "effect:save-summary",
        approval: "initial" as const,
        operation: "note_create" as const,
        targets: [
          {
            domain: "zotero" as const,
            libraryID: 1,
            targetIds: ["item:42"],
            scopeDigest: "sha256:item-42",
          },
        ],
        parameters: { targetItemId: 42 },
        review: "default" as const,
        targetBindings: [
          {
            role: "destination_collection",
            producedByEffectId: "effect:create-destination",
          },
        ],
        restrictions: [],
        dependsOnEffectIds: ["effect:create-destination"],
        materialBindings: [
          {
            role: "content" as const,
            material: {
              documentId: "document:summary",
              documentVersion: 2,
              contentHash: `sha256:${"a".repeat(64)}`,
            },
          },
        ],
      },
    ],
    deferredEffects: [
      {
        effectId: "effect:tag-research-results",
        approval: "after_research" as const,
        operation: "apply_tags" as const,
        targetSelectionDescription: "Papers supported by the completed review",
        parameters: { tags: ["reviewed"] },
        review: "review" as const,
        targetBindings: [],
        restrictions: [],
        dependsOnEffectIds: [],
        materialBindings: [],
      },
    ],
  };
}

function artifactV5() {
  return {
    version: 5 as const,
    planId: "plan-5",
    conversationKey: 42,
    provider: "original" as const,
    revision: 1,
    digest: "sha256:plan",
    status: "awaiting_approval" as const,
    contract: {
      deliverable: { kind: "answer" as const },
    },
    contractDigest: "sha256:contract",
    effectSpecification: effectSpecification(),
    skillBindings: [],
    steps: [
      {
        planStepId: "step-create",
        content: "Create the destination",
        activeForm: "Creating the destination",
        acceptanceCriteria: [
          {
            criterionId: "created",
            description: "The destination is created",
            verifier: "mutation_receipts" as const,
          },
        ],
        expectedEffect: "mutation" as const,
        effectIds: ["effect:create-destination"],
        completionRequirements: [
          {
            requirementId: "step-create:mutation",
            kind: "mutation_receipts" as const,
            criterionIds: ["created"],
            contractDigest: "sha256:contract",
          },
        ],
      },
      {
        planStepId: "step-1",
        content: "Save the summary",
        activeForm: "Saving the summary",
        acceptanceCriteria: [
          {
            criterionId: "saved",
            description: "The summary is saved",
            verifier: "mutation_receipts" as const,
          },
        ],
        expectedEffect: "mutation" as const,
        effectIds: ["effect:save-summary"],
        completionRequirements: [
          {
            requirementId: "step-1:mutation",
            kind: "mutation_receipts" as const,
            criterionIds: ["saved"],
            contractDigest: "sha256:contract",
          },
        ],
      },
      {
        planStepId: "step-research-write",
        content: "Tag the supported papers after review",
        activeForm: "Tagging the supported papers",
        acceptanceCriteria: [
          {
            criterionId: "tagged",
            description: "The approved papers are tagged",
            verifier: "mutation_receipts" as const,
          },
        ],
        expectedEffect: "mutation" as const,
        effectIds: ["effect:tag-research-results"],
        completionRequirements: [
          {
            requirementId: "step-research-write:mutation",
            kind: "mutation_receipts" as const,
            criterionIds: ["tagged"],
            contractDigest: "sha256:contract",
          },
        ],
      },
    ],
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("Plan v5 concrete effect specifications", function () {
  it("decodes stable effects, explicit dependencies, exact material versions, and deferred approval", function () {
    const artifact = decodePlanArtifact(artifactV5());
    assert.equal(artifact.version, 5);
    assert.deepEqual(artifact.steps[1].effectIds, ["effect:save-summary"]);
    assert.deepEqual(
      artifact.effectSpecification?.effects[1].materialBindings[0],
      effectSpecification().effects[1].materialBindings[0],
    );
    assert.equal(
      artifact.effectSpecification?.deferredEffects[0].approval,
      "after_research",
    );
  });

  it("decodes an exact v4 research grant without recreating an action contract", function () {
    const base = effectSpecification();
    const deferred = base.deferredEffects[0];
    const approvedSpecification = {
      ...base,
      effects: [
        ...base.effects,
        {
          effectId: `${deferred.effectId}:approved:1`,
          approval: "after_research" as const,
          operation: deferred.operation,
          targets: [
            {
              domain: "zotero" as const,
              libraryID: 1,
              targetIds: ["item:43"],
              scopeDigest: "sha256:item-43",
            },
          ],
          targetBindings: deferred.targetBindings,
          parameters: deferred.parameters,
          review: deferred.review,
          restrictions: deferred.restrictions,
          dependsOnEffectIds: deferred.dependsOnEffectIds,
          materialBindings: deferred.materialBindings,
          derivedFromDeferredEffectId: deferred.effectId,
        },
      ],
    };
    const grant = decodeResearchMutationApprovalGrant({
      version: 4,
      authority: "user",
      grantId: "grant-4",
      planId: "plan-5",
      planRevision: 1,
      executionId: "execution-5",
      conversationKey: 42,
      planDigest: "sha256:plan",
      researchResultDigest: "sha256:research",
      scopeLineageDigest: "sha256:lineage",
      targetSetDigest: "sha256:targets",
      effectSpecification: approvedSpecification,
      effectSpecificationDigest: "sha256:effects",
      status: "approved",
      approvedAt: 1,
    });
    assert.equal(grant.version, 4);
    assert.isUndefined(grant.actionContract);
    assert.equal(
      grant.effectSpecification?.effects.at(-1)?.derivedFromDeferredEffectId,
      deferred.effectId,
    );
  });

  it("rejects duplicate IDs and dependencies that are missing or not earlier", function () {
    const duplicate = effectSpecification();
    duplicate.effects[1] = {
      ...duplicate.effects[1],
      effectId: duplicate.effects[0].effectId,
    };
    assert.throws(
      () => decodePlanEffectSpecification(duplicate),
      /duplicate effect/i,
    );

    const forward = effectSpecification();
    forward.effects[0] = {
      ...forward.effects[0],
      dependsOnEffectIds: [forward.effects[1].effectId],
    };
    assert.throws(
      () => decodePlanEffectSpecification(forward),
      /dependency.*earlier/i,
    );
  });

  it("requires concrete frozen targets for initially approved effects", function () {
    const specification = effectSpecification();
    specification.effects[0] = {
      ...specification.effects[0],
      targets: [],
    };
    assert.throws(
      () => decodePlanEffectSpecification(specification),
      /frozen target/i,
    );
  });

  it("names the accepted values the schema leaves to the decoder", function () {
    // update_plan's schema leaves operation names, restriction kinds, and
    // target domains to this decoder, so a rejection must say what is valid.
    const reject = (mutate: (spec: any) => void): string => {
      const specification: any = effectSpecification();
      mutate(specification);
      try {
        decodePlanEffectSpecification(specification);
      } catch (error) {
        return (error as Error).message;
      }
      assert.fail("expected the decoder to reject the specification");
    };
    const operation = reject((spec) => {
      spec.effects[0].operation = "add_tags";
    });
    assert.include(
      operation,
      "effectSpecification.effects[0].operation is invalid",
    );
    assert.include(operation, "apply_tags");
    assert.include(operation, "zotero_script_execute");
    const deferred = reject((spec) => {
      spec.deferredEffects[0].operation = "tag_items";
    });
    assert.include(
      deferred,
      "effectSpecification.deferredEffects[0].operation is invalid",
    );
    assert.include(deferred, "apply_tags");
    const kind = reject((spec) => {
      spec.constraints = [{ kind: "no_write", description: "Read only" }];
    });
    assert.include(
      kind,
      "effectSpecification.constraints[0].kind is unsupported",
    );
    assert.include(kind, "deny_effects");
    assert.include(kind, "deny_mechanisms");
    const effects = reject((spec) => {
      spec.constraints = [
        {
          kind: "deny_effects",
          effects: ["write"],
          domains: ["filesystem"],
          description: "No writes",
        },
      ];
    });
    assert.include(
      effects,
      "effectSpecification.constraints[0].effects is invalid",
    );
    assert.include(effects, "egress");
    const domains = reject((spec) => {
      spec.constraints = [
        {
          kind: "deny_effects",
          effects: ["create"],
          domains: ["disk"],
          description: "No writes",
        },
      ];
    });
    assert.include(
      domains,
      "effectSpecification.constraints[0].domains is invalid",
    );
    assert.include(domains, "privileged_zotero");
    const mechanisms = reject((spec) => {
      spec.constraints = [
        { kind: "deny_mechanisms", mechanisms: ["python"], description: "x" },
      ];
    });
    assert.include(
      mechanisms,
      "effectSpecification.constraints[0].mechanisms is invalid",
    );
    assert.include(mechanisms, "zotero_script");
    const domain = reject((spec) => {
      spec.effects[0].targets = [{ domain: "library", targetIds: ["item:1"] }];
    });
    assert.include(
      domain,
      "effectSpecification.effects[0].targets[0].domain is invalid",
    );
    assert.include(domain, "filesystem");
    assert.include(domain, "execution");
  });

  it("replaces a supplied Zotero scope digest with the host target digest", async function () {
    const input = effectSpecification();
    input.effects = [input.effects[0]];
    input.deferredEffects = [];
    const frozen = await freezePlanEffectSpecification(
      input as unknown as ReturnType<typeof decodePlanEffectSpecification>,
    );
    assert.notEqual(
      frozen.effects[0].targets[0].domain === "zotero"
        ? frozen.effects[0].targets[0].scopeDigest
        : "",
      "sha256:library-1",
    );
  });

  it("projects a lossless legacy action contract and retains digest provenance", async function () {
    const legacy = {
      version: 4,
      planId: "legacy",
      conversationKey: 42,
      provider: "original",
      revision: 3,
      digest: "sha256:legacy-plan",
      status: "approved",
      actionContractId: "contract-1",
      actionContract: {
        version: 3,
        id: "contract-1",
        writeDisposition: "required",
        interpretationSource: "semantic",
        hardConstraints: [
          {
            kind: "deny_effects",
            effects: ["delete"],
            domains: ["zotero_library"],
            description: "Do not delete papers",
          },
        ],
        obligations: [
          {
            id: "tag-papers",
            operation: "apply_tags",
            capability: "zotero.tags",
            proofDomain: "zotero_state",
            coverage: "some",
            targetKind: "papers",
            parameters: { tags: ["reviewed"] },
            targetBoundary: {
              kind: "selection",
              libraryID: 1,
              frozenTargetIds: [42, 43],
              scopeDigest: "sha256:scope",
            },
          },
        ],
      },
      contract: { deliverable: { kind: "answer" } },
      contractDigest: "sha256:legacy-contract",
      steps: [
        {
          planStepId: "step",
          content: "Tag papers",
          activeForm: "Tagging papers",
          acceptanceCriteria: [
            {
              criterionId: "tagged",
              description: "Papers are tagged",
              verifier: "mutation_receipts",
            },
          ],
          expectedEffect: "mutation",
          actionIndexes: [0],
          completionRequirements: [
            {
              requirementId: "step:mutation_receipts",
              kind: "mutation_receipts",
              criterionIds: ["tagged"],
              contractDigest: "sha256:legacy-contract",
            },
          ],
        },
      ],
      createdAt: 1,
      updatedAt: 2,
      approvedAt: 2,
    } as PlanArtifact;
    const result = projectLegacyPlanEffects(legacy);
    assert.equal(result.kind, "compatible");
    if (result.kind !== "compatible") return;
    assert.equal(result.provenance.sourceDigest, legacy.digest);
    assert.equal(result.provenance.sourceContractDigest, legacy.contractDigest);
    assert.deepEqual(result.specification.effects[0].targets[0], {
      domain: "zotero",
      libraryID: 1,
      targetIds: ["item:42", "item:43"],
      scopeDigest: "sha256:scope",
    });
    assert.deepEqual(
      result.specification.effects[0].restrictions,
      legacy.actionContract?.hardConstraints,
    );
    const artifactResult = await projectLegacyPlanArtifactV5(legacy);
    assert.equal(artifactResult.kind, "compatible");
    if (artifactResult.kind !== "compatible") return;
    assert.equal(artifactResult.artifact.version, 5);
    assert.notEqual(artifactResult.artifact.digest, legacy.digest);
    assert.equal(
      artifactResult.artifact.approvalProvenance?.sourceDigest,
      legacy.digest,
    );
    assert.isUndefined(artifactResult.artifact.actionContract);
    assert.deepEqual(artifactResult.artifact.steps[0].effectIds, [
      "effect:legacy:0:tag-papers",
    ]);
  });

  it("requires renewed approval when a legacy write has no frozen target", function () {
    const legacy = {
      ...artifactV5(),
      version: 4,
      digest: "sha256:legacy",
      effectSpecification: undefined,
      actionContract: {
        version: 3,
        id: "legacy-contract",
        writeDisposition: "required",
        interpretationSource: "semantic",
        obligations: [
          {
            id: "ambiguous",
            operation: "apply_tags",
            capability: "zotero.tags",
            proofDomain: "zotero_state",
            coverage: "some",
            targetKind: "papers",
            parameters: { tags: ["reviewed"] },
          },
        ],
      },
    } as unknown as PlanArtifact;
    const result = projectLegacyPlanEffects(legacy);
    assert.equal(result.kind, "renewed_approval_required");
    if (result.kind === "renewed_approval_required") {
      assert.match(result.reason, /frozen target/i);
    }
  });

  it("preserves a future collection destination through its producer effect", function () {
    const legacy = {
      version: 4,
      planId: "create-then-file",
      conversationKey: 42,
      provider: "original",
      revision: 1,
      digest: "sha256:create-then-file",
      status: "approved",
      actionContractId: "contract",
      actionContract: {
        version: 3,
        id: "contract",
        writeDisposition: "required",
        interpretationSource: "semantic",
        obligations: [
          {
            id: "create",
            sourceActionIndex: 0,
            operation: "create_collection",
            capability: "zotero.collections",
            proofDomain: "zotero_state",
            coverage: "one",
            targetKind: "items",
            parameters: { collectionName: "New" },
          },
          {
            id: "file",
            sourceActionIndex: 1,
            operation: "move_to_collection",
            capability: "zotero.collections",
            proofDomain: "zotero_state",
            coverage: "one",
            targetKind: "papers",
            dependsOn: [0],
            destinationFrom: 0,
            destinationCreation: { obligationId: "create", libraryID: 1 },
            parameters: { sourceCollectionId: 8 },
            targetBoundary: {
              kind: "selection",
              libraryID: 1,
              frozenTargetIds: [42],
              scopeDigest: "sha256:paper-42",
            },
          },
        ],
      },
      contract: { deliverable: { kind: "answer" } },
      contractDigest: "sha256:contract",
      steps: [
        {
          planStepId: "step",
          content: "Create and file",
          activeForm: "Creating and filing",
          acceptanceCriteria: [
            {
              criterionId: "done",
              description: "The paper is filed",
              verifier: "mutation_receipts",
            },
          ],
          expectedEffect: "mutation",
          actionIndexes: [0, 1],
          completionRequirements: [
            {
              requirementId: "step:mutation_receipts",
              kind: "mutation_receipts",
              criterionIds: ["done"],
              contractDigest: "sha256:contract",
            },
          ],
        },
      ],
      createdAt: 1,
      updatedAt: 2,
      approvedAt: 2,
    } as PlanArtifact;
    const result = projectLegacyPlanEffects(legacy);
    assert.equal(result.kind, "compatible");
    if (result.kind !== "compatible") return;
    assert.deepEqual(result.specification.effects[0].targets, [
      {
        domain: "zotero",
        libraryID: 1,
        targetIds: ["library:1"],
        scopeDigest: "library:1",
      },
    ]);
    assert.deepEqual(result.specification.effects[1].targetBindings, [
      {
        role: "destination_collection",
        producedByEffectId: "effect:legacy:0:create",
      },
    ]);
    assert.include(
      result.specification.effects[1].dependsOnEffectIds,
      "effect:legacy:0:create",
    );
  });
});
