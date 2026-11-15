import { assert } from "chai";
import bundledRegistry from "../registry/model-capabilities.v1.json";
import {
  configureModelCapabilityRuntime,
  getModelCapabilities,
  initializeModelCapabilityRegistry,
  refreshModelCapabilityRegistry,
  resetModelCapabilityStateForTests,
} from "../src/modelCapabilities";
import { getModelCapabilityRegistryCachePath } from "../src/modelCapabilities/registryCache";

describe("workflow: model capability registry disk cache", function () {
  it("migrates real Zotero preferences and reloads the file with a full timestamp", async function () {
    const path = getModelCapabilityRegistryCachePath();
    const keys = [
      "extensions.zotero.llmforzotero.modelCapabilitiesRegistry",
      "extensions.zotero.llmforzotero.modelCapabilitiesRegistryFetchedAt",
    ];
    const originalPrefs = keys.map((key) => Zotero.Prefs.get(key, true));
    const originalFile = (await IOUtils.exists(path))
      ? await IOUtils.read(path)
      : null;
    const registry = {
      ...bundledRegistry,
      revision: bundledRegistry.revision + 1,
      models: [
        ...bundledRegistry.models,
        {
          match: { provider: "kimi", exact: "workflow-cache-model" },
          limits: { inputTokens: 2_000_000 },
        },
      ],
    };
    const now = Date.now();
    let fetches = 0;
    const configure = () =>
      configureModelCapabilityRuntime({
        now: () => now,
        fetch: (async () => {
          fetches += 1;
          return {
            ok: true,
            text: async () => JSON.stringify(registry),
          } as Response;
        }) as typeof fetch,
      });

    resetModelCapabilityStateForTests();
    configure();
    try {
      await IOUtils.remove(path, { ignoreAbsent: true });
      keys.forEach((key) => Zotero.Prefs.clear(key, true));
      // Reproduce the old write using the actual Gecko preference service.
      Zotero.Prefs.set(keys[0], JSON.stringify(registry), true);
      Zotero.Prefs.set(keys[1], now, true);
      assert.notEqual(Zotero.Prefs.get(keys[1], true), now);

      await initializeModelCapabilityRegistry();
      assert.equal(fetches, 0, "startup cache loading is local only");
      for (const key of keys) assert.isUndefined(Zotero.Prefs.get(key, true));
      assert.isTrue(await IOUtils.exists(path));
      assert.equal(
        getModelCapabilities({
          provider: "kimi",
          model: "workflow-cache-model",
        }).limits.inputTokens,
        2_000_000,
      );

      await refreshModelCapabilityRegistry();
      const saved = JSON.parse(await IOUtils.readUTF8(path));
      assert.equal(saved.fetchedAt, now);
      assert.equal(saved.registry.revision, registry.revision);
      assert.equal(fetches, 1);
      assert.isFalse(await IOUtils.exists(`${path}.tmp`));

      resetModelCapabilityStateForTests();
      configure();
      await refreshModelCapabilityRegistry();
      assert.equal(fetches, 1, "reload honors the cached 24-hour interval");
      for (const key of keys) assert.isUndefined(Zotero.Prefs.get(key, true));
    } finally {
      resetModelCapabilityStateForTests();
      if (originalFile) await IOUtils.write(path, originalFile);
      else await IOUtils.remove(path, { ignoreAbsent: true });
      await IOUtils.remove(`${path}.tmp`, { ignoreAbsent: true });
      keys.forEach((key, index) => {
        Zotero.Prefs.clear(key, true);
        if (originalPrefs[index] !== undefined) {
          Zotero.Prefs.set(key, originalPrefs[index], true);
        }
      });
    }
  });
});
