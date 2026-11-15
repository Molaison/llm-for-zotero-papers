import type { IncludeReaderSelectedTextOutcome } from "../readerTextInclusion";
import { classifySelectionPromptKey } from "./selectionPromptKeys";

const XHTML_NS = "http://www.w3.org/1999/xhtml";
const OVERLAY_KEY = "__llmReaderSelectionPromptOverlay";
const MARGIN = 8;
const GAP = 6;

export type ReaderSelectionPromptAnchor = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export type ReaderSelectionPromptOverlayInput = {
  /** Reader popup document (the renderTextSelectionPopup event's doc). */
  doc: Document;
  /** "Add Text" button rect in viewport coordinates, measured at pointerdown. */
  anchor: ReaderSelectionPromptAnchor;
  /** The selection the box asks about, shown above the editor. */
  selectedText: string;
  /** Editor text at open (the chip's current question), caret at the end. */
  initialText?: string;
  labels: {
    placeholder: string;
    hint: string;
    /** The button label ("Add"). */
    submit: string;
    /** Label above the quoted selection ("Selected text"). */
    selectedTextLabel: string;
    /** Shown in place of the hint when onSubmit refuses the text. */
    chipGone?: string;
  };
  /** Receives non-empty, trimmed text. */
  /** Return false when the text was not accepted; the box then stays open. */
  onSubmit: (text: string) => boolean;
  /** Called exactly once on any close path. */
  onClose: () => void;
};

export type ReaderSelectionPromptOverlayHandle = {
  close(): void;
  root: HTMLElement;
};

/**
 * Every open overlay and its document, so plugin shutdown can close them
 * all. Entries whose reader document lost its window (tab closed) are
 * dropped at the next open, so the registry does not keep dead documents.
 */
const openOverlays = new Map<ReaderSelectionPromptOverlayHandle, Document>();

function pruneDeadOverlays(): void {
  for (const [handle, doc] of Array.from(openOverlays)) {
    let alive = false;
    try {
      alive = Boolean(doc.defaultView);
    } catch {
      alive = false;
    }
    if (alive) continue;
    openOverlays.delete(handle);
    try {
      handle.close();
    } catch {
      // The document is gone; nothing left to detach.
    }
  }
}

type DocWithOverlay = Document & {
  [OVERLAY_KEY]?: ReaderSelectionPromptOverlayHandle;
};

/**
 * `doc` plus every same-origin iframe document nested in it. The reader UI
 * document hosts the popup, but the PDF page lives in a nested view iframe,
 * and pointer events there never reach `doc`.
 */
function collectPointerDocuments(doc: Document, depth = 3): Document[] {
  const docs: Document[] = [doc];
  if (depth <= 0) return docs;
  let frames: ArrayLike<HTMLIFrameElement> = [];
  try {
    frames = doc.querySelectorAll?.("iframe") ?? [];
  } catch {
    return docs;
  }
  for (const frame of Array.from(frames)) {
    let inner: Document | null = null;
    try {
      inner = frame.contentDocument;
    } catch {
      continue; // cross-origin
    }
    if (inner && !docs.includes(inner)) {
      for (const nested of collectPointerDocuments(inner, depth - 1)) {
        if (!docs.includes(nested)) docs.push(nested);
      }
    }
  }
  return docs;
}

function isDark(doc: Document): boolean {
  try {
    return Boolean(
      doc.defaultView?.matchMedia?.("(prefers-color-scheme: dark)")?.matches,
    );
  } catch {
    return false;
  }
}

/**
 * Plugin-owned floating prompt box for the reader (D6). It lives outside
 * Zotero's selection popup, so popup teardown cannot remove it. One overlay
 * per document; a new one replaces the old one. Plugin CSS never reaches
 * reader documents, so every style is inline.
 */
export function openReaderSelectionPromptOverlay(
  input: ReaderSelectionPromptOverlayInput,
): ReaderSelectionPromptOverlayHandle {
  const { doc, anchor, labels } = input;
  pruneDeadOverlays();
  (doc as DocWithOverlay)[OVERLAY_KEY]?.close();

  const dark = isDark(doc);
  const bg = dark ? "#2b2b2b" : "#ffffff";
  const fg = dark ? "#e6e6e6" : "#1f1f1f";
  const border = dark ? "rgba(255,255,255,0.18)" : "rgba(0,0,0,0.18)";
  const fieldBg = dark ? "#1f1f1f" : "#f6f6f6";
  const quoteFg = dark ? "#b3b3b3" : "#5b5b5b";
  const labelFg = dark ? "#8f8f8f" : "#7a7a7a";

  const el = (tag: string, css: string[]) => {
    const node = doc.createElementNS(XHTML_NS, tag) as HTMLElement;
    node.style.cssText = css.join(";");
    return node;
  };
  const root = el("div", [
    "position:fixed",
    "z-index:10000",
    "display:flex",
    "flex-direction:column",
    "gap:4px",
    "width:320px",
    "max-width:calc(100vw - 16px)",
    "padding:8px",
    "box-sizing:border-box",
    `background:${bg}`,
    `color:${fg}`,
    `border:1px solid ${border}`,
    "border-radius:10px",
    "box-shadow:0 6px 18px rgba(0,0,0,0.22)",
    "font-size:12px",
    "line-height:1.3",
    "user-select:text",
    "-moz-user-select:text",
  ]);
  root.setAttribute("data-llm-reader-selection-prompt", "true");
  const quoteLabel = el("div", [
    "font-size:11px",
    `color:${labelFg}`,
    "line-height:1.2",
  ]);
  quoteLabel.setAttribute(
    "data-llm-reader-selection-prompt-quote-label",
    "true",
  );
  quoteLabel.textContent = labels.selectedTextLabel;
  // The selection, clamped to four lines and dimmed against the editor.
  const quote = el("div", [
    `color:${quoteFg}`,
    "font-size:12px",
    "line-height:1.3",
    "white-space:pre-wrap",
    "overflow-wrap:anywhere",
    "display:-webkit-box",
    "-webkit-box-orient:vertical",
    "-webkit-line-clamp:4",
    "overflow:hidden",
  ]);
  quote.setAttribute("data-llm-reader-selection-prompt-quote", "true");
  quote.textContent = input.selectedText;
  const row = el("div", ["display:flex", "gap:6px", "align-items:flex-end"]);
  // The editor is a contenteditable="true" div, not a <textarea>: Zotero's
  // reader KeyboardManager and FocusManager listen for keydown on the reader
  // window in the capture phase, before any listener here, and they skip
  // only <input type=text> and contenteditable="true" targets. A <textarea>
  // there loses Cmd/Ctrl+A, arrow keys, Alt+digits, "h", "s", and digits to
  // reader shortcuts. ("plaintext-only" fails their exact "true" check.)
  const field = el("div", [
    "position:relative",
    "flex:1 1 auto",
    "min-width:0",
  ]);
  const editor = el("div", [
    "min-height:24px",
    "max-height:120px",
    "overflow-y:auto",
    "box-sizing:border-box",
    "padding:4px 6px",
    `border:1px solid ${border}`,
    "border-radius:6px",
    `background:${fieldBg}`,
    `color:${fg}`,
    "font:inherit",
    "font-size:12px",
    "line-height:1.3",
    "white-space:pre-wrap",
    "overflow-wrap:anywhere",
    "outline:none",
    "cursor:text",
  ]);
  editor.setAttribute("contenteditable", "true");
  editor.setAttribute("role", "textbox");
  editor.setAttribute("aria-multiline", "true");
  editor.setAttribute("aria-placeholder", labels.placeholder);
  editor.setAttribute("data-llm-reader-selection-prompt-editor", "true");
  const placeholder = el("span", [
    "position:absolute",
    "left:7px",
    "top:5px",
    "right:7px",
    "overflow:hidden",
    "white-space:nowrap",
    "text-overflow:ellipsis",
    "pointer-events:none",
    "opacity:0.55",
    "font-size:12px",
    "line-height:1.3",
  ]);
  placeholder.setAttribute(
    "data-llm-reader-selection-prompt-placeholder",
    "true",
  );
  placeholder.setAttribute("aria-hidden", "true");
  placeholder.textContent = labels.placeholder;
  field.append(editor, placeholder);
  const submitBtn = el("button", [
    "flex:0 0 auto",
    "padding:4px 8px",
    `border:1px solid ${border}`,
    "border-radius:6px",
    `background:${fieldBg}`,
    `color:${fg}`,
    "font-size:12px",
    "cursor:pointer",
  ]) as HTMLButtonElement;
  submitBtn.setAttribute("type", "button");
  submitBtn.textContent = labels.submit;
  submitBtn.setAttribute("title", labels.submit);
  const hint = el("span", [
    "font-size:10px",
    "line-height:1.25",
    `color:${labelFg}`,
  ]);
  hint.textContent = labels.hint;
  row.append(field, submitBtn);
  const quoteSection = el("div", [
    "display:flex",
    "flex-direction:column",
    "gap:2px",
    "min-width:0",
  ]);
  quoteSection.append(quoteLabel, quote);
  root.append(quoteSection, row, hint);

  let closed = false;
  let pointerDocs: Document[] = [];
  const onDocPointerDown = (e: Event) => {
    const target = e.target as Node | null;
    if (target && root.contains(target)) return;
    close();
  };
  // innerText keeps Shift+Enter line breaks (<br>) as "\n".
  const readText = () => editor.innerText ?? editor.textContent ?? "";
  const syncPlaceholder = () => {
    placeholder.style.display = editor.textContent ? "none" : "";
  };
  if (input.initialText) {
    editor.textContent = input.initialText;
    syncPlaceholder();
  }
  // Puts the caret after the prefilled text, so typing extends the question.
  const placeCaretAtEnd = () => {
    if (!editor.textContent) return;
    try {
      const range = doc.createRange?.();
      const selection = doc.defaultView?.getSelection?.();
      if (!range || !selection) return;
      range.selectNodeContents(editor);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    } catch {
      // Focus alone still lets the user edit the question.
    }
  };
  const onPaste = (e: Event) => {
    // Rich paste would put markup into the box; keep it plain text.
    const text = (e as ClipboardEvent).clipboardData?.getData("text/plain");
    e.preventDefault();
    if (!text) return;
    let inserted = false;
    try {
      inserted = doc.execCommand("insertText", false, text);
    } catch {
      inserted = false;
    }
    if (!inserted) editor.textContent = `${editor.textContent || ""}${text}`;
    syncPlaceholder();
  };
  const submit = () => {
    const text = readText().trim();
    if (!text) {
      close();
      return;
    }
    if (input.onSubmit(text)) {
      close();
      return;
    }
    if (labels.chipGone) hint.textContent = labels.chipGone;
  };
  const onKeyDown = (e: Event) => {
    const action = classifySelectionPromptKey(e as KeyboardEvent);
    // Keeps bubble-phase listeners above the box out. The reader's window
    // capture listeners have already run; see the editor comment above.
    e.stopPropagation();
    if (action === "other" || action === "newline") return;
    e.preventDefault();
    if (action === "close") {
      close();
      return;
    }
    submit();
  };
  const onSubmitClick = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    submit();
  };
  const stop = (e: Event) => e.stopPropagation();

  function close() {
    if (closed) return;
    closed = true;
    // Remove the box and registry entry first: a dead nested document can
    // make the listener removals below throw.
    root.remove();
    openOverlays.delete(handle);
    if ((doc as DocWithOverlay)[OVERLAY_KEY] === handle) {
      delete (doc as DocWithOverlay)[OVERLAY_KEY];
    }
    for (const pointerDoc of pointerDocs) {
      try {
        pointerDoc.removeEventListener("pointerdown", onDocPointerDown, true);
      } catch {
        // The reader recreated that view; its listeners are gone with it.
      }
    }
    root.removeEventListener("keydown", onKeyDown);
    root.removeEventListener("keyup", stop);
    root.removeEventListener("keypress", stop);
    submitBtn.removeEventListener("click", onSubmitClick);
    editor.removeEventListener("input", syncPlaceholder);
    editor.removeEventListener("paste", onPaste);
    input.onClose();
  }
  const handle: ReaderSelectionPromptOverlayHandle = { close, root };

  (doc.body || doc.documentElement).appendChild(root);
  (doc as DocWithOverlay)[OVERLAY_KEY] = handle;
  openOverlays.set(handle, doc);

  // Position after mount so the measured size is real.
  const view = doc.defaultView;
  const vw = view?.innerWidth ?? 800;
  const vh = view?.innerHeight ?? 600;
  const rect = root.getBoundingClientRect();
  let top = anchor.bottom + GAP;
  if (top + rect.height > vh - MARGIN) top = anchor.top - GAP - rect.height;
  top = Math.max(MARGIN, Math.min(top, vh - MARGIN - rect.height));
  const left = Math.max(
    MARGIN,
    Math.min(anchor.left, vw - MARGIN - rect.width),
  );
  root.style.left = `${Math.round(left)}px`;
  root.style.top = `${Math.round(top)}px`;

  // Clicks on the PDF page land in the nested view iframe, not in `doc`.
  pointerDocs = collectPointerDocuments(doc);
  for (const pointerDoc of pointerDocs) {
    pointerDoc.addEventListener("pointerdown", onDocPointerDown, true);
  }
  // On the root, so Escape and Enter also work with focus on the button.
  root.addEventListener("keydown", onKeyDown);
  root.addEventListener("keyup", stop);
  root.addEventListener("keypress", stop);
  submitBtn.addEventListener("click", onSubmitClick);
  editor.addEventListener("input", syncPlaceholder);
  editor.addEventListener("paste", onPaste);
  // Bind: calling a window's setTimeout unbound throws in Gecko chrome.
  // Deferred so focus lands after the Add Text handler finishes.
  const schedule = view ? view.setTimeout.bind(view) : setTimeout;
  schedule(() => {
    if (closed) return;
    editor.focus({ preventScroll: true });
    placeCaretAtEnd();
  }, 0);
  return handle;
}

/** Closes any overlay currently open on `doc`. Safe when none is open. */
export function closeReaderSelectionPromptOverlay(doc: Document): void {
  (doc as DocWithOverlay)[OVERLAY_KEY]?.close();
}

/** Closes every open overlay (plugin shutdown). */
export function closeAllReaderSelectionPromptOverlays(): void {
  for (const handle of Array.from(openOverlays.keys())) {
    try {
      handle.close();
    } catch {
      // A torn-down reader document; nothing left to detach.
    }
  }
  openOverlays.clear();
}

/** Test seam: how many overlays are open. */
export function countOpenReaderSelectionPromptOverlays(): number {
  return openOverlays.size;
}

/**
 * Opens the reader prompt for the chip that Add Text just made, or for the
 * chip that already held this text (a duplicate add). The box starts with
 * that chip's question, if any. Enter attaches the typed text to that chip
 * as its question; it never sends. `attach` returns
 * false when no chip took the text, and the box then stays open.
 */
export function openReaderSelectionPromptForChip(input: {
  doc: Document;
  anchor: ReaderSelectionPromptAnchor;
  outcome: IncludeReaderSelectedTextOutcome | null | undefined;
  /** The normalized chip text (IncludeReaderSelectedTextResult.selectedText). */
  selectedText: string;
  /** The chip's current question; the box opens with it to edit. */
  existingQuestion?: string;
  labels: ReaderSelectionPromptOverlayInput["labels"];
  attach: (text: string) => boolean;
}): ReaderSelectionPromptOverlayHandle | null {
  if (input.outcome !== "added" && input.outcome !== "duplicate") return null;
  if (!input.selectedText.trim()) return null;
  return openReaderSelectionPromptOverlay({
    doc: input.doc,
    anchor: input.anchor,
    selectedText: input.selectedText,
    initialText: input.existingQuestion,
    labels: input.labels,
    onSubmit: (text) => input.attach(text),
    onClose: () => {},
  });
}
