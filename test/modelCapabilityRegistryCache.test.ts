import { assert } from "chai";
import bundledRegistry from "../registry/model-capabilities.v1.json";
import {
  configureModelCapabilityRuntime,
  getActiveModelCapabilityRegistryForTests,
  getModelCapabilities,
  initializeModelCapabilityRegistry,
  refreshModelCapabilityRegistry,
  resetModelCapabilityStateForTests,
} from "../src/modelCapabilities";
import {
  getModelCapabilityRegistryCachePath,
  type ModelCapabilityRegistryCache,
} from "../src/modelCapabilities/registryCache";

const REGISTRY_PREF =
  "extensions.zotero.llmforzotero.modelCapabilitiesRegistry";
const TIMESTAMP_PREF = `${REGISTRY_PREF}FetchedAt`;
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 29);
const newerRegistry = {
  ...bundledRegistry,
  revision: bundledRegistry.revision + 1,
  models: [
    ...bundledRegistry.models,
    {
      match: { provider: "kimi", exact: "cache-test-model" },
      limits: { inputTokens: 2_000_000 },
    },
  ],
};

describe("model capability registry persistence", function () {
  const globals = globalThis as any;
  let originalZotero: unknown;
  let originalIO: unknown;
  let prefs: Map<string, unknown>;
  let file: Uint8Array | undefined;
  let reads: number;
  let writes: number;
  let fetches: number;
  let clock: number;
  let failWrite: boolean;
  let failClear: boolean;
  let remote: unknown;
  let beforeWrite: (() => Promise<void>) | undefined;

  function configure(): void {
    configureModelCapabilityRuntime({
      now: () => clock,
      fetch: (async () => {
        fetches += 1;
        return new Response(JSON.stringify(remote));
      }) as typeof fetch,
    });
  }

  function saved(): ModelCapabilityRegistryCache {
    return JSON.parse(new TextDecoder().decode(file));
  }

  function seedFile(registry: unknown, fetchedAt: unknown = NOW): void {
    file = new TextEncoder().encode(
      JSON.stringify({ schemaVersion: 1, registry, fetchedAt }),
    );
  }

  beforeEach(function () {
    originalZotero = globals.Zotero;
    originalIO = globals.IOUtils;
    prefs = new Map();
    file = undefined;
    reads = writes = fetches = 0;
    clock = NOW;
    failWrite = failClear = false;
    beforeWrite = undefined;
    remote = newerRegistry;
    globals.Zotero = {
      Profile: { dir: "/test-profile" },
      Prefs: {
        get: (key: string) => prefs.get(key),
        set: () => assert.fail("Registry persistence must never write a pref"),
        clear: (key: string) => {
          if (failClear) throw new Error("Preference service unavailable");
          prefs.delete(key);
        },
      },
    };
    globals.IOUtils = {
      read: async (path: string, options: { maxBytes: number }) => {
        reads += 1;
        assert.equal(path, getModelCapabilityRegistryCachePath());
        if (!file) throw new Error("Not found");
        return file.slice(0, options.maxBytes);
      },
      write: async (
        path: string,
        bytes: Uint8Array,
        options: { tmpPath: string; flush: boolean },
      ) => {
        writes += 1;
        assert.equal(path, getModelCapabilityRegistryCachePath());
        assert.deepEqual(options, { tmpPath: `${path}.tmp`, flush: true });
        await beforeWrite?.();
        if (failWrite) throw new Error("Disk full");
        file = bytes.slice();
      },
    };
    resetModelCapabilityStateForTests();
    configure();
  });

  afterEach(function () {
    resetModelCapabilityStateForTests();
    globals.Zotero = originalZotero;
    globals.IOUtils = originalIO;
  });

  it("preserves millisecond timestamps and the daily refresh interval across reloads", async function () {
    assert.isTrue(await refreshModelCapabilityRegistry());
    assert.equal(saved().fetchedAt, NOW);
    assert.deepEqual(
      saved().registry,
      getActiveModelCapabilityRegistryForTests(),
    );
    assert.equal(writes, 1);

    resetModelCapabilityStateForTests();
    configure();
    clock += DAY - 1;
    assert.isFalse(await refreshModelCapabilityRegistry());
    assert.equal(fetches, 1);
    assert.equal(writes, 1);
    assert.equal(
      getModelCapabilities({ provider: "kimi", model: "cache-test-model" })
        .limits.inputTokens,
      2_000_000,
    );

    clock += 1;
    assert.isFalse(await refreshModelCapabilityRegistry());
    assert.equal(fetches, 2, "unchanged revisions still renew freshness daily");
    assert.equal(writes, 2);
    assert.equal(saved().fetchedAt, clock);
    await refreshModelCapabilityRegistry({ force: true });
    assert.equal(fetches, 3, "explicit refresh still bypasses the interval");
  });

  it("loads once without network and exposes cached capabilities before controls mount", async function () {
    seedFile(newerRegistry);
    await Promise.all([
      initializeModelCapabilityRegistry(),
      initializeModelCapabilityRegistry(),
    ]);
    assert.equal(reads, 1);
    assert.equal(fetches, 0);
    assert.equal(writes, 0);
    assert.equal(
      getActiveModelCapabilityRegistryForTests().revision,
      newerRegistry.revision,
    );
  });

  it("migrates a large legacy registry only after the atomic save finishes", async function () {
    const legacy = JSON.stringify(newerRegistry);
    assert.isAbove(legacy.length, 4096);
    prefs.set(REGISTRY_PREF, legacy);
    prefs.set(TIMESTAMP_PREF, NOW | 0);
    beforeWrite = async () => {
      assert.equal(prefs.get(REGISTRY_PREF), legacy);
      assert.isTrue(prefs.has(TIMESTAMP_PREF));
    };
    await initializeModelCapabilityRegistry();
    assert.isEmpty([...prefs]);
    assert.equal(saved().registry.revision, newerRegistry.revision);
    beforeWrite = undefined;
    await refreshModelCapabilityRegistry();
    assert.equal(fetches, 1, "the truncated legacy timestamp is stale");
    assert.equal(saved().fetchedAt, NOW);
  });

  it("retains legacy data after a failed migration and retries on reload", async function () {
    prefs.set(REGISTRY_PREF, JSON.stringify(newerRegistry));
    prefs.set(TIMESTAMP_PREF, String(NOW));
    failWrite = true;
    await initializeModelCapabilityRegistry();
    assert.isTrue(prefs.has(REGISTRY_PREF));
    assert.isTrue(prefs.has(TIMESTAMP_PREF));
    assert.isUndefined(file);
    assert.equal(
      getActiveModelCapabilityRegistryForTests().revision,
      newerRegistry.revision,
    );
    failWrite = false;
    resetModelCapabilityStateForTests();
    configure();
    await initializeModelCapabilityRegistry();
    assert.equal(saved().fetchedAt, NOW);
    assert.isEmpty([...prefs]);
  });

  it("retries failed preference cleanup from the durable file without rewriting it", async function () {
    prefs.set(REGISTRY_PREF, JSON.stringify(newerRegistry));
    failClear = true;
    await initializeModelCapabilityRegistry();
    assert.isTrue(prefs.has(REGISTRY_PREF));
    assert.equal(writes, 1);
    failClear = false;
    resetModelCapabilityStateForTests();
    configure();
    await initializeModelCapabilityRegistry();
    assert.isEmpty([...prefs]);
    assert.equal(writes, 1);
  });

  it("keeps the previous file and fresh in-memory metadata when a refresh save fails", async function () {
    seedFile(bundledRegistry, NOW - DAY);
    const previous = file;
    failWrite = true;
    assert.isTrue(await refreshModelCapabilityRegistry());
    assert.strictEqual(file, previous);
    assert.equal(
      getActiveModelCapabilityRegistryForTests().revision,
      newerRegistry.revision,
    );
    await refreshModelCapabilityRegistry();
    assert.equal(fetches, 1, "disk failure must not cause a refresh loop");
  });

  it("deduplicates concurrent initialization, migration and refresh", async function () {
    prefs.set(REGISTRY_PREF, JSON.stringify(bundledRegistry));
    await Promise.all([
      refreshModelCapabilityRegistry(),
      refreshModelCapabilityRegistry(),
      initializeModelCapabilityRegistry(),
    ]);
    assert.equal(reads, 1);
    assert.equal(fetches, 1);
    assert.equal(writes, 2, "one migration and one remote update");
    assert.equal(saved().registry.revision, newerRegistry.revision);
  });

  for (const invalid of [
    "{broken",
    "x".repeat(514 * 1024),
    JSON.stringify({ schemaVersion: 9 }),
  ]) {
    it(`falls back to bundled data for an invalid cache (${invalid.length} bytes)`, async function () {
      file = new TextEncoder().encode(invalid);
      await initializeModelCapabilityRegistry();
      assert.equal(
        getActiveModelCapabilityRegistryForTests().revision,
        bundledRegistry.revision,
      );
      assert.equal(fetches, 0);
      assert.isTrue(await refreshModelCapabilityRegistry());
    });
  }

  for (const timestamp of [NOW + DAY, -1, "not a timestamp"]) {
    it(`refreshes a valid registry with an invalid timestamp (${timestamp})`, async function () {
      seedFile(newerRegistry, timestamp);
      await initializeModelCapabilityRegistry();
      assert.equal(
        getActiveModelCapabilityRegistryForTests().revision,
        newerRegistry.revision,
      );
      await refreshModelCapabilityRegistry();
      assert.equal(fetches, 1);
      assert.equal(saved().fetchedAt, NOW);
    });
  }

  it("uses legacy data when the file is corrupt and preserves a newer legacy revision", async function () {
    file = new TextEncoder().encode("invalid JSON");
    prefs.set(REGISTRY_PREF, JSON.stringify(newerRegistry));
    await initializeModelCapabilityRegistry();
    assert.equal(saved().registry.revision, newerRegistry.revision);
    resetModelCapabilityStateForTests();
    configure();
    seedFile(bundledRegistry);
    prefs.set(REGISTRY_PREF, JSON.stringify(newerRegistry));
    await initializeModelCapabilityRegistry();
    assert.equal(saved().registry.revision, newerRegistry.revision);
  });

  it("does not let stale disk metadata replace a newer bundled registry", async function () {
    seedFile({ ...bundledRegistry, revision: bundledRegistry.revision - 1 });
    await initializeModelCapabilityRegistry();
    assert.equal(
      getActiveModelCapabilityRegistryForTests().revision,
      bundledRegistry.revision,
    );
  });

  it("keeps bundled capabilities usable without profile or file APIs", async function () {
    delete globals.Zotero.Profile;
    delete globals.IOUtils;
    await initializeModelCapabilityRegistry();
    assert.equal(
      getActiveModelCapabilityRegistryForTests().revision,
      bundledRegistry.revision,
    );
    assert.isTrue(await refreshModelCapabilityRegistry());
    await refreshModelCapabilityRegistry();
    assert.equal(fetches, 1);
  });

  it("does not mark an invalid remote registry fresh or overwrite the last good cache", async function () {
    seedFile(bundledRegistry, NOW - DAY);
    const previous = file;
    remote = { schemaVersion: 99 };
    assert.isFalse(await refreshModelCapabilityRegistry());
    assert.strictEqual(file, previous);
    remote = newerRegistry;
    assert.isTrue(await refreshModelCapabilityRegistry());
    assert.equal(fetches, 2);
  });
});
