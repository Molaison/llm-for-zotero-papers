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
  function pie(slices: Array<{ label: string; value: number }>) {
    return render({
      version: 1,
      kind: "pie_chart",
      id: "chart-1",
      title: "",
      labelField: "category",
      valueField: "value",
      slices,
    });
  }
  function paths(root: ElementStub) {
    return root.children[2]!.children[0]!.children;
  }
  function assertEnd(path: ElementStub, fraction: number) {
    const d = path.attrs.get("d")!;
    assert.notMatch(d, /NaN|Infinity/);
    const end = /1 ([^ ]+) ([^ ]+) Z$/.exec(d)!;
    assert.isTrue(Boolean(end));
    const angle = -Math.PI / 2 + fraction * Math.PI * 2;
    assert.closeTo(Number(end[1]), 320 + Math.cos(angle) * 117, 1e-10);
    assert.closeTo(Number(end[2]), 146 + Math.sin(angle) * 117, 1e-10);
  }
  for (const value of [1e308, Number.MAX_VALUE, 1e-300, Number.MIN_VALUE, 7]) {
    it(`keeps grouped pie proportions finite for ${value}`, function () {
      const { root } = pie([
        { label: "A", value },
        { label: "A", value },
        { label: "B", value },
      ]);
      assert.lengthOf(paths(root), 2);
      assertEnd(paths(root)[0]!, 2 / 3);
      assertEnd(paths(root)[1]!, 1);
      const sum = value + value;
      assert.equal(
        paths(root)[0]!.children[0]!.textContent,
        `A: ${Number.isFinite(sum) ? sum : `${value} + ${value}`}`,
      );
      const rows = root.children[4]!.children[1]!.children;
      assert.lengthOf(rows, 3);
      assert.equal(rows[0]!.children[1]!.textContent, String(value));
      root.children[1]!.children[0]!.click();
      assert.isFalse(root.children[4]!.hidden);
    });
  }
  it("preserves finite decimal tooltips without reconstructing the sum", function () {
    const { root } = pie([
      { label: "A", value: 0.1 },
      { label: "A", value: 0.2 },
      { label: "B", value: 0.3 },
    ]);
    assert.equal(
      paths(root)[0]!.children[0]!.textContent,
      "A: 0.30000000000000004",
    );
    assertEnd(paths(root)[0]!, 0.5);
  });
  it("keeps both overflowing categories proportional at the row limit", function () {
    const { root } = pie(
      Array.from({ length: 300 }, (_, i) => ({
        label: i < 200 ? "A" : "B",
        value: Number.MAX_VALUE,
      })),
    );
    assert.lengthOf(paths(root), 2);
    assertEnd(paths(root)[0]!, 2 / 3);
    assertEnd(paths(root)[1]!, 1);
    assert.equal(
      paths(root)[0]!.children[0]!.textContent,
      `A: ${Array(200).fill(String(Number.MAX_VALUE)).join(" + ")}`,
    );
  });
  it("rescales pie data after toggling a dominating category", function () {
    const { root } = pie([
      { label: "large", value: Number.MAX_VALUE },
      { label: "tiny", value: Number.MIN_VALUE },
      { label: "tiny", value: Number.MIN_VALUE },
      { label: "small", value: Number.MIN_VALUE },
    ]);
    const buttons = root.children[1]!.children;
    buttons[1]!.click();
    assert.equal(buttons[1]!.attrs.get("aria-pressed"), "false");
    assert.lengthOf(paths(root), 2);
    assertEnd(paths(root)[0]!, 2 / 3);
    assertEnd(paths(root)[1]!, 1);
    buttons[2]!.click();
    assert.lengthOf(paths(root), 1);
    assert.notMatch(paths(root)[0]!.attrs.get("d")!, /NaN|Infinity/);
    assert.include(paths(root)[0]!.attrs.get("d")!, "A117 117 0 1 1 320 263");
    buttons[3]!.click();
    assert.lengthOf(paths(root), 0);
    buttons[2]!.click();
    buttons[3]!.click();
    assertEnd(paths(root)[0]!, 2 / 3);
    buttons[1]!.click();
    paths(root).forEach((path) =>
      assert.notMatch(path.attrs.get("d")!, /NaN|Infinity/),
    );
  });
});
