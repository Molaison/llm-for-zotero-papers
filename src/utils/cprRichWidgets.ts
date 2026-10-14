import type { ChatAttachment } from "../shared/types";

/** A declarative chart, deliberately excluding arbitrary HTML/JavaScript and remote assets. */
export type CprCartesianChartWidget = {
  version: 1;
  kind: "cartesian_chart";
  id: string;
  mark: "bar" | "line" | "point" | "area";
  title: string;
  xField: string;
  yField: string;
  seriesField?: string;
  points: Array<{ x: string; y: number; series?: string }>;
};

export type CprPieChartWidget = {
  version: 1; kind: "pie_chart"; id: string; title: string;
  labelField: string; valueField: string;
  slices: Array<{ label: string; value: number }>;
};

export type CprHeatmapChartWidget = {
  version: 1; kind: "heatmap_chart"; id: string; title: string;
  xField: string; yField: string; valueField: string;
  cells: Array<{ x: string; y: string; value: number }>;
};

export type CprChartWidget = CprCartesianChartWidget | CprPieChartWidget | CprHeatmapChartWidget;

export const CPR_RICH_CHART_MIME = "application/vnd.molaison.papers-chart.v1+json";

export function parseCprChartWidget(value: unknown): CprChartWidget | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const chart = value as Record<string, unknown>;
  if (chart.version !== 1
    || typeof chart.id !== "string" || !/^chart-[1-4]$/.test(chart.id)
    || typeof chart.title !== "string" || chart.title.length > 160) return;
  if (chart.kind === "pie_chart") {
    if (typeof chart.labelField !== "string" || !chart.labelField || chart.labelField.length > 100
      || typeof chart.valueField !== "string" || !chart.valueField || chart.valueField.length > 100
      || !Array.isArray(chart.slices) || chart.slices.length === 0 || chart.slices.length > 300) return;
    const slices: CprPieChartWidget["slices"] = [];
    for (const value of chart.slices) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return;
      const row = value as Record<string, unknown>;
      if (typeof row.label !== "string" || row.label.length > 100 ||
        typeof row.value !== "number" || !Number.isFinite(row.value) || row.value <= 0) return;
      slices.push({ label: row.label, value: row.value });
    }
    return { version: 1, kind: "pie_chart", id: chart.id, title: chart.title,
      labelField: chart.labelField, valueField: chart.valueField, slices };
  }
  if (chart.kind === "heatmap_chart") {
    if (typeof chart.xField !== "string" || !chart.xField || chart.xField.length > 100
      || typeof chart.yField !== "string" || !chart.yField || chart.yField.length > 100
      || typeof chart.valueField !== "string" || !chart.valueField || chart.valueField.length > 100
      || !Array.isArray(chart.cells) || chart.cells.length === 0 || chart.cells.length > 300) return;
    const cells: CprHeatmapChartWidget["cells"] = [];
    for (const value of chart.cells) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return;
      const row = value as Record<string, unknown>;
      if (typeof row.x !== "string" || row.x.length > 100
        || typeof row.y !== "string" || row.y.length > 100
        || typeof row.value !== "number" || !Number.isFinite(row.value)) return;
      cells.push({ x: row.x, y: row.y, value: row.value });
    }
    return { version: 1, kind: "heatmap_chart", id: chart.id, title: chart.title,
      xField: chart.xField, yField: chart.yField, valueField: chart.valueField, cells };
  }
  if (chart.kind !== "cartesian_chart"
    || (chart.mark !== "bar" && chart.mark !== "line" && chart.mark !== "point" && chart.mark !== "area")
    || typeof chart.xField !== "string" || !chart.xField || chart.xField.length > 100
    || typeof chart.yField !== "string" || !chart.yField || chart.yField.length > 100
    || (chart.seriesField !== undefined && (typeof chart.seriesField !== "string" || chart.seriesField.length > 100))
    || !Array.isArray(chart.points) || chart.points.length === 0 || chart.points.length > 300) return;
  const points: CprCartesianChartWidget["points"] = [];
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
