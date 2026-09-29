import { createAbortController } from "../utils/apiHelpers";

/** Account allowance is independent of locally recorded conversation tokens. */
export type ProviderQuota =
  | {
      kind: "balance";
      scope: "account" | "key";
      balances: Array<{ currency: string; amount: number }>;
    }
  | {
      kind: "usage";
      windows: Array<{
        usedPercent: number;
        durationMins?: number;
        resetsAt?: number;
      }>;
    };

export type QuotaTarget =
  | { kind: "deepseek" | "openrouter"; apiKey: string }
  | { kind: "codex"; codexPath: string };

export type QuotaSnapshot = {
  quota: ProviderQuota | null;
  checkedAt: number;
};

export function resolveQuotaTarget(
  entry: {
    authMode: string;
    apiBase: string;
    apiKey: string;
  } | null,
): QuotaTarget | null {
  if (!entry) return null;
  if (entry.authMode === "codex_app_server") {
    return { kind: "codex", codexPath: entry.apiBase };
  }
  if (entry.authMode !== "api_key" || !entry.apiKey.trim()) return null;
  try {
    const url = new URL(entry.apiBase);
    // Never send a proxy's credentials to the upstream provider, even when
    // the selected model or preset has that provider's name.
    if (url.protocol !== "https:" || url.port || url.username || url.password)
      return null;
    if (url.hostname === "api.deepseek.com") {
      return { kind: "deepseek", apiKey: entry.apiKey };
    }
    if (url.hostname === "openrouter.ai") {
      return { kind: "openrouter", apiKey: entry.apiKey };
    }
  } catch {
    // Unrecognized or local endpoints have no known balance contract.
  }
  return null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function number(value: unknown): number | undefined {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    (typeof value === "string" && !value.trim())
  )
    return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Schemas: api-docs.deepseek.com/api/get-user-balance and OpenRouter /key. */
export function parseApiQuota(
  kind: "deepseek" | "openrouter",
  value: unknown,
): ProviderQuota | null {
  const payload = record(value);
  if (kind === "deepseek") {
    const balances = (
      Array.isArray(payload.balance_infos) ? payload.balance_infos : []
    ).flatMap((raw) => {
      const row = record(raw);
      const amount = number(row.total_balance);
      return amount !== undefined &&
        (row.currency === "USD" || row.currency === "CNY")
        ? [{ currency: row.currency, amount }]
        : [];
    });
    return balances.length
      ? { kind: "balance", scope: "account", balances }
      : null;
  }
  const data = record(payload.data);
  const amount = number(data.limit_remaining);
  // A null limit is unlimited key spending, not an account balance of zero.
  return amount !== undefined && number(data.limit) !== undefined
    ? { kind: "balance", scope: "key", balances: [{ currency: "USD", amount }] }
    : null;
}

/** Codex account/rateLimits/read: prefer the named Codex bucket when present. */
export function parseCodexQuota(value: unknown): ProviderQuota | null {
  const payload = record(value);
  const buckets = record(payload.rateLimitsByLimitId);
  const bucket = Object.keys(buckets).length
    ? record(buckets.codex)
    : record(payload.rateLimits);
  const windows = [bucket.primary, bucket.secondary].flatMap((raw) => {
    const row = record(raw);
    const usedPercent = number(row.usedPercent);
    if (usedPercent === undefined || usedPercent < 0) return [];
    const durationMins = number(row.windowDurationMins);
    const resetsAt = number(row.resetsAt);
    return [
      {
        usedPercent: Math.min(100, usedPercent),
        ...(durationMins !== undefined && durationMins > 0
          ? { durationMins }
          : {}),
        ...(resetsAt !== undefined && resetsAt > 0 ? { resetsAt } : {}),
      },
    ];
  });
  return windows.length ? { kind: "usage", windows } : null;
}

export async function readApiQuota(
  target: Exclude<QuotaTarget, { kind: "codex" }>,
): Promise<ProviderQuota | null> {
  const controller = createAbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(
      target.kind === "deepseek"
        ? "https://api.deepseek.com/user/balance"
        : "https://openrouter.ai/api/v1/key",
      {
        headers: {
          Authorization: `Bearer ${target.apiKey}`,
          Accept: "application/json",
        },
        signal: controller.signal,
        redirect: "error",
        credentials: "omit",
      },
    );
    if (!response.ok) return null;
    return parseApiQuota(target.kind, await response.json());
  } finally {
    clearTimeout(timer);
  }
}

/** Memory-only, bounded cache. Credentials never enter DOM, preferences or logs. */
export function createQuotaReader(
  read: (target: QuotaTarget) => Promise<ProviderQuota | null>,
  now = Date.now,
) {
  const cache = new Map<
    string,
    {
      pending: Promise<QuotaSnapshot>;
      startedAt: number;
      settled: boolean;
      refresh: boolean;
    }
  >();
  return (target: QuotaTarget, refresh = false): Promise<QuotaSnapshot> => {
    const key = JSON.stringify(target);
    const previous = cache.get(key);
    const age = previous ? now() - previous.startedAt : Infinity;
    // A completed turn invalidates even a recent read from before that turn.
    // Concurrent refreshes share their own request, never the pre-turn read.
    if (
      previous &&
      ((!previous.settled && (!refresh || previous.refresh)) ||
        (!refresh && age < 60000))
    ) {
      return previous.pending;
    }
    const entry = {
      startedAt: now(),
      settled: false,
      refresh,
      pending: Promise.resolve()
        .then(() => read(target))
        .then(
          (quota) => ({ quota, checkedAt: now() }),
          () => ({ quota: null, checkedAt: now() }),
        )
        .finally(() => {
          entry.settled = true;
        }),
    };
    cache.delete(key);
    cache.set(key, entry);
    if (cache.size > 32) cache.delete(cache.keys().next().value!);
    return entry.pending;
  };
}
