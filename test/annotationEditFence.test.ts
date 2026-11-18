import { assert } from "chai";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { isAnnotationReplyTurn } from "../src/services/pdf/annotationReplyService";

describe("annotation history editing", function () {
  it("rejects removal of an original batch marker before any history mutation", async function () {
    // Execute the actual editor entry point with its pre-dispatch dependencies.
    // Loading the whole panel would create unrelated runtime/DOM owners.
    const source = readFileSync(
      new URL("../src/modules/contextPanel/chat.ts", import.meta.url),
      "utf8",
    );
    const ast = ts.createSourceFile(
      "chat.ts",
      source,
      ts.ScriptTarget.Latest,
      true,
    );
    const declaration = ast.statements.find(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) &&
        node.name?.text === "editUserTurnAndRetry",
    );
    assert.exists(declaration);
    const code = ts.transpileModule(
      declaration!.getText(ast).replace(/^export\s+/, ""),
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
    ).outputText;
    const history = [
      {
        role: "user",
        timestamp: 10,
        text: "Saved request\n[Zotero annotation batch: original-batch]",
      },
      { role: "assistant", timestamp: 11, text: "Saved answer" },
      { role: "user", timestamp: 12, text: "Later turn to preserve" },
    ];
    const before = JSON.stringify(history);
    let mutations = 0;
    const status = {};
    const deps = {
      getConversationKey: () => 42,
      ensureConversationLoaded: async () => undefined,
      pendingDeletionStore: {
        ensurePersistedFenceLoaded: async () => true,
        finalizeTurnsForConversation: async () => undefined,
        isConversationPendingDeletion: () => false,
      },
      awaitPendingTurnFinalize: async (value: Promise<unknown>) => value,
      chatHistory: new Map([[42, history]]),
      getConversationWriteGeneration: () => 1,
      isAnnotationReplyTurn,
      appLogger: { debug: () => undefined },
      setStatus: () => undefined,
      deleteTrailingTurnPairs: async () => {
        mutations += 1;
      },
      resolveEffectiveRequestConfig: () => {
        mutations += 1;
        throw new Error("The frozen turn reached retry preparation");
      },
    };
    const edit = new Function(
      "deps",
      `with (deps) { ${code}; return editUserTurnAndRetry; }`,
    )(deps);
    const result = await edit({
      body: { querySelector: () => status },
      item: { id: 42 },
      userTimestamp: 10,
      newText: "Edited request with the marker removed",
    });

    assert.isFalse(result);
    assert.equal(mutations, 0);
    assert.equal(JSON.stringify(history), before);
  });
});
