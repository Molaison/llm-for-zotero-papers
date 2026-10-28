import { spawn, execFileSync } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const destination = "docs/design-review/evidence/reader-sidebar";
const sourceFiles = [
  "addon/content/zoteroPane.css",
  "src/modules/contextPanel/index.ts",
  "src/modules/contextPanel/buildUI.ts",
  "src/modules/contextPanel/chat.ts",
  "src/modules/contextPanel/setupHandlers.ts",
  "src/modules/contextPanel/dedicatedChatPane.ts",
  "src/modules/contextPanel/sidebarLayout.ts",
  "src/modules/contextPanel/readerPopupPanelRouting.ts",
  "src/modules/contextPanel/panelHostOwnership.ts",
  "src/modules/contextPanel/workflowTestHarness.ts",
  "src/modules/contextPanel/taskProgressReplay.ts",
  "test-ui-reader/readerSidebar.workflow.test.ts",
  "scripts/capture-reader-sidebar.mjs",
];
const hashes = {};
for (const file of sourceFiles) {
  hashes[file] = createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}
const startedAt = new Date().toISOString();
const child = spawn(process.execPath, ["scripts/run-workflow-tests.mjs"], {
  stdio: "inherit",
  env: { ...process.env, LLM_FOR_ZOTERO_TEST_ENTRIES: "test-ui-reader" },
});
const code = await new Promise((resolve, reject) => {
  child.on("error", reject);
  child.on("close", (exitCode) => resolve(exitCode ?? 1));
});
if (code !== 0) process.exit(code);
await mkdir(destination, { recursive: true });
await cp(".scaffold/test/data/reader-sidebar", destination, {
  recursive: true,
});
await writeFile(
  `${destination}/source.json`,
  JSON.stringify(
    {
      startedAt,
      commit: execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
      sourceSha256: hashes,
      validation:
        "Native isolated Zotero profile; real PDF reader and registered native sidebar; deterministic stored conversation; no live provider request",
    },
    null,
    2,
  ) + "\n",
);
console.log(`Native reader evidence saved: ${destination}`);
