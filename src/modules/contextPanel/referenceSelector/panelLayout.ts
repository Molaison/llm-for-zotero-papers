import { createElement } from "../../../utils/domHelpers";
import { t } from "../../../utils/i18n";
import type { ReferenceSelectorMode } from "./model";

export type ReferenceSelectorPanelKey = "folders" | "tags" | "references";

export const REFERENCE_SELECTOR_VIEWPORT_MARGIN = 12;
export const REFERENCE_SELECTOR_ANCHOR_GAP = 8;
export const REFERENCE_SELECTOR_MIN_USEFUL_HEIGHT = 120;
export const REFERENCE_SELECTOR_MAX_HEIGHT = 720;
export const REFERENCE_SELECTOR_VIEWPORT_FRACTION = 0.82;

const REFERENCE_SELECTOR_DEFAULT_COLLAPSED_PANELS: ReferenceSelectorPanelKey[] =
  ["tags"];
const REFERENCE_SELECTOR_PANEL_DEFAULT_HEIGHT: Record<
  ReferenceSelectorPanelKey,
  number
> = {
  folders: 190,
  tags: 180,
  references: 360,
};
const REFERENCE_SELECTOR_PANEL_MIN_HEIGHT: Record<
  ReferenceSelectorPanelKey,
  number
> = {
  folders: 165,
  tags: 150,
  references: 150,
};
const REFERENCE_SELECTOR_PANEL_MAX_HEIGHT: Record<
  ReferenceSelectorPanelKey,
  number
> = {
  folders: 420,
  tags: 300,
  references: 520,
};
const REFERENCE_SELECTOR_PANEL_KEYS: ReferenceSelectorPanelKey[] = [
  "folders",
  "references",
  "tags",
];
const REFERENCE_SELECTOR_AUTO_COLLAPSE_ORDER: ReferenceSelectorPanelKey[] = [
  "references",
  "folders",
  "tags",
];
export const REFERENCE_SELECTOR_PANEL_COLLAPSED_HEIGHT = 28;
const REFERENCE_SELECTOR_LIST_VERTICAL_PADDING = 12;

type ReferenceSelectorPanelLayoutDeps = {
  paperPicker: HTMLDivElement | null;
  paperPickerList: HTMLDivElement | null;
  getMode: () => ReferenceSelectorMode;
  render: () => void;
};

export type ReferenceSelectorPanelLayout = {
  reset: () => void;
  isCollapsed: (key: ReferenceSelectorPanelKey) => boolean;
  toggleCollapsed: (key: ReferenceSelectorPanelKey) => void;
  capturePanelHeights: () => void;
  captureRenderedPanelHeights: () => Map<ReferenceSelectorPanelKey, number>;
  fitPanelsToAvailableHeight: (
    preferredOpenPanel?: ReferenceSelectorPanelKey,
  ) => void;
  applyPanelHeight: (
    panel: HTMLElement,
    key: ReferenceSelectorPanelKey,
  ) => void;
  createPanelSeparator: (
    ownerDoc: Document,
    key: ReferenceSelectorPanelKey,
    panel: HTMLElement,
  ) => HTMLElement;
  createPanelToggle: (
    ownerDoc: Document,
    key: ReferenceSelectorPanelKey,
  ) => HTMLButtonElement;
  attachPanelHeaderToggle: (
    header: HTMLElement,
    key: ReferenceSelectorPanelKey,
  ) => void;
  animatePanelHeights: (
    shell: HTMLElement,
    previousHeights: Map<ReferenceSelectorPanelKey, number>,
  ) => void;
};

export function createReferenceSelectorPanelLayout(
  deps: ReferenceSelectorPanelLayoutDeps,
): ReferenceSelectorPanelLayout {
  let collapsedPanels = new Set<ReferenceSelectorPanelKey>(
    REFERENCE_SELECTOR_DEFAULT_COLLAPSED_PANELS,
  );
  let panelHeights = new Map<ReferenceSelectorPanelKey, number>();

  const reset = (): void => {
    collapsedPanels = new Set<ReferenceSelectorPanelKey>(
      REFERENCE_SELECTOR_DEFAULT_COLLAPSED_PANELS,
    );
    panelHeights = new Map<ReferenceSelectorPanelKey, number>();
  };

  const getPanelStackBudget = (): number => {
    const rawMaxHeight =
      deps.paperPicker?.style.getPropertyValue(
        "--llm-paper-picker-max-height",
      ) || "";
    const maxHeight = Number.parseFloat(rawMaxHeight);
    const safeMaxHeight =
      Number.isFinite(maxHeight) && maxHeight > 0
        ? maxHeight
        : REFERENCE_SELECTOR_MAX_HEIGHT;
    return Math.max(
      0,
      safeMaxHeight - REFERENCE_SELECTOR_LIST_VERTICAL_PADDING,
    );
  };

  const getPanelBudgetHeight = (
    key: ReferenceSelectorPanelKey,
    panels: Set<ReferenceSelectorPanelKey> = collapsedPanels,
  ): number => {
    if (panels.has(key)) return REFERENCE_SELECTOR_PANEL_COLLAPSED_HEIGHT;
    const height =
      panelHeights.get(key) ?? REFERENCE_SELECTOR_PANEL_DEFAULT_HEIGHT[key];
    return Math.max(
      REFERENCE_SELECTOR_PANEL_MIN_HEIGHT[key],
      Math.min(REFERENCE_SELECTOR_PANEL_MAX_HEIGHT[key], Math.floor(height)),
    );
  };

  const clampPanelStoredHeight = (
    key: ReferenceSelectorPanelKey,
    height: number,
  ): number =>
    Math.max(
      REFERENCE_SELECTOR_PANEL_MIN_HEIGHT[key],
      Math.min(REFERENCE_SELECTOR_PANEL_MAX_HEIGHT[key], Math.floor(height)),
    );

  const getPanelAvailableMaxHeight = (
    key: ReferenceSelectorPanelKey,
  ): number => {
    const reservedHeight = REFERENCE_SELECTOR_PANEL_KEYS.filter(
      (panelKey) => panelKey !== key,
    ).reduce((total, panelKey) => total + getPanelBudgetHeight(panelKey), 0);
    const availableHeight = getPanelStackBudget() - reservedHeight;
    return Math.max(
      REFERENCE_SELECTOR_PANEL_MIN_HEIGHT[key],
      Math.min(REFERENCE_SELECTOR_PANEL_MAX_HEIGHT[key], availableHeight),
    );
  };

  const clampPanelHeight = (
    key: ReferenceSelectorPanelKey,
    height: number,
  ): number =>
    Math.max(
      REFERENCE_SELECTOR_PANEL_MIN_HEIGHT[key],
      Math.min(getPanelAvailableMaxHeight(key), Math.floor(height)),
    );

  const getPreviousPanelKey = (
    key: ReferenceSelectorPanelKey,
  ): ReferenceSelectorPanelKey | null => {
    const index = REFERENCE_SELECTOR_PANEL_KEYS.indexOf(key);
    if (index <= 0) return null;
    return REFERENCE_SELECTOR_PANEL_KEYS[index - 1];
  };

  const getMinimumPanelStackHeight = (
    panels: Set<ReferenceSelectorPanelKey>,
  ): number =>
    REFERENCE_SELECTOR_PANEL_KEYS.reduce(
      (total, key) =>
        total +
        (panels.has(key)
          ? REFERENCE_SELECTOR_PANEL_COLLAPSED_HEIGHT
          : REFERENCE_SELECTOR_PANEL_MIN_HEIGHT[key]),
      0,
    );

  const collapsePanelsToFit = (
    panels: Set<ReferenceSelectorPanelKey>,
    preferredOpenPanel?: ReferenceSelectorPanelKey,
  ): Set<ReferenceSelectorPanelKey> => {
    const budget = getPanelStackBudget();
    if (getMinimumPanelStackHeight(panels) <= budget) return panels;

    const next = new Set(panels);
    const collapseOrder = REFERENCE_SELECTOR_AUTO_COLLAPSE_ORDER.filter(
      (key) => key !== preferredOpenPanel,
    );
    if (preferredOpenPanel) collapseOrder.push(preferredOpenPanel);

    for (const key of collapseOrder) {
      if (next.has(key)) continue;
      next.add(key);
      if (getMinimumPanelStackHeight(next) <= budget) break;
    }
    return next;
  };

  const fitPanelsToAvailableHeight = (
    preferredOpenPanel?: ReferenceSelectorPanelKey,
  ): void => {
    collapsedPanels = collapsePanelsToFit(collapsedPanels, preferredOpenPanel);
  };

  const getRenderedPanels = (): Array<
    [ReferenceSelectorPanelKey, HTMLElement | undefined]
  > => {
    if (!deps.paperPickerList || deps.getMode() !== "browse") return [];
    const shell = deps.paperPickerList.children[0] as HTMLElement | undefined;
    if (!shell) return [];
    return [
      ["folders", shell.children[0] as HTMLElement | undefined],
      ["references", shell.children[1] as HTMLElement | undefined],
      ["tags", shell.children[2] as HTMLElement | undefined],
    ];
  };

  const getRenderedPanel = (
    key: ReferenceSelectorPanelKey,
  ): HTMLElement | undefined => {
    for (const [panelKey, panel] of getRenderedPanels()) {
      if (panelKey === key) return panel;
    }
    return undefined;
  };

  const capturePanelHeights = (): void => {
    for (const [key, panel] of getRenderedPanels()) {
      if (!panel) continue;
      if (panel.classList.contains("llm-paper-picker-panel-collapsed"))
        continue;
      const rect =
        typeof panel.getBoundingClientRect === "function"
          ? panel.getBoundingClientRect()
          : null;
      const cssHeight = Number.parseFloat(
        panel.style.getPropertyValue("height") || "",
      );
      const height =
        rect && Number.isFinite(rect.height) && rect.height > 0
          ? rect.height
          : cssHeight;
      if (!Number.isFinite(height) || height <= 0) continue;
      panelHeights.set(key, clampPanelHeight(key, height));
    }
  };

  const getPanelRenderedHeight = (
    panel: HTMLElement | undefined,
    key: ReferenceSelectorPanelKey,
  ): number => {
    if (!panel) return 0;
    if (panel.classList.contains("llm-paper-picker-panel-collapsed")) {
      return REFERENCE_SELECTOR_PANEL_COLLAPSED_HEIGHT;
    }
    const rect =
      typeof panel.getBoundingClientRect === "function"
        ? panel.getBoundingClientRect()
        : null;
    if (rect && Number.isFinite(rect.height) && rect.height > 0) {
      return rect.height;
    }
    const cssHeight = Number.parseFloat(
      panel.style.getPropertyValue("height") || "",
    );
    if (Number.isFinite(cssHeight) && cssHeight > 0) return cssHeight;
    return REFERENCE_SELECTOR_PANEL_DEFAULT_HEIGHT[key];
  };

  const captureRenderedPanelHeights = (): Map<
    ReferenceSelectorPanelKey,
    number
  > => {
    const heights = new Map<ReferenceSelectorPanelKey, number>();
    for (const [key, panel] of getRenderedPanels()) {
      const height = getPanelRenderedHeight(panel, key);
      if (Number.isFinite(height) && height > 0) heights.set(key, height);
    }
    return heights;
  };

  const applyPanelHeight = (
    panel: HTMLElement,
    key: ReferenceSelectorPanelKey,
  ): void => {
    if (collapsedPanels.has(key)) return;
    const height =
      panelHeights.get(key) ?? REFERENCE_SELECTOR_PANEL_DEFAULT_HEIGHT[key];
    panel.style.height = `${clampPanelHeight(key, height)}px`;
  };

  const beginPanelResize = (
    key: ReferenceSelectorPanelKey,
    panel: HTMLElement,
    event: MouseEvent,
  ): void => {
    const ownerWin = panel.ownerDocument?.defaultView;
    if (!ownerWin || collapsedPanels.has(key)) return;
    const startY = event.clientY;
    const startHeight = getPanelRenderedHeight(panel, key);
    const neighborKey = getPreviousPanelKey(key);
    const neighborPanel =
      neighborKey && !collapsedPanels.has(neighborKey)
        ? getRenderedPanel(neighborKey)
        : undefined;
    const startNeighborHeight =
      neighborKey && neighborPanel
        ? getPanelRenderedHeight(neighborPanel, neighborKey)
        : 0;
    panel.classList.add("llm-paper-picker-panel-resizing");
    neighborPanel?.classList.add("llm-paper-picker-panel-resizing");
    const onMove = (moveEvent: MouseEvent) => {
      moveEvent.preventDefault();
      const requestedDelta = startY - moveEvent.clientY;
      if (neighborKey && neighborPanel && startNeighborHeight > 0) {
        const maxGrow = Math.max(
          0,
          Math.min(
            REFERENCE_SELECTOR_PANEL_MAX_HEIGHT[key] - startHeight,
            startNeighborHeight -
              REFERENCE_SELECTOR_PANEL_MIN_HEIGHT[neighborKey],
          ),
        );
        const maxShrink = Math.max(
          0,
          Math.min(
            startHeight - REFERENCE_SELECTOR_PANEL_MIN_HEIGHT[key],
            REFERENCE_SELECTOR_PANEL_MAX_HEIGHT[neighborKey] -
              startNeighborHeight,
          ),
        );
        const appliedDelta = Math.max(
          -maxShrink,
          Math.min(maxGrow, requestedDelta),
        );
        const nextHeight = clampPanelStoredHeight(
          key,
          startHeight + appliedDelta,
        );
        const nextNeighborHeight = clampPanelStoredHeight(
          neighborKey,
          startNeighborHeight - appliedDelta,
        );
        panelHeights.set(key, nextHeight);
        panelHeights.set(neighborKey, nextNeighborHeight);
        panel.style.height = `${nextHeight}px`;
        neighborPanel.style.height = `${nextNeighborHeight}px`;
        return;
      }
      const nextHeight = clampPanelHeight(key, startHeight + requestedDelta);
      panelHeights.set(key, nextHeight);
      panel.style.height = `${nextHeight}px`;
    };
    const onUp = () => {
      ownerWin.removeEventListener("mousemove", onMove);
      ownerWin.removeEventListener("mouseup", onUp);
      panel.classList.remove("llm-paper-picker-panel-resizing");
      neighborPanel?.classList.remove("llm-paper-picker-panel-resizing");
      capturePanelHeights();
    };
    ownerWin.addEventListener("mousemove", onMove);
    ownerWin.addEventListener("mouseup", onUp);
  };

  const createPanelSeparator = (
    ownerDoc: Document,
    key: ReferenceSelectorPanelKey,
    panel: HTMLElement,
  ): HTMLElement => {
    const separator = createElement(
      ownerDoc,
      "div",
      "llm-paper-picker-panel-separator",
      { title: t("Resize panel") },
    );
    separator.setAttribute("role", "separator");
    separator.setAttribute("aria-orientation", "horizontal");
    separator.setAttribute("aria-label", t("Resize panel"));
    separator.addEventListener("mousedown", (event: Event) => {
      const mouse = event as MouseEvent;
      if (typeof mouse.button === "number" && mouse.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      beginPanelResize(key, panel, mouse);
    });
    separator.addEventListener("click", (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    return separator;
  };

  const animatePanelHeight = (
    panel: HTMLElement,
    key: ReferenceSelectorPanelKey,
    fromHeight: number | undefined,
  ): void => {
    const ownerWin = panel.ownerDocument?.defaultView;
    if (
      !ownerWin ||
      typeof ownerWin.requestAnimationFrame !== "function" ||
      !fromHeight ||
      !Number.isFinite(fromHeight) ||
      fromHeight <= 0
    ) {
      return;
    }
    const targetHeight = getPanelRenderedHeight(panel, key);
    if (
      !Number.isFinite(targetHeight) ||
      Math.abs(targetHeight - fromHeight) < 1
    )
      return;
    const media = ownerWin.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (media?.matches) return;
    const target = `${targetHeight}px`;
    panel.style.transition = "none";
    panel.style.height = `${fromHeight}px`;
    void panel.offsetHeight;
    ownerWin.requestAnimationFrame?.(() => {
      panel.style.removeProperty("transition");
      panel.style.height = target;
    });
  };

  const animatePanelHeights = (
    shell: HTMLElement,
    previousHeights: Map<ReferenceSelectorPanelKey, number>,
  ): void => {
    const panels: Array<[ReferenceSelectorPanelKey, HTMLElement | undefined]> =
      [
        ["folders", shell.children[0] as HTMLElement | undefined],
        ["references", shell.children[1] as HTMLElement | undefined],
        ["tags", shell.children[2] as HTMLElement | undefined],
      ];
    for (const [key, panel] of panels) {
      if (!panel) continue;
      animatePanelHeight(panel, key, previousHeights.get(key));
    }
  };

  const isCollapsed = (key: ReferenceSelectorPanelKey): boolean =>
    collapsedPanels.has(key);

  const toggleCollapsed = (key: ReferenceSelectorPanelKey): void => {
    const expanding = collapsedPanels.has(key);
    const next = new Set(collapsedPanels);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    collapsedPanels = expanding ? collapsePanelsToFit(next, key) : next;
    deps.render();
  };

  const createPanelToggle = (
    ownerDoc: Document,
    key: ReferenceSelectorPanelKey,
  ): HTMLButtonElement => {
    const collapsed = isCollapsed(key);
    const button = createElement(
      ownerDoc,
      "button",
      "llm-paper-picker-panel-toggle",
      {
        textContent: collapsed ? "›" : "▾",
        title: collapsed ? t("Expand panel") : t("Collapse panel"),
      },
    );
    button.type = "button";
    button.setAttribute("aria-expanded", collapsed ? "false" : "true");
    button.addEventListener("mousedown", (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleCollapsed(key);
    });
    button.addEventListener("click", (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    return button;
  };

  const attachPanelHeaderToggle = (
    header: HTMLElement,
    key: ReferenceSelectorPanelKey,
  ): void => {
    header.addEventListener("mousedown", (event: Event) => {
      const mouse = event as MouseEvent;
      if (typeof mouse.button === "number" && mouse.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      toggleCollapsed(key);
    });
    header.addEventListener("click", (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
    });
  };

  return {
    reset,
    isCollapsed,
    toggleCollapsed,
    capturePanelHeights,
    captureRenderedPanelHeights,
    fitPanelsToAvailableHeight,
    applyPanelHeight,
    createPanelSeparator,
    createPanelToggle,
    attachPanelHeaderToggle,
    animatePanelHeights,
  };
}
