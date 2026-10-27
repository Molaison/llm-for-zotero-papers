import { createElement } from "../../utils/domHelpers";
import { t } from "../../utils/i18n";
import {
  PREFERENCES_PANE_ID,
  getSelectTextExpandedLabel,
  getScreenshotExpandedLabel,
  SCREENSHOT_COMPACT_LABEL,
  SELECT_TEXT_COMPACT_LABEL,
  UPLOAD_FILE_EXPANDED_LABEL,
  formatFigureCountLabel,
  formatFileCountLabel,
} from "./constants";
import type { ActionDropdownSpec } from "./types";
import {
  getBaseSlashMenuItems,
  resolveSlashActionChatMode,
  type SlashBaseMenuItem,
} from "./slashMenuBehavior";
import {
  resolveConversationBaseItem,
  resolveActiveNoteSession,
  resolveDisplayConversationKind,
  resolvePreferredConversationSystem,
} from "./portalScope";
import { getConversationKey } from "./conversationIdentity";
import { createRuntimeSystemControls } from "./runtimeSystemControls";
import {
  resolveSidebarChatModeToggleState,
  type SidebarChatModeTab,
} from "./sidebarChatModeToggle";
import { createSidebarModeSwitch } from "./sidebarModeSwitch";
import { buildContextUsagePresentation } from "./textUtils";
import { createChatLatestButton } from "./chatLatestButton";
import { createTaskProgressCurtain } from "./taskProgress/view";

function createActionDropdown(doc: Document, spec: ActionDropdownSpec) {
  const slot = createElement(
    doc,
    "div",
    `llm-action-slot ${spec.slotClassName}`.trim(),
    { id: spec.slotId },
  );
  const button = createElement(doc, "button", spec.buttonClassName, {
    id: spec.buttonId,
    textContent: spec.buttonText,
    disabled: spec.disabled,
  });
  const menu = createElement(doc, "div", spec.menuClassName, {
    id: spec.menuId,
  });
  menu.style.display = "none";
  slot.append(button, menu);
  return { slot, button, menu };
}

/**
 * Read the identity that is useful to a person looking at the chat header.
 * Zotero item mocks used by workflow tests do not all implement getField(),
 * so keep this deliberately defensive and never make rendering depend on
 * metadata being available.
 */
function readScopeIdentity(item: Zotero.Item | null | undefined): {
  title: string;
  creator: string;
  year: string;
} {
  if (!item) return { title: "", creator: "", year: "" };
  const candidate = item as Zotero.Item & {
    getField?: (field: string, unformatted?: boolean) => unknown;
    title?: unknown;
  };
  const readField = (field: string): string => {
    try {
      const value = candidate.getField?.(field, true);
      return typeof value === "string" ? value.trim() : "";
    } catch {
      return "";
    }
  };
  return {
    title: readField("title") ||
      (typeof candidate.title === "string" ? candidate.title.trim() : ""),
    creator: readField("firstCreator"),
    year: readField("year"),
  };
}

function buildUI(body: Element, item?: Zotero.Item | null) {
  // Clear this section body before rebuilding.
  if (typeof (body as any).replaceChildren === "function") {
    (body as any).replaceChildren();
  } else {
    body.textContent = "";
  }
  const doc = body.ownerDocument!;
  const hasItem = Boolean(item);
  const activeNoteSession = resolveActiveNoteSession(item);
  const displayConversationKind = resolveDisplayConversationKind(item);
  const isGlobalMode = displayConversationKind === "global";
  const isPaperMode = displayConversationKind === "paper";
  const conversationItemId = hasItem && item ? getConversationKey(item) : 0;
  const basePaperItemId =
    hasItem && item
      ? activeNoteSession
        ? activeNoteSession.parentItemId || 0
        : isPaperMode
          ? Number(resolveConversationBaseItem(item)?.id || 0)
          : 0
      : 0;
  const hasPaperContext = basePaperItemId > 0;
  const scopeIdentity = readScopeIdentity(item);

  // Disable CSS scroll anchoring on the Zotero-provided panel body so that
  // Gecko doesn't fight with our programmatic scroll management.
  if (body instanceof (doc.defaultView?.HTMLElement || HTMLElement)) {
    const hostBody = body as HTMLElement;
    hostBody.style.overflowAnchor = "none";
    // Keep panel host width-bound: descendants (e.g., long KaTeX blocks)
    // must never raise the side panel's minimum width.
    hostBody.style.minWidth = "0";
    hostBody.style.width = "100%";
    hostBody.style.maxWidth = "100%";
    // `clip`, not `hidden`: one-axis `hidden` forces computed overflow-y to
    // `auto`, making the host a scroll container that can paint a second
    // scrollbar beside the .llm-messages one.
    hostBody.style.overflowX = "clip";
    hostBody.style.boxSizing = "border-box";
  }

  // Main container
  const container = createElement(doc, "div", "llm-panel", { id: "llm-main" });
  container.dataset.itemId =
    conversationItemId > 0 ? `${conversationItemId}` : "";
  container.dataset.libraryId = hasItem && item ? `${item.libraryID}` : "";
  container.dataset.conversationKind = activeNoteSession
    ? activeNoteSession.conversationKind
    : hasItem
      ? isGlobalMode
        ? "global"
        : "paper"
      : "";
  container.dataset.conversationSystem = resolvePreferredConversationSystem({
    item,
  });
  container.dataset.basePaperItemId =
    basePaperItemId > 0 ? `${basePaperItemId}` : "";
  container.dataset.noteKind = activeNoteSession?.noteKind || "";
  container.dataset.noteId = activeNoteSession?.noteId
    ? `${activeNoteSession.noteId}`
    : "";
  container.dataset.noteTitle = activeNoteSession?.title || "";
  container.dataset.noteParentItemId = activeNoteSession?.parentItemId
    ? `${activeNoteSession.parentItemId}`
    : "";

  // Header section
  const header = createElement(doc, "div", "llm-header");
  const headerTop = createElement(doc, "div", "llm-header-top");
  const headerInfo = createElement(doc, "div", "llm-header-info");
  const title = createElement(doc, "div", "llm-title", {
    id: "llm-title-static",
    textContent: t("LLM-for-Zotero"),
  });
  if (hasItem) {
    title.style.display = "none";
  }
  const historyBar = createElement(doc, "div", "llm-history-bar", {
    id: "llm-history-bar",
  });
  historyBar.style.display = hasItem ? "inline-flex" : "none";
  const historyNewBtn = createElement(doc, "button", "llm-history-new", {
    id: "llm-history-new",
    type: "button",
    textContent: "",
    title: t("Start a new chat"),
  });
  historyNewBtn.setAttribute("aria-label", t("Start a new chat"));
  historyNewBtn.style.display = "";

  // History toggle button (clock icon)
  const historyToggle = createElement(doc, "button", "llm-history-toggle", {
    id: "llm-history-toggle",
    type: "button",
    title: t("Conversation history"),
  });
  historyToggle.setAttribute("aria-label", t("Conversation history"));
  historyToggle.setAttribute("aria-haspopup", "menu");
  historyToggle.setAttribute("aria-expanded", "false");
  historyToggle.dataset.location = "scope-bar";
  historyToggle.setAttribute("data-visible-label", t("History"));
  historyToggle.style.display = "";

  const isStandaloneBody = (body as HTMLElement).dataset?.standalone === "true";
  // Paper chat or Library chat: the Independent toggle row and the Stacked
  // chip show the same state.
  const chatModeToggle = resolveSidebarChatModeToggleState({
    isGlobalMode: hasItem && isGlobalMode,
    isNoteSession: Boolean(activeNoteSession),
    isWebChat: false,
  });
  // Runtime systems follow the history button, after a thin divider
  // (Independent) or the mode chip in its place (Stacked). Both are built;
  // CSS picks one from the root layout attribute.
  const headerRuntimeControls = createElement(
    doc,
    "div",
    "llm-header-runtime-controls",
    {
      id: "llm-header-runtime-controls",
    },
  );
  const modeSwitch = createSidebarModeSwitch(
    doc,
    {
      activeTab: chatModeToggle.activeTab,
      paperLabel: t(chatModeToggle.paperTabLabel),
      libraryLabel: t(chatModeToggle.libraryTabLabel),
      disabled: chatModeToggle.disabled,
    },
    {
      ariaLabel: t("Chat mode"),
      fitLabels: [t("Paper chat"), t("Library chat"), t("Note chat")],
    },
  );

  const runtimeSystemControls = createRuntimeSystemControls(doc, {
    groupId: "llm-runtime-system-controls",
    groupClassName: "llm-panel-runtime-system-controls",
    buttonClassName: "llm-panel-runtime-system-toggle",
    buttonIds: {
      codex: "llm-codex-system-toggle",
      claude_code: "llm-claude-system-toggle",
    },
  });

  // Paper chat | Library chat, sharing the standalone window's segmented tabs.
  const chatModeTabs = createElement(
    doc,
    "div",
    "llm-standalone-tab-group llm-header-mode-tabs",
    { id: "llm-chat-mode-tabs" },
  );
  chatModeTabs.dataset.mode = chatModeToggle.activeTab;
  const createChatModeTab = (
    tab: SidebarChatModeTab,
    id: string,
    label: string,
  ): HTMLButtonElement => {
    const button = createElement(
      doc,
      "button",
      "llm-standalone-tab llm-header-mode-tab",
      { id, type: "button", title: label },
    );
    button.dataset.tab = tab;
    const labelEl = createElement(doc, "span", "llm-header-mode-tab-label", {
      textContent: label,
    });
    button.appendChild(labelEl);
    const active = chatModeToggle.activeTab === tab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
    button.disabled = chatModeToggle.disabled;
    if (chatModeToggle.disabled) button.setAttribute("aria-disabled", "true");
    return button;
  };
  chatModeTabs.append(
    createChatModeTab(
      "library",
      "llm-library-chat-tab",
      "Chat",
    ),
    createChatModeTab(
      "paper",
      "llm-paper-chat-tab",
      activeNoteSession ? t(chatModeToggle.paperTabLabel) : "Papers",
    ),
  );

  // Independent tabs and the stacked mode switch share one left header slot.
  const toggleRow = createElement(doc, "div", "llm-header-toggle-row", {
    id: "llm-header-toggle-row",
  });
  toggleRow.append(chatModeTabs);
  headerRuntimeControls.append(toggleRow, modeSwitch);
  historyBar.append(historyNewBtn, historyToggle);

  headerInfo.append(title, headerRuntimeControls);
  // Conversation actions share the right header slot.
  const headerNavRow = createElement(doc, "div", "llm-header-nav-row");
  headerNavRow.appendChild(headerInfo);

  const headerActions = createElement(doc, "div", "llm-header-actions");
  const popoutBtn = createElement(
    doc,
    "button",
    "llm-btn-icon llm-popout-btn",
    {
      id: "llm-popout",
      type: "button",
      title: t("Open in Window"),
    },
  );
  popoutBtn.setAttribute("aria-label", t("Open chat in a standalone window"));
  const settingsBtn = createElement(
    doc,
    "button",
    "llm-btn-icon llm-settings-btn",
    {
      id: "llm-settings",
      type: "button",
      title: t("Settings"),
    },
  );
  settingsBtn.setAttribute("aria-label", t("Open plugin settings"));
  settingsBtn.dataset.preferencesPaneId = PREFERENCES_PANE_ID;
  const exportBtn = createElement(
    doc,
    "button",
    "llm-btn-icon llm-export-btn",
    {
      id: "llm-export",
      type: "button",
      title: t("Export"),
      disabled: !hasItem,
    },
  );
  exportBtn.setAttribute("aria-label", t("Export"));
  const clearBtn = createElement(doc, "button", "llm-btn-icon llm-clear-btn", {
    id: "llm-clear",
    type: "button",
    title: t("Delete conversation"),
  });
  clearBtn.setAttribute("aria-label", t("Delete conversation"));
  const remoteHistoryBtn = createElement(
    doc,
    "button",
    "llm-btn-icon llm-remote-history-btn",
    {
      id: "llm-remote-history",
      type: "button",
      title: t("Sync remote conversation"),
    },
  );
  remoteHistoryBtn.setAttribute("aria-label", t("Sync remote conversation"));
  remoteHistoryBtn.style.display = "none";
  const restoreHistoryBtn = createElement(
    doc,
    "button",
    "llm-btn-icon llm-restore-history-btn",
    {
      id: "llm-restore-history",
      type: "button",
      title: t("Restore local history"),
      textContent: "↶",
    },
  );
  restoreHistoryBtn.setAttribute("aria-label", t("Restore local history"));
  restoreHistoryBtn.style.display = "none";
  // Less frequent conversation tools share one native disclosure; their IDs
  // and handlers remain the same, including settings, pop-out and runtime systems.
  const conversationTools = createElement(doc, "details", "llm-conversation-tools", {
    id: "llm-conversation-tools",
  });
  const toolsSummary = createElement(doc, "summary", undefined, {
    textContent: "…",
    title: "更多",
  });
  toolsSummary.setAttribute("aria-label", "更多");
  const toolsBody = createElement(doc, "div", "llm-conversation-tools-body");
  toolsBody.setAttribute("role", "group");
  toolsBody.setAttribute("aria-label", t("Context actions"));
  for (const tool of [popoutBtn, settingsBtn, remoteHistoryBtn, restoreHistoryBtn, exportBtn, clearBtn]) {
    tool.textContent = tool.getAttribute("aria-label") || tool.title;
  }
  toolsBody.append(popoutBtn, settingsBtn, remoteHistoryBtn, restoreHistoryBtn, exportBtn, clearBtn, runtimeSystemControls.group);
  conversationTools.append(toolsSummary, toolsBody);
  conversationTools.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !conversationTools.open) return;
    event.preventDefault();
    event.stopPropagation();
    conversationTools.open = false;
    toolsSummary.focus({ preventScroll: true });
  });
  headerActions.append(historyBar, conversationTools);
  headerNavRow.appendChild(headerActions);
  headerTop.append(headerNavRow);
  if (body.closest(".llm-dedicated-chat-pane")) {
    title.style.display = "none";
  }
  header.appendChild(headerTop);

  // Keep the conversation scope visible without competing with history and
  // action controls. The existing data attributes/IDs remain the source of
  // truth for handlers; this is a read-only presentation layer.
  const scopeBar = createElement(doc, "div", "llm-scope-bar", {
    id: "llm-scope-bar",
  });
  scopeBar.dataset.scope = activeNoteSession
    ? "note"
    : isGlobalMode
      ? "library"
      : hasItem
        ? "paper"
        : "empty";
  scopeBar.dataset.itemId = conversationItemId > 0 ? `${conversationItemId}` : "";
  scopeBar.dataset.basePaperItemId = basePaperItemId > 0 ? `${basePaperItemId}` : "";
  scopeBar.setAttribute("role", "group");
  scopeBar.setAttribute("aria-label", t("Conversation scope"));
  const scopeIcon = createElement(doc, "span", "llm-scope-icon");
  scopeIcon.setAttribute("aria-hidden", "true");
  const scopeCopy = createElement(doc, "span", "llm-scope-copy");
  const scopeKind = createElement(doc, "span", "llm-scope-kind", {
    textContent: activeNoteSession
      ? t("Note chat")
      : isGlobalMode
        ? t("Library chat")
        : hasItem
          ? t("Paper chat")
          : t("Ready to chat"),
  });
  const scopeTitleText = activeNoteSession?.title ||
    (isGlobalMode ? t("Your Zotero library") : scopeIdentity.title) ||
    (hasItem ? t("Selected paper") : t("Select a paper or open a PDF"));
  const scopeTitle = createElement(doc, "span", "llm-scope-title", {
    id: "llm-scope-title",
    textContent: scopeTitleText,
  });
  scopeTitle.title = scopeTitleText;
  const scopeMetaText = [scopeIdentity.creator, scopeIdentity.year]
    .filter(Boolean)
    .join(" · ");
  const scopeMeta = createElement(doc, "span", "llm-scope-meta", {
    id: "llm-scope-meta",
    textContent: scopeMetaText,
  });
  scopeMeta.hidden = !scopeMetaText;
  scopeCopy.append(scopeKind, scopeTitle, scopeMeta);
  scopeBar.append(scopeIcon, scopeCopy);
  header.appendChild(scopeBar);
  const historyMenu = createElement(doc, "div", "llm-history-menu", {
    id: "llm-history-menu",
  });
  historyMenu.style.display = "none";
  header.appendChild(historyMenu);

  const historyRowMenu = createElement(doc, "div", "llm-history-row-menu", {
    id: "llm-history-row-menu",
  });
  historyRowMenu.style.display = "none";
  const historyRowRenameBtn = createElement(
    doc,
    "button",
    "llm-history-row-menu-item",
    {
      id: "llm-history-row-rename",
      type: "button",
      textContent: t("Rename"),
      title: t("Rename chat"),
    },
  );
  historyRowMenu.append(historyRowRenameBtn);
  header.appendChild(historyRowMenu);

  const historyUndo = createElement(doc, "div", "llm-history-undo", {
    id: "llm-history-undo",
  });
  historyUndo.style.display = "none";
  const historyUndoText = createElement(doc, "span", "llm-history-undo-text", {
    id: "llm-history-undo-text",
    textContent: "",
  });
  const historyUndoBtn = createElement(doc, "button", "llm-history-undo-btn", {
    id: "llm-history-undo-btn",
    type: "button",
    textContent: t("Undo"),
    title: t("Restore deleted conversation"),
  });
  historyUndo.append(historyUndoText, historyUndoBtn);
  header.appendChild(historyUndo);

  const topToast = createElement(doc, "div", "llm-top-toast", {
    id: "llm-top-toast",
    textContent: "",
  });
  topToast.style.display = "none";
  topToast.setAttribute("role", "status");
  topToast.setAttribute("aria-live", "polite");
  topToast.setAttribute("aria-hidden", "true");
  header.appendChild(topToast);

  container.appendChild(header);

  header.setAttribute("aria-label", t("Conversation history"));

  // Chat display area
  const chatShell = createElement(doc, "div", "llm-chat-shell", {
    id: "llm-chat-shell",
  });
  const chatBox = createElement(doc, "div", "llm-messages", {
    id: "llm-chat-box",
  });
  chatBox.setAttribute("role", "region");
  chatBox.setAttribute("aria-label", t("Conversation history"));
  // The Task progress card sits at the top of the shell: its header row, and
  // the drawer that unrolls inside the same card. It lowers from under the
  // header in its curtain once it has something to show, and rises back.
  chatShell.append(
    createTaskProgressCurtain(doc),
    chatBox,
    createChatLatestButton(doc),
  );
  if (isStandaloneBody) {
    const chatResizeHandle = createElement(
      doc,
      "div",
      "llm-standalone-resize-handle",
    );
    chatResizeHandle.dataset.resizeTarget = "chat";
    chatResizeHandle.setAttribute("aria-hidden", "true");
    chatShell.appendChild(chatResizeHandle);
  }
  const workspace = createElement(doc, "div", "llm-reading-workspace", { id: "llm-reading-workspace" });
  workspace.dataset.view = "reading";
  workspace.append(chatShell);
  container.appendChild(workspace);

  // Shortcuts row
  const shortcutsRow = createElement(doc, "div", "llm-shortcuts", {
    id: "llm-shortcuts",
  });
  const shortcutsDisclosure = createElement(doc, "details", "llm-shortcuts-disclosure", {
    id: "llm-shortcuts-disclosure",
  });
  shortcutsDisclosure.append(
    createElement(doc, "summary", undefined, { textContent: "快捷提问" }),
    shortcutsRow,
  );
  toolsBody.appendChild(shortcutsDisclosure);

  // Shortcut context menu
  const shortcutMenu = createElement(doc, "div", "llm-shortcut-menu", {
    id: "llm-shortcut-menu",
  });
  shortcutMenu.style.display = "none";
  const menuEditBtn = createElement(doc, "button", "llm-shortcut-menu-item", {
    id: "llm-shortcut-menu-edit",
    type: "button",
    textContent: t("Edit"),
  });
  const menuDeleteBtn = createElement(doc, "button", "llm-shortcut-menu-item", {
    id: "llm-shortcut-menu-delete",
    type: "button",
    textContent: t("Delete"),
  });
  const menuAddBtn = createElement(doc, "button", "llm-shortcut-menu-item", {
    id: "llm-shortcut-menu-add",
    type: "button",
    textContent: t("Add"),
  });
  const menuMoveBtn = createElement(doc, "button", "llm-shortcut-menu-item", {
    id: "llm-shortcut-menu-move",
    type: "button",
    textContent: t("Move"),
  });
  const menuResetBtn = createElement(doc, "button", "llm-shortcut-menu-item", {
    id: "llm-shortcut-menu-reset",
    type: "button",
    textContent: t("Reset"),
  });
  shortcutMenu.append(
    menuEditBtn,
    menuDeleteBtn,
    menuAddBtn,
    menuMoveBtn,
    menuResetBtn,
  );
  container.appendChild(shortcutMenu);

  // Response context menu
  const responseMenu = createElement(doc, "div", "llm-response-menu", {
    id: "llm-response-menu",
  });
  responseMenu.style.display = "none";
  const responseMenuCopyBtn = createElement(
    doc,
    "button",
    "llm-response-menu-item",
    {
      id: "llm-response-menu-copy",
      type: "button",
      textContent: t("Copy"),
    },
  );
  const responseMenuNoteBtn = createElement(
    doc,
    "button",
    "llm-response-menu-item",
    {
      id: "llm-response-menu-note",
      type: "button",
      textContent: t("Save as note"),
    },
  );
  const responseMenuDeleteBtn = createElement(
    doc,
    "button",
    "llm-response-menu-item",
    {
      id: "llm-response-menu-delete",
      type: "button",
      textContent: t("Delete this turn"),
      title: t("Delete this prompt and response"),
    },
  );
  const responseMenuForkBtn = createElement(
    doc,
    "button",
    "llm-response-menu-item",
    {
      id: "llm-response-menu-fork",
      type: "button",
      textContent: t("Fork this turn"),
      title: t("Start a new chat from this turn"),
    },
  );
  responseMenu.append(
    responseMenuCopyBtn,
    responseMenuNoteBtn,
    responseMenuForkBtn,
    responseMenuDeleteBtn,
  );
  container.appendChild(responseMenu);

  // Prompt context menu
  const promptMenu = createElement(doc, "div", "llm-response-menu", {
    id: "llm-prompt-menu",
  });
  promptMenu.style.display = "none";
  const promptMenuDeleteBtn = createElement(
    doc,
    "button",
    "llm-response-menu-item",
    {
      id: "llm-prompt-menu-delete",
      type: "button",
      textContent: t("Delete this turn"),
      title: t("Delete this prompt and response"),
    },
  );
  const promptMenuForkBtn = createElement(
    doc,
    "button",
    "llm-response-menu-item",
    {
      id: "llm-prompt-menu-fork",
      type: "button",
      textContent: t("Fork this turn"),
      title: t("Start a new chat from this turn"),
    },
  );
  promptMenu.append(promptMenuForkBtn, promptMenuDeleteBtn);
  container.appendChild(promptMenu);

  // Export menu
  const exportMenu = createElement(doc, "div", "llm-response-menu", {
    id: "llm-export-menu",
  });
  exportMenu.style.display = "none";
  const exportMenuCopyBtn = createElement(
    doc,
    "button",
    "llm-response-menu-item",
    {
      id: "llm-export-copy",
      type: "button",
      textContent: t("Copy chat as md"),
    },
  );
  const exportMenuNoteBtn = createElement(
    doc,
    "button",
    "llm-response-menu-item",
    {
      id: "llm-export-note",
      type: "button",
      textContent: t("Save chat as note"),
    },
  );
  exportMenu.append(exportMenuCopyBtn, exportMenuNoteBtn);
  container.appendChild(exportMenu);

  const slashMenu = createElement(
    doc,
    "div",
    "llm-response-menu llm-slash-menu",
    {
      id: "llm-slash-menu",
    },
  );
  slashMenu.style.display = "none";
  const slashList = createElement(doc, "div", "llm-action-picker-list", {});
  const makeSlashItem = (id: string, title: string, desc: string) => {
    const btn = createElement(doc, "button", "llm-action-picker-item", {
      id,
      type: "button",
      title: desc,
    });
    btn.setAttribute("data-slash-base-item", "true");
    const titleEl = createElement(doc, "span", "llm-action-picker-title", {
      textContent: title,
    });
    btn.append(titleEl);
    return btn;
  };
  const slashUploadBtn = makeSlashItem(
    "llm-slash-upload-option",
    t("Upload files"),
    t("Add documents or images"),
  );
  const slashReferenceBtn = makeSlashItem(
    "llm-slash-reference-option",
    t("Select references"),
    t("Add papers from your library"),
  );
  const slashPdfPageBtn = makeSlashItem(
    "llm-slash-pdf-page-option",
    t("Send current PDF page"),
    t("Capture the visible page as an image"),
  );
  const slashPdfMultiplePagesBtn = makeSlashItem(
    "llm-slash-pdf-multiple-pages-option",
    t("Send multiple PDF pages"),
    t("Select pages from the open PDF"),
  );
  const slashBaseButtons: Record<SlashBaseMenuItem, HTMLButtonElement> = {
    upload: slashUploadBtn,
    reference: slashReferenceBtn,
    pdfPage: slashPdfPageBtn,
    pdfMultiplePages: slashPdfMultiplePagesBtn,
  };
  slashList.append(
    ...getBaseSlashMenuItems(
      resolveSlashActionChatMode(displayConversationKind),
    ).map((entry) => slashBaseButtons[entry]),
  );
  slashMenu.append(slashList);
  // slashMenu is appended to composeArea below (after composeArea is created)

  // Retry model menu (opened from latest assistant retry action)
  const retryModelMenu = createElement(doc, "div", "llm-model-menu", {
    id: "llm-retry-model-menu",
  });
  retryModelMenu.style.display = "none";
  container.appendChild(retryModelMenu);

  // Input section
  const inputSection = createElement(doc, "div", "llm-input-section");
  const contextPreviews = createElement(doc, "div", "llm-context-previews", {
    id: "llm-context-previews",
  });
  contextPreviews.setAttribute("role", "group");
  contextPreviews.setAttribute("aria-label", t("Context actions"));
  const runtimeModeBtn = createElement(
    doc,
    "button",
    "llm-context-agent-toggle llm-agent-process-summary",
    {
      id: "llm-runtime-mode-toggle",
      type: "button",
      title: t("Switch to Agent mode"),
      disabled: !hasItem,
    },
  );
  runtimeModeBtn.dataset.contextGroup = "current";
  runtimeModeBtn.setAttribute("aria-label", t("Switch to Agent mode"));
  runtimeModeBtn.setAttribute("aria-pressed", "false");
  runtimeModeBtn.dataset.location = "composer-context-tray";
  const runtimeModeIndicator = createElement(
    doc,
    "span",
    "llm-agent-toggle-indicator",
  );
  runtimeModeIndicator.setAttribute("aria-hidden", "true");
  const runtimeModeLabel = createElement(
    doc,
    "span",
    "llm-agent-toggle-label llm-agent-process-summary-label",
    {
      textContent: t("Agent mode"),
    },
  );
  runtimeModeBtn.append(runtimeModeIndicator, runtimeModeLabel);
  const selectedContextList = createElement(
    doc,
    "div",
    "llm-selected-context-list",
    {
      id: "llm-selected-context-list",
    },
  );
  selectedContextList.style.display = "none";
  selectedContextList.dataset.contextGroup = "added";
  const currentContextLabel = createElement(
    doc,
    "span",
    "llm-context-group-label",
    { textContent: t("Current context") },
  );
  currentContextLabel.dataset.contextGroup = "current";
  currentContextLabel.setAttribute("aria-hidden", "true");
  currentContextLabel.hidden = !hasItem;
  const addedContextLabel = createElement(
    doc,
    "span",
    "llm-context-group-label",
    { textContent: t("Add context") },
  );
  addedContextLabel.dataset.contextGroup = "add";
  addedContextLabel.setAttribute("aria-hidden", "true");
  addedContextLabel.hidden = !hasItem;
  contextPreviews.dataset.scope = isGlobalMode ? "library" : hasItem ? "paper" : "empty";
  contextPreviews.dataset.hasPaperContext = hasPaperContext ? "true" : "false";
  contextPreviews.setAttribute("aria-label", t("Current context and context actions"));
  // Agent mode is a composer concern: keep the same node and ID, but make it
  // visible beside the context chips instead of hiding it in the header menu.
  contextPreviews.append(
    currentContextLabel,
    runtimeModeBtn,
    selectedContextList,
    addedContextLabel,
  );

  const paperPreview = createElement(doc, "div", "llm-paper-context-inline", {
    id: "llm-paper-context-preview",
  });
  paperPreview.style.display = "none";
  const paperPreviewList = createElement(
    doc,
    "div",
    "llm-paper-context-inline-list",
    {
      id: "llm-paper-context-list",
    },
  );
  paperPreview.append(paperPreviewList);
  const sourceControl = createElement(doc, "details", "llm-source-control", { id: "llm-source-control" });
  sourceControl.hidden = true;
  const sourceToggle = createElement(doc, "summary", "llm-toolbar-icon llm-source-toggle", {
    title: "论文来源", id: "llm-source-toggle",
  });
  sourceToggle.setAttribute("aria-label", "论文来源");
  const sourceBody = createElement(doc, "div", "llm-source-body");
  sourceBody.append(paperPreview);
  const paperHeading = createElement(doc, "span", "llm-paper-heading", { id: "llm-paper-heading", textContent: "论文来源" });
  const paperMode = createElement(doc, "span", "llm-paper-mode", { id: "llm-paper-mode" });
  sourceToggle.append(paperHeading, paperMode);
  sourceControl.append(sourceToggle, sourceBody);
  const paperBar = createElement(doc, "div", "llm-paper-bar", { id: "llm-paper-bar" });
  paperBar.hidden = true;
  paperBar.append(sourceControl);
  header.append(paperBar);
  const sourceShortcut = createElement(doc, "button", "llm-toolbar-icon llm-source-shortcut", {
    id: "llm-source-shortcut", type: "button", title: "论文来源",
  });
  sourceShortcut.setAttribute("aria-label", "论文来源");
  sourceShortcut.setAttribute("aria-controls", "llm-source-control");
  sourceShortcut.setAttribute("aria-expanded", "false");
  sourceShortcut.hidden = true;
  sourceShortcut.addEventListener("click", () => { sourceControl.open = !sourceControl.open; if (sourceControl.open) sourceToggle.focus({preventScroll: true}); });
  sourceControl.addEventListener("toggle", () => sourceShortcut.setAttribute("aria-expanded", String(sourceControl.open)));
  sourceControl.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Escape" && sourceControl.open) {
      event.preventDefault(); event.stopPropagation(); sourceControl.open = false; sourceToggle.focus();
    }
  });

  // Image preview area (shows selected screenshot)
  const imagePreview = createElement(doc, "div", "llm-image-preview", {
    id: "llm-image-preview",
  });
  imagePreview.dataset.contextGroup = "added";
  imagePreview.style.display = "none";

  const imagePreviewMeta = createElement(
    doc,
    "button",
    "llm-image-preview-meta",
    {
      id: "llm-image-preview-meta",
      type: "button",
      textContent: formatFigureCountLabel(0),
      title: t("Expand figures"),
    },
  );
  const imagePreviewHeader = createElement(
    doc,
    "div",
    "llm-image-preview-header",
    {
      id: "llm-image-preview-header",
    },
  );
  const removeImgBtn = createElement(doc, "button", "llm-remove-img-btn", {
    id: "llm-remove-img",
    type: "button",
    textContent: "×",
    title: t("Clear selected screenshots"),
  });
  removeImgBtn.setAttribute("aria-label", t("Clear selected screenshots"));
  imagePreviewHeader.append(imagePreviewMeta, removeImgBtn);

  const imagePreviewExpanded = createElement(
    doc,
    "div",
    "llm-image-preview-expanded",
    {
      id: "llm-image-preview-expanded",
    },
  );
  const previewStrip = createElement(doc, "div", "llm-image-preview-strip", {
    id: "llm-image-preview-strip",
  });
  const previewLargeWrap = createElement(
    doc,
    "div",
    "llm-image-preview-selected",
    {
      id: "llm-image-preview-selected",
    },
  );
  const previewLargeImg = createElement(
    doc,
    "img",
    "llm-image-preview-selected-img",
    {
      id: "llm-image-preview-selected-img",
      alt: t("Selected screenshot preview"),
    },
  ) as HTMLImageElement;
  previewLargeWrap.appendChild(previewLargeImg);

  imagePreviewExpanded.append(previewStrip, previewLargeWrap);
  imagePreview.append(imagePreviewHeader, imagePreviewExpanded);
  contextPreviews.appendChild(imagePreview);

  const filePreview = createElement(doc, "div", "llm-image-preview", {
    id: "llm-file-context-preview",
  });
  filePreview.dataset.contextGroup = "added";
  filePreview.style.display = "none";
  const filePreviewMeta = createElement(
    doc,
    "button",
    "llm-image-preview-meta llm-file-context-meta",
    {
      id: "llm-file-context-meta",
      type: "button",
      textContent: formatFileCountLabel(0),
      title: t("Expand files"),
    },
  );
  const filePreviewHeader = createElement(
    doc,
    "div",
    "llm-image-preview-header",
    {
      id: "llm-file-context-header",
    },
  );
  const filePreviewClear = createElement(doc, "button", "llm-remove-img-btn", {
    id: "llm-file-context-clear",
    type: "button",
    textContent: "×",
    title: t("Clear uploaded files"),
  });
  filePreviewHeader.append(filePreviewMeta, filePreviewClear);
  const filePreviewExpanded = createElement(
    doc,
    "div",
    "llm-image-preview-expanded llm-file-context-expanded",
    {
      id: "llm-file-context-expanded",
    },
  );
  const filePreviewList = createElement(doc, "div", "llm-file-context-list", {
    id: "llm-file-context-list",
  });
  filePreviewExpanded.append(filePreviewList);
  filePreview.append(filePreviewHeader, filePreviewExpanded);
  contextPreviews.appendChild(filePreview);

  const paperPicker = createElement(doc, "div", "llm-paper-picker", {
    id: "llm-paper-picker",
  });
  paperPicker.style.display = "none";
  const paperPickerList = createElement(doc, "div", "llm-paper-picker-list", {
    id: "llm-paper-picker-list",
  });
  paperPickerList.setAttribute("role", "listbox");
  paperPicker.appendChild(paperPickerList);
  inputSection.appendChild(paperPicker);


  const composeArea = createElement(doc, "div", "llm-compose-area", {
    id: "llm-compose-area",
  });
  inputSection.appendChild(composeArea);
  composeArea.appendChild(contextPreviews);

  const actionPicker = createElement(doc, "div", "llm-action-picker", {
    id: "llm-action-picker",
  });
  actionPicker.style.display = "none";
  const actionPickerList = createElement(doc, "div", "llm-action-picker-list", {
    id: "llm-action-picker-list",
  });
  actionPickerList.setAttribute("role", "listbox");
  actionPicker.appendChild(actionPickerList);
  composeArea.appendChild(actionPicker);
  composeArea.appendChild(slashMenu);

  const actionHitlPanel = createElement(doc, "div", "llm-action-hitl-panel", {
    id: "llm-action-hitl-panel",
  });
  actionHitlPanel.style.display = "none";
  composeArea.appendChild(actionHitlPanel);

  // Command row — shows active skill/action badge above textarea
  // Uses the exact same chip DOM as paper context chips
  const commandRow = createElement(
    doc,
    "div",
    "llm-command-row llm-selected-context",
    { id: "llm-command-row" },
  );
  const commandRowHeader = createElement(
    doc,
    "div",
    "llm-image-preview-header llm-selected-context-header llm-paper-context-chip-header",
  );
  const commandRowLabel = createElement(
    doc,
    "span",
    "llm-paper-context-chip-label",
    { id: "llm-command-row-badge" },
  );
  const commandRowClear = createElement(
    doc,
    "button",
    "llm-remove-img-btn llm-paper-context-clear",
    {
      type: "button",
      textContent: "\u00d7",
      title: t("Clear"),
    },
  );
  // The glyph is the only text, so name the control for assistive tech.
  commandRowClear.setAttribute("aria-label", t("Clear"));
  commandRowHeader.appendChild(commandRowLabel);
  commandRowHeader.appendChild(commandRowClear);
  commandRow.appendChild(commandRowHeader);
  composeArea.appendChild(commandRow);

  const queueBar = createElement(doc, "div", "llm-queued-input-bar", {
    id: "llm-queued-input-bar",
  });
  queueBar.style.display = "none";
  composeArea.appendChild(queueBar);

  const inputBox = createElement(doc, "textarea", "llm-input", {
    id: "llm-input",
    placeholder: hasItem
      ? isGlobalMode
        ? t("Ask a research question…")
        : t("Ask about this paper…")
      : t("Open a PDF first"),
    disabled: !hasItem,
  });
  inputBox.setAttribute("aria-label", t("Ask a research question…"));
  if (isStandaloneBody) {
    const inputResizeWrap = createElement(
      doc,
      "div",
      "llm-standalone-input-resize-wrap",
    );
    const inputResizeHandle = createElement(
      doc,
      "div",
      "llm-standalone-resize-handle",
    );
    inputResizeHandle.dataset.resizeTarget = "input";
    inputResizeHandle.setAttribute("aria-hidden", "true");
    inputResizeWrap.append(inputBox, inputResizeHandle);
    composeArea.appendChild(inputResizeWrap);
  } else {
    composeArea.appendChild(inputBox);
  }

  // One toolbar: model may ellipsize, reasoning and usage stay together.
  const modelControls = createElement(doc, "div", "llm-model-controls", {
    id: "llm-model-controls",
  });
  modelControls.setAttribute("role", "group");
  modelControls.setAttribute("aria-label", t("Reasoning"));
  // Actions row
  const actionsRow = createElement(doc, "div", "llm-actions");
  const actionsLeft = createElement(doc, "div", "llm-actions-left");
  const actionsRight = createElement(doc, "div", "llm-actions-right");

  const selectTextBtn = createElement(
    doc,
    "button",
    "llm-action-picker-item llm-select-text-btn",
    {
      id: "llm-select-text",
      textContent: getSelectTextExpandedLabel(),
      title: t("Include selected reader text"),
      disabled: !hasItem,
    },
  );
  selectTextBtn.setAttribute("aria-label", getSelectTextExpandedLabel());

  // Screenshot button
  const screenshotBtn = createElement(
    doc,
    "button",
    "llm-action-picker-item llm-screenshot-btn",
    {
      id: "llm-screenshot",
      textContent: getScreenshotExpandedLabel(),
      title: t("Select figure screenshot"),
      disabled: !hasItem,
    },
  );
  screenshotBtn.setAttribute("aria-label", getScreenshotExpandedLabel());

  const uploadBtn = createElement(
    doc,
    "button",
    "llm-shortcut-btn llm-action-btn llm-action-btn-secondary llm-upload-file-btn llm-slash-menu-btn",
    {
      id: "llm-upload-file",
      type: "button",
      textContent: t("Add context"),
      title: t("Add context"),
      disabled: !hasItem,
    },
  );
  uploadBtn.setAttribute("aria-haspopup", "menu");
  uploadBtn.setAttribute("aria-expanded", "false");
  uploadBtn.setAttribute("aria-label", t("Add context"));
  const uploadInput = createElement(doc, "input", "", {
    id: "llm-upload-input",
    type: "file",
  }) as HTMLInputElement;
  uploadInput.multiple = true;
  uploadInput.style.display = "none";
  const uploadSlot = createElement(doc, "div", "llm-action-slot");
  uploadSlot.classList.add("llm-context-add-slot");
  uploadSlot.dataset.location = "composer-context-tray";
  uploadSlot.append(uploadBtn, uploadInput);

  const {
    slot: modelDropdown,
    button: modelBtn,
    menu: modelMenu,
  } = createActionDropdown(doc, {
    slotId: "llm-model-dropdown",
    slotClassName: "llm-model-dropdown",
    buttonId: "llm-model-toggle",
    buttonClassName:
      "llm-shortcut-btn llm-action-btn llm-action-btn-secondary llm-model-btn",
    buttonText: "Model: ...",
    menuId: "llm-model-menu",
    menuClassName: "llm-model-menu",
    disabled: !hasItem,
  });

  const {
    slot: reasoningDropdown,
    button: reasoningBtn,
    menu: reasoningMenu,
  } = createActionDropdown(doc, {
    slotId: "llm-reasoning-dropdown",
    slotClassName: "llm-reasoning-dropdown",
    buttonId: "llm-reasoning-toggle",
    buttonClassName:
      "llm-shortcut-btn llm-action-btn llm-action-btn-secondary llm-reasoning-btn",
    buttonText: t("Reasoning"),
    menuId: "llm-reasoning-menu",
    menuClassName: "llm-reasoning-menu",
    disabled: !hasItem,
  });

  const sendBtn = createElement(
    doc,
    "button",
    "llm-shortcut-btn llm-action-btn llm-action-btn-primary llm-send-btn llm-action-icon-only",
    {
      id: "llm-send",
      title: t("Send"),
      disabled: !hasItem,
    },
  );
  const cancelBtn = createElement(
    doc,
    "button",
    "llm-shortcut-btn llm-action-btn llm-send-btn llm-cancel-btn llm-action-icon-only",
    {
      id: "llm-cancel",
      title: t("Cancel"),
    },
  );
  sendBtn.setAttribute("aria-label", t("Send"));
  cancelBtn.setAttribute("aria-label", t("Cancel"));
  cancelBtn.style.display = "none";
  const sendSlot = createElement(doc, "div", "llm-action-slot");
  sendSlot.append(sendBtn, cancelBtn);

  const statusBar = createElement(
    doc,
    "div",
    "llm-status-control llm-run-status-strip",
  );
  statusBar.setAttribute("aria-label", t("Run status"));
  const statusLine = createElement(doc, "div", "llm-status", {
    id: "llm-status",
    textContent: hasItem ? "" : t("Select an item or open a PDF"),
  });
  // Keep idle status out of the composer footprint. Existing handlers update
  // this node outside the builder, so observe it instead of using :has(),
  // which the stylesheet avoids for older Gecko versions.
  const syncStatusVisibility = () => {
    const visible = hasItem && Boolean(statusLine.textContent?.trim());
    statusBar.classList.toggle("llm-run-status-empty", !visible);
    statusBar.dataset.state = visible ? "visible" : "empty";
    if (visible) statusBar.removeAttribute("aria-hidden");
    else statusBar.setAttribute("aria-hidden", "true");
  };
  syncStatusVisibility();
  const mutationObserverConstructor =
    doc.defaultView?.MutationObserver ||
    (typeof MutationObserver === "function" ? MutationObserver : undefined);
  if (mutationObserverConstructor) {
    const statusObserver = new mutationObserverConstructor(syncStatusVisibility);
    statusObserver.observe(statusLine, {
      attributes: true,
      attributeFilter: ["class", "style"],
      characterData: true,
      childList: true,
      subtree: true,
    });
  }
  const footerControls = createElement(doc, "div", "llm-footer-controls");
  const permissionControl = createElement(
    doc,
    "div",
    "llm-permission-control",
    { id: "llm-permission-control" },
  );
  permissionControl.style.display = "none";
  const permissionButton = createElement(
    doc,
    "button",
    "llm-permission-toggle",
    {
      id: "llm-permission-toggle",
      type: "button",
      title: t("Permission mode"),
    },
  );
  permissionButton.setAttribute("aria-haspopup", "menu");
  permissionButton.setAttribute("aria-expanded", "false");
  const permissionMenu = createElement(doc, "div", "llm-permission-menu", {
    id: "llm-permission-menu",
  });
  permissionMenu.setAttribute("role", "menu");
  permissionMenu.style.display = "none";
  permissionControl.append(permissionButton, permissionMenu);

  const contextUsageControl = createElement(
    doc,
    "span",
    "llm-context-usage-control",
  );
  const contextUsagePresentation = buildContextUsagePresentation({
    sessionTokens: 0,
  });
  const contextGauge = createElement(doc, "span", "llm-context-gauge", {
    id: "llm-context-gauge",
    title: contextUsagePresentation.title,
  });
  contextGauge.setAttribute("role", "img");
  contextGauge.setAttribute("tabindex", "0");
  contextGauge.setAttribute("aria-label", contextUsagePresentation.title);
  contextGauge.setAttribute("aria-describedby", "llm-token-usage");
  const tokenUsage = createElement(doc, "span", "llm-token-usage", {
    id: "llm-token-usage",
  });
  tokenUsage.setAttribute("role", "tooltip");
  tokenUsage.dataset.label = contextUsagePresentation.label;
  tokenUsage.dataset.summary = contextUsagePresentation.summary;
  tokenUsage.dataset.detail = contextUsagePresentation.detail;
  contextUsageControl.append(contextGauge, tokenUsage);
  footerControls.append(permissionControl);
  const providerQuota = createElement(doc, "button", "llm-provider-quota", {
    id: "llm-provider-quota",
    type: "button",
  });
  providerQuota.style.display = "none";
  footerControls.append(providerQuota);
  statusLine.setAttribute("role", "status");
  statusLine.setAttribute("aria-live", "polite");
  const statusToggle = createElement(doc, "button", "llm-status-toggle", {
    id: "llm-status-toggle", type: "button", title: "状态",
  });
  statusToggle.setAttribute("aria-label", "状态");
  statusToggle.setAttribute("aria-describedby", "llm-status");
  statusToggle.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Escape") statusToggle.blur();
  });
  statusBar.append(statusLine, statusToggle);
  toolsBody.append(footerControls);

  modelControls.append(modelDropdown, reasoningDropdown, contextUsageControl);
  // Keep Add context in the same visible tray as Agent mode and selected
  // context. Moving the existing node preserves its event-handler contract.
  uploadSlot.dataset.contextGroup = "add";
  contextPreviews.insertBefore(uploadSlot, addedContextLabel.nextSibling);
  actionsLeft.append(sourceShortcut);
  for (const button of [selectTextBtn, screenshotBtn]) button.setAttribute("data-slash-base-item", "true");
  slashList.append(selectTextBtn, screenshotBtn);
  // Hide PDF-reader-specific buttons in standalone library chat
  if (isStandaloneBody && isGlobalMode) {
    selectTextBtn.style.display = "none";
    screenshotBtn.style.display = "none";
  }
  actionsRight.append(statusBar, sendSlot);
  actionsRow.append(actionsLeft, modelControls, actionsRight);
  composeArea.appendChild(actionsRow);
  container.appendChild(inputSection);

  body.appendChild(container);
}

export { buildUI };
