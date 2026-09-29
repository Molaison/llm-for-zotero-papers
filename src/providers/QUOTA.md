# Provider balance and quota footer

Account allowance is independent of conversation context usage and locally recorded token totals.
The footer queries the selected provider and hides unavailable data, including authentication failures, unsupported endpoints, and malformed responses.
It displays the most-used applicable quota window, with individual windows, available reset times, and the last check in the tooltip.
Balances preserve the provider's currency; a limited key's allowance is labelled separately from an account balance.

## Supported sources

| Connection                    | Display                                  | Read contract                                                                                                                        |
| ----------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| DeepSeek                      | Account balance in USD or CNY            | `GET https://api.deepseek.com/user/balance`; `balance_infos[].total_balance`                                                         |
| OpenRouter                    | Limited API key allowance in USD         | `GET https://openrouter.ai/api/v1/key`; `data.limit_remaining` when `data.limit` is finite                                           |
| Kimi / Moonshot China         | Available account balance in CNY         | `GET https://api.moonshot.cn/v1/users/me/balance`; `data.available_balance`                                                          |
| Kimi / Moonshot international | Available account balance in USD         | Same balance path on `api.moonshot.ai`; regional credentials remain separate                                                         |
| Kimi Code                     | Weekly and returned rolling-window usage | `GET https://api.kimi.com/coding/v1/usages`; `usage` and `limits[].detail` counters                                                  |
| GLM / Z.ai Coding Plan        | Reported model quota usage               | `GET /api/monitor/usage/quota/limit` on `open.bigmodel.cn` or `api.z.ai`; `data.limits[]` with `type: TOKENS_LIMIT` and `percentage` |
| Codex app server              | Account quota usage                      | `account/rateLimits/read`, preferring the named Codex bucket                                                                         |
| Claude Code                   | Five-hour and seven-day account usage    | Companion bridge `GET /account-quota`, using the installed Agent SDK's structured usage control request                              |

GLM detection is limited to `/api/anthropic` and `/api/coding/paas/v4` routes, because prepaid inference and the Coding Plan have separate allowances.
GLM's tool/MCP allowance is excluded; window durations and reset times are omitted when their contract is not established.
Kimi Code converts explicit used or remaining counters into percentages only when a positive limit exists.
Missing usage is never treated as zero, and Kimi's available balance is never reconstructed from cash and voucher balances.

## Claude Code integration

Claude Code requires the companion adapter change in `cc-llm4zotero-adapter` and a running bridge built from that source.
Older bridges return 404 and the indicator stays hidden.
The bridge uses `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` from Agent SDK 0.3.220, so the method is feature-detected and the payload is validated.
The probe reuses the chat's scoped working directory and configured settings sources to select the same account/provider configuration.
It submits no user message, disables hooks and MCP servers, disables session persistence, times out after eight seconds, and closes its SDK connection on every path.
Only normalized quota windows leave the bridge; session costs and model usage do not.
API-key and third-party Claude configurations may report that subscription limits do not apply, in which case the indicator stays hidden.

## Presets without a wired quota contract

OpenAI API, Gemini, Anthropic API, MiniMax, GLM prepaid API, Grok, Qwen, MiMo, OpenCode Zen, GitHub Copilot, Ollama, and arbitrary custom endpoints currently keep the indicator hidden.
This is an implementation boundary, not a claim that none of these providers offers billing or administrative APIs.
MiniMax documents a Token Plan read endpoint, but its response counter semantics still need verification before integration.
SiliconFlow's former `/user/info` endpoint was retired on August 14, 2026; it is deliberately not queried.
OpenRouter account-wide credits require a management key, so ordinary unlimited keys do not display a made-up account balance.

## Refresh and credential boundaries

Reads are cached in memory for sixty seconds and shared across panels with the same target.
Completing a chat turn or clicking the displayed allowance refreshes the value.
Switching targets clears the previous display immediately, and late replies cannot replace the new target's data.
API credentials are sent only to allowlisted HTTPS origins matched against the configured API URL; preset names and model names do not establish that trust.
Requests reject redirects and omit browser cookies, with no fallback across regions or domains.
No balance, usage, or credential is persisted by the quota feature.

## Sources checked September 29, 2026

- [DeepSeek balance API](https://api-docs.deepseek.com/api/get-user-balance/).
- [OpenRouter current API key](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key) and [management-only account credits](https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits).
- [Kimi international balance](https://platform.kimi.ai/docs/api/balance) and [China balance](https://platform.kimi.com/docs/api/balance).
- [Moonshot's official Kimi Code usage implementation](https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/ui/shell/usage.py).
- [Z.ai's official Coding Plan usage implementation](https://github.com/zai-org/zai-coding-plugins/blob/main/plugins/glm-plan-usage/skills/usage-query-skill/scripts/query-usage.mjs).
- [Codex app-server rate limits](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt).
- [Claude statusline account windows](https://code.claude.com/docs/en/statusline), plus the installed Agent SDK 0.3.220 `Query` and `SDKControlGetUsageResponse` type declarations.
- [MiniMax Token Plan usage endpoint](https://platform.minimax.io/subscribe/token-plan).
- [SiliconFlow retirement notice](https://docs.siliconflow.cn/docs/release-notes/overview).
