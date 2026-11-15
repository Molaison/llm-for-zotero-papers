let activeActionId: string | null = null;
let mutationTail: Promise<void> = Promise.resolve();

export function getActiveMutationActionId(): string | null {
  return activeActionId;
}

/**
 * Serialize the actual Zotero write window across every conversation.
 *
 * The runtime's ordinary lock is intentionally per conversation, so two
 * conversations can otherwise overlap. A process-global action id would then
 * attribute native notifier events to whichever write happened to set it
 * last. Keeping this narrow global queue around the forward call, post-image
 * capture, and notifier flush makes attribution deterministic without
 * serializing read-only planning or confirmation UI.
 *
 * The window is reentrant by owner. An action that already holds it owns
 * every write inside it, so a nested acquire under the same action id runs
 * inline rather than waiting on itself, while a different owner still
 * queues. Only a named owner is reentrant: an unowned acquire (`null`) has
 * no identity to match and queues like any other stranger.
 */
export async function withActiveMutationAction<T>(
  actionId: string | null,
  task: () => Promise<T>,
): Promise<T> {
  if (actionId !== null && actionId === activeActionId) return task();
  const predecessor = mutationTail;
  let release!: () => void;
  mutationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await predecessor;
  const previous = activeActionId;
  activeActionId = actionId;
  try {
    return await task();
  } finally {
    activeActionId = previous;
    release();
  }
}
