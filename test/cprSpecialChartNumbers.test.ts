import { assert } from "chai";
import { renderCprChartWidgets } from "../src/modules/contextPanel/cprChartRenderer";
import { toCprChartAttachments } from "../src/utils/cprRichWidgets";

describe("CPR special chart finite-number rendering", function () {
  class ElementStub {
    children: ElementStub[] = [];
    attrs = new Map<string, string>();
    listeners = new Map<
      string,
      (e: { preventDefault(): void; stopPropagation(): void }) => void
    >();
    textContent = "";
    style: Record<string, string> = {};
    hidden = false;
    type = "";
    constructor(public tagName: string) {}
    appendChild(child: ElementStub) {
      this.children.push(child);
      return child;
    }
    append(...children: ElementStub[]) {
      children.forEach((child) => this.appendChild(child));
    }
    replaceChildren(...children: ElementStub[]) {
      this.children = children;
    }
    setAttribute(key: string, value: string) {
      this.attrs.set(key, value);
    }
    addEventListener(
      name: string,
      handler: (e: { preventDefault(): void; stopPropagation(): void }) => void,
    ) {
      this.listeners.set(name, handler);
    }
    click() {
      this.listeners.get("click")?.({
        preventDefault() {},
        stopPropagation() {},
      });
    }
  }
  const doc = {
    createElement: (tag: string) => new ElementStub(tag),
    createElementNS: (_ns: string, tag: string) => new ElementStub(tag),
  } as unknown as Document;

  function render(widget: unknown) {
    const host = new ElementStub("host");
    const attachments = toCprChartAttachments([widget]);
    assert.lengthOf(attachments, 1);
    renderCprChartWidgets(host as unknown as HTMLElement, attachments, doc);
    const root = host.children[0]!;
    return { root, marks: root.children[2]!.children[0]!.children };
  }
  for (const values of [
    [-1e308, 0, 1e308],
    [-10, 0, 10],
    [0, 0, 0],
    [1e-300, 2e-300, 3e-300],
    [1e308, 1.0000000000000002e308],
    [Number.MIN_VALUE, Number.MIN_VALUE * 2],
    [-Number.MAX_VALUE, Number.MAX_VALUE],
  ]) {
    it(`keeps heatmap opacity proportional for ${values.join(",")}`, function () {
      const { marks } = render({
        version: 1,
        kind: "heatmap_chart",
        id: "chart-1",
        title: "",
        xField: "x",
        yField: "y",
        valueField: "v",
        cells: values.map((value, i) => ({ x: String(i), y: "row", value })),
      });
      const opacity = marks
        .filter((el) => el.tagName === "rect")
        .map((el) => Number(el.attrs.get("opacity")));
      opacity.forEach((value) => {
        assert.isTrue(Number.isFinite(value));
        assert.isAtLeast(value, 0.16);
        assert.isAtMost(value, 1);
      });
      assert.closeTo(opacity[0]!, 0.16, 1e-12);
      if (values[0] !== values[values.length - 1])
        assert.closeTo(opacity[opacity.length - 1]!, 1, 1e-12);
      if (values[1] === 0 && values[0] !== 0)
        assert.closeTo(opacity[1]!, 0.58, 1e-12);
    });
  }
});
