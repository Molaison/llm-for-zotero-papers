import { assert } from "chai";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import {
  getSidebarLayout,
  SIDEBAR_LAYOUT_PREF,
} from "../src/modules/contextPanel/sidebarLayout";

describe("sidebar layout preference", function () {
  const globals = globalThis as any;
  let originalZotero: any;

  beforeEach(function () {
    originalZotero = globals.Zotero;
  });

  afterEach(function () {
    globals.Zotero = originalZotero;
  });

  it("ships Stacked as the default preference", function () {
    const defaults = new Map<string, unknown>();
    runInNewContext(readFileSync("addon/prefs.js", "utf8"), {
      pref: (key: string, value: unknown) => defaults.set(key, value),
    });
    assert.equal(defaults.get("sidebarLayout"), "stacked");
  });

  it("labels Stacked as default in settings and translations", function () {
    const markup = readFileSync("addon/content/preferences.xhtml", "utf8");
    const script = readFileSync("src/modules/preferenceScript.ts", "utf8");
    const translations = readFileSync("src/utils/i18n.ts", "utf8");
    assert.include(
      markup,
      '<html:option value="stacked">Stacked (default)</html:option>',
    );
    assert.include(
      markup,
      '<html:option value="independent">Independent</html:option>',
    );
    assert.include(script, '"Stacked (default)"');
    assert.notInclude(script, '"Independent (default)"');
    assert.include(translations, '"Stacked (default)": "堆叠（默认）"');
  });

  for (const value of [
    undefined,
    null,
    "",
    "invalid",
    "stacked",
    "independent",
  ]) {
    it(`resolves ${String(value)} to ${value === "independent" ? "Independent" : "Stacked"}`, function () {
      globals.Zotero = {
        Prefs: {
          get(key: string, global: boolean) {
            assert.equal(key, SIDEBAR_LAYOUT_PREF);
            assert.isTrue(global);
            return value;
          },
        },
      };
      assert.equal(
        getSidebarLayout(),
        value === "independent" ? "independent" : "stacked",
      );
    });
  }

  it("falls back to Stacked if preferences cannot be read", function () {
    globals.Zotero = {
      Prefs: {
        get() {
          throw new Error("Preferences unavailable");
        },
      },
    };
    assert.equal(getSidebarLayout(), "stacked");
  });
});
