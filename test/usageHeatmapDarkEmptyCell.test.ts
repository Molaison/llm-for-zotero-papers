import { assert } from "chai";
import {
  USAGE_DARK_PALETTE,
  USAGE_LIGHT_PALETTE,
  resolveUsagePalette,
} from "../src/utils/usageView";

/**
 * WHY THIS EXISTS: on the dark pane the shared subtle surface
 * (`--llm-usage-subtle`, a desaturated grey) was LIGHTER than the darkest ramp
 * stop, so "no activity" read brighter than "a little activity" — the legend
 * ran More → Less → More. The dark theme therefore owns an empty-cell colour
 * of its own, darker than ramp stop 1 and near-neutral so it stays clearly
 * outside the green ramp. Light mode is unchanged.
 */

function parseHex(color: string): { r: number; g: number; b: number } {
  const match = /^#([0-9a-f]{6})$/i.exec(color.trim());
  assert.isNotNull(match, `${color} is a plain hex colour`);
  const value = parseInt(match![1]!, 16);
  return {
    r: (value >> 16) & 0xff,
    g: (value >> 8) & 0xff,
    b: value & 0xff,
  };
}

/** Relative luminance, the thing the eye actually orders these by. */
function luminance(color: string): number {
  const { r, g, b } = parseHex(color);
  const channel = (raw: number) => {
    const c = raw / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** How far from grey a colour is, 0..1 of its own brightest channel. */
function saturation(color: string): number {
  const { r, g, b } = parseHex(color);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

describe("usage heatmap empty cell", function () {
  it("keeps the dark legend monotonic from empty through all five stops", function () {
    const palette = resolveUsagePalette("dark");
    const stops = [palette.emptyCell, ...palette.ramp];
    const lightness = stops.map(luminance);
    for (let index = 1; index < lightness.length; index += 1) {
      assert.isAbove(
        lightness[index]!,
        lightness[index - 1]!,
        `dark stop ${index} (${stops[index]}) must be lighter than ${stops[index - 1]}`,
      );
    }
  });

  it("keeps the dark empty cell near-neutral, outside the green ramp", function () {
    assert.isBelow(saturation(USAGE_DARK_PALETTE.emptyCell), 0.2);
    for (const stop of USAGE_DARK_PALETTE.ramp) {
      assert.isAbove(saturation(stop), 0.4);
    }
  });

  it("leaves the light pane on the shared subtle surface", function () {
    assert.strictEqual(
      USAGE_LIGHT_PALETTE.emptyCell,
      "var(--llm-usage-subtle)",
    );
    assert.strictEqual(
      resolveUsagePalette("light").emptyCell,
      USAGE_LIGHT_PALETTE.emptyCell,
    );
  });
});
