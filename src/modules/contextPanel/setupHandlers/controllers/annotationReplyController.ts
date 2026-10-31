import { createElement } from "../../../../utils/domHelpers";
import type {
  AnnotationReplyBatch,
  AnnotationReplyPage,
  AnnotationReplyTarget,
} from "../../../../shared/types";
import {
  listAnnotationReplyCandidates,
  renderAnnotationReplyPages,
  prepareAnnotationReplyBatch,
  loadAnnotationReplyBatches,
  reparseAnnotationReplyBatch,
  type AnnotationReplyCandidate,
} from "../../../../services/pdf/annotationReplyService";

import {
  annotationBatchPresentation,
  annotationSourceLabel,
  annotationStatusLabel,
  annotationSelectionSummary,
  createAnnotationDrawerSelection,
  readableAnnotationComment,
  renderAnnotationBatchAnswers,
} from "../../annotationReplyPresentation";

/** Bound the single reading workspace to the native viewport, including its composer. */
export function installAnnotationReplyLayout(
  root: HTMLDetailsElement,
): () => void {
  const panel = root.closest<HTMLElement>(".llm-panel");
  const viewport = root.closest<HTMLElement>(".zotero-view-item");
  const win = root.ownerDocument.defaultView;
  if (!panel || !viewport || !win) return () => {};
  let frame: number | undefined;
  const measure = () => {
    frame = undefined;
    if (!root.isConnected) return;
    const bounds = viewport.getBoundingClientRect();
    const viewportWidth = Number(bounds.width);
    if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return;
    const innerHeight = Number(win.innerHeight);
    if (!Number.isFinite(innerHeight) || innerHeight <= 0) return;
    const visibleTop = Math.max(bounds.top, 0);
    const visibleBottom = Math.min(innerHeight, bounds.bottom);
    const viewportBudget = Math.floor(visibleBottom - visibleTop - 8);
    if (!Number.isFinite(viewportBudget) || viewportBudget <= 0) return;
    const panelBudget = Math.floor(
      visibleBottom -
        Math.max(visibleTop, panel.getBoundingClientRect().top) -
        8,
    );
    const height = panelBudget > 0 ? panelBudget : viewportBudget;
    panel.style.setProperty("--llm-workspace-height", `${height}px`);
  };
  const schedule = () => {
    if (frame === undefined) frame = win.requestAnimationFrame(measure);
  };
  const observer = new win.ResizeObserver(schedule);
  const reset = () => {
    observer.disconnect();
    win.removeEventListener("resize", schedule);
    viewport.removeEventListener("scroll", schedule);
    if (frame !== undefined) win.cancelAnimationFrame(frame);
    frame = undefined;
    panel.removeAttribute("data-reading-workspace");
    panel.style.removeProperty("--llm-workspace-height");
  };
  measure();
  panel.setAttribute("data-reading-workspace", "true");
  observer.observe(viewport);
  observer.observe(panel);
  win.addEventListener("resize", schedule);
  viewport.addEventListener("scroll", schedule);
  return reset;
}

export function createAnnotationReplyController(deps: {
  body: Element;
  getScope: () => Promise<{ attachmentIDs: number[]; conversationKey: number }>;
  onRepliesChanged?: () => void;
}) {
  const doc = deps.body.ownerDocument;
  deps.body.querySelector("#llm-annotation-replies")?.remove();
  deps.body.querySelector("#llm-annotation-selection-summary")?.remove();
  deps.body.querySelector("#llm-annotation-toggle")?.remove();
  const root = createElement(doc, "details", "llm-annotation-drawer", {
    id: "llm-annotation-replies",
  });
  const summary = createElement(doc, "summary", "llm-annotation-summary");
  summary.textContent = "批注";
  summary.hidden = true;
  summary.tabIndex = -1;
  const trigger = createElement(doc, "button", "llm-annotation-toggle", {
    id: "llm-annotation-toggle", type: "button",
  });
  trigger.setAttribute("aria-controls", root.id);
  trigger.setAttribute("aria-expanded", "false");
  trigger.classList.add("llm-toolbar-icon");
  const workspace = deps.body.querySelector<HTMLElement>("#llm-reading-workspace");
  const chatShell = deps.body.querySelector<HTMLElement>("#llm-chat-shell");
  let navigationVersion = 0;
  const syncExpanded = () => {
    trigger.setAttribute("aria-expanded", String(root.open));
    if (workspace) workspace.dataset.view = root.open ? "annotations" : "reading";
    if (chatShell) chatShell.hidden = root.open;
  };
  trigger.addEventListener("click", () => {
    navigationVersion++;
    root.open = !root.open;
    syncExpanded();
    if (root.open) navigate(view);
  });
  root.append(summary);
  const content = createElement(doc, "div", "llm-annotation-drawer-content");
  const status = createElement(doc, "p", "llm-annotation-status", {
    id: "llm-annotation-status",
  });
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.setAttribute("aria-atomic", "true");
  const list = createElement(doc, "div", "llm-annotation-list", {
    id: "llm-annotation-list",
  });
  const detail = createElement(doc, "section", "llm-annotation-detail", {
    id: "llm-annotation-focus",
  });
  detail.setAttribute("aria-label", "当前查看的批注来源（不改变发送选择）");
  const history = createElement(doc, "details", "llm-annotation-history", {
    id: "llm-annotation-history",
  });
  const historyTitle = createElement(doc, "summary", undefined, {
    textContent: "回答记录",
  });
  const historyBody = createElement(doc, "div");
  history.append(historyTitle, historyBody);
  const selectionSummary = createElement(
    doc,
    "span",
    "llm-annotation-selection-summary",
    { id: "llm-annotation-selection-summary" },
  );
  selectionSummary.setAttribute("role", "status");
  selectionSummary.setAttribute("aria-live", "polite");
  trigger.append(selectionSummary);
  const actions = deps.body.querySelector(".llm-actions-left");
  const source = actions?.querySelector("#llm-source-shortcut");
  actions?.insertBefore(trigger, source || null);
  type View = "list" | "source" | "preview" | "history";
  let view: View = "list";
  let previewReturn: View = "source";
  const viewHeader = createElement(doc, "div", "llm-annotation-view-header");
  let listOrigin: () => HTMLElement | null = () => records;
  let previewOrigin: () => HTMLElement | null = () => back;
  const viewTitle = createElement(doc, "h2", "llm-annotation-view-title", {textContent: "批注"});
  viewTitle.tabIndex = -1;
  const back = createElement(doc, "button", "llm-annotation-nav", {id: "llm-annotation-back", type: "button", textContent: "←", title: "返回"});
  back.setAttribute("aria-label", "返回");
  const records = createElement(doc, "button", "llm-annotation-nav", {id: "llm-annotation-records", type: "button", textContent: "回答记录"});
  const close = createElement(doc, "button", "llm-annotation-nav", {id: "llm-annotation-close", type: "button", textContent: "×", title: "返回阅读"});
  close.setAttribute("aria-label", "返回阅读");
  const listView = createElement(doc, "section", "llm-annotation-list-view");
  const showView = (next: View) => {
    if (next !== view && status.dataset.kind === "info") status.textContent = "";
    count.hidden = next !== "list";
    view = next;
    root.dataset.view = next;
    listView.hidden = next !== "list";
    detail.hidden = next !== "source" && next !== "preview";
    history.hidden = next !== "history";
    history.open = next === "history";
    back.hidden = next === "list";
    records.hidden = next === "history";
    viewTitle.textContent = next === "list" ? "批注" : next === "source" ? "批注来源" : next === "preview" ? "页面预览" : "回答记录";
  };
  const navigate = (next: View, focus: HTMLElement | null = viewTitle) => {
    navigationVersion++;
    showView(next);
    if (root.open) (focus || viewTitle).focus({preventScroll: true});
  };
  const goBack = () => {
    if (view === "preview") navigate(previewReturn, previewOrigin());
    else navigate("list", listOrigin());
  };
  back.addEventListener("click", goBack);
  records.addEventListener("click", () => {
    listOrigin = () => records;
    navigate("history");
  });
  close.addEventListener("click", () => { navigationVersion++; root.open = false; syncExpanded(); trigger.focus({preventScroll: true}); });
  const headerActions = createElement(doc, "div", "llm-annotation-header-actions");
  headerActions.append(records, close);
  viewHeader.append(back, viewTitle, headerActions);
  // Native details remains the external toggle contract; the body is one workspace view.
  historyTitle.hidden = true;
  historyTitle.tabIndex = -1;
  root.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !root.open) return;
    event.preventDefault(); event.stopPropagation();
    if (view === "list") close.click();
    else goBack();
  });
  const selection = createAnnotationDrawerSelection();
  let candidates: AnnotationReplyCandidate[] = [];
  let batches: AnnotationReplyBatch[] = [];
  let scopeKey = "";
  let conversationKey = 0;
  let pages: AnnotationReplyPage[] | undefined;
  let focusPages:
    | { identity: string; version: string; pages: AnnotationReplyPage[] }
    | undefined;
  let preparedKey = "";
  let revision = 0;
  let disposed = false;
  let previewButton: HTMLButtonElement;
  const busyButtons = new Set<HTMLButtonElement>();
  const selectionKey = () =>
    JSON.stringify(selection.targets().map((t) => [t.identity, t.version]));
  let statusVersion = 0;
  const setStatus = (message: string, kind: "info" | "busy" | "error" = "info") => {
    status.textContent = message;
    status.dataset.kind = kind;
    return ++statusVersion;
  };
  const clearPreviewStatus = (owner: number) => {
    if (statusVersion === owner) setStatus("");
  };
  const updatePreviewAvailability = () => {
    if (!previewButton) return;
    previewButton.disabled = !selection.targets().length || busyButtons.has(previewButton);
    previewButton.title = selection.targets().length
      ? "渲染所选批注的实际 PDF 页面；不会发送"
      : "先勾选至少一条可发送的文字批注";
  };
  const updateSelection = () => {
    const targets = selection.targets();
    selectionSummary.textContent = targets.length
      ? String(targets.length)
      : "";
    selectionSummary.title = targets
      .map((t) => `${t.identity}，${annotationSourceLabel(t)}`)
      .join("\n");
    selectionSummary.hidden = !targets.length;
    trigger.title = selectionSummary.title || "批注";
    trigger.setAttribute("aria-label", targets.length ? `批注，${annotationSelectionSummary(targets)}` : "批注");
    updatePreviewAvailability();
    const chosen = deps.body.querySelector<HTMLElement>("#llm-annotation-chosen");
    if (chosen) chosen.textContent = targets.length ? `已选 ${targets.length} 条` : "";
    for (const node of Array.from(
      list.querySelectorAll(".llm-annotation-row"),
    )) {
      const row = node as HTMLElement;
      row.dataset.selected = String(
        targets.some((t) => t.identity === row.dataset.annotationIdentity),
      );
    }
  };
  const run = async (action: () => Promise<void>) => {
    try {
      await action();
    } catch (error) {
      if (!disposed)
        setStatus(error instanceof Error ? error.message : String(error), "error");
    }
  };
  const button = (id: string, text: string, action: () => Promise<void>) => {
    const b = createElement(doc, "button", "llm-annotation-button", {
      id,
      type: "button",
      textContent: text,
    });
    b.addEventListener("click", () => {
      if (b.disabled) return;
      const restoreFocus = doc.activeElement === b;
      const actionNavigation = navigationVersion;
      void run(async () => {
        busyButtons.add(b);
        b.disabled = true;
        b.setAttribute("aria-busy", "true");
        b.textContent = "处理中…";
        try {
          await action();
        } finally {
          busyButtons.delete(b);
          b.disabled = false;
          b.removeAttribute("aria-busy");
          b.textContent = text;
          updatePreviewAvailability();
          // Rendering may replace the detail's controls. Keep keyboard users
          // at the same action without scrolling the outer reading document.
          const replacement = deps.body.querySelector<HTMLElement>(`#${id}`);
          if (restoreFocus && !disposed && root.open && navigationVersion === actionNavigation &&
              replacement && !replacement.closest("[hidden]") &&
              !(view === "preview" && id === "llm-annotation-focus-preview") &&
              (doc.activeElement === b || doc.activeElement === doc.body))
            replacement.focus({ preventScroll: true });
        }
      });
    });
    return b;
  };
  const filter = createElement(doc, "select", "llm-annotation-filter", {
    id: "llm-annotation-filter",
  });
  filter.setAttribute("aria-label", "筛选批注（不清除已选项）");
  for (const [value, text] of [
    ["all", "全部文字批注"],
    ["new", "可发送"],
    ["blocked", "已处理 / 待确认"],
  ]) {
    filter.append(
      createElement(doc, "option", undefined, { value, textContent: text }),
    );
  }
  // Explicit reading gestures reveal their result inside this drawer only.
  // Refreshes and checkbox changes must not move the reader or composer.
  const revealFocus = (_anchor: HTMLElement | null = detail) => {
    if (!root.open || detail.hidden) return;
    detail.scrollTop = 0;
  };
  const renderFocus = () => {
    detail.replaceChildren();
    const candidate = candidates.find(
      (c) => c.annotationID === selection.focused(),
    );
    if (!candidate) {
      detail.hidden = true;
      return;
    }
    detail.hidden = view !== "source" && view !== "preview";
    const target = candidate.target;
    if (!target) {
      detail.append(
        createElement(doc, "p", "llm-annotation-error", {
          textContent: candidate.blocked || "此批注缺少准确位置，无法发送。",
        }),
      );
      return;
    }
    detail.append(
      createElement(doc, "p", "llm-annotation-question", {
        textContent: readableAnnotationComment(target.comment),
      }),
      createElement(doc, "div", "llm-annotation-meta", { textContent: annotationSourceLabel(target) }),
      createElement(doc, "blockquote", "llm-annotation-quote", {
        textContent:
          target.quotedText || "无选中文本。",
      }),
    );
    const identity = createElement(doc, "details", "llm-annotation-identity");
    identity.append(
      createElement(doc, "summary", undefined, {textContent: "标识与位置"}),
      createElement(doc, "p", undefined, {textContent: target.identity}),
      createElement(doc, "pre", undefined, {textContent: JSON.stringify(target.position, null, 2)}),
    );
    detail.append(identity);
    const tools = createElement(doc, "div", "llm-annotation-toolbar");
    tools.append(
      button("llm-annotation-locate", "定位原文", async () => {
        await Zotero.Reader.open(target.attachmentID, {
          pageIndex: target.position.pageIndex,
          position: target.position,
        });
      }),
    );
    tools.append(
      button("llm-annotation-focus-preview", "预览页面", async () => {
        const currentScope = scopeKey, requestNavigation = navigationVersion;
        const statusOwner = setStatus("正在生成预览…", "busy");
        const rendered = await renderAnnotationReplyPages([target]);
        if (disposed || scopeKey !== currentScope) return;
        focusPages = {
          identity: target.identity,
          version: target.version,
          pages: rendered,
        };
        if (root.open && navigationVersion === requestNavigation && selection.focused() === target.annotationID) {
          renderFocus();
          previewReturn = "source";
          previewOrigin = () => detail.querySelector<HTMLElement>("#llm-annotation-focus-preview");
          navigate("preview");
          revealFocus(detail.querySelector<HTMLElement>("#llm-annotation-images"));
          clearPreviewStatus(statusOwner);
        } else clearPreviewStatus(statusOwner);
      }),
    );
    detail.append(tools);
    const batch = batches.find((b) =>
      b.targets.some(
        (t) => t.identity === target.identity && t.version === target.version,
      ),
    );
    const savedReply = batch && annotationBatchPresentation(batch).replies.find(r => r.target.identity === target.identity);
    if (savedReply) {
      const answer = createElement(doc, "section", "llm-annotation-source-answer");
      answer.append(createElement(doc, "h3", undefined, {textContent: "回答"}),
        createElement(doc, "p", undefined, {textContent: savedReply.answer}));
      detail.append(answer);
    }
    const values =
      focusPages?.identity === target.identity &&
      focusPages.version === target.version
        ? focusPages.pages
        : pages && selection.has(target)
          ? pages
          : batch?.pages || [];
    const sourcePages = values.filter(
      (p) =>
        p.attachmentID === target.attachmentID &&
        (p.pageIndex === target.position.pageIndex ||
          (target.position.nextPageRects &&
            p.pageIndex === target.position.pageIndex + 1)),
    );
    const imageHost = createElement(doc, "div", "llm-annotation-source", {
      id: "llm-annotation-images",
    });
    if (sourcePages.length) {
      const pageSelect = createElement(doc, "select", "llm-annotation-filter");
      pageSelect.setAttribute("aria-label", "当前批注的原生页面");
      sourcePages.forEach((p, i) =>
        pageSelect.append(
          createElement(doc, "option", undefined, {
            value: String(i),
            textContent: `第 ${p.pageIndex + 1} 页`,
          }),
        ),
      );
      const imageLink = createElement(
        doc,
        "button",
        "llm-annotation-image-button",
        { type: "button", title: "展开 / 收起原生页图" },
      );
      imageLink.setAttribute("aria-expanded", "false");
      const img = createElement(doc, "img");
      const context = createElement(
        doc,
        "details",
        "llm-annotation-source-context",
      );
      context.append(
        createElement(doc, "summary", undefined, {
          textContent: "页面文本",
        }),
      );
      const text = createElement(doc, "p");
      context.append(text);
      const show = () => {
        const page = sourcePages[Number(pageSelect.value) || 0];
        img.src = page.dataURL;
        img.alt = `${target.identity}，${target.title}，第 ${page.pageIndex + 1} 页页图`;
        text.textContent = page.context;
      };
      imageLink.append(img);
      imageLink.addEventListener("click", () => {
        const expanded = imageLink.getAttribute("aria-expanded") !== "true";
        imageLink.setAttribute("aria-expanded", String(expanded));
      });
      pageSelect.addEventListener("change", show);
      show();
      imageHost.append(pageSelect, imageLink, context);
    } else
      imageHost.append(
        createElement(doc, "p", "llm-annotation-help", {
          textContent:
            "暂无预览",
        }),
      );
    detail.append(imageHost);
  };
  const renderList = () => {
    list.replaceChildren();
    const visible = candidates.filter((c) =>
      filter.value === "new"
        ? !c.blocked
        : filter.value === "blocked"
          ? c.batchStatus === "applied"
          : true,
    );
    for (const candidate of visible) {
      const target = candidate.target;
      const row = createElement(doc, "div", "llm-annotation-row");
      row.dataset.annotationIdentity = target?.identity || candidate.identity || "";
      const check = createElement(doc, "input");
      check.type = "checkbox";
      check.disabled = !!candidate.blocked || !target;
      check.checked = !!target && selection.has(target);
      check.dataset.annotationIdentity = target?.identity || candidate.identity || "";
      check.title = candidate.blocked
        ? (!target ? candidate.blocked : annotationStatusLabel(candidate.batchStatus))
        : "勾选后随下方发送提交";
      check.setAttribute(
        "aria-label",
        `加入发送：${target?.identity || candidate.identity || candidate.annotationID}，${readableAnnotationComment(target?.comment || candidate.label)}`,
      );
      check.addEventListener("change", () => {
        selection.select(candidate, check.checked);
        pages = undefined;
        preparedKey = "";
        updateSelection();
        renderFocus();
        setStatus(
          `已选 ${selection.targets().length} 条。`,
        );
      });
      const focus = createElement(doc, "button", "llm-annotation-row-focus", {
        type: "button",
      });
      focus.dataset.annotationId = String(candidate.annotationID);
      focus.title = target?.identity || candidate.identity || "";
      focus.setAttribute(
        "aria-expanded",
        String(selection.focused() === candidate.annotationID),
      );
      focus.setAttribute("aria-controls", "llm-annotation-focus");
      const state = createElement(doc, "span", "llm-annotation-state", {
        textContent: !target ? "无法发送，查看原因" : annotationStatusLabel(candidate.batchStatus),
      });
      state.title = state.textContent || "";
      state.setAttribute("aria-label", state.title);
      state.textContent = candidate.batchStatus === "applied" ? "✓"
        : candidate.batchStatus === "inflight" ? "…"
        : candidate.blocked ? "!" : "+";
      state.dataset.state = candidate.batchStatus || "new";
      focus.append(
        createElement(doc, "span", "llm-annotation-row-comment", {
          textContent: readableAnnotationComment(target?.comment || candidate.label),
        }),
        createElement(doc, "span", "llm-annotation-meta", {
          textContent: target
            ? annotationSourceLabel(target)
            : `${candidate.pdfTitle}，位置不可用`,
        }),
        state,
      );
      focus.addEventListener("click", () => {
        selection.focus(candidate.annotationID);
        for (const node of Array.from(
          list.querySelectorAll(".llm-annotation-row-focus"),
        ))
          (node as HTMLElement).setAttribute(
            "aria-expanded",
            String(node === focus),
          );
        renderFocus();
        listOrigin = () => list.querySelector<HTMLElement>(`[data-annotation-id="${candidate.annotationID}"]`);
        navigate("source");
        revealFocus();
      });
      const pageLink = createElement(doc, "button", "llm-annotation-row-page", {
        type: "button", textContent: target ? `第 ${target.position.pageIndex + 1} 页` : "位置不可用",
        title: target ? `${target.identity}，预览页面` : "位置不可用",
        disabled: !target,
      });
      pageLink.setAttribute("aria-label", pageLink.title);
      pageLink.dataset.pageAnnotationId = String(candidate.annotationID);
      pageLink.addEventListener("click", () => {
        selection.focus(candidate.annotationID);
        renderFocus();
        listOrigin = () => list.querySelector<HTMLElement>(`[data-page-annotation-id="${candidate.annotationID}"]`);
        navigate("source");
        detail.querySelector<HTMLButtonElement>("#llm-annotation-focus-preview")?.click();
      });
      row.append(check, focus, pageLink);
      list.append(row);
    }
    if (!visible.length)
      list.append(
        createElement(doc, "p", "llm-annotation-help", {
          textContent: "无符合条件的批注。",
        }),
      );
    updateSelection();
  };
  filter.addEventListener("change", renderList);
  const renderHistory = () => {
    historyTitle.textContent = `回答记录，${batches.length} 批`;
    historyBody.replaceChildren();
    for (const batch of batches) {
      const row = createElement(doc, "section", "llm-annotation-batch");
      row.append(
        createElement(doc, "div", "llm-annotation-meta", {
          textContent: `${new Date(batch.createdAt).toLocaleString()}，${batch.targets.length} 条批注`,
        }),
      );
      const answers = createElement(doc, "div");
      renderAnnotationBatchAnswers(answers, batch);
      row.append(answers);
      row.append(
        button(
          `llm-annotation-preview-${batch.id}`,
          "查看本批来源",
          async () => {
            const target = batch.targets[0];
            if (!target) return;
            // An edited historical version is displayed as saved, never substituted for current source.
            detail.hidden = false;
            detail.replaceChildren();
            const select = createElement(
              doc,
              "select",
              "llm-annotation-filter",
            );
            select.setAttribute("aria-label", "选择已存批注来源");
            batch.targets.forEach((t, i) =>
              select.append(
                createElement(doc, "option", undefined, {
                  value: String(i),
                  textContent: `${t.identity}，${annotationSourceLabel(t)}`,
                }),
              ),
            );
            const host = createElement(doc, "div", "llm-annotation-source");
            const show = () => {
              const t = batch.targets[Number(select.value) || 0];
              const savedSource = createElement(doc, "details", "llm-annotation-saved-source");
              savedSource.append(
                createElement(doc, "summary", undefined, {textContent: "本批来源与原选文"}),
                createElement(doc, "p", undefined, {textContent: t.identity}),
                createElement(doc, "p", undefined, {textContent: readableAnnotationComment(t.comment)}),
                createElement(doc, "blockquote", undefined, {textContent: t.quotedText || "无选中文本。"}),
              );
              host.replaceChildren(savedSource);
              const p = batch.pages.find(
                (p) =>
                  p.attachmentID === t.attachmentID &&
                  p.pageIndex === t.position.pageIndex,
              );
              if (p)
                host.append(
                  createElement(doc, "img", "llm-annotation-history-image", {
                    src: p.dataURL,
                    alt: `${t.identity}，第 ${p.pageIndex + 1} 页，已存批次原生图`,
                  }),
                  createElement(doc, "p", "llm-annotation-context", {
                    textContent: p.context,
                  }),
                );
            };
            const revealSavedPage = () => revealFocus(
              host.querySelector<HTMLElement>(".llm-annotation-history-image") || detail,
            );
            select.addEventListener("change", () => {
              show();
              revealSavedPage();
            });
            show();
            detail.append(select, host);
            previewReturn = "history";
            previewOrigin = () => historyBody.querySelector<HTMLElement>(`#llm-annotation-preview-${batch.id}`);
            navigate("preview");
            revealSavedPage();
          },
        ),
      );
      if (batch.rawAnswer !== undefined)
        row.append(
          button(
            `llm-annotation-reparse-${batch.id}`,
            "重新解析，不重发",
            async () => {
              try {
                await reparseAnnotationReplyBatch(batch.id);
                setStatus("解析完成。");
              } finally {
                await refresh();
                deps.onRepliesChanged?.();
              }
            },
          ),
        );
      historyBody.append(row);
    }
  };
  const refresh = async () => {
    const current = ++revision;
    const scope = await deps.getScope();
    const key = JSON.stringify([scope.conversationKey, scope.attachmentIDs]);
    const [nextCandidates, nextBatches] = await Promise.all([
      listAnnotationReplyCandidates(scope.attachmentIDs),
      loadAnnotationReplyBatches(scope.conversationKey),
    ]);
    if (current !== revision || disposed) return;
    selection.reconcile(nextCandidates, scopeKey !== key);
    if (scopeKey !== key) focusPages = undefined;
    scopeKey = key;
    conversationKey = scope.conversationKey;
    candidates = nextCandidates;
    batches = nextBatches;
    pages = undefined;
    preparedKey = "";
    renderList();
    renderFocus();
    renderHistory();
    const available = candidates.filter((c) => c.target && !c.blocked).length;
    count.textContent = String(candidates.length);
    filterButtons.forEach((b) => {
      const key = b.dataset.filter;
      const n = key === "all" ? candidates.length : key === "new" ? available : candidates.filter(c => c.batchStatus === "applied").length;
      b.textContent = `${key === "all" ? "全部" : key === "new" ? "待发送" : "已回答"} ${n}`;
    });
    showView(view);
    setStatus(candidates.length ? "" : "当前 PDF 没有文字批注。");
  };
  const tools = createElement(doc, "div", "llm-annotation-toolbar");
  const count = createElement(doc, "span", "llm-annotation-count");
  viewHeader.insertBefore(count, headerActions);
  const refreshButton = button("llm-annotation-refresh", "↻", refresh);
  refreshButton.title = "刷新批注";
  refreshButton.setAttribute("aria-label", "刷新批注");
  headerActions.insertBefore(refreshButton, close);
  const filterRow = createElement(doc, "div", "llm-annotation-filters");
  filterRow.setAttribute("role", "group");
  filterRow.setAttribute("aria-label", "筛选批注");
  filter.hidden = true;
  const filterButtons = ["all", "new", "blocked"].map(key => {
    const b = createElement(doc, "button", "llm-annotation-filter-tab", {type: "button"});
    b.dataset.filter = key;
    b.setAttribute("aria-pressed", String(key === filter.value));
    b.addEventListener("click", () => { filter.value = key; renderList(); filterButtons.forEach(t => t.setAttribute("aria-pressed", String(t === b))); });
    filterRow.append(b); return b;
  });
  const chosen = createElement(doc, "span", "llm-annotation-chosen", {id: "llm-annotation-chosen"});
  const chooseAll = button("llm-annotation-select-pending", "选择待发送", async () => { candidates.forEach(c => selection.select(c, true)); pages = undefined; preparedKey = ""; renderList(); });
  const clear = button("llm-annotation-clear-selection", "清空", async () => { selection.clear(); pages = undefined; preparedKey = ""; renderList(); });
  tools.append(
    chosen, chooseAll, clear,
    (previewButton = button("llm-annotation-preview", "预览所选页面", async () => {
      if (!selection.targets().length) throw new Error("请先勾选文字批注。");
      const key = selectionKey(),
        currentScope = scopeKey, requestNavigation = navigationVersion;
      const statusOwner = setStatus("正在生成预览…", "busy");
      const rendered = await renderAnnotationReplyPages(selection.targets());
      if (disposed || key !== selectionKey() || currentScope !== scopeKey)
        return;
      pages = rendered;
      preparedKey = key;
      focusPages = undefined;
      if (!root.open || navigationVersion !== requestNavigation) {
        clearPreviewStatus(statusOwner);
        return;
      }
      selection.focus(selection.targets()[0].annotationID);
      renderList();
      renderFocus();
      clearPreviewStatus(statusOwner);
      previewReturn = "list";
      previewOrigin = () => previewButton;
      navigate("preview");
      revealFocus(detail.querySelector<HTMLElement>("#llm-annotation-images"));
    })),
  );
  listView.append(filter, filterRow, tools, list);
  content.append(viewHeader, status, listView, detail, history);
  showView("list");
  root.append(content);
  root.addEventListener("toggle", () => {
    syncExpanded();
    if (!root.open) navigationVersion++;
    if (root.open) void run(refresh);
  });
  // Reading and annotation views share one viewport; the composer never moves.
  (workspace || deps.body).append(root);
  const disposeLayout = installAnnotationReplyLayout(root);
  updateSelection();
  return {
    dispose: () => {
      disposed = true;
      revision++;
      disposeLayout();
      trigger.remove();
      root.remove();
      if (chatShell) chatShell.hidden = false;
      if (workspace) workspace.dataset.view = "reading";
    },
    hasSelection: () => selection.targets().length > 0,
    prepare: async (key: number): Promise<AnnotationReplyBatch | undefined> => {
      if (!selection.targets().length) return undefined;
      const targets = selection.targets();
      const scope = await deps.getScope();
      if (
        scope.conversationKey !== key ||
        conversationKey !== key ||
        JSON.stringify([scope.conversationKey, scope.attachmentIDs]) !==
          scopeKey
      ) {
        selection.clear();
        updateSelection();
        throw new Error("对话或 PDF 已切换；请刷新并重新选择批注。");
      }
      const batch = await prepareAnnotationReplyBatch(
        targets,
        key,
        preparedKey === selectionKey() ? pages : undefined,
      );
      selection.clear();
      updateSelection();
      candidates = candidates.map((c) =>
        targets.some(
          (t) =>
            t.identity === c.target?.identity &&
            t.version === c.target?.version,
        )
          ? {
              ...c,
              blocked: `inflight: ${batch.id}`,
              batchStatus: "inflight",
              batchId: batch.id,
            }
          : c,
      );
      batches = [batch, ...batches];
      pages = undefined;
      renderList();
      renderFocus();
      renderHistory();
      if (root.open) showView("history");
      setStatus("正在处理批注。", "busy");
      return batch;
    },
    settled: async () => {
      await refresh();
      deps.onRepliesChanged?.();
    },
  };
}
