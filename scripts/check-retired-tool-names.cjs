// scripts/check-retired-tool-names.cjs
// Fails when a retired tool name appears in src outside the effect-operation vocabulary files.
const fs = require("fs");
const path = require("path");
const RETIRED_TOOL_NAMES = []; // grown by each retirement task
const ALLOWLIST = [
  "src/agent/model/actionIntent.ts", // OPERATION_CATALOG keys are operations, not tools
  "src/agent/tools/preparedLibraryActions.ts", // registerActionBinding(operation)
  "src/agent/services/libraryMutation/", // operation handlers
  "src/agent/contracts/actionScope.ts",
  "src/agent/plans/",
  "src/modules/contextPanel/agentTrace/actionCardModel.ts",
];
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    // Forward slashes on every platform so ALLOWLIST prefixes match on Windows.
    const p = path.join(dir, e.name).split(path.sep).join("/");
    if (e.isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}
const hits = [];
for (const file of walk("src")) {
  if (ALLOWLIST.some((a) => file.startsWith(a))) continue;
  const text = fs.readFileSync(file, "utf8");
  for (const name of RETIRED_TOOL_NAMES) {
    const re = new RegExp(`["'\`]${name}["'\`]`, "g");
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
