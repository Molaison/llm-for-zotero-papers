/** Normalize request-terminal usage; do not sum cumulative streaming snapshots. */
export function usageFromResponse(text: string) {
  let usage: Record<string, any> | undefined;
  const records: any[] = [];
  try {
    records.push(JSON.parse(text));
  } catch {
    /* SSE below */
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    try {
      records.push(JSON.parse(line.slice(5).trim()));
    } catch {
      /* done marker */
    }
  }
  for (const record of records) {
    const next =
      record.usage ??
      record.message?.usage ??
      record.response?.usage ??
      record.usageMetadata;
    if (next) usage = { ...usage, ...next };
  }
  if (!usage) return null;
  const input =
    usage.prompt_tokens ??
    usage.promptTokenCount ??
    (typeof usage.input_tokens === "number"
      ? usage.input_tokens +
        (usage.cache_read_input_tokens || 0) +
        (usage.cache_creation_input_tokens || 0)
      : undefined);
  const output =
    usage.completion_tokens ??
    usage.output_tokens ??
    usage.candidatesTokenCount;
  const total =
    usage.total_tokens ??
    usage.totalTokenCount ??
    (typeof input === "number" && typeof output === "number"
      ? input + output
      : undefined);
  return {
    inputTokens: input ?? null,
    outputTokens: output ?? null,
    totalTokens: total ?? null,
    cachedInputTokens:
      usage.prompt_cache_hit_tokens ??
      usage.prompt_tokens_details?.cached_tokens ??
      usage.cache_read_input_tokens ??
      null,
    reasoningTokens:
      usage.completion_tokens_details?.reasoning_tokens ??
      usage.thoughtsTokenCount ??
      null,
  };
}
