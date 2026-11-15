import { assert } from "chai";
import {
  evaluateHostAccess,
  resolveConfiguredHostAccess,
} from "../src/agent/authorization/hostAccess";
import type { AgentExecutionContext } from "../src/agent/types";

function context(
  overrides: Partial<AgentExecutionContext["configuredAccess"]> = {},
): AgentExecutionContext {
  return {
    version: 1,
    executionId: "host-access-test",
    conversationKey: 7,
    conversationGeneration: 0,
    chatLibraryID: 1,
    permissionOwner: "external_runtime",
    workspaceSnapshot: { selectedPapers: [], selectedCollections: [] },
    configuredAccess: {
      libraryIDs: [1],
      outputDirectories: ["/vault"],
      fileAccess: {
        readFiles: ["/cache/paper/full.md"],
        writeFiles: [],
        readDirectories: ["/shared/read-only"],
        writeDirectories: ["/vault"],
      },
      hostCommandExecution: false,
      ...overrides,
    },
  };
}

describe("host filesystem and command access", function () {
  it("delegates MCP paths without directory or native reparse-point screening", async function () {
    const originalIO = (globalThis as any).IOUtils;
    (globalThis as any).IOUtils = {
      exists: async () => true,
      realPath: async () => {
        throw new Error("Path screening must not run for client-owned access");
      },
    };
    try {
      for (const impact of ["read_only", "state_change"] as const) {
        const decision = await evaluateHostAccess({
          toolName: "file_io",
          executionContext: context({ unrestrictedFileAccess: true }),
          plan: {
            mechanism: "none",
            impact,
            assurance: "runtime_enforced",
            domains: ["filesystem"],
            effects: ["read"],
            targets: ["/outside/link/file.txt"],
            reversibility: "full",
            riskSignals: [],
            reason: "Caller approved",
          },
        });
        assert.equal(decision.kind, "allow");
      }
    } finally {
      (globalThis as any).IOUtils = originalIO;
    }
  });
  it("separates exact task reads, directory writes, and command permission", async function () {
    assert.equal(
      (
        await evaluateHostAccess({
          toolName: "file_io",
          plan: {
            mechanism: "none",
            impact: "read_only",
            assurance: "runtime_enforced",
            domains: ["filesystem"],
            effects: ["read"],
            targets: ["/cache/paper/full.md"],
            reversibility: "full",
            riskSignals: [],
            reason: "fixture",
          },
          executionContext: context(),
        })
      ).kind,
      "allow",
    );
    assert.equal(
      (
        await evaluateHostAccess({
          toolName: "file_io",
          plan: {
            mechanism: "none",
            impact: "state_change",
            assurance: "runtime_enforced",
            domains: ["filesystem"],
            effects: ["modify"],
            targets: ["/vault/report.md", "/vault/report_assets/figure.png"],
            reversibility: "full",
            riskSignals: [],
            reason: "fixture",
          },
          executionContext: context(),
        })
      ).kind,
      "allow",
    );
    const denied = await evaluateHostAccess({
      toolName: "file_io",
      plan: {
        mechanism: "none",
        impact: "read_only",
        assurance: "runtime_enforced",
        domains: ["filesystem"],
        effects: ["read"],
        targets: ["/cache/paper/sibling.md"],
        reversibility: "full",
        riskSignals: [],
        reason: "fixture",
      },
      executionContext: context(),
    });
    assert.equal(denied.kind, "expand");
    assert.include(denied.reason, "/cache/paper/sibling.md");

    assert.equal(
      (
        await evaluateHostAccess({
          toolName: "run_command",
          plan: {
            mechanism: "shell",
            impact: "read_only",
            assurance: "unknown",
            domains: ["local_execution"],
            effects: ["execute"],
            targets: [],
            reversibility: "none",
            riskSignals: [],
            reason: "fixture",
          },
          executionContext: context(),
        })
      ).kind,
      "expand",
    );
  });

  it("keeps legacy output directories restricted and never interprets missing fields as full access", async function () {
    const access = resolveConfiguredHostAccess(
      context({ fileAccess: undefined }),
    );
    assert.deepEqual(access.writeDirectories, ["/vault"]);
    assert.deepEqual(access.readDirectories, ["/vault"]);
    assert.deepEqual(access.readFiles, []);
    assert.isFalse(access.hostCommandExecution);
  });

  it("uses real paths to reject a symlink escape", async function () {
    const originalIO = (globalThis as any).IOUtils;
    const originalComponents = (globalThis as any).Components;
    class FakeLocalFile {
      path = "";
      initWithPath(path: string) {
        this.path = path.replace(/\/+$/g, "") || "/";
      }
      append(name: string) {
        this.path = `${this.path.replace(/\/+$/g, "")}/${name}`;
      }
      exists() {
        return true;
      }
      isSymlink() {
        return this.path === "/vault/link";
      }
      get target() {
        if (this.isSymlink()) return "/private";
        throw new Error("not a symlink");
      }
      get leafName() {
        return this.path.split("/").filter(Boolean).pop() || "";
      }
      get parent(): FakeLocalFile | null {
        if (this.path === "/") return null;
        const parent = new FakeLocalFile();
        parent.initWithPath(
          this.path.slice(0, this.path.lastIndexOf("/")) || "/",
        );
        return parent;
      }
    }
    (globalThis as any).IOUtils = {
      exists: async () => true,
    };
    (globalThis as any).Components = {
      classes: {
        "@mozilla.org/file/local;1": {
          createInstance: () => new FakeLocalFile(),
        },
      },
      interfaces: { nsIFile: {} },
    };
    try {
      const result = await evaluateHostAccess({
        toolName: "file_io",
        plan: {
          mechanism: "none",
          impact: "read_only",
          assurance: "runtime_enforced",
          domains: ["filesystem"],
          effects: ["read"],
          targets: ["/vault/link/secret.md"],
          reversibility: "full",
          riskSignals: [],
          reason: "fixture",
        },
        executionContext: context({
          outputDirectories: [],
          fileAccess: {
            readFiles: [],
            writeFiles: [],
            readDirectories: ["/vault"],
            writeDirectories: [],
          },
        }),
      });
      assert.equal(result.kind, "expand");
    } finally {
      (globalThis as any).IOUtils = originalIO;
      (globalThis as any).Components = originalComponents;
    }
  });

  it("validates the managed atomic temporary path before a file write", async function () {
    const originalIO = (globalThis as any).IOUtils;
    (globalThis as any).IOUtils = {
      exists: async () => true,
      realPath: async (path: string) =>
        path === "/vault/report.md.tmp" ? "/private/escaped.tmp" : path,
    };
    try {
      const result = await evaluateHostAccess({
        toolName: "file_io",
        plan: {
          mechanism: "none",
          impact: "state_change",
          assurance: "runtime_enforced",
          domains: ["filesystem"],
          effects: ["modify"],
          targets: ["/vault/report.md"],
          reversibility: "full",
          riskSignals: [],
          reason: "fixture",
        },
        executionContext: context({
          outputDirectories: [],
          fileAccess: {
            readFiles: [],
            writeFiles: ["/vault/report.md"],
            readDirectories: [],
            writeDirectories: [],
          },
        }),
      });
      assert.equal(result.kind, "expand");
      assert.deepEqual(result.targets, ["/private/escaped.tmp"]);
    } finally {
      (globalThis as any).IOUtils = originalIO;
    }
  });

  it("resolves a new nested destination from its nearest existing parent", async function () {
    const originalIO = (globalThis as any).IOUtils;
    (globalThis as any).IOUtils = {
      exists: async (path: string) => path === "/vault",
    };
    try {
      const result = await evaluateHostAccess({
        toolName: "file_io",
        plan: {
          mechanism: "none",
          impact: "state_change",
          assurance: "runtime_enforced",
          domains: ["filesystem"],
          effects: ["create"],
          targets: ["/vault/new/nested/report.md"],
          reversibility: "full",
          riskSignals: [],
          reason: "fixture",
        },
        executionContext: context(),
      });
      assert.equal(result.kind, "allow");
    } finally {
      (globalThis as any).IOUtils = originalIO;
    }
  });

  it("normalizes Windows drive and UNC paths case-insensitively", async function () {
    const originalZotero = globalThis.Zotero;
    globalThis.Zotero = { isWin: true } as any;
    try {
      for (const [root, target] of [
        ["C:\\Vault", "c:\\vault\\Notes\\paper.md"],
        ["\\\\Server\\Share\\Notes", "\\\\server\\share\\notes\\paper.md"],
      ]) {
        const result = await evaluateHostAccess({
          toolName: "file_io",
          plan: {
            mechanism: "none",
            impact: "state_change",
            assurance: "runtime_enforced",
            domains: ["filesystem"],
            effects: ["modify"],
            targets: [target],
            reversibility: "full",
            riskSignals: [],
            reason: "fixture",
          },
          executionContext: context({
            outputDirectories: [root],
            fileAccess: {
              readFiles: [],
              writeFiles: [],
              readDirectories: [],
              writeDirectories: [root],
            },
          }),
        });
        assert.equal(result.kind, "allow", `${root} should contain ${target}`);
      }
    } finally {
      globalThis.Zotero = originalZotero;
    }
  });

  it("fails closed for a Windows reparse point inside an allowed root", async function () {
    const originalZotero = globalThis.Zotero;
    const originalIO = (globalThis as any).IOUtils;
    globalThis.Zotero = { isWin: true } as any;
    (globalThis as any).IOUtils = {
      exists: async () => true,
      stat: async (path: string) => ({
        type: path.toLowerCase() === "c:\\vault\\link" ? "other" : "directory",
      }),
    };
    try {
      const result = await evaluateHostAccess({
        toolName: "file_io",
        plan: {
          mechanism: "none",
          impact: "read_only",
          assurance: "runtime_enforced",
          domains: ["filesystem"],
          effects: ["read"],
          targets: ["C:\\Vault\\Link\\secret.md"],
          reversibility: "full",
          riskSignals: [],
          reason: "fixture",
        },
        executionContext: context({
          outputDirectories: [],
          fileAccess: {
            readFiles: [],
            writeFiles: [],
            readDirectories: ["C:\\Vault"],
            writeDirectories: [],
          },
        }),
      });
      assert.equal(result.kind, "block");
    } finally {
      globalThis.Zotero = originalZotero;
      (globalThis as any).IOUtils = originalIO;
    }
  });
});
