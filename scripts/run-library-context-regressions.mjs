import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

// A focused native preflight for the sidebar drop and library-chat paths this
// branch changes. The complete workflow suite still runs immediately after it.
const directory = ".scaffold/pr8-library-regression";
await mkdir(directory, { recursive: true });
await writeFile(
  `${directory}/flows.workflow.test.ts`,
  [
    "dedicatedChatPane",
    "questionCardReadability",
    "selectedItemContext",
    "standaloneResponsiveChrome",
    "sectionHeadAlignment",
    "sidebarChatModeToggle",
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
