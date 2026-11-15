import { assert } from "chai";
import {
  parseApiQuota,
  readApiQuota,
  resolveQuotaTarget,
  createQuotaReader,
  type ApiQuotaTarget,
} from "../src/providers/quota";
import { buildQuotaPresentation } from "../src/modules/contextPanel/footerQuotaControl";
import { detectProviderPreset } from "../src/utils/providerPresets";

const start = Date.parse("2026-09-29T00:00:00Z");
const payload = (rows: unknown[]) => ({
  base_resp: { status_code: 0 },
  model_remains: rows,
});
const general = {
  model_name: "general",
  current_interval_remaining_percent: 80,
  current_weekly_remaining_percent: 35,
  current_interval_total_count: 0,
  current_interval_usage_count: 0,
  current_weekly_total_count: 0,
  current_weekly_usage_count: 0,
  start_time: start,
  end_time: start + 5 * 3600000,
  weekly_start_time: start,
  weekly_end_time: start + 7 * 86400000,
};
const parse = (rows: unknown[], model = "MiniMax-M2.7") =>
  parseApiQuota("minimax_global", payload(rows), model);

describe("MiniMax quota", function () {
  it("matches each region by origin, preserves the selected model, and recognizes the new China host", function () {
    for (const [host, kind] of [
      ["api.minimax.io", "minimax_global"],
      ["api.minimax.cn", "minimax_cn"],
      ["api.minimaxi.com", "minimax_legacy_cn"],
    ]) {
      assert.deepEqual(
        resolveQuotaTarget({
          authMode: "api_key",
          apiBase: `https://${host}/anthropic`,
          apiKey: "fixture",
          model: "MiniMax-M2.7",
        }),
        { kind, apiKey: "fixture", model: "MiniMax-M2.7" },
      );
      assert.equal(
        detectProviderPreset(`https://${host}/anthropic`),
        "minimax",
      );
    }
    for (const apiBase of [
      "https://api.minimax.io.proxy.example/anthropic",
      "http://api.minimax.cn/v1",
      "https://api.minimaxi.com:8443/v1",
      "https://key@api.minimax.io/v1",
    ])
      assert.isNull(
        resolveQuotaTarget({ authMode: "api_key", apiBase, apiKey: "fixture" }),
      );
  });

  it("prefers explicit remaining percentages when counts are zero or have changed meaning", function () {
    const quota = parse([general]);
    assert.deepEqual(quota, {
      kind: "usage",
      provider: "minimax",
      windows: [
        {
          usedPercent: 20,
          durationMins: 300,
          resetsAt: (start + 5 * 3600000) / 1000,
        },
        {
          usedPercent: 65,
          durationMins: 10080,
          resetsAt: (start + 7 * 86400000) / 1000,
        },
      ],
    });
    const view = buildQuotaPresentation({ quota, checkedAt: start })!;
    assert.equal(view.text, "65% used");
    assert.include(view.title, "MiniMax Token Plan quota");
    assert.include(view.title, "5h: 20% used");
    assert.include(view.title, "7d: 65% used");
    assert.deepEqual(
      parse([
        {
          ...general,
          current_interval_total_count: 100,
          current_interval_usage_count: 20,
        },
      ]),
      quota,
    );
    assert.deepEqual(
      parse([{ ...general, weekly_boost_permille: 1500 }]),
      quota,
    );
  });

  it("handles legacy remaining counts and zero or exhausted percentages", function () {
    const quota = parse([
      {
        model_name: "MiniMax-M*",
        current_interval_total_count: "100",
        current_interval_usage_count: "80",
      },
    ]);
    assert.equal(quota?.kind, "usage");
    if (quota?.kind !== "usage") throw new Error("Expected usage");
    assert.closeTo(quota.windows[0].usedPercent, 20, 1e-10);
    assert.deepEqual(
      parse([
        {
          model_name: "general",
          current_interval_remaining_percent: 100,
          current_weekly_remaining_percent: 0,
        },
      ]),
      {
        kind: "usage",
        provider: "minimax",
        windows: [{ usedPercent: 0 }, { usedPercent: 100 }],
      },
    );
  });

  it("selects the applicable model bucket without treating media quota as chat usage", function () {
    const rows = [
      { model_name: "video", current_interval_remaining_percent: 0 },
      { model_name: "speech-hd", current_interval_remaining_percent: 1 },
      { model_name: "general", current_interval_remaining_percent: 70 },
      { model_name: "MiniMax-M*", current_interval_remaining_percent: 60 },
      { model_name: "MiniMax-M2.7", current_interval_remaining_percent: 50 },
    ];
    for (const [model, usedPercent] of [
      ["MiniMax-M2.7", 50],
      ["MiniMax-M3", 40],
      ["new-chat-model", 30],
    ] as const)
      assert.deepEqual(parse(rows, model), {
        kind: "usage",
        provider: "minimax",
        windows: [{ usedPercent }],
      });
    assert.isNull(parse(rows.slice(0, 2)));
    assert.isNull(
      parse(
        [
          {
            model_name: "MiniMax-M2.7",
            current_interval_remaining_percent: 20,
          },
        ],
        "MiniMax-M3",
      ),
    );
  });

  it("hides unlimited, unprovisioned, malformed, and failed quota responses", function () {
    assert.isNull(
      parse([
        { ...general, current_interval_status: 3, current_weekly_status: 3 },
      ]),
    );
    assert.deepEqual(parse([{ ...general, current_weekly_status: 3 }]), {
      kind: "usage",
      provider: "minimax",
      windows: [
        {
          usedPercent: 20,
          durationMins: 300,
          resetsAt: (start + 5 * 3600000) / 1000,
        },
      ],
    });
    for (const data of [
      {},
      { current_interval_total_count: 0, current_interval_usage_count: 0 },
      { current_interval_total_count: 100 },
      { current_interval_total_count: 10, current_interval_usage_count: 11 },
      { current_interval_total_count: 10, current_interval_usage_count: -1 },
      { current_interval_remaining_percent: "" },
      { current_interval_remaining_percent: false },
      { current_interval_remaining_percent: NaN },
      { current_interval_remaining_percent: 101 },
      {
        current_interval_remaining_percent: -1,
        current_interval_total_count: 100,
        current_interval_usage_count: 50,
      },
    ])
      assert.isNull(parse([{ model_name: "general", ...data }]));
    for (const value of [
      null,
      {},
      { model_remains: [general] },
      { ...payload([general]), base_resp: { status_code: 1004 } },
    ])
      assert.isNull(parseApiQuota("minimax_cn", value));
  });

  it("preserves regional available balances, including zero and debt", function () {
    for (const kind of [
      "minimax_global",
      "minimax_cn",
      "minimax_legacy_cn",
    ] as const) {
      for (const amount of [0, 98, -1.25]) {
        assert.deepEqual(
          parseApiQuota(kind, {
            base_resp: { status_code: 0 },
            available_amount: String(amount),
            cash_balance: "100",
            voucher_balance: "900",
          }),
          {
            kind: "balance",
            scope: "account",
            balances: [
              { currency: kind === "minimax_global" ? "USD" : "CNY", amount },
            ],
          },
        );
      }
      for (const amount of [null, "", "bad", Infinity, false])
        assert.isNull(
          parseApiQuota(kind, {
            base_resp: { status_code: 0 },
            available_amount: amount,
          }),
        );
    }
  });

  it("routes standard and plan keys to one same-region read with no fallback", async function () {
    const original = globalThis.fetch;
    try {
      const requests: Array<{ url: string; init?: RequestInit }> = [];
      globalThis.fetch = (async (url: string, init?: RequestInit) => {
        requests.push({ url, init });
        return {
          ok: true,
          json: async () =>
            url.endsWith("query_balance")
              ? { base_resp: { status_code: 0 }, available_amount: "12.50" }
              : payload([general]),
        };
      }) as typeof fetch;
      for (const [kind, host] of [
        ["minimax_global", "api.minimax.io"],
        ["minimax_cn", "api.minimax.cn"],
        ["minimax_legacy_cn", "api.minimaxi.com"],
      ] as const) {
        for (const [apiKey, path] of [
          ["sk-api-fixture", "/account/query_balance"],
          ["sk-cp-fixture", "/v1/token_plan/remains"],
          ["legacy-fixture", "/v1/token_plan/remains"],
        ]) {
          const quota = await readApiQuota({
            kind,
            apiKey,
            model: "MiniMax-M2.7",
          });
          assert.equal(
            quota?.kind,
            apiKey.startsWith("sk-api-") ? "balance" : "usage",
          );
          const request = requests.at(-1)!;
          assert.equal(request.url, `https://${host}${path}`);
          assert.equal(request.init?.redirect, "error");
          assert.equal(request.init?.credentials, "omit");
          assert.equal(
            (request.init?.headers as Record<string, string>).Authorization,
            `Bearer ${apiKey}`,
          );
        }
      }
      assert.lengthOf(requests, 9);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("does not reuse a model-specific quota after changing models with the same key", async function () {
    let reads = 0;
    const read = createQuotaReader(async (target) => {
      reads++;
      return parse(
        [
          {
            model_name: "MiniMax-M2.7",
            current_interval_remaining_percent: 90,
          },
        ],
        (target as ApiQuotaTarget).model,
      );
    });
    const target: ApiQuotaTarget = {
      kind: "minimax_cn",
      apiKey: "fixture",
      model: "MiniMax-M2.7",
    };
    assert.isNotNull((await read(target)).quota);
    assert.isNull((await read({ ...target, model: "MiniMax-M3" })).quota);
    assert.equal(reads, 2);
  });
});
