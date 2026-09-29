// scripts/check-retired-tool-names.cjs
// Fails when a retired tool name appears in src (code, prompt prose, or skill
// .md files) outside the effect-operation vocabulary files. Names that remain
// internal identifiers (IDENTIFIER_NAMES) are allowed only as exact string
// literals or object keys.
/* global __dirname -- CommonJS script; eslint config only declares console/process */
const fs = require("fs");
const path = require("path");
// Retired tool names that live on as internal identifiers: each is the
// spec.name of a facade delegate (journaling, presentation) and most are also
// effect-operation names. As an exact string literal ("apply_tags") or an
// object key (apply_tags: ...) they are that identifier; anywhere else -- in
// prose, a comment, or a skill file -- they read as a tool the model cannot
// call, and are hits.
const IDENTIFIER_NAMES = [
  "apply_tags",
  "set_item_tags",
  "tag_update",
  "move_to_collection",
  "update_metadata",
  "reparent_items",
  "relate_items",
  "import_identifiers",
  "import_local_files",
  "create_items",
  "trash_items",
  "restore_from_trash",
  "merge_items",
];
const RETIRED_TOOL_NAMES = [
  // grown by each retirement task
  "read_paper",
  "search_paper",
  "view_pdf_pages",
  "query_library",
  "read_library",
  "search_literature_online",
  "edit_current_note",
  "write_notes_batch",
  "manage_collections",
  "manage_attachments",
  ...IDENTIFIER_NAMES,
];
// Repo-relative, forward-slash prefixes matched with startsWith.
const ALLOWLIST = [
  "src/agent/model/actionIntent.ts", // OPERATION_CATALOG keys are operations, not tools
  "src/agent/tools/preparedLibraryActions.ts", // registerActionBinding(operation)
  "src/agent/services/libraryMutation/", // operation handlers
  "src/agent/contracts/actionScope.ts",
  "src/agent/plans/",
  "src/modules/contextPanel/agentTrace/actionCardModel.ts",
  "src/agent/context/toolNames.ts", // RETIRED_TOOL_HINTS: retired name -> facade
  "src/agent/finalization/finalAnswerController.ts", // accepts search_literature_online from stored tool history
  "src/modules/contextPanel/agentTrace/noteReviewCard.ts", // accepts edit_current_note from stored review cards
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
  // An exact quoted literal, or a bare object key (line start, "{" or ",").
  identifier: IDENTIFIER_NAMES.includes(name)
    ? new RegExp(
        "([\"'`])" +
          escapeRegExp(name) +
          "\\1|(^|[{,])[ \\t]*" +
          escapeRegExp(name) +
          "[ \\t]*:",
        "gm",
      )
    : null,
}));
const hits = [];
for (const absolute of walk(SRC_ROOT)) {
  const file = toRepoPath(absolute);
  if (ALLOWLIST.some((a) => file.startsWith(a))) continue;
  const text = fs.readFileSync(absolute, "utf8");
  for (const { name, re, identifier } of patterns) {
    const scanned =
      identifier && !file.endsWith(".md") ? text.replace(identifier, "") : text;
    const m = scanned.match(re);
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
