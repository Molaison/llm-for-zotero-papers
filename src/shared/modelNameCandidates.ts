/**
 * A model id as a gateway namespaces it, plus the plain id underneath.
 *
 * OpenCode Zen serves `opencode/gpt-5.6-sol`; OpenRouter-style catalogs nest
 * further (`openrouter/deepseek/deepseek-v4-pro`). Family rules anchored to
 * the start of the string would miss all of those, so every lookup that keys
 * off a model name tries each candidate in turn: the full id first, then the
 * id with one leading `vendor/` segment removed, and so on.
 *
 * Only `/` separates a vendor from its id, so `not-a-vendor-gpt-5.6` yields no
 * extra candidate and cannot be mistaken for a prefixed name. See #439.
 */
export function modelNameCandidates(modelName: string): string[] {
  const name = modelName.trim().toLowerCase();
  if (!name) return [];
  const candidates = [name];
  let rest = name;
  while (rest.includes("/")) {
    rest = rest.slice(rest.indexOf("/") + 1);
    if (rest) candidates.push(rest);
  }
  return candidates;
}
