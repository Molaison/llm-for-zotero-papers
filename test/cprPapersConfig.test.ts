import { assert } from "chai";
import { config } from "../package.json";
import { getModelProviderGroups, getLastUsedModelEntryId, setModelProviderGroups } from "../src/utils/modelProviders";
import { CPR_PAPERS_API_BASE, CPR_PAPERS_MODEL, CPR_PAPERS_MODELS, normalizeCprPapersTarget } from "../src/utils/cprPapers";

describe("CPR papers public configuration", function () {
  let original: typeof Zotero;
  let prefs: Map<string, unknown>;
  const pref = (key: string) => `${config.prefsPrefix}.${key}`;
  const other = {id: "other", apiBase: "https://example.org/v1", apiKey: "other-key", authMode: "api_key" as const, providerProtocol: "openai_chat_compat" as const, models: [{id: "other-model", model: "example"}]};
  beforeEach(function () {
    original = globalThis.Zotero;
    prefs = new Map<string, unknown>();
    globalThis.Zotero = {Prefs: {get: (key: string) => prefs.get(key), set: (key: string, value: unknown) => prefs.set(key, value)}} as unknown as typeof Zotero;
  });
  afterEach(function () { globalThis.Zotero = original; });
  it("installs and selects the public Responses profile without embedding a key", function () {
    const groups = getModelProviderGroups();
    const papers = groups.find(g => g.models.some(m => m.model === CPR_PAPERS_MODEL));
    assert.equal(papers?.apiBase, CPR_PAPERS_API_BASE);
    assert.equal(papers?.apiKey, "");
    assert.equal(papers?.providerProtocol, "responses_api");
    assert.deepEqual(papers?.models.map(m => m.model), [...CPR_PAPERS_MODELS]);
    assert.deepEqual(papers?.models.map(m => m.providerProtocol), Array(4).fill("responses_api"));
    assert.equal(getLastUsedModelEntryId(), papers?.models[0].id);
    assert.equal(JSON.stringify(getModelProviderGroups()), JSON.stringify(groups));
  });

  it("widens an installed single-model papers group once, keeping key, row id and selection", function () {
    prefs.set(pref("cprPapersPublicConfigured"), "1");
    prefs.set(pref("lastUsedModelEntryId"), "keep-me");
    setModelProviderGroups([other, {id: "papers", apiBase: CPR_PAPERS_API_BASE, apiKey: "retained-key", authMode: "api_key", providerProtocol: "responses_api", models: [{id: "keep-me", model: CPR_PAPERS_MODEL}]}]);
    const groups = getModelProviderGroups();
    const papers = groups.find(g => g.id === "papers")!;
    assert.deepEqual(papers.models.map(m => m.model), [...CPR_PAPERS_MODELS]);
    assert.equal(papers.models[0].id, "keep-me");
    assert.equal(papers.apiKey, "retained-key");
    assert.equal(groups[0].id, "other");
    assert.equal(groups[0].apiKey, "other-key");
    assert.equal(getLastUsedModelEntryId(), "keep-me");
    assert.equal(JSON.stringify(getModelProviderGroups()), JSON.stringify(groups));
    // The extension ran once: a row the user removes afterwards stays removed.
    setModelProviderGroups(groups.map(g => g.id === "papers" ? {...g, models: g.models.filter(m => m.model !== "papers/gpt-6-pro")} : g));
    assert.deepEqual(getModelProviderGroups().find(g => g.id === "papers")!.models.map(m => m.model), ["papers/gpt-5.6-sol", "papers/gpt-5.6-sol-instant", "papers/gpt-5.6-pro"]);
  });

  it("does not recreate a papers group the user deleted", function () {
    prefs.set(pref("cprPapersPublicConfigured"), "1");
    setModelProviderGroups([other]);
    const groups = getModelProviderGroups();
    assert.deepEqual(groups.map(g => g.id), ["other"]);
  });
  it("preserves another selected provider and the installed papers endpoint", function () {
    prefs.set(pref("cprPapersPublicConfigured"), "1");
    prefs.set(pref("lastUsedModelEntryId"), "other-model");
    setModelProviderGroups([other, {id: "papers", apiBase: "https://custom.example/v1", apiKey: "retained-key", authMode: "api_key", providerProtocol: "responses_api", models: [{id: "keep-me", model: CPR_PAPERS_MODEL}]}]);
    const groups = getModelProviderGroups();
    assert.equal(getLastUsedModelEntryId(), "other-model");
    assert.equal(groups.find(g => g.id === "papers")?.apiBase, "https://custom.example/v1");
  });
  it("migrates only the dedicated paper group, preserving its key and other providers", function () {
    setModelProviderGroups([other, {id: "papers", apiBase: "http://192.168.233.231:18082/v1", apiKey: "retained-key", authMode: "api_key", providerProtocol: "openai_chat_compat", models: [{id: "paper-model", model: CPR_PAPERS_MODEL}]}]);
    const groups = getModelProviderGroups();
    assert.equal(groups[0].apiBase, other.apiBase);
    assert.equal(groups[0].apiKey, other.apiKey);
    assert.equal(groups[0].models[0].model, "example");
    assert.equal(groups[1].apiBase, CPR_PAPERS_API_BASE);
    assert.equal(groups[1].apiKey, "retained-key");
    assert.equal(getLastUsedModelEntryId(), "paper-model");
    setModelProviderGroups([]);
    assert.deepEqual(getModelProviderGroups(), []);
  });
  it("keeps uploaded-PDF identity when moving from LAN to public HTTPS", function () {
    assert.equal(normalizeCprPapersTarget("http://192.168.233.231:18082/v1"), CPR_PAPERS_API_BASE);
    assert.equal(normalizeCprPapersTarget(CPR_PAPERS_API_BASE + "/responses"), CPR_PAPERS_API_BASE);
    assert.notEqual(normalizeCprPapersTarget("https://example.org/v1"), CPR_PAPERS_API_BASE);
  });
});
