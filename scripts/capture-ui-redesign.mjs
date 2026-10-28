import { spawn } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const round = process.argv[2];
if (!/^round-\d+$/.test(round || "")) {
  throw new Error("Usage: node scripts/capture-ui-redesign.mjs round-N");
}
const destination = `docs/design-review/evidence/${round}`;
const sourceFiles = [
  "addon/content/zoteroPane.css",
  "src/modules/contextPanel/buildUI.ts",
  "src/modules/contextPanel/chat.ts",
  "src/modules/contextPanel/standaloneWindow.ts",
  "src/modules/contextPanel/setupHandlers.ts",
  "src/utils/i18n.ts",
  "test-ui-redesign/uiRedesign.workflow.test.ts",
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
  env: { ...process.env, LLM_FOR_ZOTERO_TEST_ENTRIES: "test-ui-redesign" },
});
const code = await new Promise((resolve, reject) => {
  child.on("error", reject);
  child.on("close", (exitCode) => resolve(exitCode ?? 1));
});
if (code !== 0) process.exit(code);
await mkdir(destination, { recursive: true });
await cp(".scaffold/test/data/ui-redesign/capture", destination, {
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
        "Native isolated Zotero profile; deterministic local fixtures; no live provider request",
    },
    null,
    2,
  ) + "\n",
);
console.log(`Native UI evidence saved: ${destination}`);
