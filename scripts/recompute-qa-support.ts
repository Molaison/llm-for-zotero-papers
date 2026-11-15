/** Rescore stored QA reports with the current support and grounding metrics.
 *
 * A metric change must not force a re-flight: this reads each report's own
 * `answer` and `events` and rewrites only `support`, `grounding` and
 * `finalQuoteCitations`, using the same helpers the live harness uses.
 *
 * Usage: npx tsx scripts/recompute-qa-support.ts REPORT_DIR
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  citationsFromEvents,
  measureGrounding,
  measureSupport,
} from "../test/helpers/qaSupportMetrics";

// Case ids carry one or more letters before their number (f1, p3, rl2).
const REPORT_NAME = /^(before|after)-\d+-[a-z]+\d+\.json$/;

/** Rewrites every report in `directory`; returns one summary line per report. */
export async function recomputeQaSupport(directory: string): Promise<string[]> {
  const lines: string[] = [];
  for (const name of (await readdir(directory)).sort()) {
    if (!REPORT_NAME.test(name)) continue;
    const path = resolve(directory, name);
    const report = JSON.parse(await readFile(path, "utf8"));
    const previous = report.support?.lowOverlapTokens ?? null;
    const answer = String(report.answer || "");
    const { citations, finalCount } = citationsFromEvents(
      Array.isArray(report.events) ? report.events : [],
    );
    report.support = measureSupport(answer, citations);
    report.grounding = measureGrounding(
      answer,
      new Set(citations.map((c) => c.id)),
    );
    report.finalQuoteCitations = finalCount;
    // Byte-for-byte the shape the harness writes, so a rescored directory and
    // a freshly flown one stay comparable.
    await writeFile(path, JSON.stringify(report, null, 2), "utf8");
    lines.push(
      `${name}: lowOverlapTokens ${previous} -> ${report.support.lowOverlapTokens}`,
    );
  }
  return lines;
}

const invokedDirectly =
  typeof process !== "undefined" &&
  Boolean(process.argv[1]) &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const directory = process.argv[2];
  if (!directory)
    throw new Error(
      "Usage: npx tsx scripts/recompute-qa-support.ts REPORT_DIR",
    );
  for (const line of await recomputeQaSupport(directory)) console.log(line);
}
