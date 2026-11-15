import { assert } from "chai";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import { ActionContractService } from "../src/agent/contracts/actionContract";
import { createRunCommandTool } from "../src/agent/tools/write/runCommand";
import { initAgentChangeJournal } from "../src/agent/store/changeJournal";
import type { AgentToolContext } from "../src/agent/types";

const permissionPref =
  "extensions.zotero.llmforzotero.originalAgentPermissionMode";

describe("workflow: automatic command permission", function () {
  this.timeout(30000);
  let directory: string;
  let previousMode: unknown;
  let registry: AgentToolRegistry;
  let context: AgentToolContext;
  let reviewCount: number;

  before(async function () {
    assert.match(
      Zotero.DataDirectory.dir,
      /(?:[/\\]zotero-dev|[/\\]\.scaffold[/\\]test[/\\]data)[/\\]?$/,
      "Command workflow must use the disposable Zotero data directory",
    );
    await initAgentChangeJournal();
  });

  beforeEach(async function () {
    previousMode = Zotero.Prefs.get(permissionPref, true);
    Zotero.Prefs.set(permissionPref, "auto", true);
    directory = PathUtils.join(
      Zotero.getTempDirectory().path,
      `auto-command-${Date.now()}`,
    );
    await IOUtils.makeDirectory(directory);
    registry = new AgentToolRegistry(new ActionContractService({} as never));
    registry.register(createRunCommandTool());
    reviewCount = 0;
    context = {
      request: {
        conversationKey: 987654,
        conversationGeneration: 0,
        mode: "agent",
        userText: "Write the requested report into the scratch directory.",
        libraryID: Zotero.Libraries.userLibraryID,
        executionContext: {
          version: 1,
          executionId: `auto-command-${Date.now()}`,
          conversationKey: 987654,
          conversationGeneration: 0,
          chatLibraryID: Zotero.Libraries.userLibraryID,
          permissionOwner: "original_agent",
          workspaceSnapshot: { selectedPapers: [], selectedCollections: [] },
          configuredAccess: {
            libraryIDs: [Zotero.Libraries.userLibraryID],
            outputDirectories: [],
          },
        },
      },
      runId: `auto-command-${Date.now()}`,
      item: null,
      currentAnswerText: "",
      modelName: "native-workflow-fixture",
      reviewAction: async () => {
        reviewCount++;
        return {
          decision: "execute",
          reason: "The script implements the requested scratch output.",
        };
      },
    } as unknown as AgentToolContext;
  });

  afterEach(async function () {
    await IOUtils.remove(directory, { recursive: true, ignoreAbsent: true });
    if (previousMode === undefined) Zotero.Prefs.clear(permissionPref, true);
    else Zotero.Prefs.set(permissionPref, previousMode as never, true);
  });

  async function run(command: string) {
    const result = await registry.prepareExecution(
      { id: `call-${Date.now()}`, name: "run_command", arguments: { command } },
      context,
    );
    assert.equal(
      result.kind,
      "result",
      "No permission card should interrupt execution",
    );
    if (result.kind !== "result") throw new Error("Unexpected approval card");
    assert.isTrue(
      result.execution.result.ok,
      JSON.stringify(result.execution.result.content),
    );
    return result.execution.result.content as {
      stdout: string;
      exitCode: number;
    };
  }

  function quoted(path: string) {
    return Zotero.isWin ? `"${path}"` : `'${path.replace(/'/g, "'\\''")}'`;
  }

  it("uses the retained working directory in the native subprocess", async function () {
    context.request.workingDirectory = directory;
    const output = await run(Zotero.isWin ? "cd" : "pwd");
    assert.equal(output.exitCode, 0);
    // macOS can canonicalize /var to /private/var when the shell starts.
    assert.equal(
      output.stdout.trim().replace(/^\/private(?=\/var\/)/, ""),
      directory.replace(/^\/private(?=\/var\/)/, ""),
    );
    assert.equal(reviewCount, 0);
  });

  it("executes the reported directory-listing form through native Subprocess without review", async function () {
    const exports = PathUtils.join(directory, "Exports");
    await IOUtils.makeDirectory(exports);
    const output = await run(
      Zotero.isWin
        ? `dir ${quoted(directory)} && echo --- && dir ${quoted(exports)}`
        : `ls -la ${quoted(directory)} && echo '---' && ls -la ${quoted(exports)}`,
    );
    assert.equal(output.exitCode, 0);
    assert.include(output.stdout, "Exports");
    assert.include(output.stdout, "---");
    assert.equal(reviewCount, 0);
  });

  it("writes a new file without approval and verifies it through native readback", async function () {
    const path = PathUtils.join(directory, "report.txt");
    const output = await run(
      Zotero.isWin
        ? `echo native report>${quoted(path)}`
        : `printf '%s' 'native report' > ${quoted(path)}`,
    );
    assert.equal(output.exitCode, 0);
    assert.equal(
      await IOUtils.readUTF8(path),
      Zotero.isWin ? "native report\r\n" : "native report",
    );
    assert.equal(reviewCount, 0);
  });

  it("reviews a script once and runs its actual native process", async function () {
    const path = PathUtils.join(
      directory,
      Zotero.isWin ? "script.cmd" : "script.sh",
    );
    await IOUtils.writeUTF8(
      path,
      Zotero.isWin
        ? "@echo reviewed-script\r\n"
        : "printf '%s' reviewed-script",
    );
    const output = await run(
      Zotero.isWin ? `call ${quoted(path)}` : `sh ${quoted(path)}`,
    );
    assert.equal(output.stdout.trim(), "reviewed-script");
    assert.equal(output.exitCode, 0);
    assert.equal(reviewCount, 1);
  });

  it("YOLO executes a compound deletion without model or user review", async function () {
    Zotero.Prefs.set(permissionPref, "yolo", true);
    const path = PathUtils.join(directory, "discard.txt");
    await IOUtils.writeUTF8(path, "discard");
    const output = await run(
      `${Zotero.isWin ? "del" : "rm"} ${quoted(path)} && echo removed`,
    );
    assert.equal(output.exitCode, 0);
    assert.isFalse(await IOUtils.exists(path));
    assert.equal(reviewCount, 0);
  });
});
