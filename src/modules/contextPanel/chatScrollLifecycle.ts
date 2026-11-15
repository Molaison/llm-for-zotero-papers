import {
  cancelChatNavigation,
  cancelChatScrollFollow,
  disposeChatScrollViewport,
  initializeChatScrollViewport,
  observeChatScroll,
  scheduleChatScrollReconciliation,
} from "./chatScrollSnapshots";

/** Connect one mounted chat to its scroll owner; no geometry policy lives here. */
export function bindChatScrollLifecycle(
  chatBox: HTMLDivElement,
  getConversationKey: () => number | null,
  onUserActivity: () => void,
): () => void {
  let activeKey: number | null = null;
  const syncConversation = () => {
    const key = getConversationKey();
    if (key !== activeKey) {
      disposeChatScrollViewport(chatBox);
      activeKey = key;
      if (key !== null) initializeChatScrollViewport(key, chatBox);
    }
    return key;
  };
  syncConversation();
  const win = chatBox.ownerDocument.defaultView;
  const cancelFromInput = () => {
    onUserActivity();
    cancelChatNavigation(chatBox);
    const key = syncConversation();
    if (key !== null) cancelChatScrollFollow(key, chatBox);
  };
  const onScroll = () => {
    const key = syncConversation();
    if (key !== null) observeChatScroll(key, chatBox);
  };
  const onWheel = (event: WheelEvent) => {
    onUserActivity();
    if (event.deltaY < 0) cancelFromInput();
  };
  const onKey = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest("input, textarea, [contenteditable=true]")) return;
    if (
      ["ArrowUp", "PageUp", "Home"].includes(event.key) ||
      (event.key === " " && event.shiftKey)
    )
      cancelFromInput();
  };
  const onPointer = (event: PointerEvent) => {
    // Native scrollbar input targets the viewport itself. Content controls
    // retain their own behavior; opening one does not impersonate a scroll.
    if (event.target === chatBox) cancelFromInput();
  };
  const onLayout = () => {
    const key = syncConversation();
    if (key !== null) scheduleChatScrollReconciliation(key, chatBox);
  };
  chatBox.addEventListener("scroll", onScroll, { passive: true });
  chatBox.addEventListener("wheel", onWheel, { passive: true });
  chatBox.addEventListener("keydown", onKey);
  chatBox.addEventListener("pointerdown", onPointer);
  chatBox.addEventListener("touchstart", cancelFromInput, { passive: true });

  // Observe the viewport and its content, since streaming can resize a message
  // without resizing the flex-sized viewport (and vice versa).
  const resizeObserver = win?.ResizeObserver
    ? new win.ResizeObserver(onLayout)
    : null;
  const observed = new Set<Element>();
  const observeChildren = () => {
    for (const child of observed) {
      if (child.parentElement === chatBox) continue;
      resizeObserver?.unobserve(child);
      observed.delete(child);
    }
    for (const child of Array.from(chatBox.children)) {
      if (observed.has(child)) continue;
      observed.add(child);
      resizeObserver?.observe(child);
    }
  };
  resizeObserver?.observe(chatBox);
  observeChildren();
  const mutationObserver = win?.MutationObserver
    ? new win.MutationObserver((records) => {
        if (
          records.some(
            (record) =>
              record.target === chatBox && record.type === "childList",
          )
        )
          observeChildren();
        onLayout();
      })
    : null;
  mutationObserver?.observe(chatBox, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["open", "hidden", "class", "style"],
  });
  return () => {
    chatBox.removeEventListener("scroll", onScroll);
    chatBox.removeEventListener("wheel", onWheel);
    chatBox.removeEventListener("keydown", onKey);
    chatBox.removeEventListener("pointerdown", onPointer);
    chatBox.removeEventListener("touchstart", cancelFromInput);
    mutationObserver?.disconnect();
    resizeObserver?.disconnect();
    observed.clear();
    disposeChatScrollViewport(chatBox);
  };
}
