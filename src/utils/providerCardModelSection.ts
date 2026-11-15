import { createElement, iconBtn } from "./domHelpers";

/**
 * Provider cards render with the same `.llm-pref-*` stylesheet the Agent tab
 * uses (see the style block in preferences.xhtml), so these blueprints hand
 * back classed elements rather than inline style strings. Nothing here
 * declares appearance; changing how a model row looks is a stylesheet edit.
 */

/** Class for a full-width model control (text input or catalog dropdown). */
export const PROVIDER_MODEL_INPUT_CLASS = "llm-pref-input";
export const PROVIDER_MODEL_SELECT_CLASS = "llm-pref-select";
/** Wrapper that lets a dropdown and its manual-entry input share one slot. */
export const PROVIDER_MODEL_SLOT_CLASS = "llm-pref-model-control-slot";

export function createProviderModelSectionBlueprint(params: {
  doc: Document;
  title: string;
  addTitle: string;
}): {
  section: HTMLDivElement;
  header: HTMLDivElement;
  addButton: HTMLButtonElement;
} {
  const section = createElement(params.doc, "div", "llm-pref-section");
  const header = createElement(params.doc, "div", "llm-pref-section-head");
  header.appendChild(
    createElement(params.doc, "span", "llm-pref-section-title", {
      textContent: params.title,
    }),
  );
  const addButton = iconBtn(params.doc, "+", params.addTitle);
  addButton.style.color = "var(--color-accent, #2563eb)";
  header.appendChild(addButton);
  section.appendChild(header);
  return { section, header, addButton };
}

export function createProviderModelRowBlueprint(params: {
  doc: Document;
  testLabel: string;
}): {
  row: HTMLDivElement;
  controls: HTMLDivElement;
  testButton: HTMLButtonElement;
  status: HTMLSpanElement;
} {
  const row = createElement(params.doc, "div", "llm-pref-model-row");
  const controls = createElement(params.doc, "div", "llm-pref-model-controls");
  const testButton = createElement(params.doc, "button", "llm-pref-button", {
    type: "button",
    textContent: params.testLabel,
  });
  const status = createElement(params.doc, "span", "llm-pref-status");
  status.style.display = "none";
  row.appendChild(controls);
  return { row, controls, testButton, status };
}
