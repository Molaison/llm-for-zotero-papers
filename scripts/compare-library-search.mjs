// node scripts/compare-library-search.mjs before after-text [after-hybrid ...]
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const labels = process.argv.slice(2);
if (labels.length < 2)
  throw new Error(
    "Usage: node scripts/compare-library-search.mjs <labelA> <labelB> [...]",
  );

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length
    ? s.length % 2
      ? s[(s.length - 1) / 2]
      : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
    : NaN;
};
const p95 = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length
    ? s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]
    : NaN;
};

function loadRuns(label) {
  const dir = resolve("tmp/library-search-bench", label);
  return readdirSync(dir)
    .filter((f) => /^run-\d+\.json$/.test(f))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
}
function loadRss(label) {
  const dir = resolve("tmp/library-search-bench", label);
  return readdirSync(dir)
    .filter((f) => /^run-\d+-rss\.json$/.test(f))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
}

function metrics(label) {
  const runs = loadRuns(label);
  const q = (pred) => runs.flatMap((r) => r.queries.filter(pred));
  const ms = (rows) => rows.map((r) => r.elapsedMs);
  const lib = (pass) => q((r) => r.scope === "library" && r.pass === pass);
  const col = (pass) => q((r) => r.scope === "collection30" && r.pass === pass);
  const all = q(() => true);
  const rss = loadRss(label).map((samples) =>
    Math.max(0, ...samples.map((s) => s.rssBytes)),
  );
  const phaseNames = [
    ...new Set(all.flatMap((r) => Object.keys(r.phases))),
  ].sort();
  const phases = Object.fromEntries(
    phaseNames.map((p) => [
      p,
      median(lib("cold").map((r) => r.phases[p] || 0)),
    ]),
  );
  return {
    runs: runs.length,
    "library cold p50 ms": median(ms(lib("cold"))),
    "library cold p95 ms": p95(ms(lib("cold"))),
    "library warm p50 ms": median(ms(lib("warm"))),
    "collection30 cold p50 ms": median(ms(col("cold"))),
    "collection30 warm p50 ms": median(ms(col("warm"))),
    "recall@5 (all)": all.length
      ? all.reduce((a, r) => a + r.recallAt5, 0) / all.length
      : NaN,
    "snippetHit (all)": all.length
      ? all.reduce((a, r) => a + r.snippetHit, 0) / all.length
      : NaN,
    "corpus build ms": median(runs.map((r) => r.corpusBuildMs)),
    "index build ms": median(
      runs.map((r) => r.indexBuildMs).filter((x) => x !== null),
    ),
    "index db MB": median(
      runs.map((r) => Number(r.indexStatus?.dbBytes ?? NaN) / 1e6),
    ),
    "index vectors MB": median(
      runs.map((r) => Number(r.indexStatus?.vectorBytes ?? NaN) / 1e6),
    ),
    "peak RSS MB": median(rss.map((b) => b / 1e6)),
    phases,
  };
}

const table = labels.map((label) => [label, metrics(label)]);
const rows = Object.keys(table[0][1]).filter((k) => k !== "phases");
const fmt = (v) =>
  Number.isFinite(v)
    ? Math.abs(v) < 10
      ? v.toFixed(2)
      : Math.round(v).toString()
    : "n/a";
console.log(
  `| metric | ${labels.join(" | ")} | ratio (${labels[0]} / ${labels[labels.length - 1]}) |`,
);
console.log(`|---|${labels.map(() => "---").join("|")}|---|`);
for (const key of rows) {
  const values = table.map(([, m]) => m[key]);
  const ratio = values[0] / values[values.length - 1];
  console.log(`| ${key} | ${values.map(fmt).join(" | ")} | ${fmt(ratio)} |`);
}
console.log("\nLibrary cold phase medians (ms):");
const phaseKeys = [
  ...new Set(table.flatMap(([, m]) => Object.keys(m.phases))),
].sort();
console.log(`| phase | ${labels.join(" | ")} |`);
console.log(`|---|${labels.map(() => "---").join("|")}|`);
for (const p of phaseKeys)
  console.log(
    `| ${p} | ${table.map(([, m]) => fmt(m.phases[p])).join(" | ")} |`,
  );
