import { createContextIcon } from "../contextIcons";
import type { ActionCardObject, ActionCardTarget } from "./actionCardModel";
import type { ActionCardVerb } from "./actionCardVocabulary";

/**
 * The pieces the action card is drawn from: the same chips the composer shows
 * for a paper, a collection, a tag, a note or a file.
 *
 * A turn's effects are stated with the objects the reader already recognises
 * from the composer, so "moved these two papers into Reviews" reads as the
 * chips for those papers, a glyph, and the chip for that collection. The DOM
 * is the composer's, class for class, so one stylesheet keeps both surfaces
 * looking the same.
 */

/** An object the card can send the reader to, carried in the chip's dataset. */
export type NavigableTarget =
  | ActionCardTarget
  | Extract<
      ActionCardObject,
      { kind: "collection" | "note" | "file" | "trash" | "tag" }
    >;

/**
 * One composer-shaped chip.
 *
 * A chip that names something the reader can open is also a link: it takes the
 * focus ring and the role a link has, carries what to open in its dataset, and
 * shows the trailing jump glyph the citation links use.
 */
function chip(
  doc: Document,
  shellClass: string,
  headerClass: string,
  labelClass: string,
  icon: HTMLElement,
  titleClass: string,
  text: string,
  nav: NavigableTarget | null,
): HTMLElement {
  const root = doc.createElement("div");
  root.className = `llm-selected-context ${shellClass}`;
  const header = doc.createElement("div");
  // Both classes are the composer's: `llm-image-preview-header` is what lays
  // the header out as an inline-flex box that shrinks to its content, and it
  // wins over `.llm-selected-context-header`'s `display: flex` later in the
  // sheet. A chip missing it stretches to the row's width.
  header.className = `llm-image-preview-header llm-selected-context-header ${headerClass}`;
  const label = doc.createElement("span");
  label.className = labelClass;
  const title = doc.createElement("span");
  title.className = titleClass;
  title.textContent = text;
  label.append(icon, title);
  if (nav) {
    root.classList.add("llm-agent-action-link");
    root.setAttribute("role", "link");
    root.setAttribute("tabindex", "0");
    root.dataset.llmNav = JSON.stringify(nav);
    const jump = doc.createElement("span");
    jump.className = "llm-citation-icon";
    jump.setAttribute("aria-hidden", "true");
    label.appendChild(jump);
  }
  header.appendChild(label);
  root.appendChild(header);
  return root;
}

/**
 * The chip's icon. Commands and the trash have no composer chip of their own,
 * so they get a mask span in the same shape the context icons use; their mask
 * images are declared beside the card's other styles.
 */
function maskIcon(
  doc: Document,
  name: "command" | "trash",
  className: string,
): HTMLElement {
  const icon = doc.createElement("span");
  icon.className = `llm-context-svg-icon llm-context-icon-${name} ${className}`;
  icon.setAttribute("aria-hidden", "true");
  return icon;
}

/** One object an effect covered, as the composer draws it. */
export function renderTargetChip(
  doc: Document,
  target: ActionCardTarget,
): HTMLElement {
  if (target.kind === "item")
    return chip(
      doc,
      "llm-paper-context-chip",
      "llm-paper-context-chip-header",
      "llm-paper-context-chip-label",
      createContextIcon(doc, "paper", "llm-paper-context-chip-icon"),
      "llm-paper-context-chip-text",
      target.label,
      target,
    );
  if (target.kind === "collection")
    return chip(
      doc,
      "llm-collection-context-chip",
      "llm-collection-chip-header",
      "llm-collection-chip-label",
      createContextIcon(doc, "collection", "llm-collection-chip-icon"),
      "llm-collection-chip-title",
      target.label,
      target,
    );
  return chip(
    doc,
    "llm-other-ref-chip",
    "llm-other-ref-chip-header",
    "llm-other-ref-chip-label",
    createContextIcon(doc, "file", "llm-other-ref-chip-icon"),
    "llm-other-ref-chip-title",
    target.label,
    null,
  );
}

/**
 * The objects a row covered. Past the second, they fold into the composer's
 * `+N` badge, which names the rest in its tooltip rather than growing the row.
 */
export function renderTargetList(
  doc: Document,
  targets: readonly ActionCardTarget[],
  max = 2,
): HTMLElement {
  const list = doc.createElement("div");
  list.className = "llm-agent-action-targets";
  for (const target of targets.slice(0, max))
    list.appendChild(renderTargetChip(doc, target));
  if (targets.length > max) {
    const badge = doc.createElement("span");
    badge.className = "llm-paper-picker-badge";
    badge.textContent = `+${targets.length - max}`;
    badge.setAttribute(
      "title",
      targets
        .slice(max)
        .map((target) => target.label)
        .join("\n"),
    );
    list.appendChild(badge);
  }
  return list;
}

/**
 * What an effect acted on: the collection it moved into, the tag it applied,
 * the note it wrote, the file it produced.
 *
 * A chip links only where there is something to open. A tag the turn removed
 * is gone, a command is not a library object, and a collection or note the
 * receipt never identified cannot be found again — none of those are links.
 */
export function renderObjectChip(
  doc: Document,
  object: ActionCardObject,
): HTMLElement {
  switch (object.kind) {
    case "collection":
      return chip(
        doc,
        "llm-collection-context-chip",
        "llm-collection-chip-header",
        "llm-collection-chip-label",
        createContextIcon(doc, "collection", "llm-collection-chip-icon"),
        "llm-collection-chip-title",
        object.label,
        object.collectionId !== undefined ? object : null,
      );
    case "tag":
      return chip(
        doc,
        "llm-tag-context-chip",
        "llm-tag-chip-header",
        `llm-tag-chip-label${object.removed ? " removed" : ""}`,
        createContextIcon(doc, "tag", "llm-tag-chip-icon"),
        "llm-tag-chip-title",
        object.label,
        object.removed ? null : object,
      );
    case "note":
      return chip(
        doc,
        "llm-note-context-chip",
        "llm-other-ref-chip-header",
        "llm-other-ref-chip-label",
        createContextIcon(doc, "note", "llm-other-ref-chip-icon"),
        "llm-other-ref-chip-title",
        object.label,
        object.itemKey ? object : null,
      );
    case "file":
      return chip(
        doc,
        "llm-other-ref-chip",
        "llm-other-ref-chip-header",
        "llm-other-ref-chip-label",
        createContextIcon(doc, "file", "llm-other-ref-chip-icon"),
        "llm-other-ref-chip-title llm-agent-action-path",
        object.label,
        object,
      );
    case "command":
      return chip(
        doc,
        "llm-other-ref-chip",
        "llm-other-ref-chip-header",
        "llm-other-ref-chip-label",
        maskIcon(doc, "command", "llm-other-ref-chip-icon"),
        "llm-other-ref-chip-title llm-agent-action-path",
        object.label,
        null,
      );
    case "trash":
      return chip(
        doc,
        "llm-other-ref-chip",
        "llm-other-ref-chip-header",
        "llm-other-ref-chip-label",
        maskIcon(doc, "trash", "llm-other-ref-chip-icon"),
        "llm-other-ref-chip-title",
        "Trash",
        object,
      );
    case "field": {
      // A metadata field is not an object the reader can open; it is named
      // beside the effect the way the trace names a field it changed.
      const badge = doc.createElement("span");
      badge.className = "llm-agent-hitl-badge";
      badge.textContent = object.label;
      return badge;
    }
  }
}

/**
 * The word the operation catalog gives an operation.
 *
 * Beside a glyph it is visually hidden rather than removed, so a screen reader
 * still hears what the glyph means. Where the effect has no object chip to be
 * read from, it is the only thing that says what happened, and is shown.
 */
export function renderVerbWord(
  doc: Document,
  label: string,
  visible: boolean,
): HTMLElement {
  const word = doc.createElement("span");
  word.className = `llm-agent-action-verb-word${visible ? " llm-agent-action-verb-word-inline" : ""}`;
  word.textContent = label;
  return word;
}

/**
 * How an operation is drawn between the objects it joined: its glyph, and the
 * word the operation catalog gives it.
 *
 * An operation with no glyph draws nothing at all. A node with neither a glyph
 * nor a visible word is a gap in the row carrying a tooltip the reader cannot
 * point at; the row states such an operation's word on the effect itself.
 */
export function renderVerb(
  doc: Document,
  verb: ActionCardVerb,
  label: string,
  /** Whether the effect has no object chip, so the word is shown here. */
  showWord = false,
): HTMLElement | null {
  if (!verb.glyph) return null;
  const node = doc.createElement("span");
  node.className = `llm-agent-action-verb${verb.destructive ? " llm-agent-action-verb-destructive" : ""}`;
  node.setAttribute("title", label);
  const glyph = doc.createElement("span");
  glyph.className = "llm-context-glyph-icon";
  glyph.setAttribute("aria-hidden", "true");
  glyph.textContent = verb.glyph;
  node.append(glyph, renderVerbWord(doc, label, showWord));
  return node;
}

/** A row's verdict wording, in the chip shape the trace rows already use. */
export function renderProcessChips(
  doc: Document,
  badges: readonly string[],
): HTMLElement {
  const chips = doc.createElement("div");
  chips.className = "llm-agent-process-chips";
  for (const badge of badges) {
    const shell = doc.createElement("div");
    shell.className = "llm-agent-process-chip";
    const label = doc.createElement("span");
    label.className = "llm-agent-process-chip-label";
    label.textContent = badge;
    shell.appendChild(label);
    chips.appendChild(shell);
  }
  return chips;
}

/** What a row's receipts refused to touch, and why they said they refused. */
export function renderSkipRow(
  doc: Document,
  rejected: readonly ActionCardTarget[],
  reason?: string,
): HTMLElement {
  const row = doc.createElement("div");
  row.className = "llm-at-row llm-at-row-skip";
  const icon = doc.createElement("span");
  icon.className = "llm-at-icon";
  icon.textContent = "!";
  const text = doc.createElement("span");
  text.className = "llm-at-text";
  text.textContent = `Skipped ${rejected
    .map((target) => target.label)
    .join(", ")}${reason ? ` · ${reason}` : ""}`;
  row.append(icon, text);
  return row;
}

/** What a chip opens, or nothing when the chip is not a link. */
export function navigationTargetOf(
  element: HTMLElement,
): NavigableTarget | null {
  const raw = element.dataset?.llmNav;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as NavigableTarget;
  } catch {
    return null;
  }
}
