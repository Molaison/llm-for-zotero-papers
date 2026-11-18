import type {
  AnnotationReplyBatch,
  AnnotationReplyPage,
} from "../../../../shared/types";
import {
  listAnnotationReplyCandidates,
  loadAnnotationReplyBatches,
  runAnnotationReplies,
  type AnnotationReplyRunOptions,
  type AnnotationReplyPacket,
  renderAnnotationReplyPages,
  planAnnotationReplyPages,
  annotationReplyActions,
  recoverAnnotationReplyBatch,
  type AnnotationReplyCandidate,
} from "../../../../services/pdf/annotationReplyService";
import {
  annotationSelectionSummary,
  createAnnotationSourceButton,
  annotationStatusLabel,
  createAnnotationDrawerSelection,
  readableAnnotationComment,
  renderAnnotationBatchAnswers,
} from "../../annotationReplyPresentation";
import { createElement } from "../../../../utils/domHelpers";

type AnnotationScope = { conversationKey: number; attachmentIDs: number[] };
type ControllerDeps = {
  body: Element;
  getScope: () => Promise<AnnotationScope>;
  onRepliesChanged?: () => void;
};

const scopeIdentity = (scope: AnnotationScope) =>
  JSON.stringify([
    scope.conversationKey,
    [...new Set(scope.attachmentIDs)].sort((a, b) => a - b),
  ]);

/** One composer tool; the popover never changes chat geometry or navigation. */
export function createAnnotationReplyController(deps: ControllerDeps) {
  const doc = deps.body.ownerDocument;
  const toolbar = deps.body.querySelector(".llm-actions-left");
  const selection = createAnnotationDrawerSelection();
  let disposed = false;
  let revision = 0;
  let scopeKey = "";
  let candidates: AnnotationReplyCandidate[] = [];
  let batches: AnnotationReplyBatch[] = [];
  let cachedPages: AnnotationReplyPage[] | undefined;
  let previewKey = "";
  const selectionKey = () =>
    JSON.stringify([
      scopeKey,
      selection
        .targets()
        .map((t) => [t.identity, t.version])
        .sort(),
    ]);

  const trigger = createElement(
    doc,
    "button",
    "llm-shortcut-btn llm-action-btn llm-action-btn-secondary",
    {
      id: "llm-annotation-toggle",
      type: "button",
      textContent: "便签",
      title: "PDF 便签问答",
    },
  );
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-controls", "llm-annotation-replies");
  trigger.setAttribute("aria-haspopup", "dialog");
  const slot = createElement(doc, "div", "llm-action-slot llm-annotation-tool");
  slot.append(trigger);
  toolbar?.append(slot);
  const root = createElement(doc, "div", "llm-annotation-popover", {
    id: "llm-annotation-replies",
  });
  root.setAttribute("popover", "auto");
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "PDF 便签问答");
  root.hidden = true;
  const status = createElement(doc, "p", undefined, {
    id: "llm-annotation-status",
  });
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const chosen = createElement(doc, "p", undefined, {
    id: "llm-annotation-chosen",
  });
  const list = createElement(doc, "div", "llm-annotation-list");
  const content = createElement(doc, "div", "llm-annotation-content");
  const recordNodes = new Map<string, HTMLElement>();
  const preview = createElement(doc, "details", "llm-annotation-preview");
  preview.append(
    createElement(doc, "summary", undefined, { textContent: "来源与原生页图" }),
  );
  const images = createElement(doc, "div", "llm-annotation-images");
  preview.append(images);
  const history = createElement(doc, "details", "llm-annotation-history");
  history.append(
    createElement(doc, "summary", undefined, { textContent: "回答记录" }),
  );
  const records = createElement(doc, "div");
  history.append(records);
  const setStatus = (message: string) => {
    if (!disposed) status.textContent = message;
  };
  const run = async (action: () => Promise<void>) => {
    try {
      await action();
    } catch (error) {
      setStatus(String(error));
    }
  };
  const button = (text: string, action: () => Promise<void>) => {
    const node = createElement(
      doc,
      "button",
      "llm-action-btn llm-action-btn-secondary",
      {
        type: "button",
        textContent: text,
      },
    );
    node.addEventListener("click", () => {
      void run(action);
    });
    return node;
  };
  const invalidatePreview = () => {
    cachedPages = undefined;
    previewKey = "";
    images.replaceChildren();
  };
  const updateSelection = () => {
    const targets = selection.targets();
    const count = planAnnotationReplyPages(targets).length;
    const eligible = candidates.filter((c) => c.target && !c.blocked).length;
    chosen.textContent = `${annotationSelectionSummary(targets)}，${count} 页图；当前可处理 ${eligible} 条。${count > 9 ? "超过 9 页，已保留完整选择，但不能预览或提交。" : "最多 9 页图。"}`;
    trigger.textContent = selection.targets().length
      ? `便签 (${selection.targets().length})`
      : "便签";
  };
  const showPages = (
    pages: AnnotationReplyPage[],
    targets = selection.targets(),
  ) => {
    images.replaceChildren();
    for (const page of pages) {
      const figure = createElement(doc, "figure");
      const caption = createElement(doc, "figcaption");
      const target = targets.find(
        (t) =>
          t.attachmentID === page.attachmentID &&
          (t.position.pageIndex === page.pageIndex ||
            (t.position.nextPageRects &&
              t.position.pageIndex + 1 === page.pageIndex)),
      );
      if (target)
        caption.append(
          createAnnotationSourceButton(doc, target, setStatus, page.pageIndex),
        );
      figure.append(
        caption,
        createElement(doc, "img", undefined, {
          src: page.dataURL,
          alt: `原生 PDF 第 ${page.pageIndex + 1} 页及所选便签位置`,
        }),
      );
      images.append(figure);
    }
    preview.open = true;
  };
  const renderList = () => {
    list.replaceChildren();
    for (const candidate of candidates) {
      const row = createElement(doc, "div", "llm-annotation-row");
      const label = createElement(doc, "label");
      const check = createElement(doc, "input", undefined, {
        type: "checkbox",
      });
      check.disabled = !candidate.target || Boolean(candidate.blocked);
      check.checked = candidate.target
        ? selection.has(candidate.target)
        : false;
      check.addEventListener("change", () => {
        selection.select(candidate, check.checked);
        invalidatePreview();
        updateSelection();
      });
      label.append(
        check,
        createElement(doc, "span", undefined, {
          textContent: readableAnnotationComment(
            candidate.target?.comment || candidate.label,
          ),
        }),
      );
      row.append(label);
      if (candidate.target)
        row.append(
          createAnnotationSourceButton(doc, candidate.target, setStatus),
        );
      else
        row.append(
          createElement(doc, "p", undefined, {
            textContent: candidate.pdfTitle || "来源不可用",
          }),
        );
      if (candidate.target?.quotedText)
        row.append(
          createElement(doc, "blockquote", undefined, {
            textContent: candidate.target.quotedText,
          }),
        );
      if (candidate.blocked)
        row.append(
          createElement(doc, "p", undefined, {
            textContent: candidate.batchStatus
              ? annotationStatusLabel(candidate.batchStatus)
              : candidate.blocked,
          }),
        );
      if (candidate.batchId) {
        const batchId = candidate.batchId;
        row.append(
          button("查看记录与恢复", async () => {
            history.open = true;
            const entry = recordNodes.get(batchId);
            entry?.scrollIntoView?.({ block: "nearest" });
            entry?.focus();
          }),
        );
      }
      list.append(row);
    }
    updateSelection();
  };
  const renderHistory = (batches: AnnotationReplyBatch[]) => {
    records.replaceChildren();
    recordNodes.clear();
    for (const batch of batches) {
      const entry = createElement(doc, "article", "llm-annotation-record");
      entry.tabIndex = -1;
      recordNodes.set(batch.id, entry);
      const heading = createElement(
        doc,
        "div",
        "llm-annotation-record-heading",
      );
      heading.append(
        createElement(doc, "p", undefined, {
          textContent: `${new Date(batch.createdAt).toLocaleString()} · ${annotationStatusLabel(batch.status)}`,
        }),
      );
      const actions = annotationReplyActions(batch);
      if (actions.parse)
        heading.append(
          button(
            batch.status === "applied" ? "修复已登记答案格式" : "本地重新解析",
            async () => {
              await recoverAnnotationReplyBatch(batch.id, "parse");
              await refresh();
              deps.onRepliesChanged?.();
            },
          ),
        );
      if (actions.allowRetry)
        heading.append(
          button("允许重新选择", async () => {
            const expectedRevision = batch.revision;
            const confirm = doc.defaultView?.confirm;
            if (!confirm) throw new Error("无法显示风险确认；未解除占用。");
            if (
              !confirm.call(
                doc.defaultView,
                "此请求可能已经发送。允许重新选择后，旧批次永远不会再写回，但旧答案仍保留。再次发送可能重复计费。是否允许重新选择？",
              )
            )
              return;
            await recoverAnnotationReplyBatch(
              batch.id,
              "allow-retry",
              expectedRevision,
            );
            await refresh();
            deps.onRepliesChanged?.();
            setStatus(
              "已允许重新选择。请自行勾选便签，再用聊天发送按钮提交；未自动发送。",
            );
          }),
        );
      entry.append(heading);
      const answers = createElement(doc, "div");
      renderAnnotationBatchAnswers(answers, batch);
      entry.append(answers);
      const sources = createElement(doc, "details");
      sources.append(
        createElement(doc, "summary", undefined, {
          textContent: "已发送来源页图",
        }),
      );
      for (const page of batch.pages) {
        const figure = createElement(doc, "figure");
        const caption = createElement(doc, "figcaption");
        const target = batch.targets.find(
          (t) =>
            t.attachmentID === page.attachmentID &&
            (t.position.pageIndex === page.pageIndex ||
              (t.position.nextPageRects &&
                t.position.pageIndex + 1 === page.pageIndex)),
        );
        if (target)
          caption.append(
            createAnnotationSourceButton(
              doc,
              target,
              setStatus,
              page.pageIndex,
            ),
          );
        figure.append(
          caption,
          createElement(doc, "img", undefined, {
            src: page.dataURL,
            alt: `${target?.title || "未命名 PDF"}，第 ${page.pageIndex + 1} 页（已发送）`,
          }),
        );
        sources.append(figure);
      }
      entry.append(sources);
      records.append(entry);
    }
    if (!batches.length)
      records.append(
        createElement(doc, "p", undefined, { textContent: "暂无回答记录。" }),
      );
  };
  const refresh = async () => {
    const current = ++revision;
    const scope = await deps.getScope();
    const key = scopeIdentity(scope);
    const nextCandidates = await listAnnotationReplyCandidates(
      scope.attachmentIDs,
    );
    const nextBatches = await loadAnnotationReplyBatches(
      scope.conversationKey,
      nextCandidates.flatMap((c) => (c.batchId ? [c.batchId] : [])),
    );
    if (disposed || current !== revision) return;
    // Scope may move while PDF/DB reads await. Never display the old scope as current.
    if (
      scopeIdentity(await deps.getScope()) !== key ||
      disposed ||
      current !== revision
    )
      return;
    selection.reconcile(nextCandidates, key !== scopeKey);
    scopeKey = key;
    candidates = nextCandidates;
    batches = nextBatches;
    invalidatePreview();
    renderList();
    renderHistory(batches);
    setStatus(
      candidates.length
        ? "勾选后用聊天发送按钮提交。"
        : "当前 PDF 没有可处理的文字便签。",
    );
  };
  const tools = createElement(doc, "div", "llm-annotation-tools");
  tools.append(
    button("刷新", refresh),
    button("全选可用便签", async () => {
      for (const candidate of candidates) selection.select(candidate, true);
      invalidatePreview();
      renderList();
    }),
    button("清空选择", async () => {
      selection.clear();
      invalidatePreview();
      renderList();
    }),
    button("预览所选页面", async () => {
      const targets = selection.targets();
      if (!targets.length) throw new Error("请先勾选便签。");
      if (scopeIdentity(await deps.getScope()) !== scopeKey)
        throw new Error("对话或 PDF 已切换；请刷新并重新选择便签。");
      const key = selectionKey();
      setStatus("正在生成原生页图…");
      const pages = await renderAnnotationReplyPages(targets);
      if (
        disposed ||
        key !== selectionKey() ||
        scopeIdentity(await deps.getScope()) !== scopeKey
      )
        return;
      cachedPages = pages;
      previewKey = key;
      showPages(pages);
      setStatus("原生页图已就绪。");
    }),
  );
  const close = () => {
    if (typeof root.hidePopover === "function" && !root.hidden)
      root.hidePopover();
    root.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
  };
  tools.append(button("关闭", async () => close()));
  content.append(list, preview, history);
  root.append(tools, status, chosen, content);
  (toolbar?.closest(".llm-panel") || deps.body).append(root);
  trigger.addEventListener("click", () => {
    if (!root.hidden) {
      close();
      return;
    }
    root.hidden = false;
    const rect = trigger.getBoundingClientRect();
    const win = doc.defaultView;
    root.style.left = `${Math.max(8, Math.min(rect.left, (win?.innerWidth || 400) - 392))}px`;
    root.style.bottom = `${Math.max(8, (win?.innerHeight || rect.top) - rect.top + 6)}px`;
    if (typeof root.showPopover === "function") root.showPopover();
    trigger.setAttribute("aria-expanded", "true");
    void run(refresh);
  });
  root.addEventListener("toggle", (event) => {
    if ((event as ToggleEvent).newState === "closed") {
      root.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
    }
  });
  const outside = (event: Event) => {
    if (
      !root.hidden &&
      !root.contains(event.target as Node) &&
      !slot.contains(event.target as Node)
    )
      close();
  };
  const escape = (event: KeyboardEvent) => {
    if (event.key === "Escape" && !root.hidden) {
      close();
      trigger.focus();
    }
  };
  doc.addEventListener("pointerdown", outside, true);
  doc.addEventListener("keydown", escape, true);
  updateSelection();
  return {
    dispose: () => {
      close();
      disposed = true;
      revision++;
      doc.removeEventListener("pointerdown", outside, true);
      doc.removeEventListener("keydown", escape, true);
      slot.remove();
      root.remove();
    },
    hasSelection: () => !disposed && selection.targets().length > 0,
    run: async (
      key: number,
      options: Pick<
        AnnotationReplyRunOptions,
        "signal" | "isActive" | "imageBudget"
      >,
      send: (packet: AnnotationReplyPacket) => Promise<unknown>,
    ): Promise<void> => {
      if (disposed) throw new Error("便签入口已关闭；未发送。");
      const runScopeKey = scopeKey;
      const targets = selection.targets();
      const preparedPages =
        previewKey === selectionKey() ? cachedPages : undefined;
      if (!targets.length)
        throw new Error("便签选择已变化；请重新选择后发送。");
      const scope = await deps.getScope();
      if (
        scope.conversationKey !== key ||
        scopeIdentity(scope) !== runScopeKey
      ) {
        if (!disposed && scopeKey === runScopeKey) {
          selection.clear();
          invalidatePreview();
          renderList();
        }
        throw new Error("对话或 PDF 已切换；请刷新并重新选择便签。");
      }
      try {
        await runAnnotationReplies(
          {
            ...options,
            selection: targets,
            conversationKey: key,
            preparedPages,
          },
          async (packet) => {
            if (!disposed && scopeKey === runScopeKey) {
              for (const target of targets) {
                if (selection.has(target))
                  selection.select(
                    {
                      target,
                      annotationID: target.annotationID,
                      label: target.comment,
                    },
                    false,
                  );
              }
              invalidatePreview();
              candidates = candidates.map((candidate) =>
                targets.some(
                  (target) =>
                    target.identity === candidate.target?.identity &&
                    target.version === candidate.target.version,
                )
                  ? {
                      ...candidate,
                      blocked: `inflight: ${packet.batchId}`,
                      batchStatus: "inflight",
                      batchId: packet.batchId,
                    }
                  : candidate,
              );
              renderList();
              setStatus("正在处理便签；派发后的未确认版本不会重发。");
            }
            return send(packet);
          },
        );
      } finally {
        if (!disposed && scopeKey === runScopeKey) {
          setStatus("便签运行已结束，正在读取保存状态。");
          void run(refresh);
        }
        if (!disposed) deps.onRepliesChanged?.();
      }
    },
  };
}
