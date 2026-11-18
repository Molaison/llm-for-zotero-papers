/**
 * The plugin's item-pane section sits among Zotero's own sections, and its
 * rail icon among Zotero's own rail icons. In the Stacked sidebar its head
 * must read as one of theirs: the same 16px icon box, a glyph that fills the
 * box the way the native glyphs fill theirs, the same label font, weight,
 * colour and left edge, and the same row. The rail icon must match the native
 * rail icons the same way. The Independent sidebar shows no head at all: its
 * full-pane chat hides the accordion head.
 *
 * Boxes come from layout. Glyph sizes come from the painted pixels, because
 * an icon's viewBox padding sits inside its box and only the pixels show how
 * big the drawing is.
 */
import { assert } from "chai";
import type {
  WorkflowTestApi,
  WorkflowTestFixture,
} from "../src/modules/contextPanel/workflowTestTypes";

const LAYOUT_PREF = "extensions.zotero.llmforzotero.sidebarLayout";
const THEME_PREF = "browser.theme.toolbar-theme";
const XHTML = "http://www.w3.org/1999/xhtml";
/** A pixel is ink when one colour channel is this far from the background. */
const INK = 32;
/** The native heads the user compared the plugin's head with. */
const NAMED_HEADS = ["info", "libraries-collections", "tags"];
const THEMES = ["light", "dark"] as const;
type Theme = (typeof THEMES)[number];

type Box = { left: number; top: number; width: number; height: number };
/** A glyph's painted size, and its centre's offset from its box's centre. */
type Glyph = { width: number; height: number; dx: number; dy: number };
type HeadMetrics = {
  label: string;
  /** The head row in window coordinates; everything else is relative to it. */
  row: Box;
  rowPadding: string;
  sectionPadding: string;
  icon: Box;
  iconCentreY: number;
  iconImage: string;
  glyph: Glyph;
  text: Box;
  textCentreY: number;
  font: {
    size: string;
    weight: string;
    family: string;
    color: string;
    face: string;
  };
};
type RailMetrics = { box: Box; glyph: Glyph };
type ThemeMetrics = {
  devicePixelRatio: number;
  heads: Record<string, HeadMetrics>;
  rail: Record<string, RailMetrics>;
};

const round = (value: number) => Math.round(value * 100) / 100;
const glyphSize = (glyph: Glyph) => Math.max(glyph.width, glyph.height);
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};

describe("workflow: plugin section head matches the native heads", function () {
  this.timeout(90000);

  let api: WorkflowTestApi;
  let win: any;
  let details: any;
  let fixture: WorkflowTestFixture | null = null;
  const savedPrefs = new Map<string, unknown>();
  const openStates = new Map<any, boolean>();
  let savedPinnedPane = "";
  const metrics = {} as Record<Theme, ThemeMetrics>;
  const shots: string[] = [];

  async function until(check: () => boolean, message: string) {
    const deadline = Date.now() + 10000;
    while (!check() && Date.now() < deadline) {
      await Zotero.Promise.delay(50);
    }
    assert.isTrue(check(), message);
  }

  /** Let transitions end and the next frames paint. */
  async function settle() {
    await Zotero.Promise.delay(350);
    await new Promise((resolve) =>
      win.requestAnimationFrame(() => win.requestAnimationFrame(resolve)),
    );
  }

  async function useTheme(theme: Theme) {
    Zotero.Prefs.set(THEME_PREF, theme === "dark" ? 0 : 1, true);
    await until(
      () =>
        win.matchMedia("(prefers-color-scheme: dark)").matches ===
        (theme === "dark"),
      `the ${theme} theme applies`,
    );
    await settle();
  }

  async function useLayout(layout: "independent" | "stacked") {
    Zotero.Prefs.set(LAYOUT_PREF, layout, true);
    await until(
      () =>
        win.document.documentElement.getAttribute("data-llm-sidebar-layout") ===
        layout,
      `the ${layout} layout applies`,
    );
  }

  /** Rest the pointer on the collections pane, off every head and icon. */
  function parkPointer() {
    const tree = win.document
      .getElementById("zotero-collections-pane")
      ?.getBoundingClientRect();
    if (!tree?.width) return;
    win.windowUtils.sendMouseEvent(
      "mousemove",
      tree.left + tree.width / 2,
      tree.top + tree.height / 2,
      0,
      0,
      0,
    );
  }

  function pluginSection(): any {
    return details.querySelector(
      ".llm-dedicated-chat-pane > collapsible-section",
    );
  }

  /** Every section head on screen, the plugin's keyed "plugin". */
  function visibleSections(): Array<[string, any]> {
    return Array.from(
      details.querySelectorAll("collapsible-section[data-pane]"),
    )
      .filter(
        (section: any) =>
          (section.querySelector(":scope > .head")?.getBoundingClientRect()
            .height || 0) > 0,
      )
      .map((section: any) => [
        section.closest(".llm-dedicated-chat-pane")
          ? "plugin"
          : section.dataset.pane,
        section,
      ]);
  }

  function relative(rect: DOMRect, origin: DOMRect): Box {
    return {
      left: round(rect.left - origin.left),
      top: round(rect.top - origin.top),
      width: round(rect.width),
      height: round(rect.height),
    };
  }

  function absolute(rect: DOMRect): Box {
    return {
      left: round(rect.left),
      top: round(rect.top),
      width: round(rect.width),
      height: round(rect.height),
    };
  }

  /** The ::before box a section head draws its icon in. */
  function iconBoxOf(title: Element): DOMRect {
    const before = (
      win.InspectorUtils.getChildrenForNode(title, true, false) as Node[]
    ).find((node) => node.nodeName === "_moz_generated_content_before") as
      | Element
      | undefined;
    assert.isOk(before, "the head draws its icon in ::before");
    return before!.getBoundingClientRect();
  }

  function paint(region: Box) {
    const scale = win.devicePixelRatio || 1;
    const canvas = win.document.createElementNS(XHTML, "canvas");
    canvas.width = Math.round(region.width * scale);
    canvas.height = Math.round(region.height * scale);
    const context = canvas.getContext("2d");
    context.scale(scale, scale);
    context.drawWindow(
      win,
      region.left,
      region.top,
      region.width,
      region.height,
      "#ffffff",
    );
    return { canvas, context, scale };
  }

  /**
   * Paint a window region and bound its ink: the pixels that differ from the
   * region's edge colour.
   */
  function glyphIn(region: Box): Glyph {
    const { canvas, context, scale } = paint(region);
    const { data, width, height } = context.getImageData(
      0,
      0,
      canvas.width,
      canvas.height,
    );
    const colourAt = (x: number, y: number) => {
      const index = (y * width + x) * 4;
      return (data[index] << 16) | (data[index + 1] << 8) | data[index + 2];
    };
    const counts = new Map<number, number>();
    const tally = (x: number, y: number) => {
      const colour = colourAt(x, y);
      counts.set(colour, (counts.get(colour) || 0) + 1);
    };
    for (let x = 0; x < width; x++) {
      tally(x, 0);
      tally(x, height - 1);
    }
    for (let y = 0; y < height; y++) {
      tally(0, y);
      tally(width - 1, y);
    }
    const background = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const channels = [
      (background >> 16) & 255,
      (background >> 8) & 255,
      background & 255,
    ];
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = (y * width + x) * 4;
        const distance = Math.max(
          ...channels.map((channel, offset) =>
            Math.abs(data[index + offset] - channel),
          ),
        );
        if (distance < INK) continue;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
    assert.isAtLeast(maxX, 0, "the region shows a glyph");
    return {
      width: round((maxX - minX + 1) / scale),
      height: round((maxY - minY + 1) / scale),
      dx: round((minX + maxX + 1) / 2 / scale - region.width / 2),
      dy: round((minY + maxY + 1) / 2 / scale - region.height / 2),
    };
  }

  function measureHead(section: any): HeadMetrics {
    const head = section.querySelector(":scope > .head") as Element;
    const title = head.querySelector(".title") as Element;
    const row = head.getBoundingClientRect();
    const icon = iconBoxOf(title);
    const range = win.document.createRange();
    range.selectNodeContents(title);
    const text = range.getBoundingClientRect();
    const style = win.getComputedStyle(title);
    const headStyle = win.getComputedStyle(head);
    const sectionStyle = win.getComputedStyle(section);
    const padding = (from: any) =>
      ["Top", "Right", "Bottom", "Left"]
        .map((side) => from[`padding${side}`])
        .join(" ");
    return {
      label: (title.textContent || "").trim(),
      row: absolute(row),
      rowPadding: padding(headStyle),
      sectionPadding: padding(sectionStyle),
      icon: relative(icon, row),
      iconCentreY: round(icon.top + icon.height / 2 - row.top),
      iconImage: win.getComputedStyle(title, "::before").backgroundImage,
      // A 2px margin holds the box's edge colour without reaching the label.
      glyph: glyphIn({
        left: icon.left - 2,
        top: icon.top - 2,
        width: icon.width + 4,
        height: icon.height + 4,
      }),
      text: relative(text, row),
      textCentreY: round(text.top + text.height / 2 - row.top),
      font: {
        size: style.fontSize,
        weight: style.fontWeight,
        family: style.fontFamily,
        color: style.color,
        face: (win.InspectorUtils.getUsedFontFaces(range) as any[])
          .map((face) => face.name)
          .join(", "),
      },
    };
  }

  function measureRail(): Record<string, RailMetrics> {
    const pluginPane = details.querySelector(".llm-dedicated-chat-pane")
      ?.dataset.pane;
    const rail: Record<string, RailMetrics> = {};
    for (const button of Array.from(
      details.sidenav.querySelectorAll(".btn[data-pane]"),
    ) as any[]) {
      const box = button.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      const pane = button.dataset.pane;
      rail[pane === pluginPane ? "plugin" : pane] = {
        box: absolute(box),
        // Inset past the rounded corners, so only the icon's own pixels count.
        glyph: glyphIn({
          left: box.left + 2,
          top: box.top + 2,
          width: box.width - 4,
          height: box.height - 4,
        }),
      };
    }
    return rail;
  }

  async function capture(region: Box, filename: string) {
    const { canvas } = paint(region);
    const binary = win.atob(canvas.toDataURL("image/png").split(",")[1]);
    const path = `${Zotero.DataDirectory.dir}/${filename}`;
    await win.IOUtils.write(
      path,
      Uint8Array.from(binary, (char: string) => char.charCodeAt(0)),
    );
    shots.push(path);
  }

  /** The heads, from the item pane's top to the last head, and the rail. */
  function headArea(): Box {
    const pane = win.document
      .getElementById("zotero-item-pane")
      .getBoundingClientRect();
    const rail = details.sidenav.getBoundingClientRect();
    const lastHead = Math.max(
      ...visibleSections().map(
        ([, section]) =>
          section.querySelector(":scope > .head").getBoundingClientRect()
            .bottom,
      ),
    );
    const left = Math.floor(Math.min(pane.left, rail.left));
    const top = Math.floor(pane.top);
    return {
      left,
      top,
      width: Math.ceil(Math.max(pane.right, rail.right)) - left,
      height: Math.ceil(Math.min(pane.bottom, lastHead + 16)) - top,
    };
  }

  before(async function () {
    assert.include(Zotero.DataDirectory.dir, ".scaffold/test/data");
    api = (Zotero as any).LLMForZotero.api.workflowTest;
    await api.reset();
    win = Zotero.getMainWindow();
    for (const key of [LAYOUT_PREF, THEME_PREF]) {
      savedPrefs.set(key, Zotero.Prefs.get(key, true));
    }
    fixture = await api.createPaperWithPdfFixture({
      title: "Section Head Alignment Paper",
      pdfTitle: "Section Head Alignment PDF",
    });
    await useLayout("stacked");
    await win.ZoteroPane.selectItem(fixture.parentItemId);
    details = win.document.getElementById("zotero-item-details");
    await until(
      () =>
        details.item?.id === fixture!.parentItemId &&
        win.document.documentElement.getAttribute("data-llm-pane-view") ===
          "stacked" &&
        Boolean(
          pluginSection()?.querySelector(":scope > .head .title")?.textContent,
        ),
      "the Stacked item pane shows the plugin's section head",
    );
    // No pinned pane: its badge would paint over a rail icon.
    savedPinnedPane = details.pinnedPane || "";
    details.pinnedPane = "";
    // Collapse every section so all the heads stand together, as in the
    // user's sidebar.
    for (const [, section] of visibleSections()) {
      openStates.set(section, section.open);
      if (section.open) section.open = false;
    }
    details.querySelector(".zotero-view-item").scrollTop = 0;
    parkPointer();
    for (const theme of THEMES) {
      await useTheme(theme);
      parkPointer();
      await settle();
      const heads: Record<string, HeadMetrics> = {};
      for (const [key, section] of visibleSections()) {
        heads[key] = measureHead(section);
      }
      metrics[theme] = {
        devicePixelRatio: win.devicePixelRatio || 1,
        heads,
        rail: measureRail(),
      };
      await capture(headArea(), `section-heads-stacked-${theme}.png`);
    }
    const report = `${Zotero.DataDirectory.dir}/section-head-metrics.json`;
    await win.IOUtils.writeUTF8(report, JSON.stringify(metrics, null, 2));
    Zotero.debug(`SECTION_HEAD_METRICS ${report}`, 1);
  });

  after(async function () {
    for (const [key, value] of savedPrefs) {
      if (value === undefined) Zotero.Prefs.clear(key, true);
      else Zotero.Prefs.set(key, value as never, true);
    }
    for (const [section, open] of openStates) section.open = open;
    if (details) details.pinnedPane = savedPinnedPane;
    if (shots.length) {
      Zotero.debug(`SECTION_HEAD_SCREENSHOTS ${JSON.stringify(shots)}`, 1);
    }
    if (fixture) await api.cleanupFixture(fixture);
    fixture = null;
    await api.reset();
  });

  /** The native heads to compare with: the named ones and any others shown. */
  function nativeHeads(theme: Theme): string[] {
    const shown = Object.keys(metrics[theme].heads).filter(
      (key) => key !== "plugin",
    );
    for (const pane of NAMED_HEADS) {
      assert.include(shown, pane, `the ${pane} head is on screen (${theme})`);
    }
    return shown;
  }

  it("labels the plugin's head with the plugin's name", function () {
    for (const theme of THEMES) {
      assert.equal(metrics[theme].heads.plugin?.label, "LLM-for-Zotero");
    }
  });

  for (const theme of THEMES) {
    it(`places the plugin's icon, label and row like the native heads (${theme})`, function () {
      const { heads } = metrics[theme];
      const plugin = heads.plugin;
      assert.isOk(plugin, "the plugin's head is measured");
      for (const pane of nativeHeads(theme)) {
        const native = heads[pane];
        const at = `vs ${pane} (${theme})`;
        assert.closeTo(plugin.row.height, native.row.height, 0.5, `row ${at}`);
        assert.equal(plugin.rowPadding, native.rowPadding, `padding ${at}`);
        assert.equal(plugin.sectionPadding, native.sectionPadding, at);
        for (const side of ["left", "top", "width", "height"] as const) {
          assert.closeTo(
            plugin.icon[side],
            native.icon[side],
            0.5,
            `icon box ${side} ${at}`,
          );
        }
        assert.closeTo(
          plugin.iconCentreY,
          native.iconCentreY,
          0.5,
          `icon centre ${at}`,
        );
        assert.closeTo(plugin.text.left, native.text.left, 0.5, `label ${at}`);
        assert.closeTo(
          plugin.textCentreY,
          native.textCentreY,
          0.5,
          `label centre ${at}`,
        );
        assert.closeTo(
          plugin.text.height,
          native.text.height,
          0.5,
          `label line ${at}`,
        );
        assert.deepEqual(plugin.font, native.font, `label font ${at}`);
      }
    });

    it(`draws the plugin's head glyph at the native glyph size (${theme})`, function () {
      const { heads } = metrics[theme];
      const plugin = heads.plugin.glyph;
      const natives = nativeHeads(theme);
      for (const pane of NAMED_HEADS) {
        assert.closeTo(
          glyphSize(plugin),
          glyphSize(heads[pane].glyph),
          1,
          `glyph size vs ${pane} (${theme}): ${JSON.stringify(plugin)} / ${JSON.stringify(heads[pane].glyph)}`,
        );
      }
      assert.closeTo(
        glyphSize(plugin),
        median(natives.map((pane) => glyphSize(heads[pane].glyph))),
        1,
        `glyph size vs the native median (${theme})`,
      );
      assert.closeTo(plugin.dx, 0, 1, `glyph centred across its box`);
      assert.closeTo(plugin.dy, 0, 1, `glyph centred down its box`);
    });

    it(`draws the plugin's rail icon like the native rail icons (${theme})`, function () {
      const { rail } = metrics[theme];
      const plugin = rail.plugin;
      assert.isOk(plugin, "the plugin's rail icon is measured");
      // The rail runs down the pane's edge, or along its foot when Zotero
      // stacks the item pane: the buttons share the other axis.
      const across = details.sidenav.classList.contains("stacked")
        ? "top"
        : "left";
      const natives = Object.keys(rail).filter((key) => key !== "plugin");
      const named = NAMED_HEADS.map((pane) => {
        assert.include(natives, pane, `the ${pane} rail icon is on screen`);
        const native = rail[pane];
        assert.closeTo(plugin.box[across], native.box[across], 0.5, pane);
        assert.closeTo(plugin.box.width, native.box.width, 0.5, pane);
        assert.closeTo(plugin.box.height, native.box.height, 0.5, pane);
        return glyphSize(native.glyph);
      });
      // The native rail glyphs themselves span about 2px, so the plugin's
      // must sit within 1px of their median and of the named ones' range.
      const size = glyphSize(plugin.glyph);
      const sizes = JSON.stringify(
        Object.fromEntries(
          Object.entries(rail).map(([pane, { glyph }]) => [pane, glyph]),
        ),
      );
      assert.closeTo(
        size,
        median(natives.map((pane) => glyphSize(rail[pane].glyph))),
        1,
        `rail glyph vs the native median (${theme}): ${sizes}`,
      );
      assert.isAtLeast(size, Math.min(...named) - 1, `rail glyph (${theme})`);
      assert.isAtMost(size, Math.max(...named) + 1, `rail glyph (${theme})`);
      assert.closeTo(plugin.glyph.dx, 0, 1, "rail glyph centred across");
      assert.closeTo(plugin.glyph.dy, 0, 1, "rail glyph centred down");
    });
  }

  it("shows no plugin head in the Independent layout and keeps the rail icon", async function () {
    const root = win.document.documentElement;
    for (const theme of THEMES) {
      await useTheme(theme);
      await useLayout("independent");
      const section = pluginSection();
      const main = () =>
        section.querySelector("#llm-main")?.getBoundingClientRect().height || 0;
      if (
        root.getAttribute("data-llm-pane-view") !== "chat" ||
        details.sidenav._collapsed
      ) {
        const button = Array.from(
          details.sidenav.querySelectorAll(".btn[data-pane]"),
        ).find(
          (node: any) =>
            node.dataset.pane ===
            details.querySelector(".llm-dedicated-chat-pane").dataset.pane,
        ) as any;
        assert.isOk(button, "the plugin's rail icon exists");
        button.dispatchEvent(
          new win.MouseEvent("click", { bubbles: true, detail: 1, button: 0 }),
        );
      }
      await until(
        () =>
          root.getAttribute("data-llm-pane-view") === "chat" &&
          !details.sidenav._collapsed &&
          main() > 0,
        `the Independent chat opens (${theme})`,
      );
      details.pinnedPane = "";
      parkPointer();
      await settle();
      const head = section.querySelector(":scope > .head");
      assert.equal(win.getComputedStyle(head).display, "none", theme);
      assert.equal(head.getBoundingClientRect().height, 0, theme);
      // The rail icon is the same in both layouts.
      const rail = measureRail().plugin;
      const stacked = metrics[theme].rail.plugin;
      for (const side of ["width", "height"] as const) {
        assert.closeTo(rail.box[side], stacked.box[side], 0.5, theme);
        assert.closeTo(rail.glyph[side], stacked.glyph[side], 0.5, theme);
      }
      const box = details.sidenav.getBoundingClientRect();
      await capture(
        {
          left: Math.floor(box.left),
          top: Math.floor(box.top),
          width: Math.ceil(box.width),
          height: Math.ceil(Math.min(box.height, 360)),
        },
        `section-rail-independent-${theme}.png`,
      );
    }
    await useLayout("stacked");
  });
});
