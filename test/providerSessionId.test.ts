import { assert } from "chai";
import { config } from "../package.json";
import {
  resetProviderSessionIdCacheForTests,
  resolveProviderSessionId,
} from "../src/utils/providerSessionId";

type PrefStore = Map<string, unknown>;

function installZoteroPrefs(store: PrefStore): () => void {
  const globalWithZotero = globalThis as typeof globalThis & {
    Zotero?: unknown;
  };
  const previous = globalWithZotero.Zotero;
  globalWithZotero.Zotero = {
    Prefs: {
      get: (key: string) => store.get(key),
      set: (key: string, value: unknown) => store.set(key, value),
      clear: (key: string) => store.delete(key),
    },
  };
  return () => {
    if (previous) globalWithZotero.Zotero = previous;
    else delete globalWithZotero.Zotero;
  };
}

describe("provider session id", function () {
  let restore: () => void;
  let prefs: PrefStore;

  beforeEach(function () {
    prefs = new Map();
    restore = installZoteroPrefs(prefs);
    resetProviderSessionIdCacheForTests();
  });

  afterEach(function () {
    restore();
  });

  it("is stable for one conversation and different across conversations", async function () {
    const first = await resolveProviderSessionId(11);
    const again = await resolveProviderSessionId(11);
    const other = await resolveProviderSessionId(12);

    assert.equal(first, again, "same conversation, same id");
    assert.notEqual(first, other, "different conversations, different ids");
  });

  it("reveals nothing about the conversation it belongs to", async function () {
    prefs.set(
      `${config.prefsPrefix}.providerSessionSalt`,
      "test-install-salt-0123456789",
    );
    const id = await resolveProviderSessionId(4242);
    // The id leaves the machine on every request, so it must not carry the
    // conversation key, the library, or anything derived from them in the
    // clear. A salted digest is opaque; the key itself would not be.
    // Independently calculated SHA-256 prefix for this fixed salt and key.
    assert.equal(id, "81af5cbc6298f617ff478ad62f19bf41");
    assert.match(id, /^[0-9a-f]{32}$/);
  });

  it("differs between installs for the same conversation key", async function () {
    const mine = await resolveProviderSessionId(7);

    // A second install: same conversation key, its own salt.
    prefs.clear();
    resetProviderSessionIdCacheForTests();
    const theirs = await resolveProviderSessionId(7);

    assert.notEqual(mine, theirs);
  });

  it("keeps one salt rather than minting a new one per call", async function () {
    await resolveProviderSessionId(1);
    const salts = [...prefs.keys()].filter((key) => key.includes("Salt"));
    assert.lengthOf(salts, 1);

    const saltValue = prefs.get(salts[0]);
    await resolveProviderSessionId(2);
    assert.equal(prefs.get(salts[0]), saltValue, "salt is written once");
  });

  it("has no id to offer when there is no conversation", async function () {
    assert.isUndefined(await resolveProviderSessionId(null));
    assert.isUndefined(await resolveProviderSessionId(undefined));
  });
});
