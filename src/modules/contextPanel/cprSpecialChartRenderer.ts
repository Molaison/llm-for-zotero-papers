import type { CprHeatmapChartWidget, CprPieChartWidget } from "../../utils/cprRichWidgets";

const SVG = "http://www.w3.org/2000/svg";
const COLORS = ["#2563eb", "#dc2626", "#16a34a", "#9333ea", "#ea580c", "#0891b2"];

/** Native Zotero controls only; all incoming labels are assigned with textContent. */
function chartShell(host: HTMLElement, title: string, doc: Document) {
  const root = doc.createElement("section");
  root.className = "llm-cpr-rich-chart";
  root.style.cssText = "margin:12px 0;padding:12px;border:1px solid var(--fill-quinary,#d4d4d8);border-radius:10px;max-width:100%;overflow:hidden";
  const heading = doc.createElement("strong");
  heading.textContent = title;
  const controls = doc.createElement("div");
  controls.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;margin:8px 0";
  const plot = doc.createElement("div");
  plot.style.cssText = "width:100%;overflow-x:auto";
  const status = doc.createElement("div");
  status.setAttribute("aria-live", "polite");
  status.style.cssText = "font-size:12px;min-height:18px;margin:5px 0";
  const table = doc.createElement("table");
  table.hidden = true;
  table.style.cssText = "font-size:12px;border-collapse:collapse;max-width:100%;overflow-wrap:anywhere";
  const button = (label: string, onClick: () => void) => {
    const element = doc.createElement("button");
    element.type = "button";
    element.textContent = label;
    element.style.cssText = "padding:2px 7px;border:1px solid #a1a1aa;border-radius:5px;background:transparent;cursor:pointer";
    element.addEventListener("click", (event) => {
      event.preventDefault(); event.stopPropagation(); onClick();
    });
    controls.appendChild(element);
    return element;
  };
  button("数据表", () => { table.hidden = !table.hidden; });
  const setDataTable = (columns: string[], rows: string[][]) => {
    const thead = doc.createElement("thead");
    const header = doc.createElement("tr");
    for (const column of columns) {
      const th = doc.createElement("th");
      th.textContent = column;
      th.style.cssText = "padding:4px;border-bottom:1px solid #aaa;text-align:left";
      header.appendChild(th);
    }
    thead.appendChild(header);
    const tbody = doc.createElement("tbody");
    for (const values of rows) {
      const tr = doc.createElement("tr");
      for (const value of values) {
        const td = doc.createElement("td");
        td.textContent = value;
        td.style.cssText = "padding:3px 5px;border-bottom:1px solid var(--fill-quinary,#ddd)";
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.append(thead, tbody);
  };
  const svg = (label: string) => {
    const el = doc.createElementNS(SVG, "svg");
    el.setAttribute("viewBox", "0 0 640 300");
    el.setAttribute("style", "width:100%;height:auto;min-width:260px;display:block");
    el.setAttribute("role", "img");
    el.setAttribute("aria-label", label);
    return el;
  };
  const append = (parent: Element, kind: string, attributes: Record<string, string>, label?: string) => {
    const el = doc.createElementNS(SVG, kind);
    for (const [key, value] of Object.entries(attributes)) el.setAttribute(key, value);
    if (label !== undefined) {
      el.textContent = label;
    }
    parent.appendChild(el);
    return el;
  };
  const tooltip = (node: Element, description: string) => {
    node.setAttribute("tabindex", "0");
    const tip = doc.createElementNS(SVG, "title");
    tip.textContent = description;
    node.appendChild(tip);
    node.addEventListener("mouseenter", () => { status.textContent = description; });
    node.addEventListener("focus", () => { status.textContent = description; });
  };
  root.append(heading, controls, plot, status, table);
  host.appendChild(root);
  return { button, plot, status, setDataTable, svg, append, tooltip };
}

export function renderCprPieChart(host: HTMLElement, chart: CprPieChartWidget, doc: Document): void {
  const ui = chartShell(host, chart.title || `${chart.valueField} / ${chart.labelField}`, doc);
  ui.setDataTable([chart.labelField, chart.valueField], chart.slices.map(slice => [slice.label, String(slice.value)]));
  const categories = [...new Set(chart.slices.map(slice => slice.label))];
  const enabled = new Set(categories);
  const draw = () => {
    const plot = ui.svg(`pie chart: ${chart.title || chart.valueField}`);
    const shown = categories.map(label => ({
      label, value: chart.slices.filter(row => row.label === label && enabled.has(label))
        .reduce((sum, row) => sum + row.value, 0),
    })).filter(slice => slice.value > 0);
    const max = Math.max(1, ...shown.map(slice => slice.value));
    const total = shown.reduce((sum, slice) => sum + slice.value / max, 0);
    let angle = -Math.PI / 2;
    shown.forEach((slice, index) => {
      const span = (slice.value / max) / total * Math.PI * 2;
      const next = angle + span;
      const x1 = 320 + Math.cos(angle) * 117, y1 = 146 + Math.sin(angle) * 117;
      const x2 = 320 + Math.cos(next) * 117, y2 = 146 + Math.sin(next) * 117;
      const d = span >= Math.PI * 2 - 1e-8
        ? "M320 29 A117 117 0 1 1 320 263 A117 117 0 1 1 320 29 Z"
        : `M320 146 L${x1} ${y1} A117 117 0 ${span > Math.PI ? 1 : 0} 1 ${x2} ${y2} Z`;
      const path = ui.append(plot, "path", { d, fill: COLORS[categories.indexOf(slice.label) % COLORS.length] });
      ui.tooltip(path, `${slice.label}: ${slice.value}`);
      angle = next;
    });
    ui.plot.replaceChildren(plot);
  };
  if (categories.length <= 20) {
    for (const [index, label] of categories.entries()) {
      const toggle = ui.button(label, () => {
        if (enabled.has(label)) enabled.delete(label); else enabled.add(label);
        toggle.setAttribute("aria-pressed", String(enabled.has(label)));
        draw();
      });
      toggle.setAttribute("aria-pressed", "true");
      toggle.style.borderLeft = `4px solid ${COLORS[index % COLORS.length]}`;
    }
  }
  draw();
}

export function renderCprHeatmapChart(host: HTMLElement, chart: CprHeatmapChartWidget, doc: Document): void {
  const ui = chartShell(host, chart.title || `${chart.valueField} / ${chart.xField} × ${chart.yField}`, doc);
  ui.setDataTable([chart.xField, chart.yField, chart.valueField],
    chart.cells.map(cell => [cell.x, cell.y, String(cell.value)]));
  const xs = [...new Set(chart.cells.map(cell => cell.x))];
  const ys = [...new Set(chart.cells.map(cell => cell.y))];
  const values = chart.cells.map(cell => cell.value);
  const min = Math.min(...values), span = Math.max(...values) - min || 1;
  let xPage = 0, yPage = 0;
  const draw = () => {
    const plot = ui.svg(`heatmap chart: ${chart.title || chart.valueField}`);
    const columns = xs.slice(xPage * 12, xPage * 12 + 12);
    const rows = ys.slice(yPage * 10, yPage * 10 + 10);
    const width = 540 / Math.max(1, columns.length);
    const height = 215 / Math.max(1, rows.length);
    for (const cell of chart.cells) {
      const x = columns.indexOf(cell.x), y = rows.indexOf(cell.y);
      if (x < 0 || y < 0) continue;
      const rect = ui.append(plot, "rect", {
        x: String(85 + x * width), y: String(14 + y * height),
        width: String(Math.max(1, width - 2)), height: String(Math.max(1, height - 2)),
        fill: "#2563eb", opacity: String(0.16 + 0.84 * (cell.value - min) / span),
      });
      ui.tooltip(rect, `${cell.x} × ${cell.y}: ${cell.value}`);
    }
    columns.forEach((value, index) => {
      const text = value.length > 11 ? value.slice(0, 10) + "…" : value;
      ui.append(plot, "text", { x: String(85 + (index + .5) * width),
        y: "248", "text-anchor": "middle", fill: "currentColor", "font-size": "10" }, text);
    });
    rows.forEach((value, index) => {
      const text = value.length > 11 ? value.slice(0, 10) + "…" : value;
      ui.append(plot, "text", { x: "79",
        y: String(14 + (index + .5) * height + 3),
        "text-anchor": "end", fill: "currentColor", "font-size": "10" }, text);
    });
    ui.plot.replaceChildren(plot);
    ui.status.textContent = `X ${xPage + 1}/${Math.ceil(xs.length / 12)} · Y ${yPage + 1}/${Math.ceil(ys.length / 10)}`;
  };
  if (xs.length > 12) {
    ui.button("X ←", () => { xPage = Math.max(0, xPage - 1); draw(); });
    ui.button("X →", () => { xPage = Math.min(Math.ceil(xs.length / 12) - 1, xPage + 1); draw(); });
  }
  if (ys.length > 10) {
    ui.button("Y ↑", () => { yPage = Math.max(0, yPage - 1); draw(); });
    ui.button("Y ↓", () => { yPage = Math.min(Math.ceil(ys.length / 10) - 1, yPage + 1); draw(); });
  }
  draw();
}
