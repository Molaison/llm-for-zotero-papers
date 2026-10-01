import { semanticFixture } from "./helpers/semanticIntent";
import { assert } from "chai";
import { ActionContractService } from "../src/agent/contracts/actionContract";
import { evaluateActionContract } from "../src/agent/contracts/actionEvaluation";
import type {
  AgentActionIntent,
  AgentActionEvidence,
  AgentRuntimeRequest,
  AgentRuntimeRequestInput,
  AgentToolDefinition,
  AgentToolActionDescriptor,
  AgentToolEffect,
} from "../src/agent/types";
import type {
  LibraryMutationOperation,
  LibraryMutationState,
} from "../src/agent/services/libraryMutation/contracts";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";
import { parseActionIntents } from "../src/agent/model/actionIntent";
import { createRunCommandTool } from "../src/agent/tools/write/runCommand";
import { sha256Text } from "../src/agent/store/journalRecoveryBlobStore";

type FakeItemState = {
  tags: string[];
  collections: number[];
  fields: Record<string, string>;
  libraryID?: number;
  kind?: "regular" | "attachment" | "note" | "annotation";
  deleted?: boolean;
  noteHtml?: string;
  parentItemId?: number | null;
  annotation?: boolean;
  annotationFields?: Record<string, unknown>;
};

function createHarness() {
  const directMembers = new Map<number, number[]>([
    [10, [90]],
    [11, [1, 2, 3]],
    [12, [50, 51]],
  ]);
  const items = new Map<number, FakeItemState>();
  const collections = new Map([
    [
      10,
      {
        collectionId: 10,
        libraryID: 1,
        name: "Parent",
        path: "Parent",
        parentCollectionId: null,
        deleted: false,
      },
    ],
    [
      11,
      {
        collectionId: 11,
        libraryID: 1,
        name: "Leaf",
        path: "Parent/Leaf",
        parentCollectionId: 10,
        deleted: false,
      },
    ],
    [
      12,
      {
        collectionId: 12,
        libraryID: 1,
        name: "Sibling",
        path: "Parent/Sibling",
        parentCollectionId: 10,
        deleted: false,
      },
    ],
  ]);
  const settings = new Map<string, unknown>();
  const gateway = {
    getCollectionSummary(collectionId: number) {
      const collection = collections.get(collectionId);
      return collection
        ? {
            collectionId: collection.collectionId,
            libraryID: collection.libraryID,
            name: collection.name,
            path: collection.path,
          }
        : null;
    },
    getCollectionNativeState(collectionId: number) {
      const collection = collections.get(collectionId);
      return collection
        ? {
            exists: true,
            name: collection.name,
            parentCollectionId: collection.parentCollectionId,
            deleted: collection.deleted,
          }
        : {
            exists: false,
            name: "",
            parentCollectionId: null,
            deleted: false,
          };
    },
    listCollectionSummaries(libraryID: number) {
      return [...collections.values()]
        .filter((entry) => entry.libraryID === libraryID && !entry.deleted)
        .map(({ collectionId, name, path }) => ({
          collectionId,
          libraryID,
          name,
          path,
        }));
    },
    listCurrentCollectionSummaries(libraryID: number) {
      return this.listCollectionSummaries(libraryID);
    },
    listCurrentCollectionTargetIds(params: { collectionId: number }) {
      return [...(directMembers.get(params.collectionId) || [])];
    },
    async listCurrentLibraryTargetIds() {
      return [...items.keys()];
    },
    async listCollectionPaperTargets(params: { collectionId: number }) {
      return {
        papers: (directMembers.get(params.collectionId) || []).map(
          (itemId) => ({ itemId }),
        ),
      };
    },
    async listCollectionItemTargets(params: { collectionId: number }) {
      return {
        items: (directMembers.get(params.collectionId) || []).map((itemId) => ({
          itemId,
        })),
      };
    },
    getItem(itemId: number) {
      const state = items.get(itemId);
      if (!state) return null;
      return {
        ...state.annotationFields,
        id: itemId,
        libraryID: state.libraryID ?? 1,
        parentID: state.parentItemId ?? false,
        deleted: state.deleted,
        isRegularItem: () => !state.kind || state.kind === "regular",
        isAttachment: () => state.kind === "attachment",
        isNote: () => state.kind === "note" || state.noteHtml !== undefined,
        isAnnotation: () =>
          state.kind === "annotation" || state.annotation === true,
        getNote: () => state.noteHtml || "",
        getTags: () => state.tags.map((tag) => ({ tag })),
        getCollections: () => state.collections,
        getField: (field: string) => state.fields[field] || "",
      } as unknown as Zotero.Item;
    },
    getEditableArticleMetadata(item: Zotero.Item | null | undefined) {
      if (!item) return null;
      const state = items.get(Number(item.id));
      return state ? { fields: state.fields, creators: [] } : null;
    },
    getSettingNativeState(key: string) {
      return settings.has(key)
        ? { exists: true, value: settings.get(key) }
        : { exists: false, value: undefined };
    },
  };
  return {
    collections,
    directMembers,
    gateway,
    items,
    settings,
    service: new ActionContractService(gateway),
  };
}

function tagIntent(
  operation: "apply_tags" | "remove_tags" | "set_item_tags" = "apply_tags",
): AgentActionIntent {
  return {
    capability: "zotero.tags",
    operation,
    proofDomain: "zotero_state",
    coverage: "all",
    targetKind: "papers",
    parameters: { tags: ["topic:drift"] },
    scope: { kind: "collection", includeDescendants: false },
  };
}

function requestWithIntents(
  actionIntents: AgentActionIntent[],
  options: {
    disposition?: "none" | "required" | "uncertain";
    selectedCollection?: number;
    selectedCollections?: number[];
    userText?: string;
    activeItemId?: number;
    activePaperContext?: import("../src/shared/types").PaperContextRef;
    selectedPaperContexts?: import("../src/shared/types").PaperContextRef[];
  } = {},
): AgentRuntimeRequest {
  const selectedCollection = options.selectedCollection ?? 11;
  const selectedCollections =
    options.selectedCollections ||
    (selectedCollection > 0 ? [selectedCollection] : []);
  const input: AgentRuntimeRequestInput = {
    conversationKey: 1,
    mode: "agent",
    userText: options.userText || "test action",
    model: "test",
    libraryID: 1,
    activeItemId: options.activeItemId,
    activePaperContext: options.activePaperContext,
    selectedPaperContexts: options.selectedPaperContexts,
    selectedCollectionContexts: selectedCollections.length
      ? selectedCollections.map((collectionId) => ({
          collectionId,
          libraryID: 1,
          name:
            collectionId === 11
              ? "Leaf"
              : collectionId === 12
                ? "Sibling"
                : "Parent",
        }))
      : [],
    classifiedIntent: {
      semantic: semanticFixture(),
      retrievalIntent: "none",
      wantedSections: [],
      writeDisposition:
        options.disposition || (actionIntents.length ? "required" : "none"),
      actionInterpretationSource: "classifier",
      actionIntents,
    },
  };
  return resolvedAgentRequest(input);
}

/**
 * A stand-in for whichever library mutation tool a case needs. It declares no
 * effectOperations on purpose: it is never registered, and it fronts every
 * operation in this file, so a declaration here would be a fiction the
 * adapter check would rightly refuse.
 */
function mutationTool(): AgentToolDefinition<any, unknown> {
  return {
    spec: {
      name: "library_update",
      description: "test",
      inputSchema: { type: "object" },
      executionClass: "external_effect",
      requiresConfirmation: true,
    },
    validate: (input) => ({ ok: true, value: input }),
    execute: async () => ({ content: {}, effect: "applied" }),
  };
}

function mutationEvidence(
  operationValue: LibraryMutationOperation,
  preState: LibraryMutationState,
  postState: LibraryMutationState,
  journalStepId: string,
  effect: AgentActionEvidence["effect"] = "applied",
): AgentActionEvidence[] {
  return [
    {
      version: 1,
      source: "library_mutation",
      proofDomain: "zotero_state",
      operationValue,
      preState,
      postState,
      journalStepId,
      effect,
    },
  ];
}

describe("Action Contract V2", function () {
  it("executes the explicit non-permanent trash contract through the native operation adapter", async function () {
    const { service, items } = createHarness();
    items.set(41, { tags: [], collections: [], fields: {} });
    for (const permanent of [false, true]) {
      const request = requestWithIntents(
        parseActionIntents([
          {
            operation: "trash_items",
            coverage: "one",
            targetKind: "papers",
            parameters: { permanent },
            targetSelectors: [{ kind: "item_id", value: 41 }],
          },
        ]),
        {
          selectedCollection: 0,
          userText: "Trash the identified paper; preserve recovery.",
        },
      );
      const contract = await service.createContract(request);
      const prepared = await service.prepare(
        mutationTool(),
        {
          operation: { type: "trash_items", itemIds: [41] },
        },
        request,
      );
      assert.equal(
        (await service.validateScope(contract, prepared)) === null,
        !permanent,
      );
    }
  });
  it("binds an explicit metadata value through interpretation, contract, and exact proposal validation", async function () {
    const { service, items } = createHarness();
    items.set(41, { tags: [], collections: [], fields: { title: "Old" } });
    const decoded = parseActionIntents([
      {
        operation: "update_metadata",
        coverage: "one",
        targetKind: "papers",
        parameters: { metadataValues: { title: "Requested title" } },
        targetSelectors: [{ kind: "item_id", value: 41 }],
      },
    ]);
    assert.lengthOf(decoded, 1);
    const request = requestWithIntents(decoded, {
      selectedCollection: 0,
      userText: "Set the title to Requested title",
    });
    const contract = await service.createContract(request);
    for (const [title, allowed] of [
      ["Requested title", true],
      ["Different title", false],
    ] as const) {
      const prepared = await service.prepare(
        mutationTool(),
        {
          operation: {
            type: "update_metadata",
            itemId: 41,
            metadata: { title },
          },
        },
        request,
      );
      assert.equal(
        (await service.validateScope(contract, prepared)) === null,
        allowed,
        title,
      );
    }
  });
  it("allows separate requested operations to execute sequentially without weakening per-operation target coverage", async function () {
    const { service, items } = createHarness();
    for (const id of [41, 42])
      items.set(id, { tags: [], collections: [], fields: {} });
    const targets = [
      { kind: "item_id" as const, value: 41 },
      { kind: "item_id" as const, value: 42 },
    ];
    const request = requestWithIntents(
      [
        { ...tagIntent(), scope: undefined, targetSelectors: targets },
        {
          operation: "update_metadata",
          capability: "zotero.metadata",
          proofDomain: "zotero_state",
          coverage: "some",
          targetKind: "papers",
          targetSelectors: targets,
        },
      ],
      {
        selectedCollection: 0,
        userText:
          "Add topic:drift to items 41 and 42, then update their journal.",
      },
    );
    const contract = await service.createContract(request);
    const prepare = (itemIds: number[]) =>
      service.prepare(
        mutationTool(),
        {
          operations: [{ type: "apply_tags", itemIds, tags: ["topic:drift"] }],
        },
        request,
      );
    assert.isNull(
      await service.validateScope(contract, await prepare([41, 42])),
    );
    assert.exists(
      await service.validateScope(contract, await prepare([41])),
      "every target in the current operation remains required",
    );
    assert.equal(
      service.createProgress(contract).obligations[1].status,
      "open",
      "the later metadata obligation remains pending",
    );
  });
  for (const selectorKind of ["title", "item_key"] as const) {
    it(`freezes only explicitly named ${selectorKind} targets, never the whole library or ambient selection`, async function () {
      const { service, items, gateway } = createHarness();
      for (const id of [41, 42, 43])
        items.set(id, {
          tags: ["old"],
          collections: [],
          fields: { title: `Paper ${id}` },
        });
      (gateway as any).getItemByLibraryAndKey = (
        _libraryID: number,
        key: string,
      ) => gateway.getItem(Number(key.slice(4)));
      const selectors = [41, 42].map((id) => ({
        kind: selectorKind,
        value: selectorKind === "title" ? `Paper ${id}` : `TEST00${id}`,
      }));
      const intent = {
        ...tagIntent("set_item_tags"),
        scope: undefined,
        coverage: "all" as const,
        targetSelectors: selectors,
      };
      const request = requestWithIntents([intent], {
        selectedCollection: 0,
        activeItemId: 43,
        userText: `Set tags on ${selectors.map((s) => s.value).join(", ")}`,
      });
      const contract = await service.createContract(request);
      assert.equal(contract.obligations[0].targetBoundary?.kind, "selection");
      assert.deepEqual(
        contract.obligations[0].targetBoundary?.frozenTargetIds,
        [41, 42],
      );
      const prepared = await service.prepare(
        mutationTool(),
        {
          operations: [
            {
              type: "set_item_tags",
              assignments: [{ itemId: 43, tags: ["topic:drift"] }],
            },
          ],
        },
        request,
      );
      const rejection = await service.validateScope(contract, prepared);
      assert.exists(rejection, "an unrelated paper must never be authorized");
    });
  }

  it("rejects ambiguous and missing explicit titles instead of falling back to a library boundary", async function () {
    const { service, items } = createHarness();
    for (const id of [41, 42])
      items.set(id, {
        tags: [],
        collections: [],
        fields: { title: "Same title" },
      });
    for (const value of ["Same title", "Missing title"]) {
      const request = requestWithIntents(
        [
          {
            ...tagIntent(),
            scope: undefined,
            targetSelectors: [{ kind: "title", value }],
          } as any,
        ],
        { selectedCollection: 0, userText: `Tag the paper titled "${value}"` },
      );
      let error = "";
      try {
        await service.createContract(request);
      } catch (reason) {
        error = String(reason);
      }
      assert.match(error, /ambiguous|not found/i);
    }
  });

  it("resolves every literal item key in the live plural-key request", async function () {
    const { service, items, gateway } = createHarness();
    for (const id of [41, 42, 43])
      items.set(id, { tags: [], collections: [], fields: {} });
    const keys = ["WTI4KW3E", "MG2MBGKQ", "N2TKK3CR"];
    (gateway as any).getItemByLibraryAndKey = (
      _libraryID: number,
      key: string,
    ) => gateway.getItem(41 + keys.indexOf(key));
    const request = requestWithIntents([], {
      selectedCollection: 0,
      userText: `Set exactly these three tags on only the papers with item keys ${keys.join(", ")} in My Library: coding, drift, memory. Replace their previous tags with this exact set; do not change any other item or field.`,
    });
    request.classifiedIntent!.actionIntents = parseActionIntents([
      {
        operation: "set_item_tags",
        coverage: "some",
        targetKind: "papers",
        parameters: { tags: ["coding", "drift", "memory"] },
        targetSelectors: keys.map((value) => ({ kind: "item_key", value })),
      },
    ]);
    request.classifiedIntent!.writeDisposition = "required";
    const contract = await service.createContract(request);
    assert.deepEqual(
      contract.obligations[0].targetBoundary?.frozenTargetIds,
      [41, 42, 43],
    );
  });
  it("keeps explicit collection subsets fixed while revalidating their source membership", async function () {
    const { service, items, directMembers } = createHarness();
    for (const id of [41, 42, 43, 44])
      items.set(id, {
        tags: [],
        collections: [11],
        fields: { title: `Paper ${id}` },
      });
    directMembers.set(11, [41, 42, 43]);
    const request = requestWithIntents(
      [
        {
          ...tagIntent(),
          targetSelectors: [
            { kind: "title", value: "Paper 41" },
            { kind: "title", value: "Paper 42" },
          ],
        },
      ],
      {
        userText:
          'Tag papers titled "Paper 41", "Paper 42" in collection "Leaf"',
      },
    );
    const contract = await service.createContract(request);
    assert.deepEqual(
      contract.obligations[0].targetBoundary?.frozenTargetIds,
      [41, 42],
    );
    const prepared = await service.prepare(
      mutationTool(),
      {
        operations: [
          { type: "apply_tags", itemIds: [41, 42], tags: ["topic:drift"] },
        ],
      },
      request,
    );
    assert.isNull(await service.validateScope(contract, prepared));
    directMembers.set(11, [41, 42, 43, 44]);
    assert.isNull(
      await service.validateScope(contract, prepared),
      "unrelated new members do not expand an exact subset",
    );
    directMembers.set(11, [41, 43, 44]);
    assert.exists(
      await service.validateScope(contract, prepared),
      "a selected paper leaving its source invalidates the prepared write",
    );
    let error = "";
    try {
      await service.createContract(request);
    } catch (reason) {
      error = String(reason);
    }
    assert.include(error, "outside the requested source collection");
  });

  it("rejects invented and cross-library explicit target selectors", async function () {
    const { service, items } = createHarness();
    items.set(41, { tags: [], collections: [], fields: {}, libraryID: 2 });
    for (const userText of ["Tag item 41", "Tag the current paper"]) {
      const request = requestWithIntents(
        [
          {
            ...tagIntent(),
            scope: undefined,
            targetSelectors: [{ kind: "item_id", value: 41 }],
          },
        ],
        { selectedCollection: 0, userText },
      );
      let error = "";
      try {
        await service.createContract(request);
      } catch (reason) {
        error = String(reason);
      }
      assert.match(
        error,
        /not found in library|not present in the user request/,
      );
    }
  });

  it("freezes the named native item key for trash without requiring a selected paper", async function () {
    const { service, items, gateway } = createHarness();
    items.set(42, { tags: [], collections: [], fields: {}, kind: "regular" });
    (gateway as any).getItemByLibraryAndKey = (
      libraryID: number,
      key: string,
    ) => (libraryID === 1 && key === "JBU4RMQ9" ? gateway.getItem(42) : null);
    const request = requestWithIntents([], { selectedCollection: 0 });
    request.userText =
      "Move to trash (do not permanently delete) only the paper with item key JBU4RMQ9.";
    request.classifiedIntent!.actionIntents = parseActionIntents([
      {
        operation: "trash_items",
        coverage: "one",
        targetKind: "items",
        targetSelectors: [{ kind: "item_key", value: "JBU4RMQ9" }],
      },
    ]);
    request.classifiedIntent!.writeDisposition = "required";
    const contract = await service.createContract(request);
    assert.deepEqual(
      contract.obligations[0].targetBoundary?.frozenTargetIds,
      [42],
    );
    request.userText =
      "Restore from trash only the paper with item key JBU4RMQ9.";
    assert.deepEqual(
      parseActionIntents([
        {
          operation: "restore_from_trash",
          coverage: "one",
          targetKind: "items",
          targetSelectors: [{ kind: "item_key", value: "JBU4RMQ9" }],
        },
      ]).map((intent) => intent.operation),
      ["restore_from_trash"],
    );
  });
  it("binds future collection destinations to their own verified creation and exact source papers", async function () {
    const { service, items, collections } = createHarness();
    for (const id of [41, 42, 43])
      items.set(id, { tags: [], collections: [11], fields: {} });
    const names = ["geometry new", "memory new"];
    const creates: AgentActionIntent[] = names.map((collectionName) => ({
      capability: "zotero.collections",
      operation: "create_collection",
      proofDomain: "zotero_state",
      coverage: "one",
      targetKind: "items",
      parameters: { collectionName, parentCollectionId: 10 },
    }));
    const filings: AgentActionIntent[] = names.map((path, index) => ({
      capability: "zotero.collections",
      operation: "move_to_collection",
      proofDomain: "zotero_state",
      coverage: "some",
      targetKind: "papers",
      targetSelectors: [41 + index, 43].map((value) => ({
        kind: "item_id",
        value,
      })),
      scopeRole: "destination",
      scope: { kind: "collection", path, includeDescendants: false },
    }));
    const contract = await service.createContract(
      requestWithIntents(
        // Classification order is not execution order.
        [filings[0], creates[1], creates[0], filings[1]],
        {
          selectedCollection: 0,
          userText:
            'Create "geometry new" and "memory new" under Parent (10). Add papers 41 and 43 to geometry and 42 and 43 to memory. Do not create any papers or notes.',
        },
      ),
    );
    const frozenContract = JSON.stringify(contract);
    const progress = service.createProgress(contract);
    const file = (targetCollectionId: number, itemIds: number[]) =>
      service.prepare(mutationTool(), {
        operation: { type: "move_to_collection", targetCollectionId, itemIds },
      });
    assert.exists(
      await service.validateScope(contract, await file(20, [41, 43]), {
        progress,
      }),
    );
    for (const [index, name] of names.entries()) {
      const collectionId = 20 + index;
      const operation: LibraryMutationOperation = {
        type: "create_collection",
        name,
        libraryID: 1,
        parentCollectionId: 10,
      };
      const prepared = await service.prepare(mutationTool(), { operation });
      assert.isNull(
        await service.validateScope(contract, prepared, { progress }),
      );
      collections.set(collectionId, {
        collectionId,
        libraryID: 1,
        name,
        path: `Parent/${name}`,
        parentCollectionId: 10,
        deleted: false,
      });
      // An externally created lookalike alone cannot satisfy this turn's dependency.
      assert.exists(
        await service.validateScope(
          contract,
          await file(collectionId, [41 + index, 43]),
          { progress },
        ),
      );
      const receipts = await service.finalize(
        contract,
        prepared,
        {
          ok: true,
          effect: "applied",
          actionEvidence: mutationEvidence(
            operation,
            { version: 1, operation: "create_collection" },
            {
              version: 1,
              operation: "create_collection",
              collections: [
                {
                  collectionId,
                  exists: true,
                  name,
                  parentCollectionId: 10,
                  deleted: false,
                },
              ],
            },
            `created-${collectionId}`,
          ),
        },
        progress,
      );
      assert.equal(receipts[0].verification, "verified");
      service.applyReceipts(progress, receipts);
    }
    assert.isNull(
      await service.validateScope(contract, await file(20, [41, 43]), {
        progress,
      }),
    );
    assert.isNull(
      await service.validateScope(contract, await file(21, [42, 43]), {
        progress,
      }),
    );
    assert.exists(
      await service.validateScope(contract, await file(20, [42, 43]), {
        progress,
      }),
    );
    assert.exists(
      await service.validateScope(contract, await file(12, [41, 43]), {
        progress,
      }),
    );
    assert.exists(
      await service.validateScope(contract, await file(20, [41]), { progress }),
    );
    collections.get(20)!.parentCollectionId = 12;
    assert.exists(
      await service.validateScope(contract, await file(20, [41, 43]), {
        progress,
      }),
    );
    collections.get(20)!.parentCollectionId = 10;
    const foreignProgress = { ...progress, contractId: "another-turn" };
    assert.exists(
      await service.validateScope(contract, await file(20, [41, 43]), {
        progress: foreignProgress,
      }),
    );
    assert.equal(
      JSON.stringify(contract),
      frozenContract,
      "receipt binding never mutates frozen intent",
    );
    const filing = contract.obligations.find(
      (entry) => entry.operation === "move_to_collection",
    )!;
    const onePaperReceipt = {
      version: 2 as const,
      id: "partial-filing",
      obligationId: filing.id,
      proposalId: "file-one",
      proofDomain: "zotero_state" as const,
      capability: "zotero.collections" as const,
      operation: "move_to_collection" as const,
      verification: "verified" as const,
      status: "applied" as const,
      requestedTargets: ["item:41"],
      appliedTargets: ["item:41"],
      alreadySatisfiedTargets: [],
      rejectedTargets: [],
      reasons: [],
      verifiedFacts: [],
    };
    assert.notEqual(
      evaluateActionContract({ ...contract, obligations: [filing] }, [
        onePaperReceipt,
      ]).state,
      "satisfied",
      "one filing receipt cannot satisfy both frozen papers",
    );
  });

  it("files a new standalone note in an empty destination without borrowing its members as source targets", async function () {
    const { service, directMembers } = createHarness();
    directMembers.set(11, []);
    const request = requestWithIntents([], { selectedCollection: 0 });
    request.userText =
      'Create exactly one standalone version of note 3932 and file it in the collection named "Leaf". Preserve its complete content and all six sections.';
    request.classifiedIntent!.actionIntents = parseActionIntents([
      {
        operation: "note_create",
        coverage: "one",
        targetKind: "items",
        scopeRole: "destination",
        scope: { kind: "collection", path: "Leaf", includeDescendants: false },
        parameters: { noteMode: "create" },
      },
    ]);
    request.classifiedIntent!.writeDisposition = "required";
    const contract = await service.createContract(request);
    const prepare = (destination: number) =>
      service.prepare(
        {
          ...mutationTool(),
          describeAction: () => [
            {
              id: "new-note",
              proofDomain: "zotero_state",
              capability: "zotero.notes",
              operation: "note_create",
              source: "zotero_native",
              parameters: { noteMode: "create" },
              requestedTargets: [],
              destinationCollectionIds: [destination],
            },
          ],
        },
        {},
      );
    assert.isNull(await service.validateScope(contract, await prepare(11)));
    assert.exists(await service.validateScope(contract, await prepare(12)));
    // Destination membership is not the scope of the source material.
    directMembers.set(11, [900]);
    assert.isNull(await service.validateScope(contract, await prepare(11)));
  });

  it("does not manufacture command authority from a file export obligation", async function () {
    const { service } = createHarness();
    const contract = await service.createContract(
      requestWithIntents(
        [
          {
            operation: "file_write",
            capability: "file.write",
            proofDomain: "file_state",
            coverage: "one",
            targetKind: "items",
            parameters: { filePath: "/tmp/behavior-vault/figures.md" },
          },
        ],
        { selectedCollection: 0 },
      ),
    );
    const tool = createRunCommandTool();
    const prepare = async (command: string) => {
      const input = tool.validate({ command });
      if (!input.ok) throw new Error(input.error);
      return service.prepare(tool, input.value);
    };
    for (const command of [
      'mkdir -p "/tmp/behavior-vault" && ls -la "/tmp/behavior-vault"',
      'mkdir -p "/tmp/behavior-vault/assets" && cp "/tmp/crop.png" "/tmp/behavior-vault/assets/figure.png" && ls -l "/tmp/behavior-vault/assets/figure.png"',
      'mkdir -p "/tmp/behavior-vault/assets" && cp "/tmp/figure-1-p3.png" "/tmp/behavior-vault/assets/" && ls -la "/tmp/behavior-vault" "/tmp/behavior-vault/assets"',
    ]) {
      assert.exists(
        await service.validateScope(contract, await prepare(command)),
        command,
      );
    }
    for (const command of [
      "mkdir -p /tmp/elsewhere",
      "cp /tmp/crop.png /tmp/behavior-vault/../elsewhere.png",
      "mkdir -p /tmp/behavior-vault && curl https://example.com",
      "cp /tmp/source.md /tmp/behavior-vault/figures.md",
      "cp /tmp/source.md /tmp/behavior-vault/assets/",
      "cp /tmp/source.md /tmp/behavior-vault/assets/figure.png",
      "cp /tmp/crop.png /tmp/behavior-vault/assets/../../elsewhere/",
      "mkdir -p /tmp/behavior-vault; touch /tmp/unrequested",
      'mkdir -p "/tmp/behavior-vault/$(whoami)"',
    ]) {
      assert.exists(
        await service.validateScope(contract, await prepare(command)),
        command,
      );
    }
    assert.equal(
      evaluateActionContract(contract, [], service.createProgress(contract))
        .state,
      "pending",
    );
  });
  it("resolves unscoped item boundaries by operation semantics and exact resource type", async function () {
    const { service, items } = createHarness();
    items.set(42, { tags: [], collections: [], fields: {}, kind: "regular" });
    items.set(60, { tags: [], collections: [], fields: {}, kind: "regular" });
    items.set(700, {
      tags: [],
      collections: [],
      fields: {},
      kind: "note",
      parentItemId: 42,
    });
    items.set(900, {
      tags: [],
      collections: [],
      fields: {},
      kind: "attachment",
      parentItemId: 42,
    });
    const activePaperContext = {
      itemId: 42,
      contextItemId: 900,
      title: "Paper 42",
    };
    const makeIntent = (
      operation: AgentActionIntent["operation"],
      targetKind: AgentActionIntent["targetKind"],
      targetItemId?: number,
    ): AgentActionIntent => ({
      capability:
        operation === "update_metadata"
          ? "zotero.metadata"
          : operation.includes("attachment")
            ? "zotero.attachments"
            : operation === "apply_tags"
              ? "zotero.tags"
              : "zotero.collections",
      operation,
      proofDomain: "zotero_state",
      coverage: "one",
      targetKind,
      parameters:
        operation === "move_to_collection"
          ? {
              destinationCollectionId: 10,
              ...(targetItemId ? { targetItemId } : {}),
            }
          : targetItemId
            ? { targetItemId }
            : undefined,
    });
    const boundaryFor = async (
      intent: AgentActionIntent,
      activeItemId: number,
    ) =>
      (
        await service.createContract(
          requestWithIntents([intent], {
            selectedCollection: 0,
            activeItemId,
            activePaperContext,
            selectedPaperContexts: [
              activePaperContext,
              { itemId: 60, contextItemId: 60, title: "Added" },
            ],
          }),
        )
      ).obligations[0].targetBoundary?.frozenTargetIds;

    for (const operation of [
      "rename_attachment",
      "relink_attachment",
      "delete_attachment",
    ] as const) {
      assert.deepEqual(
        await boundaryFor(makeIntent(operation, "items"), 900),
        [900],
      );
      assert.deepEqual(
        await boundaryFor(makeIntent(operation, "items"), 999),
        [900],
      );
    }
    assert.deepEqual(
      await boundaryFor(makeIntent("update_metadata", "papers"), 900),
      [42],
    );
    assert.deepEqual(
      await boundaryFor(makeIntent("update_metadata", "items"), 700),
      [42],
    );
    assert.deepEqual(
      await boundaryFor(makeIntent("move_to_collection", "items"), 700),
      [42],
    );
    assert.deepEqual(
      await boundaryFor(makeIntent("apply_tags", "items"), 999),
      [42],
    );
    assert.deepEqual(
      await boundaryFor(makeIntent("update_metadata", "papers", 60), 900),
      [60],
    );
    const addedFallback = await service.createContract(
      requestWithIntents([makeIntent("update_metadata", "papers")], {
        selectedCollection: 0,
        activeItemId: 999,
        selectedPaperContexts: [
          { itemId: 60, contextItemId: 60, title: "Added" },
        ],
      }),
    );
    assert.deepEqual(
      addedFallback.obligations[0].targetBoundary?.frozenTargetIds,
      [60],
    );

    items.set(901, {
      tags: [],
      collections: [],
      fields: {},
      kind: "attachment",
      libraryID: 2,
    });
    const rejectionMessage = async (promise: Promise<unknown>) => {
      try {
        await promise;
        assert.fail("expected contract construction to reject");
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    };
    assert.match(
      await rejectionMessage(
        service.createContract(
          requestWithIntents([makeIntent("rename_attachment", "items", 901)], {
            selectedCollection: 0,
          }),
        ),
      ),
      /different Zotero library/,
    );
    assert.match(
      await rejectionMessage(
        service.createContract(
          requestWithIntents([makeIntent("update_metadata", "items", 900)], {
            selectedCollection: 0,
          }),
        ),
      ),
      /valid regular bibliographic item/,
    );
  });

  it("keeps a valid standalone note or attachment for collection membership", async function () {
    const { service, items } = createHarness();
    items.set(701, {
      tags: [],
      collections: [],
      fields: {},
      kind: "note",
      parentItemId: null,
    });
    items.set(702, {
      tags: [],
      collections: [],
      fields: {},
      kind: "attachment",
      parentItemId: null,
    });
    const intent: AgentActionIntent = {
      capability: "zotero.collections",
      operation: "move_to_collection",
      proofDomain: "zotero_state",
      coverage: "one",
      targetKind: "items",
      parameters: { destinationCollectionId: 10 },
    };
    for (const itemId of [701, 702]) {
      const contract = await service.createContract(
        requestWithIntents([intent], {
          selectedCollection: 0,
          activeItemId: itemId,
        }),
      );
      assert.deepEqual(
        contract.obligations[0].targetBoundary?.frozenTargetIds,
        [itemId],
      );
    }
  });

  it("authorizes the unresolved union of multiple selected source collections", async function () {
    const { service, directMembers } = createHarness();
    directMembers.set(11, [1, 2]);
    directMembers.set(12, [2, 3]);
    const contract = await service.createContract(
      requestWithIntents([tagIntent()], {
        selectedCollections: [11, 12],
      }),
    );
    const progress = service.createProgress(contract);
    const operation: LibraryMutationOperation = {
      type: "apply_tags",
      itemIds: [3, 2, 1, 2],
      tags: ["topic:drift"],
    };
    const prepared = await service.prepare(mutationTool(), { operation });
    assert.isNull(
      await service.validateScope(contract, prepared, { progress }),
    );

    const evidenceItems = [1, 2, 3].map((itemId) => ({
      itemId,
      exists: true,
      tags: ["topic:drift"],
    }));
    const receipts = await service.finalize(
      contract,
      prepared,
      {
        ok: true,
        effect: "applied",
        actionEvidence: mutationEvidence(
          operation,
          {
            version: 1,
            operation: "apply_tags",
            items: evidenceItems.map((item) => ({ ...item, tags: [] })),
          },
          {
            version: 1,
            operation: "apply_tags",
            items: evidenceItems,
          },
          "journal-union",
        ),
      },
      progress,
    );

    assert.lengthOf(receipts, 2);
    assert.deepEqual(receipts[0].requestedTargets, ["item:2", "item:1"]);
    assert.deepEqual(receipts[1].requestedTargets, ["item:3", "item:2"]);
    service.applyReceipts(progress, receipts);
    assert.deepEqual(
      progress.obligations.map((entry) => entry.status),
      ["fulfilled", "fulfilled"],
    );
  });

  it("accepts one compatible proposal per source collection", async function () {
    const { service, directMembers } = createHarness();
    directMembers.set(11, [1, 2]);
    directMembers.set(12, [3, 4]);
    const contract = await service.createContract(
      requestWithIntents([tagIntent()], {
        selectedCollections: [11, 12],
      }),
    );
    const prepared = await service.prepare(mutationTool(), {
      operations: [
        {
          type: "apply_tags",
          itemIds: [2, 1],
          tags: ["topic:drift"],
        },
        {
          type: "apply_tags",
          itemIds: [4, 3],
          tags: ["topic:drift"],
        },
      ],
    });

    assert.isNull(
      await service.validateScope(contract, prepared, {
        progress: service.createProgress(contract),
      }),
    );
  });

  it("assigns only unresolved source collections and emits receipts for that same assignment", async function () {
    const { service, directMembers } = createHarness();
    directMembers.set(11, [1, 2]);
    directMembers.set(12, [3, 4]);
    const contract = await service.createContract(
      requestWithIntents([tagIntent()], {
        selectedCollections: [11, 12],
      }),
    );
    const progress = service.createProgress(contract);
    Object.assign(progress.obligations[0], {
      status: "fulfilled",
      verifiedTargetIds: ["item:1", "item:2"],
      unresolvedTargetIds: [],
    });
    const operation: LibraryMutationOperation = {
      type: "apply_tags",
      itemIds: [4, 3],
      tags: ["topic:drift"],
    };
    const prepared = await service.prepare(mutationTool(), { operation });

    assert.isNull(
      await service.validateScope(contract, prepared, { progress }),
    );
    const receipts = await service.finalize(
      contract,
      prepared,
      {
        ok: true,
        effect: "applied",
        actionEvidence: mutationEvidence(
          operation,
          {
            version: 1,
            operation: "apply_tags",
            items: [3, 4].map((itemId) => ({
              itemId,
              exists: true,
              tags: [],
            })),
          },
          {
            version: 1,
            operation: "apply_tags",
            items: [3, 4].map((itemId) => ({
              itemId,
              exists: true,
              tags: ["topic:drift"],
            })),
          },
          "journal-unresolved",
        ),
      },
      progress,
    );

    assert.lengthOf(receipts, 1);
    assert.equal(receipts[0].obligationId, contract.obligations[1].id);
    assert.deepEqual(receipts[0].requestedTargets, ["item:4", "item:3"]);
  });

  it("rejects any ungranted source removal from an add-only filing contract", async function () {
    const { service } = createHarness();
    const contract = await service.createContract(
      requestWithIntents([
        {
          capability: "zotero.collections",
          operation: "move_to_collection",
          proofDomain: "zotero_state",
          coverage: "all",
          targetKind: "items",
          scopeRole: "source",
          scope: {
            kind: "collection",
            path: "Parent/Leaf",
            includeDescendants: false,
          },
          parameters: { destinationCollectionId: 10 },
        },
      ]),
    );
    for (const source of [11, "all"] as const) {
      const prepared = await service.prepare(mutationTool(), {
        operation: {
          type: "move_to_collection",
          itemIds: [1, 2, 3],
          targetCollectionId: 10,
          mode: "move",
          from: source,
        },
      });
      assert.isNotNull(
        await service.validateScope(contract, prepared, {
          progress: service.createProgress(contract),
        }),
      );
    }
  });

  it("keeps exact destination validation independent from source collection unioning", async function () {
    const { service, directMembers } = createHarness();
    directMembers.set(11, [1, 2]);
    directMembers.set(12, [3, 4]);
    const sourceIntent: AgentActionIntent = {
      capability: "zotero.collections",
      operation: "move_to_collection",
      proofDomain: "zotero_state",
      coverage: "all",
      targetKind: "items",
      scopeRole: "source",
      scope: { kind: "collection", includeDescendants: false },
    };
    const destinationIntent: AgentActionIntent = {
      ...sourceIntent,
      coverage: "one",
      scopeRole: "destination",
      scope: {
        kind: "collection",
        path: "Parent",
        includeDescendants: false,
      },
    };
    const contract = await service.createContract(
      requestWithIntents(
        [{ ...sourceIntent, parameters: { destinationCollectionId: 10 } }],
        {
          selectedCollections: [11, 12],
        },
      ),
    );
    const operation: LibraryMutationOperation = {
      type: "move_to_collection",
      itemIds: [1, 2, 3, 4],
      targetCollectionId: 10,
    };
    const prepared = await service.prepare(mutationTool(), { operation });

    assert.isNull(
      await service.validateScope(contract, prepared, {
        progress: service.createProgress(contract),
      }),
    );
    const wrongDestination = await service.prepare(mutationTool(), {
      operation: { ...operation, targetCollectionId: 12 },
    });
    assert.include(
      (
        await service.validateScope(contract, wrongDestination, {
          progress: service.createProgress(contract),
        })
      )?.message || "",
      "different parameters",
    );
  });

  it("rejects drift in either assigned source collection independently", async function () {
    for (const changedCollectionId of [11, 12]) {
      const { service, directMembers } = createHarness();
      directMembers.set(11, [1, 2]);
      directMembers.set(12, [3, 4]);
      const contract = await service.createContract(
        requestWithIntents([tagIntent()], {
          selectedCollections: [11, 12],
        }),
      );
      directMembers.get(changedCollectionId)!.push(99);
      const prepared = await service.prepare(mutationTool(), {
        operation: {
          type: "apply_tags",
          itemIds: [1, 2, 3, 4],
          tags: ["topic:drift"],
        },
      });
      assert.include(
        (
          await service.validateScope(contract, prepared, {
            progress: service.createProgress(contract),
          })
        )?.message || "",
        "changed after planning",
      );
    }
  });

  it("rejects a multi-collection proposal atomically when any target is outside the assigned union", async function () {
    const { service, directMembers } = createHarness();
    directMembers.set(11, [1, 2]);
    directMembers.set(12, [3, 4]);
    const contract = await service.createContract(
      requestWithIntents([tagIntent()], {
        selectedCollections: [11, 12],
      }),
    );
    const prepared = await service.prepare(mutationTool(), {
      operation: {
        type: "apply_tags",
        itemIds: [1, 3, 99],
        tags: ["topic:drift"],
      },
    });
    assert.deepEqual(
      (
        await service.validateScope(contract, prepared, {
          progress: service.createProgress(contract),
        })
      )?.rejectedTargets,
      ["item:99"],
    );
  });
  it("rejects remove and replace proposals for an add-tag obligation", async function () {
    const { service } = createHarness();
    const contract = await service.createContract(
      requestWithIntents([tagIntent()]),
    );
    for (const operation of [
      {
        type: "remove_tags" as const,
        itemIds: [1, 2, 3],
        tags: ["topic:drift"],
      },
      {
        type: "set_item_tags" as const,
        assignments: [1, 2, 3].map((itemId) => ({
          itemId,
          tags: ["topic:drift"],
        })),
      },
    ]) {
      const prepared = await service.prepare(mutationTool(), { operation });
      const rejection = await service.validateScope(contract, prepared);
      assert.include(rejection?.message || "", operation.type);
      assert.include(rejection?.message || "", "does not match");
    }
  });

  it("does not grant mutations when no action obligation exists", async function () {
    const { service } = createHarness();
    const contract = await service.createContract(
      requestWithIntents([], { disposition: "none" }),
    );
    contract.hardConstraints = [
      { kind: "no_write", description: "The user explicitly prohibited it." },
    ];
    const prepared = await service.prepare(mutationTool(), {
      operation: {
        type: "apply_tags",
        itemIds: [1],
        tags: ["topic:drift"],
      },
    });
    assert.equal(
      (await service.validateScope(contract, prepared))?.code,
      "different_operation",
    );
  });

  it("binds top-level and explicitly nested collection creation precisely", async function () {
    const { service } = createHarness();
    for (const testCase of [
      {
        collectionName: "ACV2 Methods",
        scope: {
          kind: "collection" as const,
          path: "ACV2 Methods",
          includeDescendants: false,
        },
        selectedCollection: 0,
        userText: 'Create top-level collection "ACV2 Methods".',
        expectedParentId: null,
      },
      {
        collectionName: "Methods",
        selectedCollection: 10,
        userText: 'Create a collection named "Methods" under this collection.',
        expectedParentId: 10,
      },
    ]) {
      const contract = await service.createContract(
        requestWithIntents(
          [
            {
              capability: "zotero.collections",
              operation: "create_collection",
              proofDomain: "zotero_state",
              coverage: "one",
              targetKind: "items",
              parameters: {
                collectionName: testCase.collectionName,
                parentCollectionId: testCase.expectedParentId,
              },
            },
          ],
          testCase,
        ),
      );

      const obligation = contract.obligations[0];
      assert.isUndefined(obligation.scope);
      assert.equal(
        obligation.parameters?.parentCollectionId,
        testCase.expectedParentId,
      );
    }
  });

  it("requires an explicit proposal when a mixed tool plans a concrete write", async function () {
    const { service } = createHarness();
    const contract = await service.createContract(
      requestWithIntents([tagIntent()]),
    );
    const prepared = await service.prepare(
      {
        ...mutationTool(),
        describeAction: () => [],
      },
      { mode: "write" },
    );

    assert.isNull(await service.validateScope(contract, prepared));
    assert.include(
      (
        await service.validateScope(contract, prepared, {
          concreteWrite: true,
        })
      )?.message || "",
      "did not produce a typed action proposal",
    );
  });

  it("blocks an exact metadata proposal without semantic mutation authority", async function () {
    const { service } = createHarness();
    const contract = await service.createContract(
      requestWithIntents([], {
        disposition: "none",
        userText: "Update item 42 title to Corrected title.",
      }),
    );
    const prepared = await service.prepare(
      {
        ...mutationTool(),
        describeAction: () => [
          {
            id: "update_metadata:item-42",
            proofDomain: "zotero_state",
            capability: "zotero.metadata",
            operation: "update_metadata",
            source: "zotero_native",
            parameters: { fields: { title: "Corrected title" } },
            requestedTargets: ["item:42"],
            destinationCollectionIds: [],
          },
        ],
      },
      { itemIds: [42], fields: { title: "Corrected title" } },
    );

    assert.equal(contract.writeDisposition, "none");
    assert.deepEqual(contract.hardConstraints, []);
    assert.isNotNull(
      await service.validateScope(contract, prepared, {
        concreteWrite: true,
      }),
    );
  });

  it("freezes exact direct membership and rejects sibling and partial targets", async function () {
    const { service } = createHarness();
    const contract = await service.createContract(
      requestWithIntents([tagIntent()]),
    );
    assert.deepEqual(
      contract.obligations[0].targetBoundary?.frozenTargetIds,
      [1, 2, 3],
    );
    assert.match(
      contract.obligations[0].targetBoundary?.scopeDigest || "",
      /^v1:/,
    );

    const widened = await service.prepare(mutationTool(), {
      operation: {
        type: "apply_tags",
        itemIds: [1, 2, 3, 50],
        tags: ["topic:drift"],
      },
    });
    assert.deepEqual(
      (await service.validateScope(contract, widened))?.rejectedTargets,
      ["item:50"],
    );

    const partial = await service.prepare(mutationTool(), {
      operation: {
        type: "apply_tags",
        itemIds: [1, 2],
        tags: ["topic:drift"],
      },
    });
    assert.deepEqual(
      (await service.validateScope(contract, partial))?.missingTargets,
      ["item:3"],
    );
  });

  it("freezes a whole-library obligation before the first write", async function () {
    const { service, items } = createHarness();
    for (const itemId of [1, 2, 3]) {
      items.set(itemId, { tags: [], collections: [], fields: {} });
    }
    const intent = { ...tagIntent(), scope: undefined };
    const contract = await service.createContract({
      ...requestWithIntents([intent], { selectedCollection: 0 }),
      libraryID: 1,
    });

    assert.equal(contract.obligations[0].targetBoundary?.kind, "library");
    assert.deepEqual(
      contract.obligations[0].targetBoundary?.frozenTargetIds,
      [1, 2, 3],
    );

    const widened = await service.prepare(mutationTool(), {
      operation: {
        type: "apply_tags",
        itemIds: [1, 2, 3, 50],
        tags: ["topic:drift"],
      },
    });
    assert.deepEqual(
      (await service.validateScope(contract, widened))?.rejectedTargets,
      ["item:50"],
    );

    const partial = await service.prepare(mutationTool(), {
      operation: {
        type: "apply_tags",
        itemIds: [1, 2],
        tags: ["topic:drift"],
      },
    });
    assert.deepEqual(
      (await service.validateScope(contract, partial))?.missingTargets,
      ["item:3"],
    );
  });

  it("revalidates frozen membership immediately before execution", async function () {
    const { service, directMembers } = createHarness();
    const contract = await service.createContract(
      requestWithIntents([tagIntent()]),
    );
    directMembers.set(11, [1, 2, 3, 4]);
    const operation: LibraryMutationOperation = {
      type: "apply_tags",
      itemIds: [1, 2, 3],
      tags: ["topic:drift"],
    };
    const prepared = await service.prepare(mutationTool(), { operation });
    assert.include(
      (await service.validateScope(contract, prepared))?.message || "",
      "changed after planning",
    );
    assert.equal(
      (await service.validateScope(contract, prepared))?.code,
      "stale_scope",
    );
  });

  it("returns a structured amendment candidate for an addition inside the same source", async function () {
    const { service, directMembers } = createHarness();
    const contract = await service.createContract(
      requestWithIntents([tagIntent()]),
    );
    directMembers.set(11, [1, 2, 3, 4]);
    const prepared = await service.prepare(mutationTool(), {
      operation: {
        type: "apply_tags",
        itemIds: [1, 2, 3, 4],
        tags: ["topic:drift"],
      },
    });

    const failure = await service.validateScope(contract, prepared);
    assert.equal(failure?.code, "added_target");
    assert.deepEqual(failure?.amendableObligation?.addedTargetIds, [4]);
    assert.deepEqual(
      failure?.amendableObligation?.currentTargetIds,
      [1, 2, 3, 4],
    );
    assert.equal(failure?.amendableObligation?.boundaryKind, "collection");
  });

  it("distinguishes a different operation, incomplete batch, and fixed selection", async function () {
    const { service } = createHarness();
    const contract = await service.createContract(
      requestWithIntents([tagIntent()]),
    );
    const different = await service.prepare(mutationTool(), {
      operation: {
        type: "remove_tags",
        itemIds: [1, 2, 3],
        tags: ["topic:drift"],
      },
    });
    assert.equal(
      (await service.validateScope(contract, different))?.code,
      "different_operation",
    );

    const partial = await service.prepare(mutationTool(), {
      operation: {
        type: "apply_tags",
        itemIds: [1, 2],
        tags: ["topic:drift"],
      },
    });
    assert.equal(
      (await service.validateScope(contract, partial))?.code,
      "incomplete_batch",
    );

    const selectionContract = {
      ...contract,
      obligations: contract.obligations.map((obligation) => ({
        ...obligation,
        scope: undefined,
        targetBoundary: obligation.targetBoundary
          ? { ...obligation.targetBoundary, kind: "selection" as const }
          : undefined,
      })),
    };
    const widened = await service.prepare(mutationTool(), {
      operation: {
        type: "apply_tags",
        itemIds: [1, 2, 3, 4],
        tags: ["topic:drift"],
      },
    });
    assert.equal(
      (await service.validateScope(selectionContract, widened))?.code,
      "fixed_selection",
    );
  });

  it("closes an add-tag obligation only after native state verifies every target", async function () {
    const { service, items } = createHarness();
    items.set(1, { tags: [], collections: [11], fields: {} });
    items.set(2, {
      tags: ["topic:drift"],
      collections: [11],
      fields: {},
    });
    items.set(3, { tags: [], collections: [11], fields: {} });
    const contract = await service.createContract(
      requestWithIntents([tagIntent()]),
    );
    const progress = service.createProgress(contract);
    const operation: LibraryMutationOperation = {
      type: "apply_tags",
      itemIds: [1, 2, 3],
      tags: ["topic:drift"],
    };
    const prepared = await service.prepare(mutationTool(), { operation });
    items.get(1)!.tags.push("topic:drift");
    items.get(3)!.tags.push("topic:drift");
    const receipts = await service.finalize(contract, prepared, {
      ok: true,
      effect: "partial",
      content: { actionId: "journal-1" },
      actionEvidence: mutationEvidence(
        operation,
        {
          version: 1,
          operation: "apply_tags",
          items: [
            { itemId: 1, exists: true, tags: [] },
            { itemId: 2, exists: true, tags: ["topic:drift"] },
            { itemId: 3, exists: true, tags: [] },
          ],
        },
        {
          version: 1,
          operation: "apply_tags",
          items: [1, 2, 3].map((itemId) => ({
            itemId,
            exists: true,
            tags: ["topic:drift"],
          })),
        },
        "journal-1:1",
        "partial",
      ),
    });
    service.applyReceipts(progress, receipts);
    assert.deepEqual(receipts[0].appliedTargets, [
      "item:1",
      "item:2",
      "item:3",
    ]);
    assert.deepEqual(receipts[0].alreadySatisfiedTargets, []);
    assert.equal(receipts[0].verification, "verified");
    assert.equal(
      evaluateActionContract(contract, receipts, progress).state,
      "satisfied",
    );
  });

  it("binds and verifies collection create, update, and delete result IDs", async function () {
    const { service, collections } = createHarness();
    const cases: Array<{
      intent: AgentActionIntent;
      operation: LibraryMutationOperation;
      mutate: () => unknown;
      preState: LibraryMutationState;
      postState: LibraryMutationState;
      journalStepId: string;
      target: string;
    }> = [
      {
        intent: {
          capability: "zotero.collections",
          operation: "create_collection",
          proofDomain: "zotero_state",
          coverage: "one",
          targetKind: "items",
          parameters: { collectionName: "Methods" },
        },
        operation: { type: "create_collection", name: "Methods", libraryID: 1 },
        mutate: () =>
          collections.set(20, {
            collectionId: 20,
            libraryID: 1,
            name: "Methods",
            path: "Methods",
            parentCollectionId: null,
            deleted: false,
          }),
        preState: { version: 1, operation: "create_collection" },
        postState: {
          version: 1,
          operation: "create_collection",
          collections: [
            {
              collectionId: 20,
              exists: true,
              name: "Methods",
              parentCollectionId: null,
              deleted: false,
            },
          ],
        },
        journalStepId: "journal-create:1",
        target: "collection:20",
      },
      {
        intent: {
          capability: "zotero.collections",
          operation: "update_collection",
          proofDomain: "zotero_state",
          coverage: "one",
          targetKind: "items",
          parameters: { collectionId: 12, collectionName: "Methods 2" },
        },
        operation: {
          type: "update_collection",
          collectionId: 12,
          name: "Methods 2",
        },
        mutate: () => {
          collections.get(12)!.name = "Methods 2";
        },
        preState: {
          version: 1,
          operation: "update_collection",
          collections: [
            {
              collectionId: 12,
              exists: true,
              name: "Sibling",
              parentCollectionId: 10,
              deleted: false,
            },
          ],
        },
        postState: {
          version: 1,
          operation: "update_collection",
          collections: [
            {
              collectionId: 12,
              exists: true,
              name: "Methods 2",
              parentCollectionId: 10,
              deleted: false,
            },
          ],
        },
        journalStepId: "journal-update:1",
        target: "collection:12",
      },
      {
        intent: {
          capability: "zotero.collections",
          operation: "delete_collection",
          proofDomain: "zotero_state",
          coverage: "one",
          targetKind: "items",
          parameters: { collectionId: 12 },
        },
        operation: { type: "delete_collection", collectionId: 12 },
        mutate: () => {
          collections.get(12)!.deleted = true;
        },
        preState: {
          version: 1,
          operation: "delete_collection",
          collections: [
            {
              collectionId: 12,
              exists: true,
              name: "Methods 2",
              parentCollectionId: 10,
              deleted: false,
            },
          ],
        },
        postState: {
          version: 1,
          operation: "delete_collection",
          collections: [
            {
              collectionId: 12,
              exists: true,
              name: "Methods 2",
              parentCollectionId: 10,
              deleted: true,
            },
          ],
        },
        journalStepId: "journal-delete:1",
        target: "collection:12",
      },
    ];
    for (const entry of cases) {
      const contract = await service.createContract(
        requestWithIntents([entry.intent], { selectedCollection: 0 }),
      );
      const prepared = await service.prepare(mutationTool(), {
        operation: entry.operation,
      });
      assert.isNull(await service.validateScope(contract, prepared));
      if (
        entry.operation.type === "update_collection" ||
        entry.operation.type === "delete_collection"
      ) {
        const wrongTarget = await service.prepare(mutationTool(), {
          operation: { ...entry.operation, collectionId: 11 },
        });
        assert.include(
          (await service.validateScope(contract, wrongTarget))?.message || "",
          "different parameters",
        );
      }
      entry.mutate();
      const receipts = await service.finalize(contract, prepared, {
        ok: true,
        effect: "applied",
        content: { actionId: entry.journalStepId.split(":")[0] },
        actionEvidence: mutationEvidence(
          entry.operation,
          entry.preState,
          entry.postState,
          entry.journalStepId,
        ),
      });
      assert.equal(receipts[0].verification, "verified");
      assert.deepEqual(receipts[0].appliedTargets, [entry.target]);
      assert.equal(
        evaluateActionContract(contract, receipts).state,
        "satisfied",
      );
    }
  });

  it("requires file readback identity and keeps execution proof separate", async function () {
    const { service } = createHarness();
    const fileTool: AgentToolDefinition<any, unknown> = {
      ...mutationTool(),
      describeAction: (input) => [
        {
          id: `file_write:${input.filePath}`,
          proofDomain: "file_state",
          capability: "file.write",
          operation: "file_write",
          source: "file_io",
          parameters: { filePath: input.filePath },
          requestedTargets: [`file:${input.filePath}`],
          destinationCollectionIds: [],
        },
      ],
    };
    const fileContract = await service.createContract(
      requestWithIntents(
        [
          {
            capability: "file.write",
            operation: "file_write",
            proofDomain: "file_state",
            coverage: "one",
            targetKind: "items",
            parameters: { filePath: "/tmp/acv2.md" },
          },
        ],
        { selectedCollection: 0 },
      ),
    );
    const preparedFile = await service.prepare(fileTool, {
      filePath: "/tmp/acv2.md",
    });
    const noReadback = await service.finalize(fileContract, preparedFile, {
      ok: true,
      effect: "applied",
      content: { filePath: "/tmp/acv2.md" },
    });
    assert.equal(noReadback[0].verification, "unverified");
    const verified = await service.finalize(fileContract, preparedFile, {
      ok: true,
      effect: "applied",
      content: {
        filePath: "/tmp/acv2.md",
        exists: true,
        expectedContentHash: "abc",
        contentHash: "abc",
      },
    });
    assert.equal(verified[0].verification, "verified");
    assert.equal(verified[0].evidenceRef, "sha256:abc");

    const command = await service.prepare(
      {
        ...mutationTool(),
        describeAction: () => [
          {
            id: "command:true",
            proofDomain: "execution",
            capability: "command.execute",
            operation: "command_execute",
            source: "command",
            requestedTargets: [],
            destinationCollectionIds: [],
          },
        ],
      },
      {},
    );
    assert.include(
      (await service.validateScope(fileContract, command))?.message || "",
      "does not match",
    );
  });

  for (const validParent of [true, false]) {
    it(
      validParent
        ? "closes a parent-paper note obligation using verified note identity and parent coverage"
        : "does not credit parent coverage when the created note belongs to a different paper",
      async function () {
        const { service, items } = createHarness();
        items.set(41, {
          tags: [],
          collections: [],
          fields: { title: "Paper" },
        });
        items.set(700, {
          tags: [],
          collections: [],
          fields: {},
          kind: "note",
          parentItemId: validParent ? 41 : 42,
          noteHtml: "<p>Grounded summary.</p>",
        });
        const request = requestWithIntents(
          [
            {
              capability: "zotero.notes",
              operation: "note_create",
              proofDomain: "zotero_state",
              coverage: "one",
              targetKind: "papers",
              scopeRole: "source",
              parameters: { noteMode: "create" },
            },
          ],
          { selectedCollection: 0, activeItemId: 41 },
        );
        request.classifiedIntent!.paperTargetIntent = "active";
        const contract = await service.createContract(request);
        assert.deepEqual(
          contract.obligations[0].targetBoundary?.frozenTargetIds,
          [41],
        );
        const progress = service.createProgress(contract);
        const prepared = await service.prepare(
          {
            ...mutationTool(),
            describeAction: () => [
              {
                id: "note-for-paper",
                proofDomain: "zotero_state",
                capability: "zotero.notes",
                operation: "note_create",
                source: "zotero_native",
                parameters: {
                  noteMode: "create",
                  targetItemId: 41,
                  expectedText: "Grounded summary.",
                },
                requestedTargets: ["item:41"],
                destinationCollectionIds: [],
              },
            ],
          },
          {},
        );
        assert.isNull(await service.validateScope(contract, prepared));
        const receipts = await service.finalize(contract, prepared, {
          ok: true,
          effect: "applied",
          content: { noteId: 700 },
        });
        service.applyReceipts(progress, receipts);
        assert.equal(
          evaluateActionContract(contract, receipts, progress).state,
          validParent ? "satisfied" : "unverified",
        );
        if (validParent) {
          assert.deepEqual(receipts[0].appliedTargets, ["item:41"]);
          assert.include(receipts[0].verifiedFacts, "created_note:item:700");
          assert.deepEqual(progress.obligations[0].unresolvedTargetIds, []);
        } else assert.deepEqual(receipts[0].appliedTargets, []);
      },
    );
  }

  async function noteWriteReceipt(params: {
    parameters: Record<string, unknown>;
    content: unknown;
    noteHtml: string;
  }) {
    const { service, items } = createHarness();
    items.set(41, { tags: [], collections: [], fields: { title: "Paper" } });
    items.set(700, {
      tags: [],
      collections: [],
      fields: {},
      kind: "note",
      parentItemId: 41,
      noteHtml: params.noteHtml,
    });
    const prepared = await service.prepare(
      {
        ...mutationTool(),
        describeAction: () => [
          {
            id: "note-for-paper",
            proofDomain: "zotero_state",
            capability: "zotero.notes",
            operation: "note_create",
            source: "zotero_native",
            parameters: params.parameters,
            requestedTargets: ["item:41"],
            destinationCollectionIds: [],
          },
        ],
      },
      {},
    );
    const receipts = await service.finalize(undefined, prepared, {
      ok: true,
      effect: "applied",
      content: params.content,
    });
    return receipts[0];
  }

  it("names the material and the native HTML digest on a material-backed note write", async function () {
    const html = "<p>Grounded summary.</p>";
    const receipt = await noteWriteReceipt({
      noteHtml: html,
      parameters: {
        noteMode: "create",
        targetItemId: 41,
        documentId: "doc-material-1",
        documentVersion: 2,
        contentHash: "sha256:frozen-content-hash",
      },
      content: {
        noteId: 700,
        noteVerification: {
          schemaVersion: 1,
          noteId: 700,
          matches: true,
          html,
          expectedHtml: html,
        },
      },
    });
    assert.deepEqual(receipt.materialRef, {
      documentId: "doc-material-1",
      documentVersion: 2,
      contentHash: "sha256:frozen-content-hash",
    });
    assert.equal(receipt.verification, "verified");
    assert.include(receipt.verifiedFacts, "created_note:item:700");
    assert.include(
      receipt.verifiedFacts,
      `native_note:700:html_sha256:${await sha256Text(html)}`,
    );
    assert.notInclude(receipt.verifiedFacts, "native_note:700:text_match");
  });

  it("leaves materialRef unset when the note write froze no material", async function () {
    const receipt = await noteWriteReceipt({
      noteHtml: "<p>Grounded summary.</p>",
      parameters: {
        noteMode: "create",
        targetItemId: 41,
        expectedText: "Grounded summary.",
      },
      content: { noteId: 700 },
    });
    assert.isUndefined(receipt.materialRef);
    assert.include(receipt.verifiedFacts, "created_note:item:700");
    assert.include(receipt.verifiedFacts, "native_note:700:text_match");
    assert.notInclude(receipt.verifiedFacts.join(" "), "html_sha256");
  });

  it("marks the weaker text-match evidence when no native note verification was produced", async function () {
    // The already-satisfied save of a document with embedded assets returns no
    // noteVerification, so the receipt must not claim native HTML evidence.
    const receipt = await noteWriteReceipt({
      noteHtml: "<p>Grounded summary.</p>",
      parameters: {
        noteMode: "create",
        targetItemId: 41,
        expectedText: "Grounded summary.",
        documentId: "doc-material-2",
        documentVersion: 3,
        contentHash: "sha256:asset-backed-hash",
      },
      content: { noteId: 700 },
    });
    assert.deepEqual(receipt.materialRef, {
      documentId: "doc-material-2",
      documentVersion: 3,
      contentHash: "sha256:asset-backed-hash",
    });
    assert.include(receipt.verifiedFacts, "native_note:700:text_match");
    assert.notInclude(receipt.verifiedFacts.join(" "), "html_sha256");
  });
  it("says which note of a batch could not be re-read at receipt time", async function () {
    // The whole-set postcondition is a claim about the set, so it can still
    // hold while one note the call physically wrote is gone by the time the
    // receipt re-reads it. Without a reason the only symptom is a missing
    // fact, which reads as "this note was never written". The write stays
    // applied -- the mutation window proved it -- but the receipt stops
    // vouching for the set, the way a single note write does.
    const html = "<p>Grounded summary.</p>";
    const { service, items } = createHarness();
    items.set(41, { tags: [], collections: [], fields: { title: "First" } });
    items.set(42, { tags: [], collections: [], fields: { title: "Second" } });
    items.set(700, {
      tags: [],
      collections: [],
      fields: {},
      kind: "note",
      parentItemId: 41,
      noteHtml: html,
    });
    items.set(701, {
      tags: [],
      collections: [],
      fields: {},
      kind: "note",
      parentItemId: 42,
      noteHtml: html,
      // Trashed between the write and the receipt.
      deleted: true,
    });
    const operation: LibraryMutationOperation = {
      type: "save_notes_batch",
      notes: [
        { targetItemId: 41, content: "Grounded summary." },
        { targetItemId: 42, content: "Grounded summary." },
      ],
    };
    const prepared = await service.prepare(mutationTool(), { operation });
    const postState: LibraryMutationState = {
      version: 1,
      operation: "save_notes_batch",
      items: [
        { itemId: 700, exists: true, parentItemId: 41, noteHtml: html },
        { itemId: 701, exists: true, parentItemId: 42, noteHtml: html },
      ],
    };
    const verificationFor = (noteId: number) => ({
      schemaVersion: 1,
      noteId,
      matches: true,
      html,
      expectedHtml: html,
    });
    const receipts = await service.finalize(undefined, prepared, {
      ok: true,
      effect: "applied",
      actionEvidence: [
        {
          ...mutationEvidence(
            operation,
            { version: 1, operation: "save_notes_batch", items: [] },
            postState,
            "journal-batch",
          )[0],
          noteWrites: [
            {
              noteId: 700,
              parentItemId: 41,
              verification: verificationFor(700),
            },
            {
              noteId: 701,
              parentItemId: 42,
              verification: verificationFor(701),
            },
          ],
        },
      ],
    });
    const receipt = receipts[0];
    assert.equal(
      receipt.verification,
      "unverified",
      "a receipt cannot vouch for a note its own re-read could not confirm",
    );
    assert.equal(
      receipt.status,
      "applied",
      "the captured post-state still proves the set landed",
    );
    assert.deepEqual(
      receipt.appliedTargets,
      receipt.requestedTargets,
      "the write is not retracted by the failed re-read",
    );
    assert.include(receipt.verifiedFacts, "created_note:item:700");
    assert.lengthOf(
      receipt.verifiedFacts.filter((fact) => fact.startsWith("native_note:")),
      1,
      "only the note that survived its re-read carries a content fact",
    );
    assert.notInclude(receipt.verifiedFacts.join(" "), "native_note:701:");
    assert.deepEqual(
      receipt.reasons.filter((reason) => reason.includes("701")),
      ["Zotero item 701 is not a live note after mutation."],
      "the receipt names the written note it could not re-read",
    );
  });

  it("closes Zotero-note and file-export obligations independently", async function () {
    const { service, items } = createHarness();
    items.set(700, {
      tags: [],
      collections: [],
      fields: {},
      noteHtml: "<h2>Summary</h2><p>Grounded body.</p>",
    });
    const contract = await service.createContract(
      requestWithIntents(
        [
          {
            capability: "zotero.notes",
            operation: "note_create",
            proofDomain: "zotero_state",
            coverage: "one",
            targetKind: "items",
            parameters: { noteMode: "create" },
          },
          {
            capability: "file.write",
            operation: "file_write",
            proofDomain: "file_state",
            coverage: "one",
            targetKind: "items",
            parameters: { filePath: "/tmp/mixed-note.md" },
          },
        ],
        { selectedCollection: 0 },
      ),
    );
    const notePrepared = await service.prepare(
      {
        ...mutationTool(),
        describeAction: () => [
          {
            id: "note_create:700",
            proofDomain: "zotero_state",
            capability: "zotero.notes",
            operation: "note_create",
            source: "zotero_native",
            parameters: {
              noteMode: "create",
              expectedText: "Grounded body.",
            },
            requestedTargets: [],
            destinationCollectionIds: [],
          },
        ],
      },
      {},
    );
    const noteReceipts = await service.finalize(contract, notePrepared, {
      ok: true,
      effect: "applied",
      content: { actionId: "note-step", result: { noteId: 700 } },
    });
    assert.equal(
      evaluateActionContract(contract, noteReceipts).state,
      "pending",
    );

    const filePrepared = await service.prepare(
      {
        ...mutationTool(),
        describeAction: () => [
          {
            id: "file_write:/tmp/mixed-note.md",
            proofDomain: "file_state",
            capability: "file.write",
            operation: "file_write",
            source: "file_io",
            parameters: { filePath: "/tmp/mixed-note.md" },
            requestedTargets: ["file:/tmp/mixed-note.md"],
            destinationCollectionIds: [],
          },
        ],
      },
      {},
    );
    const fileReceipts = await service.finalize(contract, filePrepared, {
      ok: true,
      effect: "applied",
      content: {
        filePath: "/tmp/mixed-note.md",
        exists: true,
        expectedContentHash: "mixed-hash",
        contentHash: "mixed-hash",
      },
    });
    assert.equal(
      evaluateActionContract(contract, fileReceipts).state,
      "pending",
    );
    assert.equal(
      evaluateActionContract(contract, [...noteReceipts, ...fileReceipts])
        .state,
      "satisfied",
    );
  });

  it("applies replayed receipts idempotently by obligation and journal identity", async function () {
    const { service, items } = createHarness();
    for (const itemId of [1, 2, 3]) {
      items.set(itemId, {
        tags: ["topic:drift"],
        collections: [11],
        fields: {},
      });
    }
    const contract = await service.createContract(
      requestWithIntents([tagIntent()]),
    );
    const progress = service.createProgress(contract);
    const prepared = await service.prepare(mutationTool(), {
      operation: {
        type: "apply_tags",
        itemIds: [1, 2, 3],
        tags: ["topic:drift"],
      },
    });
    const receipts = await service.finalize(contract, prepared, {
      ok: true,
      effect: "applied",
      content: { actionId: "journal-once" },
    });
    service.applyReceipts(progress, receipts);
    service.applyReceipts(progress, receipts);
    assert.lengthOf(progress.appliedReceiptKeys, 1);
    assert.deepEqual(progress.obligations[0].journalStepIds, ["journal-once"]);
  });

  it("treats cancellation as terminal without a corrective retry", async function () {
    const { service } = createHarness();
    const contract = await service.createContract(
      requestWithIntents([tagIntent()]),
    );
    const prepared = await service.prepare(mutationTool(), {
      operation: {
        type: "apply_tags",
        itemIds: [1, 2, 3],
        tags: ["topic:drift"],
      },
    });
    const receipts = await service.finalize(contract, prepared, {
      ok: false,
      cancelled: true,
      reason: "User denied action",
    });
    assert.equal(receipts[0].verification, "not_applicable");
    const evaluation = evaluateActionContract(contract, receipts);
    assert.equal(evaluation.state, "cancelled");
    assert.isUndefined(evaluation.correction);
  });

  it("keeps a verified success satisfied when a redundant retry is cancelled", async function () {
    const { service, items } = createHarness();
    for (const itemId of [1, 2, 3]) {
      items.set(itemId, {
        tags: ["topic:drift"],
        collections: [11],
        fields: {},
      });
    }
    const contract = await service.createContract(
      requestWithIntents([tagIntent()]),
    );
    const operation: LibraryMutationOperation = {
      type: "apply_tags",
      itemIds: [1, 2, 3],
      tags: ["topic:drift"],
    };
    const prepared = await service.prepare(mutationTool(), { operation });
    const satisfiedState: LibraryMutationState = {
      version: 1,
      operation: "apply_tags",
      items: [1, 2, 3].map((itemId) => ({
        itemId,
        exists: true,
        tags: ["topic:drift"],
      })),
    };
    const success = await service.finalize(contract, prepared, {
      ok: true,
      effect: "none",
      content: { actionId: "journal-success" },
      actionEvidence: mutationEvidence(
        operation,
        satisfiedState,
        satisfiedState,
        "journal-success:1",
        "none",
      ),
    });
    const cancelled = await service.finalize(contract, prepared, {
      ok: false,
      cancelled: true,
      reason: "User denied redundant action",
    });
    const progress = service.createProgress(contract);
    service.applyReceipts(progress, success);
    service.applyReceipts(progress, cancelled);
    assert.equal(progress.obligations[0].status, "already_satisfied");
    const duplicate = await service.validateScope(contract, prepared, {
      progress,
    });
    assert.include(duplicate?.message || "", "already verified");
    assert.equal(
      evaluateActionContract(contract, [...success, ...cancelled], progress)
        .state,
      "satisfied",
    );
  });
});

/**
 * Every receipt the finalize path mints for a write whose proof is not a
 * library mutation operation, pinned whole.
 *
 * These branches are being consolidated onto one evidence record, and the only
 * way to show that a consolidation changed nothing is to have written down
 * beforehand every field the branch produced — not just its verification.
 * Each case therefore asserts the entire receipt with `deepEqual`.
 */
describe("Bespoke finalize-branch receipts", function () {
  async function receiptFor(params: {
    harness: ReturnType<typeof createHarness>;
    proposal: AgentToolActionDescriptor;
    content?: unknown;
    effect?: AgentToolEffect;
    ok?: boolean;
    actionEvidence?: AgentActionEvidence[];
  }) {
    const prepared = await params.harness.service.prepare(
      { ...mutationTool(), describeAction: () => [params.proposal] },
      {},
    );
    const receipts = await params.harness.service.finalize(
      undefined,
      prepared,
      {
        ok: params.ok ?? true,
        effect: params.effect ?? "applied",
        content: params.content,
        actionEvidence: params.actionEvidence,
      },
    );
    assert.lengthOf(receipts, 1);
    return receipts[0];
  }

  describe("note_write", function () {
    const html = "<p>Grounded summary.</p>";

    function noteHarness(parentItemId = 41) {
      const harness = createHarness();
      harness.items.set(41, {
        tags: [],
        collections: [],
        fields: { title: "Paper" },
      });
      harness.items.set(700, {
        tags: [],
        collections: [],
        fields: {},
        kind: "note",
        parentItemId,
        noteHtml: html,
      });
      return harness;
    }

    function noteProposal(
      operation: "note_create" | "note_edit" | "note_append",
      parameters: Record<string, unknown>,
      requestedTargets: string[],
    ): AgentToolActionDescriptor {
      return {
        id: `${operation}:700`,
        proofDomain: "zotero_state",
        capability: "zotero.notes",
        operation,
        source: "zotero_native",
        parameters,
        requestedTargets,
        destinationCollectionIds: [],
      };
    }

    it("credits the parent paper and names the native HTML digest on a created note", async function () {
      const parameters = {
        noteMode: "create",
        targetItemId: 41,
        documentId: "doc-material-1",
        documentVersion: 2,
        contentHash: "sha256:frozen-content-hash",
      };
      const receipt = await receiptFor({
        harness: noteHarness(),
        proposal: noteProposal("note_create", parameters, ["item:41"]),
        content: {
          actionId: "action-note-1",
          noteId: 700,
          noteVerification: {
            schemaVersion: 1,
            noteId: 700,
            matches: true,
            html,
            expectedHtml: html,
          },
        },
      });
      assert.deepEqual(receipt, {
        version: 2,
        id: "note_create:700:unmatched:action-note-1",
        obligationId: undefined,
        proposalId: "note_create:700",
        proofDomain: "zotero_state",
        capability: "zotero.notes",
        operation: "note_create",
        requestedTargets: ["item:41"],
        rejectedTargets: [],
        normalizedParameters: parameters,
        reasons: [],
        verifiedFacts: [
          "created_note:item:700",
          `native_note:700:html_sha256:${await sha256Text(html)}`,
        ],
        materialRef: {
          documentId: "doc-material-1",
          documentVersion: 2,
          contentHash: "sha256:frozen-content-hash",
        },
        evidenceRef: "action-note-1",
        verification: "verified",
        status: "applied",
        appliedTargets: ["item:41"],
        alreadySatisfiedTargets: [],
      });
    });

    it("marks a no-effect create already satisfied on the weaker text match", async function () {
      const parameters = {
        noteMode: "create",
        targetItemId: 41,
        expectedText: "Grounded summary.",
      };
      const receipt = await receiptFor({
        harness: noteHarness(),
        proposal: noteProposal("note_create", parameters, ["item:41"]),
        content: { noteId: 700 },
        effect: "none",
      });
      assert.deepEqual(receipt, {
        version: 2,
        id: "note_create:700:unmatched:result",
        obligationId: undefined,
        proposalId: "note_create:700",
        proofDomain: "zotero_state",
        capability: "zotero.notes",
        operation: "note_create",
        requestedTargets: ["item:41"],
        rejectedTargets: [],
        normalizedParameters: parameters,
        reasons: [],
        verifiedFacts: ["created_note:item:700", "native_note:700:text_match"],
        materialRef: undefined,
        evidenceRef: undefined,
        verification: "verified",
        status: "already_satisfied",
        appliedTargets: [],
        alreadySatisfiedTargets: ["item:41"],
      });
    });

    for (const operation of ["note_edit", "note_append"] as const) {
      it(`covers the note itself on a verified ${operation}`, async function () {
        const parameters = {
          noteMode: operation === "note_edit" ? "edit" : "append",
          targetNoteId: 700,
          expectedText: "Grounded summary.",
        };
        const receipt = await receiptFor({
          harness: noteHarness(),
          proposal: noteProposal(operation, parameters, ["item:700"]),
          content: { noteId: 700 },
        });
        assert.deepEqual(receipt, {
          version: 2,
          id: `${operation}:700:unmatched:result`,
          obligationId: undefined,
          proposalId: `${operation}:700`,
          proofDomain: "zotero_state",
          capability: "zotero.notes",
          operation,
          requestedTargets: ["item:700"],
          rejectedTargets: [],
          normalizedParameters: parameters,
          reasons: [],
          verifiedFacts: ["native_note:700:text_match"],
          materialRef: undefined,
          evidenceRef: undefined,
          verification: "verified",
          status: "applied",
          appliedTargets: ["item:700"],
          alreadySatisfiedTargets: [],
        });
      });
    }

    const noteFailures: Array<{
      name: string;
      parentItemId?: number;
      content: unknown;
      reason: string;
    }> = [
      {
        name: "the result names no note",
        content: {},
        reason: "The note mutation returned no stable note ID to verify.",
      },
      {
        name: "the created note hangs off another paper",
        parentItemId: 42,
        content: { noteId: 700 },
        reason: "Created note 700 is not attached to requested item 41.",
      },
      {
        name: "the native read-back does not prove the prepared change",
        content: {
          noteId: 700,
          noteVerification: {
            schemaVersion: 1,
            noteId: 700,
            matches: false,
            html,
            expectedHtml: html,
          },
        },
        reason:
          "The native note evidence does not prove the prepared change on the bound note.",
      },
    ];

    for (const failure of noteFailures) {
      it(`leaves the receipt unverified when ${failure.name}`, async function () {
        const parameters = { noteMode: "create", targetItemId: 41 };
        const receipt = await receiptFor({
          harness: noteHarness(failure.parentItemId),
          proposal: noteProposal("note_create", parameters, ["item:41"]),
          content: failure.content,
        });
        assert.deepEqual(receipt, {
          version: 2,
          id: "note_create:700:unmatched:result",
          obligationId: undefined,
          proposalId: "note_create:700",
          proofDomain: "zotero_state",
          capability: "zotero.notes",
          operation: "note_create",
          requestedTargets: ["item:41"],
          rejectedTargets: [],
          normalizedParameters: parameters,
          reasons: [failure.reason],
          verifiedFacts: [],
          materialRef: undefined,
          evidenceRef: undefined,
          verification: "unverified",
          status: "unverified",
          appliedTargets: [],
          alreadySatisfiedTargets: [],
        });
      });
    }
  });

  describe("library_settings", function () {
    function settingsProposal(
      settingsValue: string,
    ): AgentToolActionDescriptor {
      return {
        id: "settings_update:automaticTags",
        proofDomain: "zotero_state",
        capability: "zotero.settings",
        operation: "settings_update",
        source: "zotero_native",
        parameters: { settingsKey: "automaticTags", settingsValue },
        requestedTargets: ["setting:automaticTags"],
        destinationCollectionIds: [],
      };
    }

    /**
     * The record `library_settings` attaches in production: the preference as
     * the plan found it, as the write recorded it, and as the user authorized
     * it.
     */
    function settingsEvidence(params: {
      previous?: unknown;
      recorded: unknown;
      authorized: unknown;
    }): AgentActionEvidence[] {
      return [
        {
          version: 1,
          source: "external_mutation",
          operation: "update_preference",
          preImage: {
            kind: "preference",
            key: "automaticTags",
            existed: params.previous !== undefined,
            value: params.previous,
          },
          postImage: {
            kind: "preference",
            key: "automaticTags",
            existed: true,
            value: params.recorded,
          },
          authorizedPostImage: {
            kind: "preference",
            key: "automaticTags",
            existed: true,
            value: params.authorized,
          },
          journalStepId: "settings-action:1",
          effect: "applied",
        },
      ];
    }

    const UNVERIFIED_REASON =
      "This update_preference write could not be verified: live Zotero state " +
      "does not hold what this write was authorized to produce.";

    function settingsReceipt(params: {
      verification: "verified" | "unverified";
      status: "applied" | "already_satisfied" | "unverified";
      settingsValue: string;
      appliedTargets: string[];
      alreadySatisfiedTargets: string[];
      rejectedTargets: string[];
    }) {
      return {
        version: 2,
        id: "settings_update:automaticTags:unmatched:result",
        obligationId: undefined,
        proposalId: "settings_update:automaticTags",
        proofDomain: "zotero_state",
        capability: "zotero.settings",
        operation: "settings_update",
        requestedTargets: ["setting:automaticTags"],
        rejectedTargets: params.rejectedTargets,
        normalizedParameters: {
          settingsKey: "automaticTags",
          settingsValue: params.settingsValue,
        },
        // Two fields moved when this operation joined the generic evidence
        // path, and only these two: an unverified receipt now says why, and
        // the receipt names the durable step rather than its action, as every
        // library-mutation receipt already did.
        reasons: params.verification === "verified" ? [] : [UNVERIFIED_REASON],
        verifiedFacts: [],
        materialRef: undefined,
        evidenceRef: "settings-action:1",
        verification: params.verification,
        status: params.status,
        appliedTargets: params.appliedTargets,
        alreadySatisfiedTargets: params.alreadySatisfiedTargets,
      };
    }

    it("verifies a preference the native state now holds", async function () {
      const harness = createHarness();
      harness.settings.set("automaticTags", true);
      const receipt = await receiptFor({
        harness,
        proposal: settingsProposal(JSON.stringify(true)),
        actionEvidence: settingsEvidence({
          previous: false,
          recorded: true,
          authorized: true,
        }),
      });
      assert.deepEqual(
        receipt,
        settingsReceipt({
          verification: "verified",
          status: "applied",
          settingsValue: "true",
          appliedTargets: ["setting:automaticTags"],
          alreadySatisfiedTargets: [],
          rejectedTargets: [],
        }),
      );
    });

    it("reports a no-effect set as already satisfied", async function () {
      const harness = createHarness();
      harness.settings.set("automaticTags", true);
      const receipt = await receiptFor({
        harness,
        proposal: settingsProposal(JSON.stringify(true)),
        effect: "none",
        actionEvidence: settingsEvidence({
          previous: true,
          recorded: true,
          authorized: true,
        }),
      });
      assert.deepEqual(
        receipt,
        settingsReceipt({
          verification: "verified",
          status: "already_satisfied",
          settingsValue: "true",
          appliedTargets: [],
          alreadySatisfiedTargets: ["setting:automaticTags"],
          rejectedTargets: [],
        }),
      );
    });

    it("refuses a preference whose native value is not the authorized one", async function () {
      const harness = createHarness();
      harness.settings.set("automaticTags", false);
      const receipt = await receiptFor({
        harness,
        proposal: settingsProposal(JSON.stringify(true)),
        actionEvidence: settingsEvidence({
          previous: false,
          recorded: true,
          authorized: true,
        }),
      });
      assert.deepEqual(
        receipt,
        settingsReceipt({
          verification: "unverified",
          status: "unverified",
          settingsValue: "true",
          appliedTargets: [],
          alreadySatisfiedTargets: [],
          rejectedTargets: ["setting:automaticTags"],
        }),
      );
    });

    it("refuses a preference that is not set at all", async function () {
      const receipt = await receiptFor({
        harness: createHarness(),
        proposal: settingsProposal(JSON.stringify(true)),
        actionEvidence: settingsEvidence({ recorded: true, authorized: true }),
      });
      assert.deepEqual(
        receipt,
        settingsReceipt({
          verification: "unverified",
          status: "unverified",
          settingsValue: "true",
          appliedTargets: [],
          alreadySatisfiedTargets: [],
          rejectedTargets: ["setting:automaticTags"],
        }),
      );
    });

    it("refuses a native value that only matches the request after coercion", async function () {
      // The proposal froze the literal argument; the gateway writes a coerced
      // one. The receipt compares against what the user authorized, so a
      // string "true" written as boolean true is not proof of that request.
      const harness = createHarness();
      harness.settings.set("automaticTags", true);
      const receipt = await receiptFor({
        harness,
        proposal: settingsProposal(JSON.stringify("true")),
        // The gateway coerces "true" to the boolean the preference holds, and
        // records that. Only the authorized literal refuses it.
        actionEvidence: settingsEvidence({
          previous: false,
          recorded: true,
          authorized: "true",
        }),
      });
      assert.deepEqual(
        receipt,
        settingsReceipt({
          verification: "unverified",
          status: "unverified",
          settingsValue: '"true"',
          appliedTargets: [],
          alreadySatisfiedTargets: [],
          rejectedTargets: ["setting:automaticTags"],
        }),
      );
    });
  });

  describe("annotate_pdf", function () {
    const expectedAnnotation = {
      text: "A full quotation.",
      comment: "Core result",
      color: "#ffd400",
      pageLabel: "2",
      sortIndex: "00001|000000|00020",
      position: { pageIndex: 1, rects: [[20, 40, 90, 50]] },
      source: { documentFingerprint: "fixture", startChar: 0, endChar: 17 },
    };
    function annotationHarness(params: {
      annotationParent?: number;
      isAnnotation?: boolean;
    }) {
      const harness = createHarness();
      harness.items.set(900, {
        tags: [],
        collections: [],
        fields: {},
        kind: "attachment",
      });
      harness.items.set(901, {
        tags: [],
        collections: [],
        fields: {},
        annotationFields: {
          annotationType: "highlight",
          annotationText: expectedAnnotation.text,
          annotationComment: expectedAnnotation.comment,
          annotationColor: expectedAnnotation.color,
          annotationPageLabel: expectedAnnotation.pageLabel,
          annotationSortIndex: expectedAnnotation.sortIndex,
          annotationPosition: JSON.stringify(expectedAnnotation.position),
        },
        kind: params.isAnnotation === false ? "note" : "annotation",
        parentItemId: params.annotationParent ?? 900,
      });
      return harness;
    }

    const annotationProposal: AgentToolActionDescriptor = {
      id: "annotation_write:900:1",
      proofDomain: "zotero_state",
      capability: "zotero.annotations",
      operation: "annotation_write",
      source: "zotero_native",
      parameters: {
        targetItemId: 900,
        pageIndex: 1,
        expectedText: expectedAnnotation.text,
        annotationColor: expectedAnnotation.color,
        annotationComment: expectedAnnotation.comment,
      },
      requestedTargets: ["item:900"],
      destinationCollectionIds: [],
    };

    function annotationReceipt(params: {
      verification: "verified" | "unverified";
      status: "applied" | "unverified";
      target: string;
      appliedTargets: string[];
      rejectedTargets: string[];
    }) {
      return {
        version: 2,
        id: "annotation_write:900:1:unmatched:result",
        obligationId: undefined,
        proposalId: "annotation_write:900:1",
        proofDomain: "zotero_state",
        capability: "zotero.annotations",
        operation: "annotation_write",
        requestedTargets: [params.target],
        rejectedTargets: params.rejectedTargets,
        normalizedParameters: annotationProposal.parameters,
        reasons: [],
        verifiedFacts: [],
        materialRef: undefined,
        evidenceRef: undefined,
        verification: params.verification,
        status: params.status,
        appliedTargets: params.appliedTargets,
        alreadySatisfiedTargets: [],
      };
    }

    it("retargets the receipt onto the annotation Zotero committed", async function () {
      const receipt = await receiptFor({
        harness: annotationHarness({}),
        proposal: annotationProposal,
        content: { annotationId: 901, expectedAnnotation },
      });
      assert.deepEqual(
        receipt,
        annotationReceipt({
          verification: "verified",
          status: "applied",
          target: "item:901",
          appliedTargets: ["item:901"],
          rejectedTargets: [],
        }),
      );
    });

    it("refuses wrong native content or geometry even under the correct attachment", async function () {
      for (const [field, value] of Object.entries({
        annotationText: "Wrong quotation",
        annotationComment: "Wrong comment",
        annotationColor: "#ff6666",
        annotationPageLabel: "9",
        annotationPosition: JSON.stringify({
          pageIndex: 1,
          rects: [[0, 0, 1, 1]],
        }),
      })) {
        const harness = annotationHarness({});
        harness.items.get(901)!.annotationFields![field] = value;
        const receipt = await receiptFor({
          harness,
          proposal: annotationProposal,
          content: { annotationId: 901, expectedAnnotation },
        });
        assert.equal(receipt.verification, "unverified", field);
      }
    });
    it("credits an existing matching annotation as already satisfied", async function () {
      const receipt = await receiptFor({
        harness: annotationHarness({}),
        proposal: annotationProposal,
        content: { annotationId: 901, expectedAnnotation },
        effect: "none",
      });
      assert.equal(receipt.status, "already_satisfied");
      assert.deepEqual(receipt.alreadySatisfiedTargets, ["item:901"]);
      assert.isEmpty(receipt.appliedTargets);
    });

    it("falls back to the requested attachment when no annotation ID came back", async function () {
      const receipt = await receiptFor({
        harness: annotationHarness({}),
        proposal: annotationProposal,
        content: {},
      });
      assert.deepEqual(
        receipt,
        annotationReceipt({
          verification: "unverified",
          status: "unverified",
          target: "item:900",
          appliedTargets: [],
          rejectedTargets: ["item:900"],
        }),
      );
    });

    it("refuses an annotation that belongs to another attachment", async function () {
      const receipt = await receiptFor({
        harness: annotationHarness({ annotationParent: 902 }),
        proposal: annotationProposal,
        content: { annotationId: 901, expectedAnnotation },
      });
      assert.deepEqual(
        receipt,
        annotationReceipt({
          verification: "unverified",
          status: "unverified",
          target: "item:901",
          appliedTargets: [],
          rejectedTargets: ["item:901"],
        }),
      );
    });

    it("refuses an item that is not an annotation", async function () {
      const receipt = await receiptFor({
        harness: annotationHarness({ isAnnotation: false }),
        proposal: annotationProposal,
        content: { annotationId: 901, expectedAnnotation },
      });
      assert.deepEqual(
        receipt,
        annotationReceipt({
          verification: "unverified",
          status: "unverified",
          target: "item:901",
          appliedTargets: [],
          rejectedTargets: ["item:901"],
        }),
      );
    });
  });

  describe("an external write with no operation-specific verifier", function () {
    // The consolidation target: a Zotero write that carries no library
    // mutation operation and no branch of its own is verified from the record
    // the mutation boundary attached, by re-reading its post-image now.
    const proposal: AgentToolActionDescriptor = {
      id: "save_note:700",
      proofDomain: "zotero_state",
      capability: "zotero.notes",
      operation: "save_note",
      source: "zotero_native",
      requestedTargets: ["item:700"],
      destinationCollectionIds: [],
    };

    function preferenceImage(value: unknown) {
      return {
        kind: "preference",
        key: "automaticTags",
        existed: true,
        value,
      };
    }

    function preferenceEvidence(params: {
      recorded: unknown;
      authorized?: unknown;
    }): AgentActionEvidence[] {
      return [
        {
          version: 1,
          source: "external_mutation",
          operation: "update_preference",
          preImage: {
            kind: "preference",
            key: "automaticTags",
            existed: false,
            value: undefined,
          },
          postImage: preferenceImage(params.recorded),
          ...("authorized" in params
            ? { authorizedPostImage: preferenceImage(params.authorized) }
            : {}),
          journalStepId: "action-ext:1",
          effect: "applied",
        },
      ];
    }

    async function receiptWith(params: {
      harness: ReturnType<typeof createHarness>;
      actionEvidence?: AgentActionEvidence[];
      effect?: AgentToolEffect;
    }) {
      const prepared = await params.harness.service.prepare(
        { ...mutationTool(), describeAction: () => [proposal] },
        {},
      );
      const receipts = await params.harness.service.finalize(
        undefined,
        prepared,
        {
          ok: true,
          effect: params.effect ?? "applied",
          content: {},
          actionEvidence: params.actionEvidence,
        },
      );
      return receipts[0];
    }

    it("verifies the write when live state still holds its post-image", async function () {
      const harness = createHarness();
      harness.settings.set("automaticTags", true);
      const receipt = await receiptWith({
        harness,
        actionEvidence: preferenceEvidence({ recorded: true }),
      });
      assert.equal(receipt.verification, "verified");
      assert.equal(receipt.status, "applied");
      assert.deepEqual(receipt.appliedTargets, ["item:700"]);
      assert.deepEqual(receipt.reasons, []);
      assert.equal(receipt.evidenceRef, "action-ext:1");
    });

    it("reports a write whose post-image no longer reads back", async function () {
      const harness = createHarness();
      harness.settings.set("automaticTags", false);
      const receipt = await receiptWith({
        harness,
        actionEvidence: preferenceEvidence({ recorded: true }),
      });
      assert.equal(receipt.verification, "unverified");
      assert.equal(receipt.status, "unverified");
      assert.deepEqual(receipt.rejectedTargets, ["item:700"]);
      assert.match(
        receipt.reasons.join(" "),
        /This update_preference write could not be verified: live Zotero state no longer matches what this write recorded when it applied/,
      );
    });

    it("credits a no-effect write as already satisfied", async function () {
      const harness = createHarness();
      harness.settings.set("automaticTags", true);
      const receipt = await receiptWith({
        harness,
        actionEvidence: preferenceEvidence({ recorded: true }),
        effect: "none",
      });
      assert.equal(receipt.verification, "verified");
      assert.equal(receipt.status, "already_satisfied");
      assert.deepEqual(receipt.alreadySatisfiedTargets, ["item:700"]);
    });

    it("credits the authorized image, not the one the tool recorded", async function () {
      // The tool wrote a coerced value and recorded that. The user authorized
      // the literal, so the receipt must compare live state against the
      // literal: a write that landed as something else is not the change the
      // user approved, however faithfully the tool recorded it.
      const harness = createHarness();
      harness.settings.set("automaticTags", true);
      const receipt = await receiptWith({
        harness,
        actionEvidence: preferenceEvidence({
          recorded: true,
          authorized: "true",
        }),
      });
      assert.equal(receipt.verification, "unverified");
      assert.match(
        receipt.reasons.join(" "),
        /live Zotero state does not hold what this write was authorized to produce/,
      );
    });

    it("verifies when live state holds the authorized image", async function () {
      const harness = createHarness();
      harness.settings.set("automaticTags", true);
      const receipt = await receiptWith({
        harness,
        actionEvidence: preferenceEvidence({
          recorded: true,
          authorized: true,
        }),
      });
      assert.equal(receipt.verification, "verified");
      assert.equal(receipt.status, "applied");
    });

    it("cannot read a captured library state back, and says so", async function () {
      // A library-operation post-image needs the mutation handlers and the
      // operation it was captured for; that evidence belongs on the library
      // branch, which carries both. Reaching this branch with one must read as
      // "could not check", never as agreement.
      const receipt = await receiptWith({
        harness: createHarness(),
        actionEvidence: [
          {
            version: 1,
            source: "external_mutation",
            operation: "create_pdf_annotation",
            postImage: {
              version: 1,
              operation: "trash_items",
              items: [{ itemId: 901, exists: true, deleted: false }],
            },
            journalStepId: "action-ext:1",
            effect: "applied",
          },
        ],
      });
      assert.equal(receipt.verification, "unverified");
      assert.match(
        receipt.reasons.join(" "),
        /could not be verified: the recorded post-image format cannot be read back by this version/,
      );
    });

    it("refuses a write that attached no evidence at all", async function () {
      const receipt = await receiptWith({ harness: createHarness() });
      assert.equal(receipt.verification, "unverified");
      assert.deepEqual(receipt.reasons, [
        "No native Zotero post-state verifier is registered for this action.",
      ]);
    });

    it("refuses to pick one record out of a multi-step result", async function () {
      // A multi-file export journals one step per file. Matching the first
      // would credit the whole receipt with one member's proof.
      const harness = createHarness();
      harness.settings.set("automaticTags", true);
      const receipt = await receiptWith({
        harness,
        actionEvidence: [
          ...preferenceEvidence({ recorded: true }),
          ...preferenceEvidence({ recorded: true }),
        ],
      });
      assert.equal(receipt.verification, "unverified");
      assert.deepEqual(receipt.reasons, [
        "No native Zotero post-state verifier is registered for this action.",
      ]);
    });
  });

  describe("undo and revert", function () {
    const undoProposal: AgentToolActionDescriptor = {
      id: "undo:action-7",
      proofDomain: "zotero_state",
      capability: "zotero.undo",
      operation: "undo",
      source: "zotero_native",
      requestedTargets: ["journal-action:action-7"],
      destinationCollectionIds: [],
    };

    it("verifies an undo whose every replayed step re-read as matched", async function () {
      const receipt = await receiptFor({
        harness: createHarness(),
        proposal: undoProposal,
        content: {
          status: "undone",
          actionId: "action-7",
          actionIds: ["action-7"],
          revertedSteps: [
            { actionId: "action-7", sequence: 1, verification: "matched" },
          ],
        },
      });
      assert.deepEqual(receipt, {
        version: 2,
        id: "undo:action-7:unmatched:action-7",
        obligationId: undefined,
        proposalId: "undo:action-7",
        proofDomain: "zotero_state",
        capability: "zotero.undo",
        operation: "undo",
        requestedTargets: ["journal-action:action-7"],
        rejectedTargets: [],
        normalizedParameters: undefined,
        reasons: [],
        verifiedFacts: ["reverted_step:action-7:1:matched"],
        materialRef: undefined,
        evidenceRef: "action-7",
        verification: "verified",
        status: "applied",
        appliedTargets: ["journal-action:action-7"],
        alreadySatisfiedTargets: [],
      });
    });

    it("refuses an undo whose step re-read as mismatched", async function () {
      const receipt = await receiptFor({
        harness: createHarness(),
        proposal: undoProposal,
        content: {
          status: "undone",
          actionId: "action-7",
          actionIds: ["action-7"],
          revertedSteps: [
            {
              actionId: "action-7",
              sequence: 1,
              verification: "mismatched",
              reason: "the note changed again",
            },
          ],
        },
      });
      assert.deepEqual(receipt, {
        version: 2,
        id: "undo:action-7:unmatched:action-7",
        obligationId: undefined,
        proposalId: "undo:action-7",
        proofDomain: "zotero_state",
        capability: "zotero.undo",
        operation: "undo",
        requestedTargets: ["journal-action:action-7"],
        rejectedTargets: ["journal-action:action-7"],
        normalizedParameters: undefined,
        reasons: [
          "Reverted step 1 of action-7 re-read as mismatched: the note changed again.",
        ],
        verifiedFacts: [],
        materialRef: undefined,
        evidenceRef: "action-7",
        verification: "unverified",
        status: "unverified",
        appliedTargets: [],
        alreadySatisfiedTargets: [],
      });
    });
  });

  describe("file_io and execution", function () {
    const fileProposal: AgentToolActionDescriptor = {
      id: "file_write:/tmp/report.md",
      proofDomain: "file_state",
      capability: "file.write",
      operation: "file_write",
      source: "file_io",
      parameters: { filePath: "/tmp/report.md" },
      requestedTargets: ["file:/tmp/report.md"],
      destinationCollectionIds: [],
      expectedContentHash: "abc",
      expectedFiles: [
        { path: "/tmp/report.md", contentHash: "abc", byteLength: 12 },
      ],
    };

    it("verifies a file write from its readback identity", async function () {
      const receipt = await receiptFor({
        harness: createHarness(),
        proposal: fileProposal,
        content: {
          filePath: "/tmp/report.md",
          exists: true,
          contentHash: "abc",
          exportedFiles: [
            {
              filePath: "/tmp/report.md",
              exists: true,
              contentHash: "abc",
              bytesWritten: 12,
            },
          ],
        },
      });
      assert.deepEqual(receipt, {
        version: 2,
        id: "file_write:/tmp/report.md:unmatched:result:sha256:abc",
        obligationId: undefined,
        proposalId: "file_write:/tmp/report.md",
        proofDomain: "file_state",
        capability: "file.write",
        operation: "file_write",
        requestedTargets: ["file:/tmp/report.md"],
        rejectedTargets: [],
        normalizedParameters: { filePath: "/tmp/report.md" },
        reasons: [],
        verifiedFacts: ["/tmp/report.md:sha256:abc"],
        materialRef: undefined,
        evidenceRef: "sha256:abc",
        verification: "verified",
        status: "applied",
        appliedTargets: ["file:/tmp/report.md"],
        alreadySatisfiedTargets: [],
      });
    });

    it("refuses a file write that was never read back", async function () {
      const receipt = await receiptFor({
        harness: createHarness(),
        proposal: fileProposal,
        content: { filePath: "/tmp/report.md" },
      });
      assert.deepEqual(receipt, {
        version: 2,
        id: "file_write:/tmp/report.md:unmatched:result:unverified",
        obligationId: undefined,
        proposalId: "file_write:/tmp/report.md",
        proofDomain: "file_state",
        capability: "file.write",
        operation: "file_write",
        requestedTargets: ["file:/tmp/report.md"],
        rejectedTargets: [],
        normalizedParameters: { filePath: "/tmp/report.md" },
        reasons: [
          "The written file was not read back with an exact path and content hash.",
        ],
        verifiedFacts: [],
        materialRef: undefined,
        evidenceRef: undefined,
        verification: "unverified",
        status: "unverified",
        appliedTargets: [],
        alreadySatisfiedTargets: [],
      });
    });

    const commandProposal: AgentToolActionDescriptor = {
      id: "command_execute:fp",
      proofDomain: "execution",
      capability: "command.execute",
      operation: "command_execute",
      source: "command",
      parameters: { commandFingerprint: "fp" },
      requestedTargets: [],
      destinationCollectionIds: [],
    };

    it("keeps a command with no re-readable state at execution_only", async function () {
      const receipt = await receiptFor({
        harness: createHarness(),
        proposal: commandProposal,
        content: { exitCode: 0 },
      });
      assert.deepEqual(receipt, {
        version: 2,
        id: "command_execute:fp:unmatched:result",
        obligationId: undefined,
        proposalId: "command_execute:fp",
        proofDomain: "execution",
        capability: "command.execute",
        operation: "command_execute",
        requestedTargets: [],
        rejectedTargets: [],
        normalizedParameters: { commandFingerprint: "fp" },
        reasons: [],
        verifiedFacts: [],
        materialRef: undefined,
        evidenceRef: undefined,
        verification: "execution_only",
        status: "observed",
        appliedTargets: [],
        alreadySatisfiedTargets: [],
      });
    });

    const scriptProposal: AgentToolActionDescriptor = {
      id: "zotero_script_execute:fp",
      proofDomain: "execution",
      capability: "zotero.script",
      operation: "zotero_script_execute",
      source: "zotero_script",
      requestedTargets: ["item:1"],
      destinationCollectionIds: [],
    };

    it("verifies a script run from its journalled post-image", async function () {
      const receipt = await receiptFor({
        harness: createHarness(),
        proposal: scriptProposal,
        content: {
          executionPostState: {
            verified: true,
            facts: ["script_postcondition:act-1:1:satisfied:2 targets"],
          },
        },
      });
      assert.deepEqual(receipt, {
        version: 2,
        id: "zotero_script_execute:fp:unmatched:result",
        obligationId: undefined,
        proposalId: "zotero_script_execute:fp",
        proofDomain: "execution",
        capability: "zotero.script",
        operation: "zotero_script_execute",
        requestedTargets: ["item:1"],
        rejectedTargets: [],
        normalizedParameters: undefined,
        reasons: [],
        verifiedFacts: ["script_postcondition:act-1:1:satisfied:2 targets"],
        materialRef: undefined,
        evidenceRef: undefined,
        verification: "verified",
        status: "applied",
        appliedTargets: ["item:1"],
        alreadySatisfiedTargets: [],
      });
    });

    it("refuses a script run whose post-image no longer re-reads", async function () {
      const receipt = await receiptFor({
        harness: createHarness(),
        proposal: scriptProposal,
        content: {
          executionPostState: {
            verified: false,
            facts: ["script_postcondition:act-1:1:mismatched"],
            reason:
              "The script's recorded effect could not be confirmed: an item changed again.",
          },
        },
      });
      assert.deepEqual(receipt, {
        version: 2,
        id: "zotero_script_execute:fp:unmatched:result",
        obligationId: undefined,
        proposalId: "zotero_script_execute:fp",
        proofDomain: "execution",
        capability: "zotero.script",
        operation: "zotero_script_execute",
        requestedTargets: ["item:1"],
        rejectedTargets: ["item:1"],
        normalizedParameters: undefined,
        reasons: [
          "The script's recorded effect could not be confirmed: an item changed again.",
        ],
        verifiedFacts: ["script_postcondition:act-1:1:mismatched"],
        materialRef: undefined,
        evidenceRef: undefined,
        verification: "unverified",
        status: "unverified",
        appliedTargets: [],
        alreadySatisfiedTargets: [],
      });
    });
  });
});
