import "./hostSurfaceBootstrap";
import { assert } from "chai";
import { createAgentExecutionContext } from "../src/agent/execution/context";
import { resolveAgentRuntimeRequest } from "../src/agent/context/resolvedAgentRequest";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { ActionContractService } from "../src/agent/contracts/actionContract";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import { initAgentChangeJournal } from "../src/agent/store/changeJournal";
import {
  clearAgentTranscriptStore,
  clearAgentTranscript,
  readAgentConversationMessages,
  replaceAgentTranscriptSegment,
} from "../src/agent/store/transcriptStore";
import {
  getOriginalAgentPermissionMode,
  setOriginalAgentPermissionMode,
} from "../src/agent/originalAgentPermissionMode";
import { canonicalNoteHtml } from "../src/utils/noteHtml";
import { renderRawNoteHtml } from "../src/services/notes/noteRendering";

describe("workflow: retained answer to native note", function () {
  this.timeout(60000);
  it("saves the exact answer after storage reload through authorization and native verification", async function () {
    assert.match(
      Zotero.DataDirectory.dir,
      /(?:[/\\]zotero-dev|[/\\]\.scaffold[/\\]test[/\\]data)[/\\]?$/,
    );
    const mode = getOriginalAgentPermissionMode();
    const collection = new Zotero.Collection();
    (collection as { libraryID: number }).libraryID =
      Zotero.Libraries.userLibraryID;
    collection.name = `Retention acceptance ${Date.now()}`;
    await collection.saveTx();
    const key = 91814001;
    const answer =
      "# Three approaches\n\n" +
      "## Comparison\n\nA preserves initial conditions; B learns the update; C retrieves examples.\n\n".repeat(
        25,
      ) +
      "## Limitations\n\nExact tail: **α = 0.125**, not an empirical estimate.\n";
    let note: Zotero.Item | undefined;
    try {
      setOriginalAgentPermissionMode("auto");
      await initAgentChangeJournal();
      const registry = new AgentToolRegistry(
        new ActionContractService(new ZoteroGateway()),
      );
      registry.register(
        (Zotero as any).LLMForZotero.api.agent.getToolDefinition("note_write"),
      );
      const request = resolveAgentRuntimeRequest({
        conversationKey: key,
        mode: "agent" as const,
        model: "test",
        libraryID: collection.libraryID,
        userText: "Compare the supplied approaches.",
      });
      request.executionContext = createAgentExecutionContext(
        request,
        `retention-${Date.now()}`,
      );
      await replaceAgentTranscriptSegment({
        conversationKey: key,
        compatibilityKey: "portable-v2",
        messages: [
          {
            role: "assistant",
            content: answer,
            messageId: "native-source-answer",
          },
        ],
      });
      clearAgentTranscriptStore();
      const source = (await readAgentConversationMessages(key)).find(
        (message) => message.role === "assistant",
      );
      assert.equal(source?.content, answer);
      const call = {
        id: "save-exact-answer",
        name: "note_write",
        arguments: {
          mode: "create",
          target: "standalone",
          collections: [collection.id],
          sourceMessageId: (source as { messageId: string }).messageId,
        },
      };
      const result = await registry.prepareExecution(call, {
        request: {
          ...request,
          userText: `Save the answer unchanged as a standalone note to folder ${collection.name}.`,
        },
        item: null,
        currentAnswerText: "",
        modelName: "native fixture",
      } as never);
      assert.equal(result.kind, "result", "Auto saves without a confirmation");
      if (result.kind !== "result") throw new Error("Unexpected confirmation");
      assert.isTrue(
        result.execution.result.ok,
        JSON.stringify(result.execution.result.content),
      );
      await collection.reload(undefined as never, true);
      const children = collection.getChildItems();
      assert.lengthOf(children, 1);
      note = children[0];
      await note.reload(undefined as never, true);
      assert.isTrue(note.isNote());
      assert.isFalse(Boolean(note.parentID));
      assert.deepEqual(note.getCollections(), [collection.id]);
      assert.equal(
        canonicalNoteHtml(note.getNote()),
        canonicalNoteHtml(renderRawNoteHtml(answer)),
      );
      assert.isTrue(
        result.execution.result.actionReceipts.some(
          (receipt) => receipt.verification === "verified",
        ),
      );
    } finally {
      setOriginalAgentPermissionMode(mode);
      if (note) await note.eraseTx();
      await collection.eraseTx();
      await clearAgentTranscript(key);
    }
  });
});
