import { assert } from "chai";
import {
  parseApiQuota,
  readApiQuota,
  resolveQuotaTarget,
} from "../src/providers/quota";
import { parseClaudeQuota, readClaudeQuota } from "../src/claudeCode/quota";
import { buildQuotaPresentation } from "../src/modules/contextPanel/footerQuotaControl";

const entry = { authMode: "api_key", apiBase: "", apiKey: "fixture" };

describe("expanded provider quotas", function () {
  it("keeps regional keys and coding-plan routes separate", function () {
    for (const [apiBase, kind] of [
      ["https://api.moonshot.cn/v1", "kimi_cn"],
      ["https://api.moonshot.ai/v1", "kimi_global"],
      ["https://api.kimi.com/coding/v1", "kimi_code"],
      ["https://api.z.ai/api/anthropic", "glm_global"],
      ["https://open.bigmodel.cn/api/coding/paas/v4", "glm_cn"],
    ])
      assert.deepEqual(resolveQuotaTarget({ ...entry, apiBase }), {
        kind,
        apiKey: "fixture",
      });
    for (const apiBase of [
      "https://api.kimi.com/v1",
      "https://api.z.ai/api/paas/v4",
      "https://open.bigmodel.cn/api/anthropic-proxy",
      "https://api.moonshot.cn.proxy.example/v1",
      "http://api.moonshot.ai/v1",
      "https://api.moonshot.cn:8443/v1",
      "https://api.siliconflow.cn/v1",
      "https://api.minimax.io/anthropic",
    ])
      assert.isNull(resolveQuotaTarget({ ...entry, apiBase }));
  });

  it("uses Kimi's available balance without recomputing vouchers and cash", function () {
    for (const kind of ["kimi_cn", "kimi_global"] as const) {
      for (const amount of [0, -1.25, 49.58894]) {
        assert.deepEqual(
          parseApiQuota(kind, {
            status: true,
            code: 0,
            data: {
              available_balance: amount,
              cash_balance: -8,
              voucher_balance: 4,
            },
          }),
          {
            kind: "balance",
            scope: "account",
            balances: [
              { currency: kind === "kimi_cn" ? "CNY" : "USD", amount },
            ],
          },
        );
      }
      for (const value of [null, false, "", "NaN", Infinity]) {
        assert.isNull(
          parseApiQuota(kind, {
            status: true,
            code: 0,
            data: { available_balance: value },
          }),
        );
      }
      assert.isNull(
        parseApiQuota(kind, {
          status: false,
          code: 1,
          data: { available_balance: 20 },
        }),
      );
      assert.isNull(parseApiQuota(kind, {}));
    }
  });

  it("converts Kimi Code remaining counters to used percentages without inventing missing usage", function () {
    const quota = parseApiQuota("kimi_code", {
      usage: { limit: "100", remaining: "80" },
      limits: [
        {
          window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
          detail: { limit: 10, used: 7, resetTime: "2026-09-29T12:00:00Z" },
        },
      ],
    });
    assert.deepEqual(quota, {
      kind: "usage",
      provider: "kimi",
      windows: [
        { usedPercent: 20, durationMins: 10080 },
        {
          usedPercent: 70,
          durationMins: 300,
          resetsAt: Date.parse("2026-09-29T12:00:00Z") / 1000,
        },
      ],
    });
    assert.equal(
      buildQuotaPresentation({ quota, checkedAt: 1000 })?.text,
      "70% used",
    );
    for (const usage of [
      { limit: 100 },
      { limit: 0, used: 0 },
      { limit: 10, used: null },
      { limit: 10, remaining: 12 },
    ])
      assert.isNull(parseApiQuota("kimi_code", { usage }));
    assert.deepEqual(
      parseApiQuota("kimi_code", { usage: { limit: 10, used: 0 } }),
      {
        kind: "usage",
        provider: "kimi",
        windows: [{ usedPercent: 0, durationMins: 10080 }],
      },
    );
  });

  it("uses GLM model percentages and excludes the separate MCP quota", function () {
    for (const kind of ["glm_cn", "glm_global"] as const) {
      const quota = parseApiQuota(kind, {
        code: 200,
        success: true,
        data: {
          limits: [
            { type: "TOKENS_LIMIT", percentage: 25 },
            { type: "TIME_LIMIT", percentage: 99 },
            { type: "TOKENS_LIMIT", percentage: null },
          ],
        },
      });
      assert.deepEqual(quota, {
        kind: "usage",
        provider: "glm",
        windows: [{ usedPercent: 25 }],
      });
      assert.include(
        buildQuotaPresentation({ quota, checkedAt: 1000 })!.title,
        "GLM Coding Plan quota",
      );
      assert.isNull(
        parseApiQuota(kind, {
          data: { limits: [{ type: "TIME_LIMIT", percentage: 0 }] },
        }),
      );
      assert.isNull(
        parseApiQuota(kind, {
          code: 401,
          data: { limits: [{ type: "TOKENS_LIMIT", percentage: 0 }] },
        }),
      );
    }
  });

  it("requests each preset endpoint once with its documented authorization", async function () {
    const original = globalThis.fetch;
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    try {
      globalThis.fetch = (async (url: string, init?: RequestInit) => {
        requests.push({ url, init });
        return { ok: false };
      }) as typeof fetch;
      for (const [kind, url, authorization] of [
        [
          "kimi_cn",
          "https://api.moonshot.cn/v1/users/me/balance",
          "Bearer fixture",
        ],
        [
          "kimi_global",
          "https://api.moonshot.ai/v1/users/me/balance",
          "Bearer fixture",
        ],
        [
          "kimi_code",
          "https://api.kimi.com/coding/v1/usages",
          "Bearer fixture",
        ],
        [
          "glm_cn",
          "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
          "fixture",
        ],
        [
          "glm_global",
          "https://api.z.ai/api/monitor/usage/quota/limit",
          "fixture",
        ],
      ] as const) {
        assert.isNull(await readApiQuota({ kind, apiKey: "fixture" }));
        const request = requests.at(-1)!;
        assert.equal(request.url, url);
        assert.equal(
          (request.init?.headers as Record<string, string>).Authorization,
          authorization,
        );
        assert.equal(request.init?.redirect, "error");
        assert.equal(request.init?.credentials, "omit");
      }
      assert.lengthOf(requests, 5);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("reads Claude's scoped bridge quota and hides old or unsupported bridges", async function () {
    const original = globalThis.fetch;
    const target = {
      kind: "claude" as const,
      bridgeUrl: "http://127.0.0.1:19787/",
      settingSources: "project,local",
      context: {
        conversationKey: 23,
        scopeType: "paper" as const,
        scopeId: "paper:1:2",
        scopeLabel: "A & B",
      },
    };
    try {
      globalThis.fetch = (async (url: string) => {
        const parsed = new URL(url);
        assert.equal(parsed.pathname, "/account-quota");
        assert.equal(
          parsed.searchParams.get("settingSources"),
          "project,local",
        );
        assert.equal(parsed.searchParams.get("scopeId"), "paper:1:2");
        assert.equal(parsed.searchParams.get("scopeLabel"), "A & B");
        assert.equal(parsed.searchParams.get("conversationKey"), "23");
        return {
          ok: true,
          json: async () => ({
            quota: {
              windows: [
                { usedPercent: 20, durationMins: 300 },
                { usedPercent: 75, durationMins: 10080 },
              ],
            },
          }),
        };
      }) as typeof fetch;
      const quota = await readClaudeQuota(target);
      const presentation = buildQuotaPresentation({ quota, checkedAt: 1000 });
      assert.equal(presentation?.text, "75% used");
      assert.include(presentation!.title, "Claude Code account quota");
      globalThis.fetch = (async () => ({
        ok: false,
        status: 404,
      })) as typeof fetch;
      assert.isNull(await readClaudeQuota(target));
    } finally {
      globalThis.fetch = original;
    }
    for (const payload of [
      null,
      {},
      { quota: null },
      {
        quota: {
          windows: [
            { usedPercent: null },
            { usedPercent: NaN },
            { usedPercent: -1 },
          ],
        },
      },
    ])
      assert.isNull(parseClaudeQuota(payload));
  });
});
