import type { AcquisitionCase } from "../fixtures/qaEvaluation/acquisition";

const clean = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
type Unit = { source: string; section: string; text: string; callId: string };

/** Observe delivered source text, not quote metadata or the model's answer.
 * Section relevance is deliberately distinct from semantic support. */
export function measureAcquisition(
  entry: Pick<
    AcquisitionCase,
    "evidence" | "relevant" | "onlySections" | "acceptableFirstModes"
  >,
  events: any[],
  refs: { contextItemId: number }[],
  sources: { id: string }[],
) {
  const sourceIds = new Map(
    refs.map((r, i) => [r.contextItemId, sources[i].id]),
  );
  const calls = events.filter((e) => e.type === "tool_call");
  const reads = calls.filter((e) => e.name === "paper_read");
  const retrievalCalls = calls.filter(
    (e) =>
      e.workCategory === "retrieval" ||
      [
        "paper_read",
        "library_retrieve",
        "library_search",
        "file_io",
        "run_command",
      ].includes(e.name),
  );
  const results = events.filter(
    (e) => e.type === "tool_result" && e.name === "paper_read",
  );
  const units: Unit[] = [];
  const pageTextByCall = new Map<string, string>();
  let firstTextCall: string | undefined;
  for (const event of results) {
    const content = event.content || {};
    const pageText = Object.values(content.pageTexts || {})
      .filter((value) => typeof value === "string")
      .join("\n");
    if (pageText) {
      pageTextByCall.set(event.callId, pageText);
      firstTextCall ??= event.callId;
    }
    const rows = Array.isArray(content.results) ? content.results : [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (typeof row.text !== "string" || !row.text.trim()) continue;
      const source =
        sourceIds.get(row.paperContext?.contextItemId) || "unknown";
      const sections = row.sectionLabel
        ? [{ section: row.sectionLabel, text: row.text }]
        : [
            ...row.text.matchAll(
              /^##+ (.+)\r?\n([\s\S]*?)(?=^##+ |$(?![\s\S]))/gm,
            ),
          ].map((m) => ({
            section: m[1].trim(),
            text: m[2].replace(/\[chunk \d+\]/g, "").trim(),
          }));
      // Preserve unrecognized text in the precision denominator; do not award relevance.
      if (!sections.length)
        sections.push({ section: "unknown", text: row.text });
      for (const section of sections) {
        const key = `${source}\n${section.section}\n${section.text}`;
        if (seen.has(key)) continue;
        seen.add(key);
        firstTextCall ??= event.callId;
        units.push({ source, ...section, callId: event.callId });
      }
    }
  }
  const exhaustive = entry.acceptableFirstModes.includes("full");
  // Exhaustive reads use a nested model and may return a paraphrased digest;
  // assess the full-read receipt instead of exact-fragment delivery to the main model.
  const evidence = exhaustive ? [] : entry.evidence;
  const text = clean(
    [...units.map((u) => u.text), ...pageTextByCall.values()].join("\n"),
  );
  const firstText = clean(
    units
      .filter((u) => u.callId === firstTextCall)
      .map((u) => u.text)
      .concat(pageTextByCall.get(firstTextCall || "") || [])
      .join("\n"),
  );
  const relevant = (u: Unit) =>
    entry.relevant[u.source]?.some((s) => clean(s) === clean(u.section)) ||
    false;
  const firstMode =
    reads[0]?.args?.mode || (retrievalCalls.length ? "other" : "none");
  return {
    required: evidence.length,
    found: evidence.filter((s) => text.includes(clean(s))).length,
    firstReadFound: evidence.filter((s) => firstText.includes(clean(s))).length,
    fragmentMetricApplicable: !exhaustive,
    units: units.length,
    pageTextCharacters: [...pageTextByCall.values()].reduce(
      (n, text) => n + text.length,
      0,
    ),
    relevantUnits: units.filter(relevant).length,
    deliveredCharacters: units.reduce((n, u) => n + u.text.length, 0),
    sourcesRequired: Object.keys(entry.relevant).length,
    sourcesCovered: new Set(units.filter(relevant).map((u) => u.source)).size,
    scopeCompliant: entry.onlySections
      ? units.length > 0 &&
        units.every((u) =>
          entry.onlySections!.some((s) => clean(s) === clean(u.section)),
        )
      : null,
    firstMode,
    routeCompliant: entry.acceptableFirstModes.includes(firstMode),
    readModes: reads.map((e) => e.args?.mode || "overview"),
    retrievalCalls: retrievalCalls.length,
    reads: reads.length,
    fullReadReceipts: results
      .filter((e) => e.content?.mode === "full")
      .map((e) => e.content?.readingReceipt || e.content?.receipt || e.content),
    unitsDelivered: units,
  };
}
