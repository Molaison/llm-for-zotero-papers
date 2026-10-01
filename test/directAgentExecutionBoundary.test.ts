import { assert } from "chai";
import { afterEach, describe, it } from "mocha";
import {
  readOnlyInvocationPlan,
  stateChangeInvocationPlan,
} from "../src/agent/authorization/invocationPlan";
import { ActionContractService } from "../src/agent/contracts/actionContract";
import { initAgentChangeJournal } from "../src/agent/store/changeJournal";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import type { AgentToolContext } from "../src/agent/types";
import { ChangeJournalTestDb } from "./helpers/changeJournalTestDb";

function directContext(): AgentToolContext {
  return {
    request: {
      conversationKey: 17,
      conversationGeneration: 3,
      mode: "agent",
      userText: "Tag the paper",
      libraryID: 1,
      executionContext: {
        version: 1,
        executionId: "direct-run",
        conversationKey: 17,
        conversationGeneration: 3,
        chatLibraryID: 1,
        permissionOwner: "original_agent",
        workspaceSnapshot: {
          selectedPapers: [],
          selectedCollections: [],
        },
        configuredAccess: { libraryIDs: [1], outputDirectories: [] },
      },
    } as never,
    runId: "direct-run",
    item: null,
    currentAnswerText: "",
    modelName: "fixture",
  };
}

describe("direct-agent execution boundary", function () {
  const originalZotero = globalThis.Zotero;

  afterEach(function () {
    globalThis.Zotero = originalZotero;
  });

  it("preserves Original Agent command review semantics", async function () {
    globalThis.Zotero = {
      DB: new ChangeJournalTestDb(),
      Prefs: { get: () => "auto" },
      Items: { get: () => null },
      Collections: { get: () => null },
      debug: () => undefined,
    } as never;
    await initAgentChangeJournal();
    const registry = new AgentToolRegistry(
      new ActionContractService({} as never),
    );
    registry.register({
      effectOperations: ["command_execute"],
      spec: {
        name: "run_command",
        description: "fixture",
        inputSchema: { type: "object" },
        executionClass: "external_effect",
        requiresConfirmation: true,
      },
      validate: (input) => ({ ok: true, value: input }),
      describeAction: () => [
        {
          id: "command_execute:fixture",
          proofDomain: "execution",
          capability: "command.execute",
          operation: "command_execute",
          source: "command",
          requestedTargets: [],
          destinationCollectionIds: [],
        },
      ],
      planInvocation: () =>
        readOnlyInvocationPlan({
          mechanism: "shell",
          domains: ["local_execution"],
          reason: "Inspect host state.",
        }),
      execute: async () => ({ content: { stdout: "/repo" }, effect: "none" }),
    });

    const prepared = await registry.prepareExecution(
      { id: "call-command", name: "run_command", arguments: {} },
      directContext(),
    );
    assert.equal(prepared.kind, "result");
  });

  it("executes a typed Auto write without semantic or contract state and journals exact authority", async function () {
    const db = new ChangeJournalTestDb();
    globalThis.Zotero = {
      DB: db,
      Prefs: { get: () => "auto" },
      Items: { get: () => ({ libraryID: 1 }) },
      Collections: { get: () => null },
      debug: () => undefined,
    } as never;
    await initAgentChangeJournal();
    const registry = new AgentToolRegistry(
      new ActionContractService({} as never),
    );
    let writes = 0;
    registry.register({
      effectOperations: ["apply_tags"],
      spec: {
        name: "direct_tag",
        description: "fixture",
        inputSchema: { type: "object" },
        executionClass: "external_effect",
        requiresConfirmation: false,
      },
      validate: (input) => ({ ok: true, value: input }),
      describeAction: () => [
        {
          id: "apply_tags:41",
          proofDomain: "zotero_state",
          capability: "zotero.tags",
          operation: "apply_tags",
          source: "zotero_native",
          requestedTargets: ["item:41"],
          destinationCollectionIds: [],
        },
      ],
      planInvocation: () =>
        stateChangeInvocationPlan({
          domains: ["zotero_library"],
          effects: ["modify"],
          targets: ["item:41"],
          reason: "Apply the concrete tag change.",
        }),
      execute: async () => {
        writes += 1;
        return { content: { changed: true }, effect: "applied" };
      },
    });

    const prepared = await registry.prepareExecution(
      { id: "call-1", name: "direct_tag", arguments: {} },
      directContext(),
    );

    assert.equal(prepared.kind, "result");
    if (prepared.kind !== "result") return;
    assert.isTrue(prepared.execution.result.ok);
    assert.equal(writes, 1);
    const observations = [...db.observations.values()];
    assert.deepEqual(
      observations.map((row) => row.event),
      ["original_authorization_prepared", "original_execution_completed"],
    );
    const preparedGrant = JSON.parse(String(observations[0].extra_json));
    assert.equal(preparedGrant.grant.authority, "auto_policy");
    assert.equal(preparedGrant.proposal.targetLibraryIDs[0], 1);
  });

  it("audits an external write by summary, never by copying its post-image", async function () {
    // A script's post-image holds whole note bodies and item JSON. The durable
    // journal step already stores it; copying it into the execution audit row
    // duplicates the largest payload in the system for no reader.
    const db = new ChangeJournalTestDb();
    globalThis.Zotero = {
      DB: db,
      Prefs: { get: () => "auto" },
      Items: { get: () => ({ libraryID: 1 }) },
      Collections: { get: () => null },
      debug: () => undefined,
    } as never;
    await initAgentChangeJournal();
    const registry = new AgentToolRegistry(
      new ActionContractService({} as never),
    );
    registry.register({
      effectOperations: ["zotero_script_execute"],
      spec: {
        name: "direct_script",
        description: "fixture",
        inputSchema: { type: "object" },
        executionClass: "external_effect",
        requiresConfirmation: false,
      },
      validate: (input) => ({ ok: true, value: input }),
      describeAction: () => [
        {
          id: "zotero_script_execute:fixture",
          proofDomain: "execution",
          capability: "zotero.script",
          operation: "zotero_script_execute",
          source: "zotero_script",
          requestedTargets: ["item:41"],
          destinationCollectionIds: [],
        },
      ],
      planInvocation: () =>
        stateChangeInvocationPlan({
          domains: ["zotero_library"],
          effects: ["modify"],
          targets: ["item:41"],
          reason: "Run the declared script effect.",
        }),
      execute: async () => ({
        content: { returned: "done" },
        effect: "applied" as const,
        actionEvidence: [
          {
            version: 1 as const,
            source: "external_mutation" as const,
            operation: "zotero_script",
            preImage: { kind: "script_effects", items: [], declared: [] },
            postImage: {
              kind: "script_effects",
              items: [
                {
                  itemId: 41,
                  exists: true,
                  json: { key: "ABCD", itemType: "note" },
                  noteHtml: "<p>A whole note body that must not be copied.</p>",
                },
              ],
              declared: [],
            },
            journalStepId: "script-action:1",
            effect: "applied" as const,
          },
        ],
      }),
    });

    const prepared = await registry.prepareExecution(
      { id: "call-script", name: "direct_script", arguments: {} },
      directContext(),
    );
    assert.equal(prepared.kind, "result");
    if (prepared.kind !== "result") return;
    assert.isTrue(prepared.execution.result.ok);

    const observation = [...db.observations.values()].find(
      (row) => row.event === "original_execution_completed",
    );
    const extra = String(observation?.extra_json || "");
    assert.notInclude(extra, "noteHtml");
    assert.notInclude(extra, "A whole note body");
    assert.notInclude(extra, "ABCD");
    assert.deepEqual(JSON.parse(extra).actionEvidence, [
      {
        source: "external_mutation",
        stepId: "script-action:1",
        verification: "execution_only",
      },
    ]);
  });

  it("requires review for a new note in Safe mode", async function () {
    const db = new ChangeJournalTestDb();
    globalThis.Zotero = {
      DB: db,
      Prefs: { get: () => "safe" },
      Items: { get: () => ({ libraryID: 1 }) },
      Collections: { get: () => null },
      debug: () => undefined,
    } as never;
    await initAgentChangeJournal();
    const registry = new AgentToolRegistry(
      new ActionContractService({} as never),
    );
    let writes = 0;
    registry.register({
      effectOperations: ["note_create"],
      spec: {
        name: "direct_note",
        description: "fixture",
        inputSchema: { type: "object" },
        executionClass: "external_effect",
        requiresConfirmation: false,
      },
      validate: (input) => ({ ok: true, value: input }),
      describeAction: () => [
        {
          id: "note_create:41",
          proofDomain: "zotero_state",
          capability: "zotero.notes",
          operation: "note_create",
          source: "zotero_native",
          parameters: { noteMode: "create", targetItemId: 41 },
          requestedTargets: ["item:41"],
          destinationCollectionIds: [],
        },
      ],
      planInvocation: () =>
        stateChangeInvocationPlan({
          domains: ["zotero_library"],
          effects: ["create"],
          targets: ["item:41"],
          reason: "Create the concrete note.",
        }),
      createPendingAction: () => ({
        toolName: "direct_note",
        title: "Review new note",
        confirmLabel: "Create note",
        cancelLabel: "Cancel",
        fields: [],
      }),
      execute: async () => {
        writes += 1;
        return { content: { noteId: 99 }, effect: "applied" };
      },
    });

    const prepared = await registry.prepareExecution(
      { id: "call-2", name: "direct_note", arguments: {} },
      directContext(),
    );
    assert.equal(prepared.kind, "confirmation");
    assert.equal(writes, 0);
  });

  it("does not let model-supplied review flags override Auto policy", async function () {
    const db = new ChangeJournalTestDb();
    globalThis.Zotero = {
      DB: db,
      Prefs: { get: () => "auto" },
      Items: { get: () => ({ libraryID: 1 }) },
      Collections: { get: () => null },
      debug: () => undefined,
    } as never;
    await initAgentChangeJournal();
    const registry = new AgentToolRegistry(
      new ActionContractService({} as never),
    );
    let writes = 0;
    registry.register({
      effectOperations: ["apply_tags"],
      spec: {
        name: "reviewed_tag",
        description: "fixture",
        inputSchema: { type: "object", additionalProperties: false },
        executionClass: "external_effect",
        requiresConfirmation: false,
      },
      validate: (input) => {
        assert.notProperty(input as object, "review");
        return { ok: true, value: input };
      },
      describeAction: () => [
        {
          id: "apply_tags:reviewed",
          proofDomain: "zotero_state",
          capability: "zotero.tags",
          operation: "apply_tags",
          source: "zotero_native",
          requestedTargets: ["item:41"],
          destinationCollectionIds: [],
        },
      ],
      planInvocation: () =>
        stateChangeInvocationPlan({
          domains: ["zotero_library"],
          effects: ["modify"],
          targets: ["item:41"],
          reversibility: "full",
          reason: "Apply the concrete tag change.",
        }),
      createPendingAction: () => ({
        toolName: "reviewed_tag",
        title: "Review tag",
        confirmLabel: "Apply",
        cancelLabel: "Cancel",
        fields: [],
      }),
      execute: async () => {
        writes += 1;
        return { content: { changed: true }, effect: "applied" };
      },
    });

    const modelSchema = registry.listTools()[0].inputSchema as {
      properties?: Record<string, { type?: string }>;
    };
    assert.isUndefined(modelSchema.properties?.review);
    const prepared = await registry.prepareExecution(
      {
        id: "call-review",
        name: "reviewed_tag",
        arguments: { review: true },
      },
      directContext(),
    );

    assert.equal(prepared.kind, "result");
    assert.equal(writes, 1);
  });

  it("asks for review of a Safe-mode write even when a stored approved plan covers it", async function () {
    const db = new ChangeJournalTestDb();
    globalThis.Zotero = {
      DB: db,
      Prefs: { get: () => "safe" },
      Items: { get: () => ({ libraryID: 1 }) },
      Collections: { get: () => null },
      debug: () => undefined,
    } as never;
    await initAgentChangeJournal();
    // Everything the retired plan authority used to accept: an approved
    // plan's execution context and its frozen effect for this exact write.
    const specification = {
      version: 1,
      constraints: [],
      effects: [
        {
          effectId: "effect-tag",
          approval: "initial",
          review: "default",
          operation: "apply_tags",
          targets: [
            {
              domain: "zotero",
              libraryID: 1,
              targetIds: ["item:41"],
              scopeDigest: "sha256:scope",
            },
          ],
          targetBindings: [],
          parameters: { tags: ["reviewed"] },
          restrictions: [],
          dependsOnEffectIds: [],
          materialBindings: [],
        },
      ],
      deferredEffects: [],
    };
    const context = directContext();
    context.request.planContext = {
      phase: "executing",
      planId: "plan-1",
      revision: 1,
      executionId: "execution-plan-1",
      approvedDigest: "sha256:plan",
      activeTaskId: "task-1",
      provider: "original",
    };
    context.request.executionContext = {
      ...context.request.executionContext!,
      approvedPlanBinding: {
        planId: "plan-1",
        revision: 1,
        approvedDigest: "sha256:plan",
      },
    };
    Object.assign(context, {
      loadApprovedPlanEffectContext: async () => ({
        specification,
        activeEffectIds: ["effect-tag"],
        resolvedMaterials: [],
        resolvedTargetBindings: {},
      }),
    });
    let writes = 0;
    const registry = new AgentToolRegistry(
      new ActionContractService({} as never),
    );
    registry.register({
      effectOperations: ["apply_tags"],
      spec: {
        name: "planned_tag",
        description: "fixture",
        inputSchema: { type: "object" },
        executionClass: "external_effect",
        requiresConfirmation: false,
      },
      validate: (input) => ({ ok: true, value: input }),
      describeAction: () => [
        {
          id: "apply_tags:item:41",
          proofDomain: "zotero_state",
          capability: "zotero.tags",
          operation: "apply_tags",
          source: "zotero_native",
          parameters: { tags: ["reviewed"] },
          requestedTargets: ["item:41"],
          destinationCollectionIds: [],
        },
      ],
      planInvocation: () =>
        stateChangeInvocationPlan({
          domains: ["zotero_library"],
          effects: ["modify"],
          targets: ["item:41"],
          reason: "Apply the tag change.",
        }),
      createPendingAction: () => ({
        toolName: "planned_tag",
        title: "Review the tag change",
        confirmLabel: "Apply",
        cancelLabel: "Cancel",
        fields: [],
      }),
      execute: async () => {
        writes += 1;
        return { content: { changed: true }, effect: "applied" };
      },
    });

    const prepared = await registry.prepareExecution(
      { id: "call-plan", name: "planned_tag", arguments: {} },
      context,
    );
    assert.equal(prepared.kind, "confirmation");
    assert.equal(writes, 0);
  });
});
