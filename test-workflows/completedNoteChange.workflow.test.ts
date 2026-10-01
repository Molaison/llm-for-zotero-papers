import "./hostSurfaceBootstrap";
import { assert } from "chai";
import { ActionContractService } from "../src/agent/contracts/actionContract";
import {
  getOriginalAgentPermissionMode,
  setOriginalAgentPermissionMode,
} from "../src/agent/originalAgentPermissionMode";
import { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import { initAgentChangeJournal } from "../src/agent/store/changeJournal";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import type {
  AgentNoteChangeResultCard,
  AgentToolResult,
} from "../src/agent/types";
import type { WorkflowTestApi } from "../src/modules/contextPanel/workflowTestTypes";

describe("workflow: completed native note change", function () {
  this.timeout(60000);
  it("applies in Auto without a prompt, shows the verified historical diff, and undoes its exact action", async function () {
    const api = (Zotero as any).LLMForZotero.api;
    const workflow = api.workflowTest as WorkflowTestApi;
    const mode = getOriginalAgentPermissionMode();
    const notes: Zotero.Item[] = [];
    let root: HTMLElement | null = null;
    try {
      setOriginalAgentPermissionMode("auto");
      await initAgentChangeJournal();
      for (const title of [
        "Completed note change",
        "Unrelated latest change",
      ]) {
        const note = new Zotero.Item("note");
        note.libraryID = Zotero.Libraries.userLibraryID;
        note.setNote(`<h1>${title}</h1><p>Original paragraph.</p>`);
        await note.saveTx();
        notes.push(note);
      }
      const gateway = new ZoteroGateway(),
        contracts = new ActionContractService(gateway),
        registry = new AgentToolRegistry(contracts);
      const tool = api.agent.getToolDefinition("note_write");
      registry.register(tool);
      async function edit(
        note: Zotero.Item,
        text: string,
      ): Promise<AgentToolResult> {
        const execution = await registry.prepareExecution(
          {
            id: `edit-${note.id}`,
            name: "note_write",
            arguments: {
              mode: "edit",
              targetNoteId: note.id,
              patches: [{ find: "Original paragraph.", replace: text }],
            },
          },
          {
            request: {
              conversationKey: notes[0].id,
              mode: "agent",
              libraryID: note.libraryID,
              userText: `Edit this note: ${text}`,
              actionEntryPoint: "conversation",
              // An ordinary agent turn: the in-plugin agent owns permission.
              executionContext: {
                version: 1,
                executionId: `edit-${note.id}`,
                conversationKey: notes[0].id,
                conversationGeneration: 0,
                chatLibraryID: note.libraryID,
                permissionOwner: "original_agent",
                workspaceSnapshot: {
                  selectedPapers: [],
                  selectedCollections: [],
                },
                configuredAccess: {
                  libraryIDs: [note.libraryID],
                  outputDirectories: [],
                },
              },
            },
            item: note,
            currentAnswerText: "",
            modelName: "deterministic fixture",
          } as never,
        );
        assert.equal(
          execution.kind,
          "result",
          "Auto must emit zero confirmation events",
        );
        if (execution.kind !== "result")
          throw new Error("Unexpected confirmation");
        assert.isTrue(
          execution.execution.result.ok,
          JSON.stringify(execution.execution.result.content),
        );
        await note.reload(undefined as never, true);
        return execution.execution.result;
      }
      const result = await edit(notes[0], "Verified replacement.");
      const [card] = tool.presentation.buildResultCards(
        result.content,
      ) as AgentNoteChangeResultCard[];
      assert.equal(card.kind, "note_change");
      assert.equal(card.note.key, notes[0].key);
      await edit(notes[1], "A later unrelated action.");
      const panel = await workflow.renderPanelForItem(notes[0].id);
      root = workflow.renderToolResultForPanel(panel.panelId, result);
      const node = root!.querySelector<HTMLElement>(
        ".llm-agent-action-summary-card",
      )!;
      assert.exists(node, "the change the turn made is the turn's own card");
      assert.equal(
        node.dataset.mode,
        "note",
        "a turn whose only action was the edit is that edit",
      );
      assert.include(node.className, "llm-note-change-card");
      assert.equal(
        node.querySelector(".llm-plan-title")?.textContent,
        `Changed ‘${card.title}’`,
      );
      // The receipt for a note edit targets the note itself. A note that hangs
      // under no paper is one object, so the row draws one chip: the note. A
      // second chip carrying the same title would be a paper that never existed.
      assert.deepEqual(
        (
          [
            ...node.querySelectorAll<HTMLElement>(
              ".llm-agent-action-summary-item .llm-selected-context",
            ),
          ] as HTMLElement[]
        ).map((chip) =>
          chip.classList.contains("llm-note-context-chip")
            ? "note"
            : chip.className,
        ),
        ["note"],
      );
      assert.include(
        node.querySelector(".llm-note-context-chip")?.textContent,
        "Completed note change",
      );
      assert.lengthOf(
        root!.querySelectorAll(".llm-note-review-card"),
        0,
        "the standalone note-change card is not rendered beside it",
      );
      const interrupted = JSON.parse(JSON.stringify(result));
      interrupted.ok = false;
      interrupted.content.noteChange.state = "unverified";
      interrupted.content.noteChange.afterVerified = false;
      const consolidated = workflow.renderToolResultForPanel(
        panel.panelId,
        result,
        { priorResults: [interrupted, result] },
      );
      assert.lengthOf(
        consolidated!.querySelectorAll(".llm-note-change-card"),
        1,
      );
      assert.equal(
        consolidated!.querySelector(
          ".llm-agent-action-summary-card .llm-plan-header .llm-plan-status",
        )?.textContent,
        "Applied",
      );
      consolidated?.remove();
      for (
        let i = 0;
        i < 100 && !node.textContent?.includes("Verified replacement.");
        i++
      )
        await Zotero.Promise.delay(25);
      assert.include(node.textContent, "Original paragraph.");
      assert.include(node.textContent, "Verified replacement.");
      assert.notInclude(node.textContent, "A later unrelated action.");
      const diff = node.querySelector(".llm-agent-hitl-diff")!;
      assert.exists(diff, "the open row shows the verified diff");
      assert.isAtLeast(
        diff.querySelectorAll(".llm-agent-hitl-diff-line-add").length,
        1,
        "the replacement is drawn as an added line",
      );
      const undo = (
        [...node.querySelectorAll("button")] as HTMLButtonElement[]
      ).find((button) => button.textContent === "Undo")!;
      assert.exists(undo);
      undo.click();
      for (
        let i = 0;
        i < 200 &&
        node.querySelector(".llm-plan-status")?.textContent !== "Undone";
        i++
      )
        await Zotero.Promise.delay(25);
      assert.equal(
        node.querySelector(".llm-plan-status")?.textContent,
        "Undone",
        node.textContent || "",
      );
      await notes[0].reload(undefined as never, true);
      await notes[1].reload(undefined as never, true);
      assert.include(notes[0].getNote(), "Original paragraph.");
      assert.notInclude(notes[0].getNote(), "Verified replacement.");
      assert.include(notes[1].getNote(), "A later unrelated action.");
      root?.remove();
      // A reopened result uses durable historical content and the exact reverted action.
      root = workflow.renderToolResultForPanel(
        panel.panelId,
        JSON.parse(JSON.stringify(result)),
      );
      for (let i = 0; i < 100 && !root?.textContent?.includes("Undone"); i++)
        await Zotero.Promise.delay(25);
      assert.include(root?.textContent, "Undone");
      assert.include(root?.textContent, "Verified replacement.");
      const concurrentResult = await edit(notes[0], "Another verified change.");
      const [concurrentCard] = tool.presentation.buildResultCards(
        concurrentResult.content,
      ) as AgentNoteChangeResultCard[];
      notes[0].setNote(
        notes[0].getNote() + "<p>Native edit after the action.</p>",
      );
      await notes[0].saveTx();
      const concurrentHtml = notes[0].getNote();
      let conflict = "";
      try {
        await api.agent.undoNoteChange(concurrentCard);
      } catch (error) {
        conflict = String(error);
      }
      await notes[0].reload(undefined as never, true);
      assert.equal(
        notes[0].getNote(),
        concurrentHtml,
        "Undo must not overwrite a later native edit",
      );
      assert.match(conflict, /changed|conflict|postcondition|undo|restore/i);
      root?.remove();
      // Failed result variants must never use Applied wording.
      const failedResult = JSON.parse(JSON.stringify(concurrentResult));
      failedResult.content.noteChange.state = "failed";
      failedResult.content.noteChange.description =
        "The write failed; inspect the retained journal.";
      root = workflow.renderToolResultForPanel(panel.panelId, failedResult);
      assert.include(root?.textContent, "Not applied");
      assert.notInclude(
        root?.querySelector(".llm-plan-status")?.textContent,
        "Applied",
      );
    } finally {
      root?.remove();
      setOriginalAgentPermissionMode(mode);
      await workflow.reset();
      for (const note of notes) await note.eraseTx();
    }
  });
});
