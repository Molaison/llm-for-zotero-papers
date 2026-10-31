import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

// A reproducible, focused native smoke run. The ordinary workflow suite
// includes the quote-expansion regression alongside the other reading flows.
const directory = ".scaffold/ui-redesign-regression";
await mkdir(directory, { recursive: true });
await writeFile(
  `${directory}/flows.workflow.test.ts`,
  [
    "addTextLifecycle",
    "actionNoteCopy",
    "historyActivity",
    "paragraphCitations",
    "backgroundSendSwitch",
    "selectedItemContext",
    "dedicatedChatPane",
  ]
    .map((name) => `import "../../test-workflows/${name}.workflow.test";`)
    .join("\n"),
);
const child = spawn(process.execPath, ["scripts/run-workflow-tests.mjs"], {
  stdio: "inherit",
  env: { ...process.env, LLM_FOR_ZOTERO_TEST_ENTRIES: directory },
});
child.on("error", (error) => {
  throw error;
});
child.on("close", (code) => {
  process.exitCode = code ?? 1;
});
