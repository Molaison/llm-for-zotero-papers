import { assert } from "chai";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { config } from "../package.json";
import {
  getModelProviderGroups,
  resolveConfiguredModelCapabilities,
  setModelProviderGroups,
} from "../src/utils/modelProviders";
import { normalizePaperRouteTarget } from "../src/utils/cprPapers";

describe("CPR papers public configuration", function () {
  let original: typeof Zotero;
  let prefs: Map<string, unknown>;
  beforeEach(function () {
    original = globalThis.Zotero;
    prefs = new Map<string, unknown>();
    globalThis.Zotero = {
      Prefs: {
        get: (key: string) => prefs.get(key),
        set: (key: string, value: unknown) => prefs.set(key, value),
      },
    } as unknown as typeof Zotero;
  });
  afterEach(function () {
    globalThis.Zotero = original;
  });

  it("enables this add-on's updates from the papers fork on Zotero 7 and 8", async function () {
    const manifest = JSON.parse(
      readFileSync(new URL("../addon/manifest.json", import.meta.url), "utf8"),
    );
    assert.equal(
      manifest.applications.zotero.update_url,
      "https://github.com/Molaison/llm-for-zotero-papers/releases/download/release/update-beta.json",
    );
    const bootstrap = readFileSync(
      new URL("../addon/bootstrap.js", import.meta.url),
      "utf8",
    );
    for (const version of ["7.0", "8.0"]) {
      const self = { applyBackgroundUpdates: 0 };
      let imported = "";
      const exports = {
        AddonManager: {
          AUTOUPDATE_ENABLE: 2,
          getAddonByID: async (id: string) => {
            assert.equal(id, config.addonID);
            return self;
          },
        },
      };
      const context = {
        Zotero: {
          version,
          __addonInstance__: { hooks: { onStartup: async () => {} } },
        },
        ChromeUtils: {
          import: (path: string) => {
            imported = path;
            return exports;
          },
          importESModule: (path: string) => {
            imported = path;
            return exports;
          },
        },
        Components: {
          classes: {
            "@mozilla.org/addons/addon-manager-startup;1": {
              getService: () => ({ registerChrome: () => ({}) }),
            },
          },
          interfaces: { amIAddonManagerStartup: {} },
        },
        Services: {
          io: { newURI: (value: string) => value },
          scriptloader: { loadSubScript: () => {} },
        },
      };
      await runInNewContext(
        bootstrap +
          "\nstartup({id: '" +
          config.addonID +
          "', rootURI: 'file:///addon/'}, 0)",
        context,
      );
      assert.equal(self.applyBackgroundUpdates, 2);
      assert.equal(
        imported.endsWith(
          version.startsWith("7") ? "AddonManager.jsm" : "AddonManager.sys.mjs",
        ),
        true,
      );
    }
  });

  it("does not synthesize a provider group or select a papers model", function () {
    setModelProviderGroups([]);
    const groups = getModelProviderGroups();
    assert.deepEqual(groups, []);
  });

  it("round-trips explicit route capabilities on a provider group", function () {
    setModelProviderGroups([
      {
        id: "registry",
        apiBase: "https://reading.example/v1",
        apiKey: "retained-key",
        authMode: "api_key",
        providerProtocol: "responses_api",
        paperRegistry: true,
        directWebPdf: false,
        models: [{ id: "any-alias", model: "reading-model" }],
      },
      {
        id: "plain",
        apiBase: "https://plain.example/v1",
        apiKey: "other-key",
        authMode: "api_key",
        providerProtocol: "responses_api",
        models: [{ id: "paper-shaped", model: "papers/gpt-6-sol" }],
      },
    ]);
    const groups = getModelProviderGroups();
    assert.equal(groups[0].id, "registry");
    assert.equal(
      (groups[0] as { paperRegistry?: boolean }).paperRegistry,
      true,
    );
    assert.equal(
      (groups[1] as { paperRegistry?: boolean }).paperRegistry,
      undefined,
    );

    assert.deepEqual(
      resolveConfiguredModelCapabilities({
        entryId: "any-alias",
        model: "reading-model",
        apiBase: "https://reading.example/v1",
      }),
      { paperRegistry: true, directWebPdf: false },
    );
    assert.deepEqual(
      resolveConfiguredModelCapabilities({
        entryId: "paper-shaped",
        model: "papers/gpt-6-sol",
        apiBase: "https://plain.example/v1",
      }),
      { paperRegistry: false, directWebPdf: false },
    );
  });

  it("keeps a custom alias on a capability-enabled route usable", function () {
    setModelProviderGroups([
      {
        id: "registry",
        apiBase: "http://127.0.0.1:18100/v1",
        apiKey: "",
        authMode: "api_key",
        providerProtocol: "responses_api",
        paperRegistry: true,
        directWebPdf: true,
        models: [{ id: "custom", model: "my/reading-alias" }],
      },
    ]);
    assert.deepEqual(
      resolveConfiguredModelCapabilities({
        model: "my/reading-alias",
        apiBase: "http://127.0.0.1:18100/v1",
      }),
      { paperRegistry: true, directWebPdf: true },
    );
    assert.deepEqual(
      resolveConfiguredModelCapabilities({
        model: "papers/gpt-6-sol",
        apiBase: "http://127.0.0.1:18100/v1",
      }),
      { paperRegistry: false, directWebPdf: false },
    );
  });

  it("keeps the configured endpoint instead of rewriting it to a default host", function () {
    assert.equal(
      normalizePaperRouteTarget("http://192.168.233.231:18082/v1/"),
      "http://192.168.233.231:18082/v1",
    );
    assert.equal(
      normalizePaperRouteTarget("https://reading.example/v1/responses"),
      "https://reading.example/v1",
    );
    assert.notEqual(
      normalizePaperRouteTarget("https://example.org/v1"),
      normalizePaperRouteTarget("https://other.example/v1"),
    );
  });
});
