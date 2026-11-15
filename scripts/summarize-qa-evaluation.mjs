/** Aggregate opt-in native QA reports; semantic quality requires source review. */
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const directory = process.argv[2];
if (!directory)
  throw new Error(
    "Usage: node scripts/summarize-qa-evaluation.mjs REPORT_DIR [--prefix p]",
  );
// Suites are told apart by their case ids: the authored suite uses one letter
// (f1, s1, l1), the approved real paper uses p, the real library uses r.
const prefixFlag = process.argv.indexOf("--prefix");
const prefix = prefixFlag === -1 ? null : process.argv[prefixFlag + 1];
if (prefixFlag !== -1 && !prefix)
  throw new Error("--prefix needs a case-id prefix, for example --prefix r");
const selects = (id) =>
  prefix ? id.startsWith(prefix) : /^[a-z]\d/.test(id) && !id.startsWith("p");
const reports = [];
for (const name of await readdir(directory)) {
  if (!/^(before|after)-\d+-[a-z]+\d+\.json$/.test(name)) continue;
  const report = JSON.parse(await readFile(resolve(directory, name), "utf8"));
  if (selects(String(report.id || ""))) reports.push(report);
}
const sum = (values) => values.reduce((a, b) => a + b, 0);
const percentile = (values, fraction) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * fraction;
  const low = Math.floor(index);
  return sorted[low] + (sorted[Math.ceil(index)] - sorted[low]) * (index - low);
};
function summarize(rows) {
  const known = rows.filter((r) => r.provider.unknownUsage === 0);
  const required = sum(rows.map((r) => r.acquisition.required));
  const acquisitionRows = rows.filter(
    (r) => typeof r.acquisition.firstReadFound === "number",
  );
  const scoped = acquisitionRows.filter(
    (r) => r.acquisition.scopeCompliant !== null,
  );
  const comparableTextRows = acquisitionRows.filter(
    (r) => r.acquisition.fragmentMetricApplicable,
  );
  return {
    turns: rows.length,
    completed: rows.filter((r) => r.outcome === "completed" && r.answer.trim())
      .length,
    unknownUsageRequests: sum(rows.map((r) => r.provider.unknownUsage)),
    reportedTokens: sum(rows.map((r) => r.provider.totalTokens)),
    totalTokens:
      known.length === rows.length
        ? sum(known.map((r) => r.provider.totalTokens))
        : null,
    medianTokensKnownTurns: percentile(
      known.map((r) => r.provider.totalTokens),
      0.5,
    ),
    inputTokens: sum(
      rows.flatMap((r) => r.requests.map((q) => q.usage?.inputTokens || 0)),
    ),
    outputTokens: sum(
      rows.flatMap((r) => r.requests.map((q) => q.usage?.outputTokens || 0)),
    ),
    cachedInputTokens: sum(
      rows.flatMap((r) =>
        r.requests.map((q) => q.usage?.cachedInputTokens || 0),
      ),
    ),
    medianElapsedMs: percentile(
      rows.map((r) => r.elapsedMs),
      0.5,
    ),
    p90ElapsedMs: percentile(
      rows.map((r) => r.elapsedMs),
      0.9,
    ),
    totalElapsedMs: sum(rows.map((r) => r.elapsedMs)),
    providerRequests: sum(rows.map((r) => r.provider.requests)),
    paperReads: sum(rows.map((r) => r.acquisition.reads)),
    evidenceFragmentsRequired: required,
    evidenceFragmentsDelivered: sum(rows.map((r) => r.acquisition.found)),
    ...(acquisitionRows.length
      ? {
          firstReadFragmentsDelivered: sum(
            acquisitionRows.map((r) => r.acquisition.firstReadFound),
          ),
          passageUnits: sum(comparableTextRows.map((r) => r.acquisition.units)),
          relevantPassageUnits: sum(
            comparableTextRows.map((r) => r.acquisition.relevantUnits),
          ),
          deliveredCharacters: sum(
            acquisitionRows.map((r) => r.acquisition.deliveredCharacters),
          ),
          routeCompliantTurns: acquisitionRows.filter(
            (r) => r.acquisition.routeCompliant,
          ).length,
          sectionRestrictedTurns: scoped.length,
          sectionCompliantTurns: scoped.filter(
            (r) => r.acquisition.scopeCompliant,
          ).length,
          retrievalCalls: sum(
            acquisitionRows.map((r) => r.acquisition.retrievalCalls),
          ),
          requiredSourceCoverage: sum(
            acquisitionRows
              .filter((r) => r.acquisition.fragmentMetricApplicable)
              .map((r) => r.acquisition.sourcesRequired),
          ),
          relevantSourceCoverage: sum(
            acquisitionRows
              .filter((r) => r.acquisition.fragmentMetricApplicable)
              .map((r) => r.acquisition.sourcesCovered),
          ),
        }
      : {}),
    supportTokens: sum(rows.map((r) => r.support?.tokens?.length || 0)),
    supportMedianOverlap: percentile(
      rows.flatMap((r) => (r.support?.tokens || []).map((t) => t.overlap)),
      0.5,
    ),
    lowOverlapTokens: sum(rows.map((r) => r.support?.lowOverlapTokens || 0)),
    anchorMatchClaim: sum(rows.map((r) => r.support?.anchorMatchClaim || 0)),
    anchorMatchPassage: sum(
      rows.map((r) => r.support?.anchorMatchPassage || 0),
    ),
    groundingSentences: sum(rows.map((r) => r.grounding?.sentences || 0)),
    groundingCited: sum(rows.map((r) => r.grounding?.cited || 0)),
    finalCitationTurns: rows.filter((r) => r.finalQuoteCitations > 0).length,
    clarificationTurnsWithRetrieval: rows.filter(
      (r) =>
        ["clarification", "supplied"].includes(r.category) &&
        r.events.some(
          (e) => e.type === "tool_call" && e.workCategory === "retrieval",
        ),
    ).length,
    rawRollbackEvents: sum(rows.map((r) => r.verification.rollbacks)),
  };
}
const before = reports.filter((r) => r.variant === "before");
const after = reports.filter((r) => r.variant === "after");
const key = (r) => `${r.repeat}-${r.id}`;
const beforeKeys = new Set(before.map(key));
const afterKeys = new Set(after.map(key));
const unmatched = [...new Set([...beforeKeys, ...afterKeys])].filter(
  (k) => !beforeKeys.has(k) || !afterKeys.has(k),
);
/** Before/after for one slice of the reports, with the compared metrics. */
function compare(keep) {
  const b = summarize(before.filter(keep));
  const a = summarize(after.filter(keep));
  const changePercent = {};
  for (const metric of [
    "totalTokens",
    "medianTokensKnownTurns",
    "medianElapsedMs",
    "p90ElapsedMs",
    "totalElapsedMs",
    "providerRequests",
    "paperReads",
    "lowOverlapTokens",
  ]) {
    changePercent[metric] =
      typeof b[metric] === "number" &&
      b[metric] > 0 &&
      typeof a[metric] === "number"
        ? 100 * (a[metric] / b[metric] - 1)
        : null;
  }
  return { before: b, after: a, changePercent };
}
const groups = {};
for (const category of ["all", ...new Set(reports.map((r) => r.category))])
  groups[category] = compare(
    (r) => category === "all" || r.category === category,
  );
// Paper chat and library chat answer under different scopes; keep them apart.
for (const scope of ["paper", "library"])
  groups[`scope:${scope}`] = compare((r) => r.scope === scope);
const pairs = before
  .filter((b) => afterKeys.has(key(b)))
  .map((b) => {
    const a = after.find((row) => key(row) === key(b));
    return {
      id: b.id,
      repeat: b.repeat,
      category: b.category,
      beforeMs: b.elapsedMs,
      afterMs: a.elapsedMs,
      beforeTokens: b.provider.unknownUsage ? null : b.provider.totalTokens,
      afterTokens: a.provider.unknownUsage ? null : a.provider.totalTokens,
      beforeReads: b.acquisition.reads,
      afterReads: a.acquisition.reads,
    };
  });
console.log(
  JSON.stringify(
    {
      directory: resolve(directory),
      sourceSet: prefix ? `prefix:${prefix}` : "authored",
      unmatched,
      groups,
      pairs,
      semanticQuality:
        "Review answers against the frozen source-based rubric separately; retrieval overlap is not claim support.",
    },
    null,
    2,
  ),
);
