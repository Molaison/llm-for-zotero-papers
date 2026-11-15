import { assert } from "chai";
import {
  createRunCommandTool,
  executeCommand,
} from "../src/agent/tools/write/runCommand";
import { createTestActionContractService } from "./helpers/actionContractService";

/**
 * run_command had no test file of its own, so nothing pinned the two facts the
 * rest of the effect path depends on: what it proposes, and what its receipt
 * claims to have verified. Phase 3 changes receipt semantics tool by tool;
 * these are the characterizations those changes must not break silently.
 */
describe("run_command effect path", function () {
  it("binds the retained working directory before authorization and preserves explicit overrides", async function () {
    const tool = createRunCommandTool();
    const context = {
      request: {
        workingDirectory: "/tmp/research-task",
        userText: "List the files",
        mode: "agent",
      },
      item: null,
    } as never;
    for (const cwd of [undefined, "/tmp/explicit-task"]) {
      const validated = tool.validate({
        command: "ls",
        ...(cwd ? { cwd } : {}),
      });
      assert.isTrue(validated.ok);
      if (!validated.ok) return;
      await tool.planInvocation!(validated.value, context);
      assert.equal(validated.value.cwd, cwd || "/tmp/research-task");
    }
  });
  const tool = createRunCommandTool();
  const service = createTestActionContractService();

  const validated = (command: string) => {
    const input = tool.validate({ command });
    if (!input.ok) throw new Error(input.error);
    return input.value;
  };

  it("proposes only a command fingerprint, never the raw command as a target", async function () {
    const proposals = await tool.describeAction!(
      validated("rm -rf /tmp/run-command-target"),
    );
    assert.lengthOf(proposals, 1);
    const proposal = proposals[0];
    assert.equal(proposal.operation, "command_execute");
    assert.equal(proposal.capability, "command.execute");
    assert.equal(proposal.proofDomain, "execution");
    assert.equal(proposal.source, "command");
    assert.deepEqual(proposal.requestedTargets, []);
    assert.deepEqual(proposal.destinationCollectionIds, []);
    assert.match(
      String(proposal.parameters?.commandFingerprint),
      /^fnv1a32:[0-9a-f]{8}$/,
    );
    assert.notInclude(
      JSON.stringify(proposal),
      "/tmp/run-command-target",
      "the exact command is bound by the proposal digest, not republished as a target",
    );
  });

  it("fingerprints differ per command and are stable for the same command", async function () {
    const fingerprint = async (command: string) =>
      (await tool.describeAction!(validated(command)))[0].parameters
        ?.commandFingerprint;
    assert.equal(await fingerprint("echo one"), await fingerprint("echo one"));
    assert.notEqual(
      await fingerprint("echo one"),
      await fingerprint("echo two"),
    );
  });

  it("mints an execution_only receipt because a shell command has no re-readable state", async function () {
    const prepared = await service.prepare(
      tool,
      validated("rm -rf /tmp/run-command-target"),
    );
    const receipts = await service.finalize(prepared, {
      ok: true,
      effect: "applied",
      content: { exitCode: 0, stdout: "" },
    });
    assert.lengthOf(receipts, 1);
    assert.equal(receipts[0].operation, "command_execute");
    assert.equal(receipts[0].proofDomain, "execution");
    assert.equal(receipts[0].verification, "execution_only");
    assert.equal(receipts[0].status, "observed");
    assert.deepEqual(receipts[0].appliedTargets, []);
  });

  it("reports a cancelled command as not_applicable, never as executed", async function () {
    const prepared = await service.prepare(tool, validated("echo cancelled"));
    const receipts = await service.finalize(prepared, {
      ok: false,
      cancelled: true,
      reason: "The user declined the command.",
    });
    assert.lengthOf(receipts, 1);
    assert.equal(receipts[0].verification, "not_applicable");
    assert.equal(receipts[0].status, "cancelled");
  });

  it("fails before launch when the controllable subprocess backend is unavailable", async function () {
    const globals = globalThis as any;
    const originalChromeUtils = globals.ChromeUtils;
    const originalComponents = globals.Components;
    globals.ChromeUtils = {};
    let blockingFallbackUsed = false;
    globals.Components = {
      classes: new Proxy(
        {},
        {
          get: () => {
            blockingFallbackUsed = true;
            return undefined;
          },
        },
      ),
    };
    try {
      const result = await executeCommand({
        command: "echo unavailable",
        timeoutMs: 1000,
      });
      assert.equal(result.outcome, "launch_failed");
      assert.include(result.stderr, "No command was launched");
      assert.isFalse(blockingFallbackUsed);
    } finally {
      globals.ChromeUtils = originalChromeUtils;
      globals.Components = originalComponents;
    }
  });

  it("never retries a rejected subprocess launch through another backend", async function () {
    const globals = globalThis as any;
    const originalChromeUtils = globals.ChromeUtils;
    let launches = 0;
    globals.ChromeUtils = {
      importESModule: () => ({
        Subprocess: {
          call: async () => {
            launches++;
            throw new Error("launch rejected");
          },
        },
      }),
    };
    try {
      const result = await executeCommand({
        command: "echo once",
        timeoutMs: 1000,
      });
      assert.equal(result.outcome, "launch_failed");
      assert.equal(launches, 1);
      assert.include(result.stderr, "no fallback execution was attempted");
    } finally {
      globals.ChromeUtils = originalChromeUtils;
    }
  });

  it("reports successful and nonzero subprocess exits distinctly", async function () {
    const globals = globalThis as any;
    const originalChromeUtils = globals.ChromeUtils;
    try {
      for (const exitCode of [0, 7]) {
        let stdoutRead = false;
        let stderrRead = false;
        globals.ChromeUtils = {
          importESModule: () => ({
            Subprocess: {
              call: async () => ({
                stdout: {
                  readString: async () => {
                    if (stdoutRead) return "";
                    stdoutRead = true;
                    return "output";
                  },
                },
                stderr: {
                  readString: async () => {
                    if (stderrRead) return "";
                    stderrRead = true;
                    return exitCode ? "failed" : "";
                  },
                },
                wait: async () => ({ exitCode }),
                kill: () => undefined,
              }),
            },
          }),
        };
        const result = await executeCommand({
          command: "fixture",
          timeoutMs: 1000,
        });
        assert.equal(result.exitCode, exitCode);
        assert.equal(result.outcome, exitCode === 0 ? "succeeded" : "failed");
        assert.equal(result.stdout, "output");
      }
    } finally {
      globals.ChromeUtils = originalChromeUtils;
    }
  });

  it("times out one launched subprocess without starting another", async function () {
    const globals = globalThis as any;
    const originalChromeUtils = globals.ChromeUtils;
    let launches = 0;
    let kills = 0;
    globals.ChromeUtils = {
      importESModule: () => ({
        Subprocess: {
          call: async () => {
            launches++;
            return {
              stdout: { readString: () => new Promise(() => undefined) },
              stderr: { readString: () => new Promise(() => undefined) },
              wait: () => new Promise(() => undefined),
              kill: () => {
                kills++;
              },
            };
          },
        },
      }),
    };
    try {
      const result = await executeCommand({
        command: "long task",
        timeoutMs: 5,
      });
      assert.equal(result.outcome, "timed_out");
      assert.equal(launches, 1);
      assert.equal(kills, 1);
      assert.include(result.stderr, "detached descendants");
    } finally {
      globals.ChromeUtils = originalChromeUtils;
    }
  });

  it("reports an uncertain post-launch runtime failure distinctly", async function () {
    const globals = globalThis as any;
    const originalChromeUtils = globals.ChromeUtils;
    globals.ChromeUtils = {
      importESModule: () => ({
        Subprocess: {
          call: async () => ({
            stdout: { readString: async () => "" },
            stderr: { readString: async () => "" },
            wait: async () => {
              throw new Error("process status lost");
            },
            kill: () => undefined,
          }),
        },
      }),
    };
    try {
      const result = await executeCommand({
        command: "fixture",
        timeoutMs: 1000,
      });
      assert.equal(result.outcome, "uncertain");
      assert.include(result.stderr, "outcome is uncertain after launch");
    } finally {
      globals.ChromeUtils = originalChromeUtils;
    }
  });

  it("cancels a launched subprocess and reports the termination limit", async function () {
    const globals = globalThis as any;
    const originalChromeUtils = globals.ChromeUtils;
    let kills = 0;
    globals.ChromeUtils = {
      importESModule: () => ({
        Subprocess: {
          call: async () => ({
            stdout: { readString: async () => "" },
            stderr: { readString: async () => "" },
            wait: () => new Promise(() => undefined),
            kill: () => {
              kills++;
            },
          }),
        },
      }),
    };
    const controller = new AbortController();
    try {
      const resultPromise = executeCommand({
        command: "long task",
        timeoutMs: 1000,
        signal: controller.signal,
      });
      controller.abort();
      const result = await resultPromise;
      assert.equal(result.outcome, "cancelled");
      assert.equal(kills, 1);
      assert.include(result.stderr, "detached descendants");
    } finally {
      globals.ChromeUtils = originalChromeUtils;
    }
  });
});
