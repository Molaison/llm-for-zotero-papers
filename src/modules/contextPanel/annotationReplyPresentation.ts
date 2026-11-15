import type {
  AnnotationReplyBatch,
  AnnotationReplyTarget,
} from "../../shared/types";
import {
  ANNOTATION_BATCH_MARKER,
  parseAnnotationReplies,
  navigateAnnotationReplySource,
  getAnnotationReplyBatch,
  type AnnotationReplyCandidate,
} from "../../services/pdf/annotationReplyService";
import { createElement } from "../../utils/domHelpers";

export function annotationStatusLabel(
  status?: AnnotationReplyBatch["status"],
): string {
  switch (status) {
    case "inflight":
      return "处理中";
    case "uncertain":
      return "结果待确认（不重发）";
    case "answered":
      return "待解析（未写回）";
    case "invalid":
      return "解析失败（未写回）";
    case "applied":
      return "已回答（不重发）";
    case "corrupt":
      return "记录损坏（保留占用）";
    case "retry-allowed":
      return "已允许重新选择（旧批次只读）";
    case "not-sent":
      return "未发送";
    default:
      return "新增";
  }
}

export const readableAnnotationComment = (text: string) =>
  text.replace(/<\/?(?:b|i|sub|sup)>/g, "");
export const annotationSourceLabel = (
  target: AnnotationReplyTarget,
  pageIndex = target.position.pageIndex,
) => `${target.title || "未命名 PDF"}，第 ${pageIndex + 1} 页`;
export function createAnnotationSourceButton(
  doc: Document,
  target: AnnotationReplyTarget,
  onMessage?: (message: string) => void,
  pageIndex = target.position.pageIndex,
): HTMLButtonElement {
  const button = createElement(doc, "button", "llm-annotation-source", {
    type: "button",
    textContent: annotationSourceLabel(target, pageIndex),
    title: "打开原 PDF 并定位便签来源",
  });
  let note: HTMLElement | undefined;
  const message = (text: string) => {
    if (onMessage) {
      onMessage(text);
      return;
    }
    if (!note) {
      note = createElement(doc, "span", "llm-annotation-source-message");
      note.setAttribute("role", "status");
      button.parentElement?.append(note);
    }
    note.textContent = text;
  };
  button.addEventListener("click", () => {
    void navigateAnnotationReplySource(target, pageIndex)
      .then((notice) => {
        if (notice) message(notice);
        else if (note) note.textContent = "";
      })
      .catch((error) => message(String(error)));
  });
  return button;
}
export function annotationSelectionSummary(
  targets: AnnotationReplyTarget[],
): string {
  if (!targets.length) return "未选批注";
  const attachments = new Set(targets.map((t) => t.attachmentID));
  const pages = [...new Set(targets.map((t) => t.position.pageIndex + 1))];
  return attachments.size > 1
    ? `已选 ${targets.length} 条批注，${attachments.size} 份 PDF`
    : `已选 ${targets.length} 条批注，第 ${pages.join("、")} 页`;
}

/** Focus is a reading choice, not a send selection. Only eligible versions survive refresh. */
export function createAnnotationDrawerSelection() {
  const selected = new Map<string, AnnotationReplyTarget>();
  let focused: number | undefined;
  return {
    targets: () => [...selected.values()],
    has: (target: AnnotationReplyTarget) =>
      selected.get(target.identity)?.version === target.version,
    focus: (annotationID: number) => {
      focused = annotationID;
    },
    focused: () => focused,
    clear: () => selected.clear(),
    select: (candidate: AnnotationReplyCandidate, checked: boolean) => {
      if (!candidate.target || candidate.blocked) return;
      if (checked) selected.set(candidate.target.identity, candidate.target);
      else selected.delete(candidate.target.identity);
    },
    reconcile: (
      candidates: AnnotationReplyCandidate[],
      scopeChanged: boolean,
    ) => {
      if (scopeChanged) {
        selected.clear();
        focused = undefined;
      }
      for (const [identity, target] of selected) {
        if (
          !candidates.some(
            (c) =>
              !c.blocked &&
              c.target?.identity === identity &&
              c.target.version === target.version,
          )
        )
          selected.delete(identity);
      }
      if (!candidates.some((c) => c.annotationID === focused))
        focused = candidates[0]?.annotationID;
    },
  };
}

export function annotationBatchPresentation(batch: AnnotationReplyBatch) {
  if (batch.rawAnswer === undefined)
    return {
      label: annotationStatusLabel(batch.status),
      applied: false,
      replies: [],
      error: batch.error,
    };
  try {
    const parsed = parseAnnotationReplies(batch, batch.rawAnswer);
    return {
      label: annotationStatusLabel(batch.status),
      applied: batch.status === "applied",
      replies: parsed.map((reply) => ({
        target: batch.targets.find((t) => t.identity === reply.identity)!,
        answer: reply.answer,
      })),
      error: batch.error,
    };
  } catch (error) {
    return {
      label: `${annotationStatusLabel(batch.status)}，无法展示结构化答案`,
      applied: false,
      replies: [],
      error: String(error),
    };
  }
}

export function appendAnnotationRawAnswer(
  host: HTMLElement,
  raw: string,
): void {
  const doc = host.ownerDocument;
  const details = createElement(doc, "details", "llm-annotation-raw");
  const summary = createElement(doc, "summary", undefined, {
    textContent: "原始 JSON",
    title: "原始 JSON",
  });
  const pre = createElement(doc, "pre", undefined, { textContent: raw });
  summary.setAttribute("aria-label", "原始 JSON");
  details.append(summary, pre);
  host.append(details);
}

function appendAnswerStatus(host: HTMLElement, label: string): HTMLElement {
  const status = createElement(
    host.ownerDocument,
    "span",
    "llm-annotation-state",
    { textContent: label, title: label },
  );
  status.setAttribute("aria-label", label);
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.tabIndex = 0;
  host.append(status);
  return status;
}

/** Text nodes only; strict protocol validation precedes readable answer projection. */
export function renderAnnotationBatchAnswers(
  host: HTMLElement,
  batch: AnnotationReplyBatch,
): void {
  const doc = host.ownerDocument;
  host.replaceChildren();
  host.classList.add("llm-annotation-answers");
  const view = annotationBatchPresentation(batch);
  const state = createElement(doc, "p", "llm-annotation-state", {
    textContent: view.applied ? "已写回批注" : view.label,
  });
  state.title = state.textContent || "";
  state.setAttribute("aria-label", state.title);
  state.setAttribute("role", "status");
  state.tabIndex = 0;
  state.dataset.state = view.applied ? "applied" : "pending";
  const controls = createElement(doc, "div", "llm-annotation-answer-controls");
  controls.append(state);
  for (const reply of view.replies) {
    const card = createElement(doc, "article", "llm-annotation-answer");
    card.dataset.annotationIdentity = reply.target.identity;
    const source = createAnnotationSourceButton(doc, reply.target);
    card.append(
      createElement(doc, "p", "llm-annotation-question", {
        textContent: readableAnnotationComment(reply.target.comment),
      }),
      source,
      createElement(doc, "p", "llm-annotation-answer-text", {
        textContent: reply.answer,
      }),
    );
    host.append(card);
  }
  if (!view.replies.length)
    for (const target of batch.targets)
      host.append(createAnnotationSourceButton(doc, target));
  if (view.error)
    host.append(
      createElement(doc, "p", "llm-annotation-error", {
        textContent: view.error,
      }),
    );
  if (batch.rawAnswer !== undefined)
    appendAnnotationRawAnswer(controls, batch.rawAnswer);
  host.append(controls);
}

export function annotationBatchIdFromTurn(text: string): string | undefined {
  const start = text.lastIndexOf(ANNOTATION_BATCH_MARKER);
  if (start < 0) return;
  const tail = text.slice(start + ANNOTATION_BATCH_MARKER.length);
  return /^([^\]\r\n]+)\]\s*$/.exec(tail)?.[1];
}

export function annotationUserTurnText(text: string): string {
  return annotationBatchIdFromTurn(text)
    ? text.slice(0, text.lastIndexOf(ANNOTATION_BATCH_MARKER)).trimEnd() +
        "\n批注问答"
    : text;
}

const answerRenders = new WeakMap<HTMLElement, object>();
/** Never parse streaming fragments or replace persisted message/rawAnswer bytes. */
export function renderAnnotationChatAnswer(
  host: HTMLElement,
  userText: string,
  answer: string,
  streaming: boolean,
  onRendered?: () => void,
): boolean {
  const id = annotationBatchIdFromTurn(userText);
  if (!id) return false;
  const token = {};
  answerRenders.set(host, token);
  host.replaceChildren();
  appendAnswerStatus(
    host,
    streaming ? "正在回答批注，完整答案验证后写回。" : "正在读取已存批注答案…",
  );
  if (streaming) return true;
  void getAnnotationReplyBatch(id)
    .then((batch) => {
      if (answerRenders.get(host) !== token) return;
      if (batch.rawAnswer === undefined || batch.rawAnswer !== answer) {
        host.replaceChildren();
        appendAnswerStatus(host, "答案尚未确认，请查看回答记录。");
        if (answer) appendAnnotationRawAnswer(host, answer);
      } else renderAnnotationBatchAnswers(host, batch);
      onRendered?.();
    })
    .catch((error) => {
      if (answerRenders.get(host) !== token) return;
      host.textContent = `批注批次读取失败：${String(error)}`;
      if (answer) appendAnnotationRawAnswer(host, answer);
      onRendered?.();
    });
  return true;
}
