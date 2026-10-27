import { withChatContentScrollGuard } from "./chatScrollSnapshots";
import { marked } from "marked";
import { renderRenderedMarkdownInto, reconcileRenderedMarkdownChildren, enrichRenderedMarkdown } from "./renderedMarkdown";
import { createCoalescedFrameScheduler } from "./setupHandlers/controllers/uiSchedulingController";

/** Stable Markdown blocks share the normal renderer; only the unfinished tail is reparsed. */
const streams = new WeakMap<
  HTMLElement,
  {
    source: string | undefined;
    committed: string;
    tail: HTMLElement;
    pending: string;
    scheduler: ReturnType<typeof createCoalescedFrameScheduler>;
  }
>();

export function renderStreamingMarkdownInto(
  target: HTMLElement,
  source: string,
  doc: Document,
  onResize: () => void,
): void {
  let state = streams.get(target);
  if (!state || !source.startsWith(state.source ?? "")) {
    state?.scheduler.cancel();
    const tail = doc.createElement("div");
    tail.className = "llm-stream-tail";
    tail.style.display = "contents";
    const next = {
      source: undefined as string | undefined,
      committed: "",
      tail,
      pending: "",
      scheduler: null! as ReturnType<typeof createCoalescedFrameScheduler>,
    };
    next.scheduler = createCoalescedFrameScheduler({
      getWindow: () => doc.defaultView,
      run: () => {
        if (!target.isConnected || streams.get(target) !== next) return;
        // Prepare off-DOM so a budget yield never exposes committed blocks
        // alongside the previous tail, or clears a restarted stream early.
        const now = () => doc.defaultView?.performance.now() ?? Date.now();
        const started = now();
        let committed = next.committed;
        const blocks: HTMLElement[] = [];
        const tokens = marked.lexer(next.pending.slice(committed.length));
        // Retain the last two tokens: blank lines can still extend a list/table.
        const stable = tokens.slice(0, -2);
        for (const token of stable) {
          if (now() - started >= 8 && blocks.length) {
            next.scheduler.schedule();
            break;
          }
          const block = doc.createElement("div");
          block.style.display = "contents";
          renderRenderedMarkdownInto(block, token.raw, doc, {
            onAsyncContentRendered: onResize,
            deferEnrichment: true,
          });
          blocks.push(block);
          committed += token.raw;
        }
        const tail = doc.createElement("div");
        tail.className = "llm-stream-tail";
        tail.style.display = "contents";
        renderRenderedMarkdownInto(
          tail,
          next.pending.slice(committed.length),
          doc,
          {
            onAsyncContentRendered: onResize,
            deferEnrichment: true,
          },
        );
        withChatContentScrollGuard(target, () => {
          if (next.tail.parentElement === target) {
            // Reconcile the same tail tree before promoting complete blocks.
            // Moving its retained children into block wrappers is synchronous:
            // no intermediate blank/math fallback frame is exposed.
            const desired = doc.createElement("div");
            const sizes = blocks.map(block => block.childNodes.length);
            for (const block of [...blocks, tail]) desired.append(...(Array.from(block.childNodes) as Node[]));
            reconcileRenderedMarkdownChildren(next.tail, desired);
            blocks.forEach((block, index) => {
              for (let i = 0; i < sizes[index]; i++) block.append(next.tail.firstChild!);
              target.insertBefore(block, next.tail);
              enrichRenderedMarkdown(block, doc, onResize);
            });
          } else {
            target.replaceChildren(...blocks, tail);
            next.tail = tail;
            for (const block of blocks) enrichRenderedMarkdown(block, doc, onResize);
          }
          next.committed = committed;
          onResize();
        });
      },
    });
    streams.set(target, next);
    state = next;
  }
  if (state.source === source) return;
  state.source = source;
  state.pending = source;
  state.scheduler.schedule();
}

/** Finish the same live tree; final enrichment must not recreate closed math. */
export function finishStreamingMarkdownInto(
  target: HTMLElement, source: string, doc: Document, onResize?: () => void,
): boolean {
  const state = streams.get(target);
  if (!state) return false;
  state.scheduler.cancel();
  streams.delete(target);
  withChatContentScrollGuard(target, () => {
    // Streaming wrappers own no content semantics. Flatten them in this one
    // synchronous update before reconciling the canonical completed Markdown.
    for (const block of Array.from(target.children)) {
      if (block === state.tail || (block as HTMLElement).style.display === "contents") {
        while (block.firstChild) target.insertBefore(block.firstChild, block);
        block.remove();
      }
    }
    renderRenderedMarkdownInto(target, source, doc, {
      preserveExisting: source.startsWith(state.source ?? ""),
      onAsyncContentRendered: onResize,
    });
    onResize?.();
  });
  return true;
}

export function disposeStreamingMarkdown(target: HTMLElement): void {
  streams.get(target)?.scheduler.cancel();
  streams.delete(target);
}
