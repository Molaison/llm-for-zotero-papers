/// <reference types="zotero-types" />

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "chai";
import { after, beforeEach, describe, it } from "mocha";
import {
  BUILTIN_SHORTCUT_FILES,
  config,
} from "../src/modules/contextPanel/constants";
import { loadShortcutText } from "../src/modules/contextPanel/shortcuts";
import { shortcutTextCache } from "../src/modules/contextPanel/state";
import { initI18n } from "../src/utils/i18n";

const here = dirname(fileURLToPath(import.meta.url));

type FakeResponse = { ok: boolean; text: () => Promise<string> };

describe("built-in shortcut prompt locale", function () {
  const globals = globalThis as typeof globalThis & {
    Zotero?: typeof Zotero;
    ztoolkit?: unknown;
  };
  const originalZotero = globals.Zotero;
  const originalToolkit = globals.ztoolkit;
  const englishUri = `chrome://${config.addonRef}/content/shortcuts/summarize.txt`;
  const chineseUri = `chrome://${config.addonRef}/content/shortcuts/zh-CN/summarize.txt`;
  let prefStore: Map<string, unknown>;
  let responses: Map<string, FakeResponse>;
  let fetched: string[];

  function install(locale: string, localePref?: string): void {
    prefStore = new Map();
    if (localePref !== undefined) {
      prefStore.set("extensions.zotero.llmforzotero.locale", localePref);
    }
    globals.Zotero = {
      locale,
      Prefs: {
        get: (key: string) => prefStore.get(key),
        set: (key: string, value: unknown) => {
          prefStore.set(key, value);
        },
      },
    } as unknown as typeof Zotero;
    initI18n();
  }

  beforeEach(function () {
    shortcutTextCache.clear();
    fetched = [];
    responses = new Map([
      [englishUri, { ok: true, text: async () => "English prompt" }],
      [chineseUri, { ok: true, text: async () => "中文提示" }],
    ]);
    const fakeFetch = async (uri: string): Promise<FakeResponse> => {
      fetched.push(uri);
      const response = responses.get(uri);
      if (!response) throw new Error(`not found: ${uri}`);
      return response;
    };
    globals.ztoolkit = {
      getGlobal: (name: string) => (name === "fetch" ? fakeFetch : undefined),
    };
  });

  after(function () {
    globals.Zotero = originalZotero;
    globals.ztoolkit = originalToolkit;
    shortcutTextCache.clear();
    initI18n();
  });

  it("fetches only the English prompt for an English locale", async function () {
    install("en-US");
    const text = await loadShortcutText("summarize.txt");
    assert.equal(text, "English prompt");
    assert.deepEqual(fetched, [englishUri]);
  });

  it("fetches the zh-CN prompt when the plugin language is Chinese", async function () {
    install("en-US", "zh-CN");
    const text = await loadShortcutText("summarize.txt");
    assert.equal(text, "中文提示");
    assert.deepEqual(fetched, [chineseUri]);
  });

  it("falls back to the English prompt when the zh-CN file is missing", async function () {
    install("en-US", "zh-CN");
    responses.set(chineseUri, { ok: false, text: async () => "" });
    const text = await loadShortcutText("summarize.txt");
    assert.equal(text, "English prompt");
    assert.deepEqual(fetched, [chineseUri, englishUri]);
  });

  it("falls back to the English prompt when the zh-CN fetch throws", async function () {
    install("en-US", "zh-CN");
    responses.delete(chineseUri);
    const text = await loadShortcutText("summarize.txt");
    assert.equal(text, "English prompt");
    assert.deepEqual(fetched, [chineseUri, englishUri]);
  });

  it("caches prompts per locale key", async function () {
    install("zh-CN", "auto");
    assert.equal(await loadShortcutText("summarize.txt"), "中文提示");
    assert.equal(await loadShortcutText("summarize.txt"), "中文提示");
    assert.deepEqual(fetched, [chineseUri]);

    install("en-US", "en-US");
    assert.equal(await loadShortcutText("summarize.txt"), "English prompt");
    assert.equal(await loadShortcutText("summarize.txt"), "English prompt");
    assert.deepEqual(fetched, [chineseUri, englishUri]);
  });

  it("still throws when the English prompt cannot be loaded", async function () {
    install("en-US");
    responses.set(englishUri, { ok: false, text: async () => "" });
    let error: unknown;
    try {
      await loadShortcutText("summarize.txt");
    } catch (caught) {
      error = caught;
    }
    assert.instanceOf(error, Error);
    assert.match((error as Error).message, /Failed to load summarize\.txt/);
  });

  it("ships a non-empty zh-CN prompt for every built-in shortcut", function () {
    for (const shortcut of BUILTIN_SHORTCUT_FILES) {
      const path = resolve(
        here,
        "../addon/content/shortcuts/zh-CN",
        shortcut.file,
      );
      assert.isTrue(existsSync(path), `missing zh-CN/${shortcut.file}`);
      assert.isNotEmpty(readFileSync(path, "utf8").trim());
    }
  });
});
