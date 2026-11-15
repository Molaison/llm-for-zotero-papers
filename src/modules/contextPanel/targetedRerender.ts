/**
 * Resolution logic for targeted assistant-message re-renders.
 *
 * A refresh may request that only specific assistant messages be rebuilt
 * (streaming flushes, quote revalidation, turn completion). Targeting is only
 * safe when every requested message is present in the history AND its rendered
 * wrapper is still in the DOM; otherwise the caller must fall back to a full
 * rebuild.
 *
 * A user message may be requested only as the prompt of a requested assistant
 * answer. Finishing a turn changes the prompt's rendered controls (its edit
 * and delete affordances open up once the answer stops streaming), so the pair
 * has to be rebuilt together. Any other user message is rejected: its
 * presentation depends on state the targeted path does not recompute.
 */

type WrapperLike = {
  dataset: { messageRole?: string; messageIndex?: string };
};

export type TargetedRerenderResolution<M, W> = {
  useTargetedRerender: boolean;
  targetedMessageWrappers: Map<M, W>;
};

export function resolveTargetedAssistantRerenders<
  M extends { role: string },
  W extends WrapperLike,
>(
  history: readonly M[],
  requestedRerenders: ReadonlySet<M> | undefined,
  renderedWrappers: readonly W[],
): TargetedRerenderResolution<M, W> {
  const targetedMessageWrappers = new Map<M, W>();
  if (!requestedRerenders?.size) {
    return { useTargetedRerender: false, targetedMessageWrappers };
  }
  for (const message of requestedRerenders) {
    const messageIndex = history.indexOf(message);
    if (messageIndex < 0) {
      return { useTargetedRerender: false, targetedMessageWrappers: new Map() };
    }
    if (message.role !== "assistant") {
      const pairedAssistant = history[messageIndex + 1];
      const isPairedPrompt =
        message.role === "user" &&
        pairedAssistant?.role === "assistant" &&
        requestedRerenders.has(pairedAssistant);
      if (!isPairedPrompt) {
        return {
          useTargetedRerender: false,
          targetedMessageWrappers: new Map(),
        };
      }
    }
    const wrapper = renderedWrappers.find(
      (candidate) =>
        candidate.dataset.messageRole === message.role &&
        candidate.dataset.messageIndex === `${messageIndex}`,
    );
    if (!wrapper) {
      return { useTargetedRerender: false, targetedMessageWrappers: new Map() };
    }
    targetedMessageWrappers.set(message, wrapper);
  }
  return { useTargetedRerender: true, targetedMessageWrappers };
}
