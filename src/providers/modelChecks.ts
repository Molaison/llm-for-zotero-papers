/**
 * Legacy name-based defaults when no model capability metadata is available.
 * DeepSeek models allow images by default, without version or endpoint rules.
 */
function getModelNameCandidates(model: string): string[] {
  const normalized = model.trim().toLowerCase();
  if (!normalized) return [];
  const tail = normalized.split("/").pop() || "";
  return tail && tail !== normalized ? [normalized, tail] : [normalized];
}

function isDeepseekModel(candidate: string): boolean {
  return /^deepseek(?:$|[-.])/.test(candidate);
}

function isExplicitTextOnlyModel(candidate: string): boolean {
  return /text-only|embedding/.test(candidate);
}

export function isTextOnlyModel(model: string): boolean {
  const candidates = getModelNameCandidates(model);
  const deepseekCandidates = candidates.filter(isDeepseekModel);
  if (deepseekCandidates.length) {
    return deepseekCandidates.some(isExplicitTextOnlyModel);
  }
  return candidates.some(
    (candidate) =>
      /reasoner/.test(candidate) || isExplicitTextOnlyModel(candidate),
  );
}
