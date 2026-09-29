// scripts/check-retired-tool-names.cjs
// Fails when a retired tool name appears in src (code, prompt prose, or skill
// .md files) outside the effect-operation vocabulary files.
/* global __dirname -- CommonJS script; eslint config only declares console/process */
const fs = require("fs");
const path = require("path");
const RETIRED_TOOL_NAMES = []; // grown by each retirement task
// Repo-relative, forward-slash prefixes matched with startsWith.
const ALLOWLIST = [
  "src/agent/model/actionIntent.ts", // OPERATION_CATALOG keys are operations, not tools
  "src/agent/tools/preparedLibraryActions.ts", // registerActionBinding(operation)
  "src/agent/services/libraryMutation/", // operation handlers
  "src/agent/contracts/actionScope.ts",
  "src/agent/plans/",
  "src/modules/contextPanel/agentTrace/actionCardModel.ts",
];
const REPO_ROOT = path.resolve(__dirname, "..");
const SRC_ROOT = path.join(REPO_ROOT, "src");
function toRepoPath(absolute) {
  // Forward slashes on every platform so ALLOWLIST prefixes match on Windows.
  return path.relative(REPO_ROOT, absolute).split(path.sep).join("/");
}
function isScanned(file) {
  return (
    (file.endsWith(".ts") && !file.endsWith(".test.ts")) || file.endsWith(".md")
  );
}
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (isScanned(p)) out.push(p);
  }
  return out;
}
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
const patterns = RETIRED_TOOL_NAMES.map((name) => ({
  name,
  re: new RegExp("\\b" + escapeRegExp(name) + "\\b", "g"),
}));
const hits = [];
for (const absolute of walk(SRC_ROOT)) {
  const file = toRepoPath(absolute);
  if (ALLOWLIST.some((a) => file.startsWith(a))) continue;
  const text = fs.readFileSync(absolute, "utf8");
  for (const { name, re } of patterns) {
    const m = text.match(re);
    if (m) hits.push(`${file}: ${name} x${m.length}`);
  }
}
if (hits.length) {
  console.error("Retired tool names still referenced:\n" + hits.join("\n"));
  process.exit(1);
}
console.log(
  `OK: no retired tool names in src (${RETIRED_TOOL_NAMES.length} names checked)`,
);
