import { assert } from "chai";
import { parseResponsesStream } from "../src/utils/llmClient";
import { CPR_RICH_CHART_MIME, fromCprChartAttachments, toCprChartAttachments } from "../src/utils/cprRichWidgets";
import { renderCprChartWidgets } from "../src/modules/contextPanel/cprChartRenderer";

const chart = {
  version: 1, kind: "cartesian_chart", id: "chart-1", title: "Measured activity",
  mark: "bar", xField: "variant", yField: "activity", seriesField: "group",
  points: [{ x: "WT", y: 1.2, series: "A" }, { x: "mutant", y: 2.8, series: "B" }],
};
const pie = {
  version: 1, kind: "pie_chart", id: "chart-2", title: "Share",
  labelField: "type", valueField: "count",
  slices: [{ label: "A", value: 4 }, { label: "B", value: 6 }],
};
const heatmap = {
  version: 1, kind: "heatmap_chart", id: "chart-3", title: "Activity matrix",
  xField: "variant", yField: "dose", valueField: "activity",
  cells: Array.from({ length: 13 }, (_, index) => ({
    x: String(index), y: "1µM", value: index + 1,
  })),
};
const area = {
  ...chart, id: "chart-4", mark: "area",
  points: [{ x: "WT", y: 1.2, series: "A" }, { x: "mutant", y: 2.8, series: "A" }],
};

const stream = (...events: unknown[]) => new ReadableStream<Uint8Array>({
  start(controller) {
    const bytes = new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
    controller.enqueue(bytes.subarray(0, 29));
    controller.enqueue(bytes.subarray(29));
    controller.close();
  },
});

describe("CPR papers rich widget boundary", function () {
  it("deduplicates SSE widget events against the completed snapshot and persists only validated data", async function () {
    const result = await parseResponsesStream(stream(
      { type: "response.rich_widget.done", widget: chart },
      { type: "response.rich_widget.done", widget: { ...chart, id: "chart-2", mark: "script" } },
      { type: "response.completed", response: { status: "completed", output_text: "Results", rich_widgets: [chart] } },
    ), () => {}, undefined, undefined, { requireCompleted: true, collectRichWidgets: true });
    assert.equal(result.text, "Results");
    assert.lengthOf(result.richWidgets || [], 1);
    const attachments = toCprChartAttachments(result.richWidgets || []);
    assert.equal(attachments[0]?.mimeType, CPR_RICH_CHART_MIME);
    assert.deepEqual(fromCprChartAttachments(JSON.parse(JSON.stringify(attachments))), [chart]);
    const ignored = await parseResponsesStream(stream(
      { type: "response.rich_widget.done", widget: chart },
      { type: "response.completed", response: { status: "completed" } },
    ), () => {});
    assert.isUndefined(ignored.richWidgets);
  });

  it("never yields a widget from an interrupted or failed response", async function () {
    let failed = false;
    try {
      await parseResponsesStream(stream({ type: "response.rich_widget.done", widget: chart }), () => {},
        undefined, undefined, { requireCompleted: true, collectRichWidgets: true });
    } catch { failed = true; }
    assert.isTrue(failed);
    assert.deepEqual(toCprChartAttachments([{ ...chart, points: [{ x: "bad", y: Infinity }] }]), []);
    assert.deepEqual(fromCprChartAttachments([{ ...toCprChartAttachments([chart])[0], textContent: "{\"bad\":\"<script>\"}" }]), []);
  });

  it("retains area, pie and heatmap data through the completed Responses stream and attachments", async function () {
    const outcome = await parseResponsesStream(stream(
      { type: "response.rich_widget.done", widget: area },
      { type: "response.rich_widget.done", widget: pie },
      { type: "response.rich_widget.done", widget: heatmap },
      { type: "response.completed", response: { status: "completed", output_text: "Charts", rich_widgets: [area, pie, heatmap] } },
    ), () => {}, undefined, undefined, { requireCompleted: true, collectRichWidgets: true });
    assert.equal(outcome.text, "Charts");
    assert.deepEqual(fromCprChartAttachments(toCprChartAttachments(outcome.richWidgets || [])), [area, pie, heatmap]);
    assert.deepEqual(toCprChartAttachments([{ ...pie, slices: [{ label: "bad", value: -1 }] }]), []);
    assert.deepEqual(toCprChartAttachments([{ ...heatmap, cells: [{ x: "A", y: "B", value: Infinity }] }]), []);
    assert.deepEqual(toCprChartAttachments([{ ...pie, kind: "javascript" }]), []);
  });

  it("supports local chart table/series controls without remote script or HTML", function () {
    class ElementStub {
      children: ElementStub[] = [];
      attrs = new Map<string, string>();
      listeners = new Map<string, (e: { preventDefault(): void; stopPropagation(): void }) => void>();
      textContent = "";
      style: Record<string, string> = {};
      hidden = false;
      type = "";
      constructor(public tagName: string) {}
      appendChild(child: ElementStub) { this.children.push(child); return child; }
      append(...children: ElementStub[]) { children.forEach(child => this.appendChild(child)); }
      replaceChildren(...children: ElementStub[]) { this.children = children; }
      setAttribute(key: string, value: string) { this.attrs.set(key, value); }
      addEventListener(name: string, handler: (e: { preventDefault(): void; stopPropagation(): void }) => void) { this.listeners.set(name, handler); }
      click() { this.listeners.get("click")?.({ preventDefault() {}, stopPropagation() {} }); }
    }
    const doc = {
      createElement: (tag: string) => new ElementStub(tag),
      createElementNS: (_ns: string, tag: string) => new ElementStub(tag),
    } as unknown as Document;
    const host = new ElementStub("host");
    renderCprChartWidgets(host as unknown as HTMLElement, toCprChartAttachments([chart]), doc);
    const root = host.children[0]!;
    const controls = root.children[0]!.children[1]!.children;
    const plotted = () => root.children[1]!.children[0]!.children.filter(el => el.tagName === "rect");
    assert.lengthOf(plotted(), 2);
    controls.find(b => b.textContent === "数据表")!.click();
    assert.isFalse(root.children[3]!.hidden);
    controls.find(b => b.textContent === "B")!.click();
    assert.lengthOf(plotted(), 1);
    controls.find(b => b.textContent === "B")!.click();
    assert.lengthOf(plotted(), 2);
    controls.find(b => b.textContent === "+")!.click();
    assert.lengthOf(plotted(), 1);
    controls.find(b => b.textContent === "重置")!.click();
    assert.lengthOf(plotted(), 2);
    for (const mark of ["bar", "line", "point"]) {
      const zeroHost = new ElementStub("host");
      renderCprChartWidgets(zeroHost as unknown as HTMLElement, toCprChartAttachments([{
        ...chart, mark, points: [{ x: "A", y: 0 }, { x: "B", y: 0 }],
      }]), doc);
      const zeroSvg = zeroHost.children[0]!.children[1]!.children[0]!;
      const grid = zeroSvg.children.filter(el => el.tagName === "line").slice(0, 5);
      assert.deepEqual(grid.map(el => Number(el.attrs.get("y1"))), [248, 190.5, 133, 75.5, 18]);
      const labels = zeroSvg.children.filter(el => el.tagName === "text").slice(0, 5);
      assert.deepEqual(labels.map(el => el.textContent), ["0", "0.25", "0.5", "0.75", "1"]);
    }

    const extensions = new ElementStub("host");
    renderCprChartWidgets(extensions as unknown as HTMLElement,
      toCprChartAttachments([area, pie, heatmap]), doc);
    assert.lengthOf(extensions.children, 3);
    const areaPlot = extensions.children[0]!.children[1]!.children[0]!;
    assert.isTrue(areaPlot.children.some(el => el.tagName === "path" && el.attrs.get("fill") !== "none"));
    const pieRoot = extensions.children[1]!;
    const piePaths = () => pieRoot.children[2]!.children[0]!.children.filter(el => el.tagName === "path");
    assert.lengthOf(piePaths(), 2);
    pieRoot.children[1]!.children.find(button => button.textContent === "B")!.click();
    assert.lengthOf(piePaths(), 1);
    pieRoot.children[1]!.children.find(button => button.textContent === "数据表")!.click();
    assert.isFalse(pieRoot.children[4]!.hidden);
    const heatmapRoot = extensions.children[2]!;
    const heatmapRects = () => heatmapRoot.children[2]!.children[0]!.children.filter(el => el.tagName === "rect");
    assert.lengthOf(heatmapRects(), 12);
    heatmapRoot.children[1]!.children.find(button => button.textContent === "X →")!.click();
    assert.lengthOf(heatmapRects(), 1);
  });
});
