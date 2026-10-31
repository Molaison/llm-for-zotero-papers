import {
  SCREENSHOT_COMPACT_LABEL,
  SELECT_TEXT_COMPACT_LABEL,
  getSelectTextExpandedLabel,
  getScreenshotExpandedLabel,
  UPLOAD_FILE_COMPACT_LABEL,
  UPLOAD_FILE_EXPANDED_LABEL,
} from "../../constants";
import { t } from "../../../../utils/i18n";

type ActionLabelMode = "icon" | "full";

type ActionLayoutControllerDeps = {
  body: Element;
  panelRoot: HTMLDivElement;
  actionsRow: HTMLDivElement | null;
  actionsLeft: HTMLDivElement | null;
  modelBtn: HTMLButtonElement | null;
  modelSlot: HTMLDivElement | null;
  reasoningBtn: HTMLButtonElement | null;
  reasoningSlot: HTMLDivElement | null;
  uploadBtn: HTMLButtonElement | null;
  selectTextBtn: HTMLButtonElement | null;
  screenshotBtn: HTMLButtonElement | null;
  sendBtn: HTMLButtonElement;
  cancelBtn: HTMLButtonElement | null;
};


/** CSS keeps one toolbar row; only model text may shrink with ellipsis. */
export function createActionLayoutController(deps: ActionLayoutControllerDeps) {
  const { body, panelRoot, modelBtn, modelSlot, reasoningBtn, reasoningSlot,
    uploadBtn, selectTextBtn, screenshotBtn, sendBtn, cancelBtn } = deps;
  const setActionButtonLabel = (
    button: HTMLButtonElement | null,
    expandedLabel: string,
    compactLabel: string,
    mode: ActionLabelMode,
  ) => {
    if (!button) return;
    const label = mode === "icon" ? compactLabel : expandedLabel;
    if (button.textContent !== label) button.textContent = label;
    button.classList.toggle("llm-action-icon-only", mode === "icon");
  };
  const setSendButtonLabel = (_mode: ActionLabelMode) => {
    setActionButtonLabel(sendBtn, "", "", "icon");
    sendBtn.setAttribute("aria-label", t("Send"));
    sendBtn.title = t("Send");
    setActionButtonLabel(cancelBtn, "", "", "icon");
    if (cancelBtn) cancelBtn.title = t("Cancel");
  };
  const applyResponsiveActionButtonsLayout = () => {
    if (!body.isConnected || !panelRoot.isConnected || !panelRoot.clientWidth) return;
    setActionButtonLabel(uploadBtn, "+", "+", "full");
    setActionButtonLabel(selectTextBtn, getSelectTextExpandedLabel(), getSelectTextExpandedLabel(), "full");
    setActionButtonLabel(screenshotBtn, getScreenshotExpandedLabel(), getScreenshotExpandedLabel(), "full");
    setSendButtonLabel("full");
    for (const [button, slot, kind] of [
      [modelBtn, modelSlot, "model"],
      [reasoningBtn, reasoningSlot, "reasoning"],
    ] as const) {
      if (!button) continue;
      const label = button.dataset[`${kind}Label`] || button.textContent || "";
      const hint = button.dataset[`${kind}Hint`] || "";
      button.classList.toggle(`llm-${kind}-btn-collapsed`, false);
      slot?.classList.toggle(`llm-${kind}-dropdown-collapsed`, false);
      button.classList.toggle("llm-model-btn-wrap-2line", false);
      button.textContent = label;
      button.title = kind === "reasoning"
        ? `${t("Reasoning")}: ${label}${hint && hint !== t("Reasoning") ? `\n${hint}` : ""}`
        : hint ? `${label}\n${hint}` : label;
      button.setAttribute("aria-label", button.title);
    }
    panelRoot.dataset.llmActionLayoutMode = "full";
  };
  return { setActionButtonLabel, setSendButtonLabel, applyResponsiveActionButtonsLayout };
}
