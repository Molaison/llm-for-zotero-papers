import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as annotationService from "../src/services/pdf/annotationReplyService";
import * as annotationPresentation from "../src/modules/contextPanel/annotationReplyPresentation";
import * as domHelpers from "../src/utils/domHelpers";
import { assert } from "chai";
import { FakeElement, collectFakeText } from "./helpers/fakeDom";
import { installAnnotationReplyTestDB } from "./helpers/annotationReplyDb";
import {
  listAnnotationReplyCandidates,
  prepareAnnotationReplyBatch,
  completeAnnotationReplyBatch,
} from "../src/services/pdf/annotationReplyService";
import {
  loadAnnotationReplyBatch,
  saveAnnotationReplyBatch,
  getAnnotationReplyClaims,
} from "../src/utils/chatStore";
import {
  annotationBatchPresentation,
  annotationSelectionSummary,
  annotationStatusLabel,
  createAnnotationDrawerSelection,
  renderAnnotationBatchAnswers,
  renderAnnotationChatAnswer,
  annotationUserTurnText,
} from "../src/modules/contextPanel/annotationReplyPresentation";
import { createAnnotationReplyController, installAnnotationReplyLayout } from "../src/modules/contextPanel/setupHandlers/controllers/annotationReplyController";
import type { AnnotationReplyBatch } from "../src/shared/types";
import { renderAssistantRichText } from "../src/modules/contextPanel/assistantRichText";

class Node extends FakeElement {
  focus() {
    for (let n: FakeElement | null = this; n; n = n.parentElement) {
      assert.isFalse(!!(n as Node).hidden, "focus must not land in a hidden view");
      if (n.id === "llm-annotation-replies") {
        assert.isTrue(n.open, "focus must not land in closed details");
        assert.isFalse(n.dataset.view === "preview" && this.id === "llm-annotation-focus-preview", "preview action is CSS-hidden");
      }
    }
    (doc as any).activeElement = this;
  }

  click() { this.dispatchFakeEvent("click"); }
  checked = false;
  scrollTop = 0;
  clientTop = 0;
  getBoundingClientRect() { return {top: 0, height: 0}; }
  scrollIntoView() { throw new Error("Must not scroll an ancestor document"); }
  value = "";
  hidden = false;
  get ownerDocument() {
    return doc;
  }
  querySelector(selector: string): any {
    const data = selector.match(/^\[data-(annotation-id|page-annotation-id)="(\d+)"\]$/);
    if (data) return this.findAllByTag("button").find(n => n.dataset[data[1] === "annotation-id" ? "annotationId" : "pageAnnotationId"] === data[2]) || null;
    if (selector.startsWith("#"))
      return (
        this.findAllByTag("details")
          .concat(
            this.findAllByTag("div"),
            this.findAllByTag("span"),
            this.findAllByTag("section"),
            this.findAllByTag("p"),
            this.findAllByTag("button"),
            this.findAllByTag("select"),
          )
          .find((e) => e.id === selector.slice(1)) || null
      );
    return super.querySelector(selector);
  }
}
const doc = {
  defaultView: null,
  activeElement: null,
  createElementNS: (_ns: string, tag: string) => new Node(tag),
} as unknown as Document;
const host = () => new Node("div");
const element = (node: Node) => node as unknown as HTMLElement;
const pages = [
  {
    attachmentID: 1,
    pageIndex: 0,
    dataURL: "data:image/png;base64,AA==",
    context: "Native page context 70% to 85%.",
  },
];
const response = (batch: AnnotationReplyBatch) =>
  JSON.stringify({
    protocol: batch.protocol,
    batchId: batch.id,
    replies: batch.targets.map((t) => ({
      identity: t.identity,
      version: t.version,
      answer: "提高15个百分点。\n相对提高约21.4%。x < y & z > 0",
    })),
  });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("annotation research drawer presentation", () => {
  let env: ReturnType<typeof installAnnotationReplyTestDB>;
  beforeEach(() => {
    env = installAnnotationReplyTestDB();
    env.attachment(1);
    env.annotation(11, 1, "");
    env.annotation(12, 1, "解释 <i>提高</i> 的含义");
    env.annotation(13, 1, "独立验证是否支持结论？");
  });
  afterEach(() => env.restore());
  const prepare = async () =>
    prepareAnnotationReplyBatch(
      (await listAnnotationReplyCandidates([1])).map((c) => c.target!),
      7,
      pages,
    );

  it("keeps multi-selection separate from focused source, filters blocked versions on refresh", async () => {
    const candidates = await listAnnotationReplyCandidates([1]);
    const model = createAnnotationDrawerSelection();
    model.reconcile(candidates, true);
    model.select(candidates[0], true);
    model.select(candidates[1], true);
    model.focus(candidates[1].annotationID);
    assert.lengthOf(model.targets(), 2);
    assert.equal(model.focused(), 13);
    assert.include(
      annotationSelectionSummary(model.targets()),
      "已选 2 条批注，第 1 页",
    );
    const blocked = {
      ...candidates[0],
      blocked: "applied",
      batchStatus: "applied" as const,
    };
    model.select(blocked, false);
    assert.lengthOf(model.targets(), 2);
    model.reconcile([blocked, candidates[1]], false);
    assert.deepEqual(
      model.targets().map((t) => t.annotationID),
      [13],
    );
    model.reconcile(candidates, true);
    assert.lengthOf(model.targets(), 0);
  });

  it("maps every lifecycle explicitly without calling uncertain or answered a success", () => {
    assert.include(annotationStatusLabel(), "新增");
    assert.include(annotationStatusLabel("inflight"), "处理中");
    assert.include(annotationStatusLabel("uncertain"), "结果待确认");
    assert.include(annotationStatusLabel("answered"), "未写回");
    assert.include(annotationStatusLabel("invalid"), "解析失败");
    assert.include(annotationStatusLabel("applied"), "不重发");
  });

  it("keeps the real library/PDF/annotation identity when a source position is unavailable", async () => {
    env.items.get(12).annotationPosition = "{}";
    const candidate = (await listAnnotationReplyCandidates([1]))[0];
    assert.equal(candidate.identity, "1:PDF1:ANN12");
    assert.equal(candidate.pdfTitle, "PDF1");
    assert.isUndefined(candidate.target, "no page or coordinates are fabricated");
    assert.isString(candidate.blocked);
  });

  it("renders strict complete answers as text, keeps raw folded and never changes saved raw or claims", async () => {
    const batch = await prepare(),
      raw = response(batch);
    await completeAnnotationReplyBatch(batch.id, raw);
    const saved = await loadAnnotationReplyBatch(batch.id),
      claims = await getAnnotationReplyClaims(batch.targets[0].identity);
    const node = host();
    renderAnnotationBatchAnswers(element(node), saved);
    assert.lengthOf(node.findAllByClass("llm-annotation-answer"), 2);
    assert.include(collectFakeText(node), "提高15个百分点");
    assert.include(collectFakeText(node), "x < y & z > 0");
    assert.equal(node.findByClass("llm-annotation-state")!.title, "已写回批注");
    const state = node.findByClass("llm-annotation-state")!;
    const controls = node.findByClass("llm-annotation-answer-controls")!;
    assert.equal(node.children.indexOf(controls), 2, "compact controls follow both answers");
    assert.strictEqual(state.parentElement, controls);
    const rawDetails = node.findByClass("llm-annotation-raw")!;
    assert.strictEqual(rawDetails.parentElement, controls, "state and raw disclosure share one action row");
    assert.equal(rawDetails.findAllByTag("pre")[0].textContent, raw, "raw bytes are unchanged");
    assert.equal(rawDetails.children[0].getAttribute("aria-label"), "原始 JSON");
    assert.isFalse(node.findAllByClass("llm-annotation-raw")[0].open);
    const sources = node.findAllByClass("llm-annotation-answer-source");
    assert.lengthOf(sources, 2);
    assert.isFalse(sources[0].open);
    assert.include(collectFakeText(sources[0]), batch.targets[0].identity);
    assert.notInclude(sources[0].children[0].textContent, batch.targets[0].identity);
    assert.equal((await loadAnnotationReplyBatch(batch.id)).rawAnswer, raw);
    assert.deepEqual(
      await getAnnotationReplyClaims(batch.targets[0].identity),
      claims,
    );
    assert.equal(env.saves(), 2);
  });

  it("reveals annotation status labels on icon focus and owning row focus without permanent copy", async () => {
    const batch = await prepare();
    for (const status of ["answered", "uncertain"] as const) {
      batch.status = status;
      const node = host();
      renderAnnotationBatchAnswers(element(node), batch);
      const state = node.findByClass("llm-annotation-state")!;
      assert.equal((state as unknown as HTMLElement).tabIndex, 0);
      assert.equal(state.getAttribute("aria-label"), annotationStatusLabel(status));
      assert.equal(state.textContent, "!", "only the icon is permanent");
    }
    const streaming = host();
    renderAnnotationChatAnswer(element(streaming), `[Zotero annotation batch: ${batch.id}]`, "", true);
    const liveState = streaming.findByClass("llm-annotation-state")!;
    assert.equal((liveState as unknown as HTMLElement).tabIndex, 0);
    assert.include(liveState.getAttribute("aria-label"), "完整答案验证后");
    assert.equal(liveState.getAttribute("aria-live"), "polite");
    const css = readFileSync("addon/content/zoteroPane.css", "utf8");
    const tooltip = /\.llm-annotation-state::after\s*\{([^}]+)\}/.exec(css)![1];
    assert.include(tooltip, "content: attr(aria-label)");
    assert.include(tooltip, "display: none");
    const reveal = /([^{}]+)\{\s*display: block;\s*\}/g;
    const selectors = [...css.matchAll(reveal)].find(m => m[1].includes(".llm-annotation-state:focus::after"))![1];
    for (const selector of [
      ".llm-annotation-state:hover::after",
      ".llm-annotation-state:focus::after",
      ".llm-annotation-row-focus:hover > .llm-annotation-state::after",
      ".llm-annotation-row-focus:focus > .llm-annotation-state::after",
    ]) assert.include(selectors, selector);
  });

  for (const invalid of ["unknown", "version", "duplicate", "partial"])
    it(`does not project ${invalid} JSON as valid answers even if a record says applied`, async () => {
      const batch = await prepare();
      const data = JSON.parse(response(batch));
      if (invalid === "unknown") data.replies[0].identity = "other";
      if (invalid === "version") data.replies[0].version = "old";
      if (invalid === "duplicate") data.replies[1] = data.replies[0];
      batch.rawAnswer =
        invalid === "partial"
          ? response(batch).slice(0, -5)
          : JSON.stringify(data);
      batch.status = "applied";
      const view = annotationBatchPresentation(batch);
      assert.isFalse(view.applied);
      assert.lengthOf(view.replies, 0);
      const node = host();
      renderAnnotationBatchAnswers(element(node), batch);
      assert.lengthOf(node.findAllByClass("llm-annotation-answer"), 0);
      assert.include(node.findByClass("llm-annotation-state")!.title, "解析失败");
      assert.equal(env.saves(), 0);
    });

  it("renders historical paired chat answers readably, suppresses fragments, and leaves ordinary chat alone", async () => {
    const batch = await prepare(),
      raw = response(batch),
      user = `解释这些批注\n[Zotero annotation batch: ${batch.id}]`;
    const streaming = host();
    assert.isTrue(
      renderAnnotationChatAnswer(
        element(streaming),
        user,
        raw.slice(0, 50),
        true,
      ),
    );
    assert.include(streaming.findByClass("llm-annotation-state")!.title, "完整答案验证后");
    assert.notInclude(streaming.textContent, "protocol");
    await completeAnnotationReplyBatch(batch.id, raw);
    const oldMessage = host();
    renderAssistantRichText({
      body: element(host()), panelItem: env.items.get(1),
      bubble: element(oldMessage) as HTMLDivElement,
      assistantMessage: {role: "assistant", text: raw, timestamp: 1},
      pairedUserMessage: {role: "user", text: user, timestamp: 0},
    });
    await tick();
    assert.lengthOf(oldMessage.findAllByClass("llm-annotation-answer"), 2);
    assert.isFalse(
      renderAnnotationChatAnswer(
        element(host()),
        "ordinary question",
        raw,
        false,
      ),
    );
    assert.notInclude(annotationUserTurnText(user), batch.id);
    assert.include(annotationUserTurnText(user), "解释这些批注");
    assert.equal(env.saves(), 2);
  });

  it("never labels uncertain/raw-mismatched chat as written back", async () => {
    const batch = await prepare();
    batch.status = "uncertain";
    batch.rawAnswer = response(batch);
    await saveAnnotationReplyBatch(batch);
    const user = `[Zotero annotation batch: ${batch.id}]`;
    const node = host();
    renderAnnotationChatAnswer(element(node), user, batch.rawAnswer, false);
    await tick();
    assert.include(node.findByClass("llm-annotation-state")!.title, "结果待确认");
    assert.notInclude(collectFakeText(node), "已写回批注");
    const mismatch = host();
    renderAnnotationChatAnswer(
      element(mismatch),
      user,
      batch.rawAnswer + "changed",
      false,
    );
    await tick();
    assert.lengthOf(mismatch.findAllByClass("llm-annotation-answer"), 0);
    assert.include(mismatch.findByClass("llm-annotation-state")!.title, "尚未确认");
  });

  it("actual controller wires disabled checkboxes, independent focus, an inline context trigger and saved history", async () => {
    const first = (await listAnnotationReplyCandidates([1]))[0].target!;
    const batch = await prepareAnnotationReplyBatch([first], 7, pages);
    await completeAnnotationReplyBatch(batch.id, response(batch));
    env.annotation(14, 1, "第三条未发送问题");
    const body = host(),
      previews = host(),
      compose = host(),
      actions = host();
    previews.id = "llm-context-previews";
    actions.className = "llm-actions-left";
    compose.id = "llm-compose-area";
    compose.append(previews, actions);
    const section = host(); section.className = "llm-input-section";
    const workspace = host(); workspace.id = "llm-reading-workspace";
    const chat = host(); chat.id = "llm-chat-shell"; workspace.append(chat);
    section.append(compose); body.append(workspace, section);
    const controller = createAnnotationReplyController({
      body: element(body),
      getScope: async () => ({ attachmentIDs: [1], conversationKey: 7 }),
    });
    await controller.settled();
    const drawer = body.querySelector("#llm-annotation-replies") as Node;
    assert.strictEqual(drawer.parentElement, workspace);
    assert.strictEqual(workspace.nextSibling, section);
    assert.notInclude(compose.children, drawer);
    assert.isFalse(drawer.open);
    const opener = body.querySelector("#llm-annotation-toggle") as Node;
    assert.equal(opener.tagName.toLowerCase(), "button");
    assert.equal(opener.type, "button", "native Space/Enter activate the button without submitting");
    assert.equal(opener.getAttribute("aria-controls"), drawer.id);
    assert.equal(opener.getAttribute("aria-expanded"), "false");
    assert.equal(opener.getAttribute("aria-label"), "批注");
    assert.isTrue(opener.classList.contains("llm-toolbar-icon"));
    const hiddenSummary = drawer.findByClass("llm-annotation-summary") as Node;
    assert.isTrue(hiddenSummary.hidden);
    assert.equal((hiddenSummary as any).tabIndex, -1);
    opener.dispatchFakeEvent("click");
    assert.isTrue(drawer.open);
    assert.isTrue(chat.hidden);
    assert.equal(workspace.dataset.view, "annotations");
    assert.equal(opener.getAttribute("aria-expanded"), "true");
    drawer.dispatchFakeEvent("toggle");
    await controller.settled();
    drawer.open = false; drawer.dispatchFakeEvent("toggle");
    assert.equal(opener.getAttribute("aria-expanded"), "false", "external root.open/toggle stays synchronized");
    assert.isFalse(chat.hidden);
    assert.equal(workspace.dataset.view, "reading");
    const checks = drawer.findAllByTag("input") as Node[];
    assert.lengthOf(checks, 3, "pure highlight absent");
    assert.isTrue(checks[0].disabled);
    assert.isFalse(checks[1].disabled);
    checks[1].checked = true;
    checks[1].dispatchFakeEvent("change");
    checks[2].checked = true;
    checks[2].dispatchFakeEvent("change");
    assert.isTrue(controller.hasSelection());
    const summary = body.querySelector(
      "#llm-annotation-selection-summary",
    ) as Node;
    assert.equal(summary.textContent, "2");
    const trigger = body.querySelector("#llm-annotation-toggle") as Node;
    assert.strictEqual(summary.parentElement, trigger);
    assert.strictEqual(trigger.parentElement, actions);
    assert.include(trigger.title, "ANN13");
    assert.include(trigger.title, "ANN14");
    const focuses = drawer.findAllByClass("llm-annotation-row-focus");
    const rowState = focuses[0].findByClass("llm-annotation-state")!;
    assert.strictEqual(rowState.parentElement, focuses[0]);
    assert.equal(rowState.getAttribute("aria-label"), "已回答（不重发）");
    focuses[0].dispatchFakeEvent("click");
    assert.isTrue(checks[1].checked);
    assert.isTrue(checks[2].checked);
    assert.isTrue(controller.hasSelection());
    assert.include(
      collectFakeText(body.querySelector("#llm-annotation-focus")),
      "source quote",
    );
    assert.lengthOf(
      drawer.findAllByTag("img"),
      1,
      "single focused native page only",
    );
    assert.lengthOf(drawer.findAllByClass("llm-annotation-answer"), 1);
    assert.isFalse(drawer.findAllByClass("llm-annotation-raw")[0].open);
    const filter = body.querySelector("#llm-annotation-filter") as Node;
    filter.value = "blocked";
    filter.dispatchFakeEvent("change");
    assert.isTrue(controller.hasSelection());
    assert.equal(summary.textContent, "2");
    controller.dispose();
    assert.isNull(body.querySelector("#llm-annotation-selection-summary"));
    assert.isNull(body.querySelector("#llm-annotation-toggle"));
  });
  function annotationLayoutHarness(withNativeSection: boolean) {
    const viewport = new Node("div"), nativeSection = new Node("collapsible-section");
    const nativeHead = new Node("div"), panel = new Node("div"), root = new Node("details");
    viewport.className = "zotero-view-item";
    nativeHead.className = "head";
    panel.className = "llm-panel";
    if (withNativeSection) {
      nativeSection.append(nativeHead, panel);
      viewport.append(nativeSection);
      const inheritedClosest = panel.closest.bind(panel);
      panel.closest = ((selector: string) =>
        selector === "collapsible-section"
          ? nativeSection
          : inheritedClosest(selector)) as typeof panel.closest;
    } else {
      viewport.append(panel);
    }
    panel.append(root);
    Object.defineProperty(root, "isConnected", {configurable:true, get:() => true});
    let viewportRect = withNativeSection
      ? {top:489, bottom:600, width:800, height:111}
      : {top:200, bottom:1152, width:800, height:952};
    let nativeRect = {top:542.616, bottom:595.616, width:304, height:53};
    let panelRect = withNativeSection
      ? {top:572.616, bottom:591.616, width:304, height:19}
      : {top:1326, bottom:1326, width:800, height:0};
    viewport.getBoundingClientRect = () => viewportRect;
    nativeSection.getBoundingClientRect = () => nativeRect;
    panel.getBoundingClientRect = () => panelRect;
    const styles = new Map<string,string>();
    panel.style = {setProperty:(name:string,value:string) => styles.set(name,value),
      removeProperty:(name:string) => styles.delete(name)} as unknown as CSSStyleDeclaration;
    const frames = new Map<number,FrameRequestCallback>();
    let nextFrame = 1, observerCallback: (() => void) | null = null;
    let disconnectCount = 0;
    const observedNodes: Node[] = [];
    class TestResizeObserver {
      constructor(callback: () => void) { observerCallback = callback; }
      observe(node: Node) { observedNodes.push(node); }
      disconnect() { disconnectCount++; }
    }
    let innerHeight = withNativeSection ? 600 : 1152;
    const originalView = (doc as unknown as {defaultView: Window | null}).defaultView;
    (doc as unknown as {defaultView: Window}).defaultView = {
      get innerHeight() { return innerHeight; },
      innerWidth:1200,
      ResizeObserver:TestResizeObserver,
      getComputedStyle(node: Element) {
        assert.strictEqual(node, nativeSection);
        return {paddingBottom:"4px"} as CSSStyleDeclaration;
      },
      requestAnimationFrame(callback:FrameRequestCallback) {
        const id = nextFrame++; frames.set(id,callback); return id;
      },
      cancelAnimationFrame(id:number) { frames.delete(id); },
      addEventListener() {}, removeEventListener() {},
    } as unknown as Window;
    const flushFrame = () => {
      const callbacks = Array.from(frames.values()); frames.clear();
      for (const callback of callbacks) callback(performance.now());
    };
    const dispose = installAnnotationReplyLayout(root as unknown as HTMLDetailsElement);
    return {
      viewport, nativeSection, nativeHead, panel, root, styles, observedNodes,
      disconnectCount: () => disconnectCount,
      setViewportRect: (rect: typeof viewportRect) => { viewportRect = rect; },
      moveNativeContent: (delta: number) => {
        nativeRect = {...nativeRect, top:nativeRect.top + delta, bottom:nativeRect.bottom + delta};
        panelRect = {...panelRect, top:panelRect.top + delta, bottom:panelRect.bottom + delta};
      },
      setPanelTop: (top: number) => { panelRect = {...panelRect, top, bottom:top + panelRect.height}; },
      setInnerHeight: (value: number) => { innerHeight = value; },
      resize: () => observerCallback!(),
      flush: flushFrame,
      dispose,
      restoreWindow: () => {
        (doc as unknown as {defaultView: Window | null}).defaultView = originalView;
      },
    };
  }

  it("keeps a stable viewport budget across native panel scroll and preserves it when the viewport is invalid", () => {
    const h = annotationLayoutHarness(true);
    try {
      assert.equal(h.styles.get("--llm-workspace-height"), "69px",
        "partial panel uses the complete viewport minus stable native chrome");
      assert.sameMembers(h.observedNodes, [h.viewport, h.panel, h.nativeSection, h.nativeHead],
        "native section and head join the viewport and panel observations");
      h.moveNativeContent(-40);
      h.resize(); h.flush();
      assert.equal(h.styles.get("--llm-workspace-height"), "69px",
        "scrolling changes panel top but keeps the same viewport budget");
      h.setViewportRect({top:489, bottom:600, width:0, height:111});
      h.resize(); h.flush();
      assert.equal(h.styles.get("--llm-workspace-height"), "69px",
        "a hidden viewport retains the last positive height");
      h.setViewportRect({top:NaN, bottom:NaN, width:800, height:NaN});
      h.resize(); h.flush();
      assert.equal(h.styles.get("--llm-workspace-height"), "69px",
        "invalid viewport geometry retains the last positive height");
    } finally {
      h.dispose();
      h.restoreWindow();
    }
    assert.equal(h.disconnectCount(), 1);
    assert.isFalse(h.styles.has("--llm-workspace-height"));
    assert.isNull(h.root.getAttribute("data-reading-workspace"));
  });

  it("uses the whole viewport budget when Independent has no native collapsible chrome", () => {
    const h = annotationLayoutHarness(false);
    try {
      assert.equal(h.styles.get("--llm-workspace-height"), "944px",
        "panel below the native viewport receives the complete viewport budget");
      h.setPanelTop(700);
      h.resize(); h.flush();
      assert.equal(h.styles.get("--llm-workspace-height"), "944px",
        "Independent panel position does not reduce the stable viewport budget");
      assert.sameMembers(h.observedNodes, [h.viewport, h.panel],
        "without a native section only the viewport and panel are observed");
    } finally {
      h.dispose();
      h.restoreWindow();
    }
  });
  it("keeps one workspace view while bulk selection, source, history and Escape preserve the composer", async () => {
    const body = host(), workspace = host(), chat = host(), compose = host(), actions = host();
    workspace.id = "llm-reading-workspace"; chat.id = "llm-chat-shell";
    actions.className = "llm-actions-left"; compose.id = "llm-compose-area";
    workspace.append(chat); compose.append(actions); body.append(workspace, compose);
    const controller = createAnnotationReplyController({body:element(body),getScope:async()=>({attachmentIDs:[1],conversationKey:7})});
    await controller.settled();
    const root = body.querySelector("#llm-annotation-replies") as Node;
    body.querySelector("#llm-annotation-toggle")!.dispatchFakeEvent("click");
    assert.isTrue(chat.hidden);
    const count = root.findByClass("llm-annotation-count") as Node;
    assert.isFalse(count.hidden);
    assert.equal(count.textContent,"2");
    const headerActions = root.findByClass("llm-annotation-header-actions")!;
    for (const id of ["llm-annotation-records","llm-annotation-refresh","llm-annotation-close"])
      assert.strictEqual(body.querySelector(`#${id}`)!.parentElement,headerActions);
    body.querySelector("#llm-annotation-select-pending")!.dispatchFakeEvent("click"); await tick();
    assert.equal(root.findAllByTag("input").filter(c=>(c as Node).checked).length,2);
    const origin = root.findAllByClass("llm-annotation-row-focus")[1] as Node;
    origin.focus(); origin.dispatchFakeEvent("click");
    assert.strictEqual(doc.activeElement, root.findByClass("llm-annotation-view-title"));
    body.querySelector("#llm-annotation-back")!.dispatchFakeEvent("click");
    assert.strictEqual(doc.activeElement, origin, "back restores the row entry");
    origin.dispatchFakeEvent("click");
    assert.equal(root.dataset.view,"source");
    assert.isTrue(count.hidden);
    assert.isNull(root.findByClass("llm-annotation-detail-label"));
    const status = body.querySelector("#llm-annotation-status") as Node;
    status.dataset.kind = "info"; status.textContent = "旧视图提示";
    assert.isTrue(root.findByClass("llm-annotation-list-view")!.hidden);
    body.querySelector("#llm-annotation-records")!.dispatchFakeEvent("click");
    assert.equal(root.dataset.view,"history");
    assert.isTrue(count.hidden);
    assert.equal(status.textContent, "", "old informational notices do not leak across views");
    status.dataset.kind = "error"; status.textContent = "Native reader unavailable";
    assert.strictEqual(doc.activeElement, root.findByClass("llm-annotation-view-title"));
    assert.isTrue((body.querySelector("#llm-annotation-focus") as Node).hidden);
    const escape = root.dispatchFakeEvent("keydown", {key:"Escape"});
    assert.isTrue(escape.propagationStopped);
    assert.equal(root.dataset.view,"list");
    assert.isFalse(count.hidden);
    assert.equal(status.textContent,"Native reader unavailable", "navigation does not hide genuine failures");
    assert.strictEqual(doc.activeElement, body.querySelector("#llm-annotation-records"));
    assert.isTrue(controller.hasSelection());
    body.querySelector("#llm-annotation-clear-selection")!.dispatchFakeEvent("click"); await tick();
    assert.isFalse(controller.hasSelection());
    root.dispatchFakeEvent("keydown", {key:"Escape"});
    assert.isFalse(root.open); assert.isFalse(chat.hidden);
    assert.strictEqual(compose.parentElement,body);
    const css = readFileSync("addon/content/zoteroPane.css","utf8");
    assert.match(css,/\.llm-annotation-header-actions[^}]+margin-inline-start: auto/);
    assert.notMatch(css,/#llm-annotation-records\s*\{[^}]+margin-inline-start/);
    assert.match(css,/\.llm-annotation-drawer \.llm-annotation-status[^}]+padding: 0 22px 8px/);
    controller.dispose();
  });

  it("disables empty preview, keeps comment first and exposes local busy/error without claiming", async () => {
    const body = host(), previews = host(), compose = host(), actions = host();
    previews.id = "llm-context-previews";
    actions.className = "llm-actions-left";
    compose.append(actions); body.append(previews, compose);
    const controller = createAnnotationReplyController({
      body: element(body), getScope: async () => ({attachmentIDs: [1], conversationKey: 7}),
    });
    const preview = body.querySelector("#llm-annotation-preview") as Node;
    assert.isTrue(preview.disabled);
    assert.include(preview.title, "先勾选");
    await controller.settled();
    const drawer = body.querySelector("#llm-annotation-replies") as Node;
    const focus = drawer.findAllByClass("llm-annotation-row-focus")[0];
    assert.isTrue(focus.children[0].classList.contains("llm-annotation-row-comment"));
    assert.notInclude(focus.children[1].textContent, "1:PDF1:ANN12");
    assert.equal(focus.title, "1:PDF1:ANN12");
    assert.include(focus.children[2].getAttribute("aria-label"), "新增");
    const check = drawer.findAllByTag("input")[0] as Node;
    check.checked = true; check.dispatchFakeEvent("change");
    assert.isFalse(preview.disabled);
    let readerEntered!: () => void;
    const entered = new Promise<void>(resolve => { readerEntered = resolve; });
    (Zotero as any).Reader = { _readers: [], open: async () => {
      readerEntered(); throw new Error("Native reader unavailable");
    }};
    preview.dispatchFakeEvent("click");
    assert.isTrue(preview.disabled);
    assert.equal(preview.getAttribute("aria-busy"), "true");
    assert.equal(preview.textContent, "处理中…");
    await entered; // Wait for version hashing before the native-reader failure.
    await tick();
    const status = body.querySelector("#llm-annotation-status") as Node;
    assert.equal(status.dataset.kind, "error");
    assert.isNotEmpty(status.textContent);
    assert.equal(status.getAttribute("aria-live"), "polite");
    assert.isFalse(preview.disabled);
    assert.isNull(preview.getAttribute("aria-busy"));
    assert.equal(preview.textContent, "预览所选页面");
    assert.isTrue(controller.hasSelection());
    assert.lengthOf(await getAnnotationReplyClaims("1:PDF1:ANN12"), 0);
    check.checked = false; check.dispatchFakeEvent("change");
    assert.isTrue(preview.disabled);
    controller.dispose();
  });

  it("switches the active source view without changing selection or scrolling the composer", async () => {
    const body = host(), previews = host(), compose = host(), actions = host();
    previews.id = "llm-context-previews"; actions.className = "llm-actions-left";
    compose.append(actions); body.append(previews, compose);
    body.scrollTop = 31; compose.scrollTop = 17;
    const controller = createAnnotationReplyController({body:element(body),getScope:async()=>({attachmentIDs:[1],conversationKey:7})});
    await controller.settled();
    const drawer = body.querySelector("#llm-annotation-replies") as Node;
    const detail = body.querySelector("#llm-annotation-focus") as Node;
    const summary = drawer.findByClass("llm-annotation-summary") as Node;
    const list = body.querySelector("#llm-annotation-list") as Node;
    drawer.open = true; drawer.clientTop = 1;
    drawer.getBoundingClientRect = () => ({top:600, height:360});
    summary.getBoundingClientRect = () => ({top:601, height:32});
    detail.getBoundingClientRect = () => ({top:1028-drawer.scrollTop, height:440});
    list.scrollTop = 29;
    const checks = drawer.findAllByTag("input") as Node[];
    checks[0].checked = true; checks[0].dispatchFakeEvent("change");
    checks[1].checked = true; checks[1].dispatchFakeEvent("change");
    assert.equal(drawer.scrollTop,0,"checkbox changes do not reveal");
    const selected = body.querySelector("#llm-annotation-selection-summary")!.textContent;
    drawer.findAllByClass("llm-annotation-row-focus")[1].dispatchFakeEvent("click");
    assert.equal(drawer.dataset.view,"source");
    assert.equal(detail.scrollTop,0);
    assert.equal(drawer.scrollTop,0,"the workspace has no scroll stacking");
    assert.equal(body.scrollTop,31); assert.equal(compose.scrollTop,17); assert.equal(list.scrollTop,29);
    assert.equal(body.querySelector("#llm-annotation-selection-summary")!.textContent,selected);
    assert.isTrue(checks[0].checked); assert.isTrue(checks[1].checked);
    await controller.settled();
    assert.equal(drawer.scrollTop,0,"refresh must not steal scroll");
    const refreshedChecks = drawer.findAllByTag("input") as Node[];
    refreshedChecks[1].checked = false; refreshedChecks[1].dispatchFakeEvent("change");
    assert.equal(drawer.scrollTop,0,"deselect must not steal scroll");
    drawer.open = false;
    drawer.findAllByClass("llm-annotation-row-focus")[0].dispatchFakeEvent("click");
    assert.equal(drawer.scrollTop,0,"a closed workspace is never scrolled by a late result");
    assert.isTrue(controller.hasSelection());
    controller.dispose();
  });

  it("reveals page anchors for explicit previews but keeps row focus at the source header", async () => {
    const first = (await listAnnotationReplyCandidates([1]))[0].target!;
    const batch = await prepareAnnotationReplyBatch([first], 7, pages);
    env.annotation(14, 1, "另一个未发送问题");
    // Execute the production controller; isolate only native PNG rendering.
    const compiled = ts.transpileModule(readFileSync("src/modules/contextPanel/setupHandlers/controllers/annotationReplyController.ts", "utf8"),
      {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText;
    const exports = {} as {createAnnotationReplyController: typeof createAnnotationReplyController};
    let renders = 0;
    runInNewContext(compiled, {exports, require: (name: string) => {
      if (name.endsWith("domHelpers")) return domHelpers;
      if (name.endsWith("annotationReplyPresentation")) return annotationPresentation;
      if (name.endsWith("annotationReplyService")) return {...annotationService,
        renderAnnotationReplyPages: async () => { renders++; return pages; }};
      throw new Error(`Unexpected controller dependency ${name}`);
    }});
    const body = host(), previews = host(), compose = host(), actions = host();
    previews.id = "llm-context-previews"; actions.className = "llm-actions-left";
    compose.append(actions); body.append(previews, compose);
    body.scrollTop = 31; compose.scrollTop = 17;
    const controller = exports.createAnnotationReplyController({body:element(body), getScope:async()=>({attachmentIDs:[1],conversationKey:7})});
    await controller.settled();
    const drawer = body.querySelector("#llm-annotation-replies") as Node;
    drawer.open = true; drawer.clientTop = 1;
    drawer.getBoundingClientRect = () => ({top:600, height:360});
    const originalBounds = Node.prototype.getBoundingClientRect;
    Node.prototype.getBoundingClientRect = function () {
      if (this.classList.contains("llm-annotation-summary")) return {top:601,height:32};
      const top = this.id === "llm-annotation-images" ? 1310
        : this.classList.contains("llm-annotation-history-image") ? 1400 : 1028;
      return {top:top-drawer.scrollTop,height:440};
    };
    try {
      for (const check of drawer.findAllByTag("input") as Node[]) {
        if (!check.disabled) {check.checked = true; check.dispatchFakeEvent("change");}
      }
      const selected = body.querySelector("#llm-annotation-selection-summary")!.textContent;
      drawer.findAllByClass("llm-annotation-row-focus")[1].dispatchFakeEvent("click");
      assert.equal(drawer.dataset.view,"source","row viewing opens source, never changes selection");
      body.querySelector("#llm-annotation-focus-preview")!.dispatchFakeEvent("click");
      await tick();
      assert.equal(drawer.dataset.view,"preview","explicit preview switches the one viewport to the page");
      drawer.scrollTop = 0;
      body.querySelector("#llm-annotation-preview")!.dispatchFakeEvent("click");
      await tick();
      assert.equal(drawer.dataset.view,"preview","selected preview uses the same page view");
      assert.equal(renders,2);
      body.querySelector(`#llm-annotation-preview-${batch.id}`)!.dispatchFakeEvent("click");
      await tick();
      assert.equal(drawer.dataset.view,"preview","saved preview uses the same viewport");
      assert.equal(body.querySelector("#llm-annotation-selection-summary")!.textContent,selected);
      assert.equal(drawer.findAllByTag("input").filter(n=>(n as Node).checked).length,2);
      assert.equal(body.scrollTop,31); assert.equal(compose.scrollTop,17);
      assert.isTrue(controller.hasSelection());
    } finally {
      Node.prototype.getBoundingClientRect = originalBounds;
      controller.dispose();
    }
  });

  it("caches late previews without stealing navigation and preserves saved historical quotes", async () => {
    const first = (await listAnnotationReplyCandidates([1]))[0].target!;
    const batch = await prepareAnnotationReplyBatch([first], 7, pages);
    const originalQuote = batch.targets[0].quotedText;
    env.items.get(12).annotationText = "Edited current quote";
    const compiled = ts.transpileModule(readFileSync("src/modules/contextPanel/setupHandlers/controllers/annotationReplyController.ts", "utf8"),
      {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText;
    let finish!: (value: typeof pages) => void;
    const exports = {} as {createAnnotationReplyController: typeof createAnnotationReplyController};
    runInNewContext(compiled, {exports, Zotero: {Reader: {open: async () => {throw new Error("Location unavailable");}}}, require: (name: string) => {
      if (name.endsWith("domHelpers")) return domHelpers;
      if (name.endsWith("annotationReplyPresentation")) return annotationPresentation;
      if (name.endsWith("annotationReplyService")) return {...annotationService,
        renderAnnotationReplyPages: () => new Promise(resolve => {finish = resolve;})};
      throw new Error(name);
    }});
    const body = host(), actions = host(); actions.className = "llm-actions-left"; body.append(actions);
    const controller = exports.createAnnotationReplyController({body:element(body),getScope:async()=>({attachmentIDs:[1],conversationKey:7})});
    await controller.settled();
    const root = body.querySelector("#llm-annotation-replies") as Node;
    root.open = true;
    root.findAllByClass("llm-annotation-row-focus")[1].dispatchFakeEvent("click");
    const preview = body.querySelector("#llm-annotation-focus-preview") as Node;
    preview.focus(); preview.click();
    body.querySelector("#llm-annotation-locate")!.click(); await tick();
    const failureText = body.querySelector("#llm-annotation-status")!.textContent;
    assert.include(failureText,"Location unavailable");
    body.querySelector("#llm-annotation-back")!.click();
    const listFocus = doc.activeElement;
    finish(pages); await tick();
    assert.equal(root.dataset.view,"list"); assert.strictEqual(doc.activeElement,listFocus);
    assert.equal(body.querySelector("#llm-annotation-status")!.textContent,failureText, "late success cannot clear a newer failure");
    root.findAllByClass("llm-annotation-row-focus")[1].dispatchFakeEvent("click");
    const nextPreview = body.querySelector("#llm-annotation-focus-preview") as Node;
    nextPreview.focus(); nextPreview.click(); finish(pages); await tick();
    assert.equal(root.dataset.view,"preview");
    assert.equal(body.querySelector("#llm-annotation-status")!.textContent,"", "preview success adds no extra status row");
    assert.strictEqual(doc.activeElement,root.findByClass("llm-annotation-view-title"));
    body.querySelector("#llm-annotation-back")!.click();
    assert.equal((doc.activeElement as HTMLElement).id,"llm-annotation-focus-preview");
    body.querySelector("#llm-annotation-back")!.click();
    const checks = root.findAllByTag("input") as Node[];
    checks[1].checked = true; checks[1].dispatchFakeEvent("change");
    const selectedPreview = body.querySelector("#llm-annotation-preview") as Node;
    selectedPreview.focus(); selectedPreview.click();
    body.querySelector("#llm-annotation-records")!.click();
    const historyFocus = doc.activeElement;
    finish(pages); await tick();
    assert.equal(root.dataset.view,"history"); assert.strictEqual(doc.activeElement,historyFocus);
    assert.isTrue(controller.hasSelection());
    const historyOrigin = body.querySelector(`#llm-annotation-preview-${batch.id}`) as Node;
    historyOrigin.focus(); historyOrigin.click(); await tick();
    const source = root.findByClass("llm-annotation-saved-source")!;
    assert.include(collectFakeText(source),originalQuote);
    assert.notInclude(collectFakeText(source),"Edited current quote");
    assert.isNull(source.findByClass("llm-annotation-quote"), "saved quote is not hidden by current-source preview CSS");
    assert.equal(root.dataset.view,"preview");
    assert.strictEqual(doc.activeElement,root.findByClass("llm-annotation-view-title"));
    body.querySelector("#llm-annotation-back")!.click();
    assert.strictEqual(doc.activeElement,historyOrigin);
    controller.dispose();
  });

});
