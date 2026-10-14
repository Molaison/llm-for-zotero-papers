import type { ChatAttachment } from "../../shared/types";
import { fromCprChartAttachments, type CprCartesianChartWidget } from "../../utils/cprRichWidgets";
import { renderCprHeatmapChart, renderCprPieChart } from "./cprSpecialChartRenderer";

const SVG = "http://www.w3.org/2000/svg";
const COLORS = ["#2563eb", "#dc2626", "#16a34a", "#9333ea", "#ea580c", "#0891b2"];

/** Render only the validated chart contract, never provider HTML or executable chart code. */
export function renderCprChartWidgets(host: HTMLElement, attachments: readonly ChatAttachment[] | undefined, doc: Document): void {
  for (const widget of fromCprChartAttachments(attachments)) {
    if (widget.kind === "pie_chart") {
      renderCprPieChart(host, widget, doc);
      continue;
    }
    if (widget.kind === "heatmap_chart") {
      renderCprHeatmapChart(host, widget, doc);
      continue;
    }
    const chart = widget;
    const root = doc.createElement("section");
    root.className = "llm-cpr-rich-chart";
    root.style.cssText = "margin:12px 0;padding:12px;border:1px solid var(--fill-quinary,#d4d4d8);border-radius:10px;max-width:100%;overflow:hidden";
    const heading = doc.createElement("div");
    heading.style.cssText = "display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:8px";
    const title = doc.createElement("strong");
    title.textContent = chart.title || `${chart.yField} / ${chart.xField}`;
    title.style.cssText = "flex:1;min-width:120px;overflow-wrap:anywhere";
    heading.appendChild(title);
    const chartRegion = doc.createElement("div");
    chartRegion.style.cssText = "width:100%;overflow-x:auto";
    const table = doc.createElement("table");
    table.hidden = true;
    table.style.cssText = "width:100%;border-collapse:collapse;font-size:12px";
    const headerRow = doc.createElement("tr");
    for (const label of [chart.xField, chart.yField, ...(chart.seriesField ? [chart.seriesField] : [])]) {
      const cell = doc.createElement("th");
      cell.textContent = label;
      cell.style.cssText = "text-align:left;border-bottom:1px solid #888;padding:4px";
      headerRow.appendChild(cell);
    }
    const thead = doc.createElement("thead");
    thead.appendChild(headerRow);
    table.appendChild(thead);
    const tbody = doc.createElement("tbody");
    for (const point of chart.points) {
      const row = doc.createElement("tr");
      for (const cellText of [point.x, String(point.y), ...(chart.seriesField ? [point.series ?? ""] : [])]) {
        const cell = doc.createElement("td");
        cell.textContent = cellText;
        cell.style.cssText = "padding:3px 4px;border-bottom:1px solid var(--fill-quinary,#ddd)";
        row.appendChild(cell);
      }
      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    const status = doc.createElement("div");
    status.setAttribute("aria-live", "polite");
    status.style.cssText = "font-size:12px;min-height:18px;opacity:.8;margin:4px 0";
    status.textContent = "悬停或聚焦数据点可查看数值";
    const controls = doc.createElement("div");
    controls.style.cssText = "display:flex;gap:5px;flex-wrap:wrap;align-items:center";
    const button = (label: string, handler: () => void) => {
      const element = doc.createElement("button");
      element.type = "button";
      element.textContent = label;
      element.style.cssText = "border:1px solid var(--fill-quinary,#aaa);border-radius:5px;padding:2px 7px;cursor:pointer;background:transparent";
      element.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); handler(); });
      controls.appendChild(element);
      return element;
    };
    let zoom = 1;
    let start = 0;
    let tableVisible = false;
    const categories = [...new Set(chart.points.map((point) => point.x))];
    const series = [...new Set(chart.points.map((point) => point.series ?? "默认"))];
    const enabled = new Set(series);
    const draw = () => {
      const count = Math.max(1, Math.ceil(categories.length / zoom));
      start = Math.min(start, Math.max(0, categories.length - count));
      const visibleCategories = categories.slice(start, start + count);
      const visible = chart.points.filter((point) => visibleCategories.includes(point.x) && enabled.has(point.series ?? "默认"));
      const svg = doc.createElementNS(SVG, "svg");
      svg.setAttribute("viewBox", "0 0 640 300");
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", `${chart.mark} chart: ${chart.title || chart.yField}`);
      svg.setAttribute("style", "width:100%;height:auto;min-width:260px;display:block");
      const append = (tag: string, attributes: Record<string, string>, text?: string) => {
        const element = doc.createElementNS(SVG, tag);
        for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
        if (text !== undefined) element.textContent = text;
        svg.appendChild(element);
        return element;
      };
      const left = 56, top = 18, width = 562, height = 230;
      const minValue = Math.min(0, ...visible.map((point) => point.y));
      const dataMax = Math.max(0, ...visible.map((point) => point.y));
      const maxValue = dataMax === minValue ? minValue + 1 : dataMax;
      const span = maxValue - minValue;
      const y = (value: number) => top + (maxValue - value) / span * height;
      const x = (label: string) => left + (visibleCategories.indexOf(label) + .5) * width / Math.max(1, count);
      for (let tick = 0; tick <= 4; tick += 1) {
        const value = minValue + span * tick / 4;
        const py = y(value);
        append("line", { x1: String(left), y1: String(py), x2: String(left + width), y2: String(py), stroke: "#a1a1aa", "stroke-opacity": ".28" });
        append("text", { x: String(left - 7), y: String(py + 4), "text-anchor": "end", fill: "currentColor", "font-size": "11" }, Number(value.toPrecision(3)).toString());
      }
      append("line", { x1: String(left), y1: String(top), x2: String(left), y2: String(top + height), stroke: "currentColor", "stroke-opacity": ".55" });
      visibleCategories.forEach((label, index) => {
        if (count > 18 && index % Math.ceil(count / 18)) return;
        append("text", { x: String(x(label)), y: "266", "text-anchor": "middle", fill: "currentColor", "font-size": "11" }, label.length > 12 ? `${label.slice(0, 11)}…` : label);
      });
      const onPoint = (node: Element, point: CprCartesianChartWidget["points"][number]) => {
        node.setAttribute("tabindex", "0");
        const description = `${point.x}: ${point.y}${point.series !== undefined ? ` (${point.series})` : ""}`;
        const hint = doc.createElementNS(SVG, "title");
        hint.textContent = description;
        node.appendChild(hint);
        node.addEventListener("mouseenter", () => { status.textContent = description; });
        node.addEventListener("focus", () => { status.textContent = description; });
      };
      series.forEach((name, seriesIndex) => {
        if (!enabled.has(name)) return;
        const values = visible.filter((point) => (point.series ?? "默认") === name);
        const color = COLORS[seriesIndex % COLORS.length];
        if ((chart.mark === "line" || chart.mark === "area") && values.length > 1) {
          const ordered = [...values].sort((a, b) => visibleCategories.indexOf(a.x) - visibleCategories.indexOf(b.x));
          const outline = ordered.map((point, index) => `${index ? "L" : "M"}${x(point.x)} ${y(point.y)}`).join(" ");
          const d = chart.mark === "area"
            ? `${outline} L${x(ordered[ordered.length - 1].x)} ${y(0)} L${x(ordered[0].x)} ${y(0)} Z`
            : outline;
          append("path", { d,
            fill: chart.mark === "area" ? color : "none",
            ...(chart.mark === "area" ? { "fill-opacity": ".22" } : {}),
            stroke: color, "stroke-width": "2" });
        }
        for (const point of values) {
          if (chart.mark === "bar") {
            const step = width / Math.max(1, count);
            const barWidth = Math.max(2, Math.min(40, step * .78 / series.length));
            const baseline = y(0), valueY = y(point.y);
            const rect = append("rect", { x: String(x(point.x) - step * .39 + seriesIndex * barWidth),
              y: String(Math.min(baseline, valueY)), width: String(barWidth), height: String(Math.max(1, Math.abs(baseline - valueY))), fill: color, opacity: ".85" });
            onPoint(rect, point);
          } else {
            const dot = append("circle", { cx: String(x(point.x)), cy: String(y(point.y)), r: chart.mark === "point" ? "5" : "4", fill: color });
            onPoint(dot, point);
          }
        }
      });
      chartRegion.replaceChildren(svg);
    };
    button("−", () => { zoom = Math.max(1, Math.floor(zoom / 2)); start = 0; draw(); });
    button("+", () => { zoom = Math.min(8, zoom * 2); start = 0; draw(); });
    button("←", () => { start = Math.max(0, start - Math.ceil(categories.length / zoom)); draw(); });
    button("→", () => { start += Math.ceil(categories.length / zoom); draw(); });
    button("重置", () => { zoom = 1; start = 0; draw(); });
    button("数据表", () => { tableVisible = !tableVisible; table.hidden = !tableVisible; });
    for (const [index, name] of series.entries()) {
      if (series.length === 1) break;
      const toggle = button(name, () => {
        if (enabled.has(name)) enabled.delete(name);
        else enabled.add(name);
        toggle.setAttribute("aria-pressed", String(enabled.has(name)));
        draw();
      });
      toggle.style.borderLeft = `4px solid ${COLORS[index % COLORS.length]}`;
      toggle.setAttribute("aria-pressed", "true");
    }
    heading.appendChild(controls);
    root.append(heading, chartRegion, status, table);
    host.appendChild(root);
    draw();
  }
}
