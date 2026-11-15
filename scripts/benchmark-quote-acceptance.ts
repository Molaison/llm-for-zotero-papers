/** Run with: node --import tsx scripts/benchmark-quote-acceptance.ts */
import { performance } from "node:perf_hooks";
import {
  buildQuoteSourceIndex,
  classifyDisplayedQuoteSource,
} from "../src/services/quotes/quoteCitations.ts";
import {
  GENUINE_QUOTE_ACCEPTANCE_CASES,
  ALTERED_QUOTE_ACCEPTANCE_CASES,
} from "../test/fixtures/quoteAcceptance.ts";
const cases = [
  ...GENUINE_QUOTE_ACCEPTANCE_CASES,
  ...ALTERED_QUOTE_ACCEPTANCE_CASES,
];
const filler =
  "Participants completed the calibration task before each scanning session. Measurements were collected under the same experimental conditions. ".repeat(
    12,
  );
const inputs = cases.map((f, i) => ({
  fixture: f,
  sourceTexts: Array.from({ length: 8 }, (_, p) => ({
    sourceText: `Page ${p + 1}. ${filler}${p === 5 ? f.source : ""}${filler}`,
    sourceLabel: "(Benchmark, 2026)",
    itemId: 100 + i,
    contextItemId: 200 + i,
    pageHintIndex: p,
    sourceMatchSource: "pdf-page-text" as const,
    sourceFingerprint: `benchmark-${i}`,
  })),
}));
const indexTime = [] as number[];
const indexed = inputs.map((i) => {
  const start = performance.now();
  const sourceIndex = buildQuoteSourceIndex(i);
  indexTime.push(performance.now() - start);
  return { ...i, sourceIndex };
});
const timings: Record<string, number[]> = {};
const outcomes: Record<string, string> = {};
for (let round = 0; round < 16; round++) {
  for (const i of indexed) {
    const start = performance.now();
    const r = classifyDisplayedQuoteSource({
      quoteText: i.fixture.quote,
      sourceIndex: i.sourceIndex,
      sourceEvidenceComplete: true,
    });
    const elapsed = performance.now() - start;
    if (round > 2) (timings[i.fixture.name] ??= []).push(elapsed);
    outcomes[i.fixture.name] = r.kind;
  }
}
function summary(a: number[]) {
  const v = [...a].sort((a, b) => a - b);
  return {
    medianMs: +v[Math.floor(v.length * 0.5)].toFixed(3),
    p95Ms: +v[Math.min(v.length - 1, Math.floor(v.length * 0.95))].toFixed(3),
  };
}
const result = {
  node: process.version,
  pagesPerCase: 8,
  iterations: 13,
  indexBuild: summary(indexTime),
  indexedMatching: Object.fromEntries(
    Object.entries(timings).map(([k, v]) => [
      k,
      { ...summary(v), outcome: outcomes[k] },
    ]),
  ),
};
console.log(JSON.stringify(result, null, 2));
