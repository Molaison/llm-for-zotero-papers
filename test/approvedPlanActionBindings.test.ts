import { assert } from "chai";
import { ActionContractService } from "../src/agent/contracts/actionContract";
import { createBuiltInToolRegistry } from "../src/agent/tools";
import { actionFixture, classifiedFixture } from "./helpers/semanticIntent";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";

/**
 * Review Focus 5: a Plan approved before collection_update, attachment_update
 * and saved_search_update were folded into library_update must still execute.
 *
 * An approved Plan never stores a tool name. Its steps and its effect
 * specification carry operations (create_collection, update_collection, ...)
 * and the host turns each approved operation into a concrete call through the
 * registry's action binding for that operation. That binding is therefore the
 * one place an approved Plan resolves to a tool, and what these tests pin: the
 * collection operations resolve to library_update kind:'collection', a call
 * the registered facade accepts and routes to the collection delegate.
 */
describe("approved Plan effects resolve through library_update", function () {
  function setup(
    operation: "create_collection" | "update_collection" | "delete_collection",
    parameters: Record<string, unknown>,
  ) {
    const collections = new Map([
      [1, { collectionId: 1, libraryID: 1, name: "Source", path: "Source" }],
      [
        7,
        { collectionId: 7, libraryID: 1, name: "Learning", path: "Learning" },
      ],
    ]);
    const gateway = {
      getItem: () => null,
      getCollectionSummary: (id: number) => collections.get(id) || null,
      listCollectionSummaries: () => [...collections.values()],
      getCollectionNativeState: (id: number) => ({
        exists: collections.has(id),
        deleted: false,
        name: collections.get(id)?.name,
        parentCollectionId: null,
      }),
      listCurrentCollectionTargetIds: () => [],
    };
    const intent = {
      ...actionFixture(operation, parameters as never).actionIntents[0],
      targetKind: "collections",
    };
    const request = resolvedAgentRequest({
      conversationKey: 42,
      mode: "agent",
      libraryID: 1,
      userText: "Organize my collections",
      classifiedIntent: classifiedFixture({
        writeDisposition: "required",
        actionIntents: [intent as never],
      }),
    });
    const service = new ActionContractService(gateway as never);
    const registry = createBuiltInToolRegistry({
      zoteroGateway: gateway as never,
      pdfService: {} as never,
      pdfPageService: {} as never,
      retrievalService: {} as never,
    });
    return { request, service, registry };
  }

  const CASES = [
    {
      operation: "create_collection" as const,
      parameters: { collectionName: "New destination" },
      action: "create",
    },
    {
      operation: "update_collection" as const,
      parameters: { collectionId: 7, collectionName: "Renamed" },
      action: "rename",
    },
    {
      operation: "delete_collection" as const,
      parameters: { collectionId: 7 },
      action: "delete",
    },
  ];

  for (const entry of CASES) {
    it(`an approved ${entry.operation} effect runs as library_update kind:'collection'`, async function () {
      const { request, service, registry } = setup(
        entry.operation,
        entry.parameters,
      );
      request.actionContract = await service.createContract(request);
      request.actionProgress = service.createProgress(request.actionContract);
      request.actionPreparation = { state: "ready", issues: [] };
      const step = await registry.getNextWorkflowStep(request);
      assert.equal(step.kind, "action");
      if (step.kind !== "action") return;
      assert.equal(step.prepared.call.name, "library_update");
      const args = step.prepared.call.arguments as Record<string, unknown>;
      assert.equal(args.kind, "collection");
      assert.equal(args.action, entry.action);
      const validated = registry.getTool("library_update")!.validate(args);
      assert.isTrue(validated.ok, validated.ok ? "" : validated.error);
      if (!validated.ok) return;
      assert.equal(validated.value.delegateName, "collection_update");
    });
  }

  it("no action binding names a tool the registry does not register", function () {
    const registry = createBuiltInToolRegistry({
      zoteroGateway: {} as never,
      pdfService: {} as never,
      pdfPageService: {} as never,
      retrievalService: {} as never,
    });
    const bindings = (
      registry as unknown as {
        actionBindings: Map<string, { toolName: string }>;
      }
    ).actionBindings;
    assert.isAbove(bindings.size, 0);
    for (const [operation, binding] of bindings) {
      assert.exists(
        registry.getTool(binding.toolName),
        `${operation} binds unregistered tool ${binding.toolName}`,
      );
    }
  });
});
