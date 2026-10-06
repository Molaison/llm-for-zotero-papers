import { assert } from "chai";
import {
  createQuotaReader,
  parseApiQuota,
  parseCodexQuota,
  readApiQuota,
  resolveQuotaTarget,
  type ProviderQuota,
  type QuotaTarget,
} from "../src/providers/quota";

const target: QuotaTarget = { kind: "deepseek", apiKey: "test-key" };
const balance = (amount: number): ProviderQuota => ({
  kind: "balance",
  scope: "account",
  balances: [{ currency: "USD", amount }],
});

describe("provider account quota", function () {
  it("detects the credential's actual endpoint, not a preset or model name", function () {
    const entry = {
      authMode: "api_key",
      apiBase: "https://api.deepseek.com/v1/chat/completions",
      apiKey: "test-key",
    };
    assert.deepEqual(resolveQuotaTarget(entry), target);
    for (const apiBase of [
      "https://api.deepseek.com.proxy.example/v1",
      "https://proxy.example/deepseek",
      "http://api.deepseek.com",
      "https://api.deepseek.com:8443",
      "https://user@api.deepseek.com",
      "invalid",
    ]) {
      assert.isNull(resolveQuotaTarget({ ...entry, apiBase }));
    }
    assert.isNull(resolveQuotaTarget({ ...entry, authMode: "webchat" }));
    assert.isNull(resolveQuotaTarget({ ...entry, apiKey: "" }));
    assert.deepEqual(
      resolveQuotaTarget({ ...entry, apiBase: "https://openrouter.ai/api/v1" }),
      { kind: "openrouter", apiKey: "test-key" },
    );
    assert.deepEqual(
      resolveQuotaTarget({
        ...entry,
        authMode: "codex_app_server",
        apiBase: "/bin/codex",
      }),
      { kind: "codex", codexPath: "/bin/codex" },
    );
    assert.isNull(resolveQuotaTarget({ ...entry, authMode: "codex_auth" }));
  });

  it("preserves real currencies, zero balances and negative balances", function () {
    assert.deepEqual(
      parseApiQuota("deepseek", {
        is_available: false,
        balance_infos: [
          { currency: "CNY", total_balance: "0.00" },
          { currency: "USD", total_balance: "-1.25" },
        ],
      }),
      {
        kind: "balance",
        scope: "account",
        balances: [
          { currency: "CNY", amount: 0 },
          { currency: "USD", amount: -1.25 },
        ],
      },
    );
    for (const value of [null, undefined, "", "NaN", Infinity, false]) {
      assert.isNull(
        parseApiQuota("deepseek", {
          balance_infos: [{ currency: "USD", total_balance: value }],
        }),
      );
    }
  });

  it("distinguishes a limited OpenRouter key from unlimited or absent allowance", function () {
    assert.deepEqual(
      parseApiQuota("openrouter", { data: { limit: 10, limit_remaining: 0 } }),
      {
        kind: "balance",
        scope: "key",
        balances: [{ currency: "USD", amount: 0 }],
      },
    );
    assert.isNull(
      parseApiQuota("openrouter", {
        data: { limit: null, limit_remaining: null, usage: 12 },
      }),
    );
    assert.isNull(parseApiQuota("openrouter", { data: { usage: 12 } }));
  });

  it("uses the Codex bucket with its independent quota windows", function () {
    assert.deepEqual(
      parseCodexQuota({
        rateLimits: { primary: { usedPercent: 99 } },
        rateLimitsByLimitId: {
          codex: {
            primary: {
              usedPercent: 0,
              windowDurationMins: 300,
              resetsAt: 1234,
            },
            secondary: { usedPercent: 45, windowDurationMins: 10080 },
          },
          other: { primary: { usedPercent: 95 } },
        },
      }),
      {
        kind: "usage",
        windows: [
          { usedPercent: 0, durationMins: 300, resetsAt: 1234 },
          { usedPercent: 45, durationMins: 10080 },
        ],
      },
    );
    assert.isNull(
      parseCodexQuota({ rateLimits: { primary: { usedPercent: null } } }),
    );
    assert.isNull(
      parseCodexQuota({
        rateLimitsByLimitId: { other: { primary: { usedPercent: 5 } } },
      }),
    );
    assert.deepEqual(
      parseCodexQuota({ rateLimits: { primary: { usedPercent: 110 } } }),
      { kind: "usage", windows: [{ usedPercent: 100 }] },
    );
  });

  it("deduplicates panels, expires reads, and isolates changed credentials", async function () {
    let now = 100;
    let reads = 0;
    const read = createQuotaReader(
      async () => {
        reads++;
        return balance(reads);
      },
      () => now,
    );
    const one = read(target);
    assert.strictEqual(read(target), one);
    await one;
    await read(target);
    assert.equal(reads, 1);
    now += 60001;
    await read(target);
    await read({ ...target, apiKey: "different-key" });
    assert.equal(reads, 3);
  });

  it("refreshes after a fast turn even if the pre-turn balance request is pending", async function () {
    const resolves: Array<(value: ProviderQuota) => void> = [];
    const read = createQuotaReader(
      () => new Promise((resolve) => resolves.push(resolve)),
    );
    const beforeTurn = read(target);
    await Promise.resolve();
    const afterTurn = read(target, true);
    assert.strictEqual(read(target, true), afterTurn);
    await Promise.resolve();
    assert.lengthOf(resolves, 2);
    resolves[1](balance(5));
    await afterTurn;
    resolves[0](balance(10));
    await beforeTurn;
    assert.deepEqual((await read(target)).quota, balance(5));
  });

  it("caches failures as unavailable and allows an explicit retry", async function () {
    let reads = 0;
    const read = createQuotaReader(async () => {
      reads++;
      if (reads === 1) throw new Error("offline");
      return balance(1);
    });
    assert.isNull((await read(target)).quota);
    assert.isNull((await read(target)).quota);
    assert.equal(reads, 1);
    assert.deepEqual((await read(target, true)).quota, balance(1));
  });

  it("makes only the documented read with redirects and cookies disabled", async function () {
    const original = globalThis.fetch;
    try {
      const requests: Array<{ url: string; init?: RequestInit }> = [];
      globalThis.fetch = (async (url: string, init?: RequestInit) => {
        requests.push({ url, init });
        return {
          ok: true,
          json: async () => ({ data: { limit: 20, limit_remaining: 12 } }),
        };
      }) as typeof fetch;
      await readApiQuota({ kind: "openrouter", apiKey: "test-only" });
      assert.equal(requests[0].url, "https://openrouter.ai/api/v1/key");
      assert.equal(requests[0].init?.redirect, "error");
      assert.equal(requests[0].init?.credentials, "omit");
      assert.deepEqual(requests[0].init?.headers, {
        Authorization: "Bearer test-only",
        Accept: "application/json",
      });
      globalThis.fetch = (async () => ({ ok: false })) as typeof fetch;
      assert.isNull(await readApiQuota(target));
    } finally {
      globalThis.fetch = original;
    }
  });
});
