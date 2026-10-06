import "./hostSurfaceBootstrap";
import { createAgentRun, finishAgentRun } from "../src/agent/store/traceStore";
import { assert } from "chai";
import { ActionContractService } from "../src/agent/contracts/actionContract";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import {
  initAgentChangeJournal,
  listJournalActions,
} from "../src/agent/store/changeJournal";
import {
  getOriginalAgentPermissionMode,
  setOriginalAgentPermissionMode,
} from "../src/agent/originalAgentPermissionMode";
import { resolvedAgentRequest } from "../test/helpers/resolvedAgentRequest";
import { createAgentExecutionContext } from "../src/agent/execution/context";
import type { AgentToolContext } from "../src/agent/types";

describe("workflow: registered operation script", function () {
  this.timeout(60000);
  it("composes collection creation and filing through authorization, native receipts, and durable journals", async function () {
    const mode = getOriginalAgentPermissionMode();
    const libraryID = Zotero.Libraries.userLibraryID;
    const source = new Zotero.Collection();
    (source as { libraryID: number }).libraryID = libraryID;
    source.name = `Workflow script source ${Date.now()}`;
    await source.saveTx();
    const paper = new Zotero.Item("journalArticle");
    paper.libraryID = libraryID;
    paper.setField("title", "Registered operation paper");
    paper.setCollections([source.id]);
    await paper.saveTx();
    const sentinel = new Zotero.Item("journalArticle");
    sentinel.libraryID = libraryID;
    sentinel.setField("title", "Unrelated script sentinel");
    sentinel.setCollections([source.id]);
    await sentinel.saveTx();
    let destination: Zotero.Collection | undefined;
    const runId = `native-workflow-script:${paper.key}`;
    let succeeded = false;
    try {
      await initAgentChangeJournal();
      setOriginalAgentPermissionMode("auto");
      const name = `Registered destination ${Date.now()}`;
      const request = resolvedAgentRequest({
        conversationKey: paper.id,
        mode: "agent",
        libraryID,
        activeItemId: paper.id,
        userText: `Create ${name} under collection ${source.id} and add paper ${paper.id}. Preserve its other memberships.`,
      });
      // An ordinary agent turn: the in-plugin agent owns permission.
      request.executionContext = createAgentExecutionContext(request, runId);
      const contracts = new ActionContractService(new ZoteroGateway());
      const registry = new AgentToolRegistry(contracts);
      const agent = (Zotero as any).LLMForZotero.api.agent;
      registry.register(agent.getToolDefinition("library_update"));
      await createAgentRun({
        runId,
        conversationKey: paper.id,
        mode: "agent",
        model: "native-workflow",
        status: "running",
        createdAt: Date.now(),
      });
      let sequence = 0;
      const context: AgentToolContext = {
        request,
        runId,
        item: paper,
        currentAnswerText: "",
        modelName: "native-workflow",
        invokeRegisteredOperation: async (tool, args) => {
          const prepared = await registry.prepareExecution(
            { id: `registered:${++sequence}`, name: tool, arguments: args },
            context,
            { callerKind: "model" },
          );
          assert.equal(
            prepared.kind,
            "result",
            "Each explicit operation is independently authorized",
          );
          if (prepared.kind !== "result")
            throw new Error("Unexpected operation confirmation");
          return prepared.execution.result;
        },
      };
      const script = agent.getToolDefinition("workflow_script");
      const input = script.validate({
        description:
          "Create destination and file the paper through registered operations",
        script: `if (typeof Zotero !== "undefined" || typeof globalThis.Components !== "undefined") throw new Error("Unexpected native globals");
const creation = await env.invoke("library_update", {kind:"collection",action:"create",name:${JSON.stringify(name)},parentCollectionId:${source.id},libraryID:${libraryID}});
if (!creation.ok) throw new Error(JSON.stringify(creation.content));
const receipt=creation.actionReceipts.find(entry=>entry.operation==="create_collection"&&entry.verification==="verified");
const destinationId=Number(receipt.appliedTargets[0].split(":")[1]);
for (const id of [${paper.id}]) {
  const filing=await env.invoke("library_update",{kind:"collections",action:"add",itemIds:[id],targetCollectionId:destinationId});
  if (!filing.ok) throw new Error(JSON.stringify(filing.content));
}
return destinationId;`,
      });
      assert.isTrue(input.ok, JSON.stringify(input));
      if (!input.ok) return;
      const result = await script.execute(input.value, context);
      assert.isUndefined(result.content.error, JSON.stringify(result.content));
      destination = Zotero.Collections.get(result.content.returnValue);
      assert.isOk(destination);
      assert.equal(destination!.name, name);
      await paper.reload(undefined as never, true);
      await sentinel.reload(undefined as never, true);
      assert.sameMembers(paper.getCollections(), [source.id, destination!.id]);
      assert.sameMembers(sentinel.getCollections(), [source.id]);
      assert.lengthOf(result.content.operations, 2);
      assert.isTrue(
        result.content.operations.every(
          (operation: any) =>
            operation.ok &&
            operation.actionReceipts.some(
              (receipt: any) => receipt.verification === "verified",
            ),
        ),
      );
      const journals = await listJournalActions({ runId, limit: 10 });
      assert.isAtLeast(
        journals.length,
        2,
        "Every registered effect has durable journal evidence",
      );
      succeeded = true;
    } finally {
      await finishAgentRun(
        runId,
        succeeded ? "completed" : "failed",
        "Native script test finished",
      );
      setOriginalAgentPermissionMode(mode);
      await Zotero.DB.executeTransaction(async () => {
        if (destination) await destination.erase({ deleteItems: false });
        await paper.erase();
        await sentinel.erase();
        await source.erase({ deleteItems: false });
      });
    }
  });
});
