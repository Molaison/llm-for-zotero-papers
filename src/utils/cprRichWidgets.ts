import type { ChatAttachment } from "../shared/types";

/** A declarative chart, deliberately excluding arbitrary HTML/JavaScript and remote assets. */
export type CprChartWidget = {
  version: 1;
  kind: "cartesian_chart";
  id: string;
  mark: "bar" | "line" | "point";
  title: string;
  xField: string;
  yField: string;
  seriesField?: string;
  points: Array<{ x: string; y: number; series?: string }>;
};

export const CPR_RICH_CHART_MIME = "application/vnd.molaison.papers-chart.v1+json";

export function parseCprChartWidget(value: unknown): CprChartWidget | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const chart = value as Record<string, unknown>;
  if (chart.version !== 1 || chart.kind !== "cartesian_chart"
    || typeof chart.id !== "string" || !/^chart-[1-4]$/.test(chart.id)
    || (chart.mark !== "bar" && chart.mark !== "line" && chart.mark !== "point")
    || typeof chart.title !== "string" || chart.title.length > 160
    || typeof chart.xField !== "string" || !chart.xField || chart.xField.length > 100
    || typeof chart.yField !== "string" || !chart.yField || chart.yField.length > 100
    || (chart.seriesField !== undefined && (typeof chart.seriesField !== "string" || chart.seriesField.length > 100))
    || !Array.isArray(chart.points) || chart.points.length === 0 || chart.points.length > 300) return;
  const points: CprChartWidget["points"] = [];
  for (const value of chart.points) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const row = value as Record<string, unknown>;
    if (typeof row.x !== "string" || row.x.length > 100
      || typeof row.y !== "number" || !Number.isFinite(row.y)
      || (row.series !== undefined && (typeof row.series !== "string" || row.series.length > 80))) return;
    points.push({ x: row.x, y: row.y, ...(typeof row.series === "string" ? { series: row.series } : {}) });
  }
  return {
    version: 1, kind: "cartesian_chart", id: chart.id,
    mark: chart.mark, title: chart.title, xField: chart.xField, yField: chart.yField,
    ...(typeof chart.seriesField === "string" ? { seriesField: chart.seriesField } : {}), points,
  };
}

export function toCprChartAttachments(values: readonly unknown[]): ChatAttachment[] {
  return values.slice(0, 4).flatMap((value) => {
    const chart = parseCprChartWidget(value);
    if (!chart) return [];
    const textContent = JSON.stringify(chart);
    return [{
      id: `papers-rich-chart:${chart.id}`,
      name: chart.title || "Interactive chart",
      mimeType: CPR_RICH_CHART_MIME,
      category: "file" as const,
      sizeBytes: new TextEncoder().encode(textContent).length,
      textContent,
    }];
  });
}

export function fromCprChartAttachments(values?: readonly ChatAttachment[]): CprChartWidget[] {
  if (!Array.isArray(values)) return [];
  return values.filter((value) => value?.mimeType === CPR_RICH_CHART_MIME
    && typeof value.textContent === "string" && value.textContent.length < 100_000)
    .slice(0, 4).flatMap((value) => {
      try {
        const chart = parseCprChartWidget(JSON.parse(value.textContent!));
        return chart ? [chart] : [];
      } catch { return []; }
    });
}
