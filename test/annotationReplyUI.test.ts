import {
  prepareAnnotationReplyFixture,
  completeAnnotationReplyFixture,
} from "./helpers/annotationReplyDb";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as annotationService from "../src/services/pdf/annotationReplyService";
import * as annotationPresentation from "../src/modules/contextPanel/annotationReplyPresentation";
import * as domHelpers from "../src/utils/domHelpers";
import { assert } from "chai";
import { FakeElement, collectFakeText } from "./helpers/fakeDom";
import { installAnnotationReplyTestDB } from "./helpers/annotationReplyDb";
import { createAnnotationReplyController } from "../src/modules/contextPanel/setupHandlers/controllers/annotationReplyController";
import {
  annotationStatusLabel,
  annotationBatchPresentation,
  createAnnotationDrawerSelection,
  annotationUserTurnText,
  renderAnnotationChatAnswer,
  renderAnnotationBatchAnswers,
} from "../src/modules/contextPanel/annotationReplyPresentation";
import {
  listAnnotationReplyCandidates,
  runAnnotationReplies,
} from "../src/services/pdf/annotationReplyService";
import { loadAnnotationReplyBatch } from "../src/utils/annotationReplyStore";

class Node extends FakeElement {
  hidden = false;
  checked = false;
  get ownerDocument() {
    return doc as unknown as Document;
  }
  getBoundingClientRect() {
    return { left: 100, top: 600 };
  }
  focus() {}
}
const docEvents = new FakeElement("document");
const doc = {
  defaultView: { innerWidth: 900, innerHeight: 800 },
  createElementNS: (_ns: string, tag: string) => new Node(tag),
  addEventListener: docEvents.addEventListener.bind(docEvents),
  removeEventListener: docEvents.removeEventListener.bind(docEvents),
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 1000;
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error("annotation UI did not finish refresh");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
const find = (node: FakeElement, id: string): Node | undefined => {
  if (node.id === id) return node as Node;
  for (const child of node.children) {
    const found = find(child, id);
    if (found) return found;
  }
};
const pages = [
  {
    attachmentID: 1,
    pageIndex: 0,
    dataURL: "data:image/png;base64,AA==",
    context: "Native source",
  },
];

describe("annotation minimal upstream composer tool", function () {
  let env: ReturnType<typeof installAnnotationReplyTestDB>;
  beforeEach(function () {
    env = installAnnotationReplyTestDB();
    env.attachment(1);
    env.annotation(12, 1, "User <i>question</i>");
  });
  afterEach(function () {
    return env.restore();
  });
  function controllerWithServices(
    overrides: Partial<typeof annotationService>,
  ) {
    const compiled = ts.transpileModule(
      readFileSync(
        "src/modules/contextPanel/setupHandlers/controllers/annotationReplyController.ts",
        "utf8",
      ),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
        },
      },
    ).outputText;
    const exports = {} as {
      createAnnotationReplyController: typeof createAnnotationReplyController;
    };
    runInNewContext(compiled, {
      exports,
      require: (name: string) => {
        if (name.endsWith("domHelpers")) return domHelpers;
        if (name.endsWith("annotationReplyPresentation"))
          return annotationPresentation;
        if (name.endsWith("annotationReplyService"))
          return { ...annotationService, ...overrides };
        throw new Error(`Unexpected annotation dependency ${name}`);
      },
    });
    return exports.createAnnotationReplyController;
  }
  const fixture = (createController = createAnnotationReplyController) => {
    const body = new Node("div");
    const panel = new Node("div");
    panel.className = "llm-panel";
    const toolbar = new Node("div");
    toolbar.className = "llm-actions-left";
    const chat = new Node("div");
    chat.id = "llm-chat-shell";
    chat.style.height = "321px";
    chat.style.overflow = "auto";
    const message = new Node("p");
    message.textContent = "Existing chat";
    chat.append(message);
    panel.append(chat, toolbar);
    body.append(panel);
    let scope = { conversationKey: 7, attachmentIDs: [1] };
    const controller = createController({
      body: body as unknown as Element,
      getScope: async () => scope,
    });
    return {
      body,
      panel,
      toolbar,
      chat,
      controller,
      setScope: (next: typeof scope) => {
        scope = next;
      },
    };
  };
  it("starts closed in the original tools; opening/closing/disposal preserve chat nodes and geometry", async function () {
    const f = fixture();
    const root = find(f.body, "llm-annotation-replies")!;
    const trigger = find(f.body, "llm-annotation-toggle")!;
    assert.isTrue(root.hidden);
    assert.isTrue(f.toolbar.contains(trigger.parentElement));
    const original = [...f.chat.children];
    trigger.dispatchFakeEvent("click");
    await waitFor(() => f.body.findAllByTag("input").length > 0);
    assert.isFalse(root.hidden);
    assert.equal(trigger.getAttribute("aria-expanded"), "true");
    assert.include(collectFakeText(root), "User question");
    trigger.dispatchFakeEvent("click");
    assert.isTrue(root.hidden);
    assert.isFalse(f.chat.hidden);
    assert.deepEqual(f.chat.children, original);
    assert.equal(f.chat.style.height, "321px");
    assert.equal(f.chat.style.overflow, "auto");
    f.controller.dispose();
    assert.isUndefined(find(f.body, "llm-annotation-toggle"));
    assert.isUndefined(find(f.body, "llm-annotation-replies"));
    assert.deepEqual(f.chat.children, original);
  });
  it("requires a checked eligible version, clears stale scopes before reserve", async function () {
    const f = fixture();
    try {
      find(f.body, "llm-annotation-toggle")!.dispatchFakeEvent("click");
      await waitFor(() => f.body.findAllByTag("input").length > 0);
      const check = f.body.findAllByTag("input")[0] as Node;
      assert.isFalse(f.controller.hasSelection());
      assert.isDefined(check, collectFakeText(f.body));
      check.checked = true;
      check.dispatchFakeEvent("change");
      assert.isTrue(f.controller.hasSelection());
      f.setScope({ conversationKey: 8, attachmentIDs: [1] });
      let error: unknown;
      try {
        await f.controller.run(
          7,
          {
            signal: new AbortController().signal,
            isActive: () => true,
            imageBudget: 9,
          },
          async () => {},
        );
      } catch (caught) {
        error = caught;
      }
      assert.include(String(error), "已切换");
      assert.isFalse(f.controller.hasSelection());
      assert.isUndefined((await listAnnotationReplyCandidates([1]))[0].blocked);
    } finally {
      f.controller.dispose();
    }
  });
  it("keeps source focus independent from selected versions and rejects edited or blocked refresh entries", async function () {
    const candidates = await listAnnotationReplyCandidates([1]);
    const selection = createAnnotationDrawerSelection();
    selection.focus(12);
    assert.lengthOf(selection.targets(), 0);
    selection.select(candidates[0], true);
    assert.lengthOf(selection.targets(), 1);
    env.items.get(12).annotationComment = "Edited";
    selection.reconcile(await listAnnotationReplyCandidates([1]), false);
    assert.lengthOf(selection.targets(), 0);
    const blocked = {
      ...(await listAnnotationReplyCandidates([1]))[0],
      blocked: "uncertain",
    };
    selection.select(blocked, true);
    assert.lengthOf(selection.targets(), 0);
  });
  it("labels pending states honestly and leaves stored marker intact under display projection", function () {
    assert.include(annotationStatusLabel("uncertain"), "不重发");
    assert.include(annotationStatusLabel("answered"), "未写回");
    const text = "Question\n[Zotero annotation batch: batch-1]";
    assert.equal(annotationUserTurnText(text), "Question\n批注问答");
    assert.include(text, "batch-1");
  });
  it("shows final answers as text only, retains exact raw bytes, and refuses streaming or mismatched stored answers", async function () {
    const targets = (await listAnnotationReplyCandidates([1])).map(
      (c) => c.target!,
    );
    const batch = await prepareAnnotationReplyFixture(targets, 7, pages);
    const raw = JSON.stringify(
      {
        protocol: batch.protocol,
        batchId: batch.id,
        replies: targets.map((t) => ({
          identity: t.identity,
          version: t.version,
          answer: "x < y & z > 0",
        })),
      },
      null,
      2,
    );
    const host = new Node("div");
    const user = `Question\n[Zotero annotation batch: ${batch.id}]`;
    renderAnnotationChatAnswer(host as unknown as HTMLElement, user, raw, true);
    await tick();
    assert.notInclude(collectFakeText(host), "x < y");
    await completeAnnotationReplyFixture(batch.id, raw);
    const saved = await loadAnnotationReplyBatch(batch.id);
    assert.isTrue(annotationBatchPresentation(saved).applied);
    renderAnnotationBatchAnswers(host as unknown as HTMLElement, saved);
    assert.include(collectFakeText(host), "x < y & z > 0");
    assert.equal(host.findAllByTag("pre")[0].textContent, raw);
    renderAnnotationChatAnswer(
      host as unknown as HTMLElement,
      user,
      raw + "different",
      false,
    );
    await tick();
    assert.include(collectFakeText(host), "尚未确认");
    assert.isEmpty(host.findAllByTag("article"));
  });
  it("reuses only same-selection native preview pages and immediately blocks newly reserved versions", async function () {
    let cached: unknown;
    let renders = 0;
    const create = controllerWithServices({
      renderAnnotationReplyPages: async () => {
        renders++;
        return pages;
      },
      runAnnotationReplies: async (options, send) => {
        cached = options.preparedPages;
        return runAnnotationReplies(
          { ...options, preparedPages: options.preparedPages || pages },
          send,
        );
      },
    });
    const f = fixture(create);
    try {
      find(f.body, "llm-annotation-toggle")!.dispatchFakeEvent("click");
      await waitFor(() => f.body.findAllByTag("input").length > 0);
      const check = f.body.findAllByTag("input")[0] as Node;
      check.checked = true;
      check.dispatchFakeEvent("change");
      f.body
        .findAllByTag("button")
        .find((n) => n.textContent === "预览所选页面")!
        .dispatchFakeEvent("click");
      await waitFor(() => f.body.findAllByTag("img").length > 0);
      let batch:
        | Awaited<ReturnType<typeof loadAnnotationReplyBatch>>
        | undefined;
      let finish!: () => void;
      const pending = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const sending = f.controller.run(
        7,
        {
          signal: new AbortController().signal,
          isActive: () => true,
          imageBudget: 9,
        },
        async (packet) => {
          batch = await loadAnnotationReplyBatch(packet.batchId);
          await pending;
        },
      );
      await waitFor(() => Boolean(batch));
      assert.strictEqual(cached, pages);
      assert.equal(renders, 1);
      assert.equal(batch!.pages[0].dataURL, pages[0].dataURL);
      assert.isFalse(f.controller.hasSelection());
      assert.isTrue((f.body.findAllByTag("input")[0] as Node).disabled);
      assert.include(collectFakeText(f.body), "处理中");
      assert.isEmpty(
        f.body
          .findAllByTag("button")
          .filter((n) => n.textContent === "本地重新解析"),
        "no local reparse without raw bytes",
      );
      finish();
      await sending;
    } finally {
      f.controller.dispose();
    }
  });
  it("discards a late preview after selection changes instead of sending stale cached images", async function () {
    let finish: ((value: typeof pages) => void) | undefined;
    let cached: unknown = "not-called";
    const create = controllerWithServices({
      renderAnnotationReplyPages: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      runAnnotationReplies: async (options, send) => {
        cached = options.preparedPages;
        return runAnnotationReplies(
          { ...options, preparedPages: options.preparedPages || pages },
          send,
        );
      },
    });
    const f = fixture(create);
    try {
      find(f.body, "llm-annotation-toggle")!.dispatchFakeEvent("click");
      await waitFor(() => f.body.findAllByTag("input").length > 0);
      const check = f.body.findAllByTag("input")[0] as Node;
      check.checked = true;
      check.dispatchFakeEvent("change");
      f.body
        .findAllByTag("button")
        .find((n) => n.textContent === "预览所选页面")!
        .dispatchFakeEvent("click");
      await waitFor(() => Boolean(finish));
      check.checked = false;
      check.dispatchFakeEvent("change");
      finish!(pages);
      await tick();
      assert.isEmpty(f.body.findAllByTag("img"));
      check.checked = true;
      check.dispatchFakeEvent("change");
      await f.controller.run(
        7,
        {
          signal: new AbortController().signal,
          isActive: () => true,
          imageBudget: 9,
        },
        async () => {},
      );
      assert.isUndefined(cached);
    } finally {
      f.controller.dispose();
    }
  });
});
