/** Isolated-profile acceptance entry. No credential reads or provider calls. */
import {
  listAnnotationReplyCandidates, prepareAnnotationReplyBatch, completeAnnotationReplyBatch,
  reparseAnnotationReplyBatch, settleAnnotationReplyBatch, annotationReplyPrompt,
} from "../src/services/pdf/annotationReplyService";
import { loadAnnotationReplyBatch } from "../src/utils/chatStore";
import { getPdfViewerApplication, getPdfPageTextContent } from "../src/services/pdf/pdfPageCapture";
import { createAnnotationReplyController } from "../src/modules/contextPanel/setupHandlers/controllers/annotationReplyController";

export async function runAnnotationReplyNativeAcceptance(attachmentID?: number) {
  const globals = _globalThis as any;
  const root = globals.__annotationAcceptanceRoot;
  if (!root) throw new Error("Native acceptance requires explicit isolated __annotationAcceptanceRoot");
  const io = globals.IOUtils;
  const PathUtils = globals.PathUtils;
  const checks: Record<string, boolean> = {};
  const assert = (name: string, pass: boolean) => { checks[name] = pass; if (!pass) throw new Error(`Native check failed: ${name}`); };
  let resume: {input: any; report: any; failed: any} | undefined;
  if (await io.exists(PathUtils.join(root, "annotation-model-input.json"))) {
    if (!await io.exists(PathUtils.join(root, "model-reply.json")) ||
        !await io.exists(PathUtils.join(root, "native-model-result.json"))) {
      throw new Error("Existing native model batch has no completed result; preserve its owner, do not recreate fixtures or send again.");
    }
    const input = await io.readJSON(PathUtils.join(root, "annotation-model-input.json"));
    const report = await io.readJSON(PathUtils.join(root, "native-result.json"));
    const failed = await io.readJSON(PathUtils.join(root, "native-model-result.json"));
    if (report.modelBatch !== input.batchId) throw new Error("Stored native batch identity mismatch; no reparse or new fixtures.");
    resume = {input, report, failed};
    attachmentID = report.attachmentID;
    Object.assign(checks, report.checks);
    if (failed.ok === false && !await io.exists(PathUtils.join(root, "native-model-result-before-reparse.json"))) {
      await io.writeJSON(PathUtils.join(root, "native-model-result-before-reparse.json"), failed);
    }
  }
  if (!attachmentID) {
    const paper = new Zotero.Item("journalArticle");
    paper.libraryID = Zotero.Libraries.userLibraryID;
    paper.setField("title", "Isolated annotation reply acceptance");
    await paper.saveTx();
    const attachment = await Zotero.Attachments.importFromFile({file: PathUtils.join(root, "fixture.pdf"), parentItemID: paper.id});
    attachmentID = attachment.id;
  }
  const attachment = await Zotero.Items.getAsync(attachmentID!);
  const reader = await (Zotero.Reader as any).open(attachmentID);
  await reader._initPromise;
  await reader._internalReader?._primaryView?.initializedPromise;
  const app = getPdfViewerApplication(reader);
  if (!app) throw new Error("Native PDF.js viewer unavailable");
  const create = async (pageIndex: number, comment: string) => {
    const text = await getPdfPageTextContent(app, pageIndex + 1);
    const prefix = comment ? (comment.includes("概括") ? "B:" : "A:") : "C:";
    const line = text.items.find((i: any) => i.str?.startsWith(prefix) && i.width > 0 && i.height > 0);
    if (!line) throw new Error("Fixture needs extractable text on both pages");
    const x = line.transform[4], y = line.transform[5];
    const item = new Zotero.Item("annotation");
    item.libraryID = attachment.libraryID;
    item.parentID = attachment.id;
    item.annotationType = "highlight";
    item.annotationText = line.str;
    item.annotationComment = comment;
    item.annotationColor = "#ffd400";
    item.annotationPageLabel = String(pageIndex + 1);
    item.annotationSortIndex = `${String(pageIndex).padStart(5,"0")}|000000|00000`;
    item.annotationPosition = JSON.stringify({pageIndex, rects: [[x, y, x + line.width, y + line.height]]});
    await item.saveTx();
    return item;
  };
  const win = Zotero.getMainWindow();
  const mountController = () => {
    const doc = win.document;
    let host = doc.getElementById("annotation-acceptance-panel");
    if (!host) {
      host = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
      host.id = "annotation-acceptance-panel";
      host.style.cssText = "position:fixed;right:16px;top:80px;width:440px;max-height:78vh;overflow:auto;background:white;color:#222;z-index:2147483647;padding:16px;border:1px solid #ccd4df;box-shadow:0 8px 32px #0003;font:14px sans-serif;";
      doc.documentElement.appendChild(host);
    }
    const controller = createAnnotationReplyController({body: host, getScope: async () => ({attachmentIDs:[attachment.id], conversationKey:attachment.id})});
    return {host, controller};
  };
  const startFollowup = async () => {
    let followupBatch;
    if (await io.exists(PathUtils.join(root, "annotation-model-followup-input.json"))) {
      const existing = await io.readJSON(PathUtils.join(root, "annotation-model-followup-input.json"));
      followupBatch = await loadAnnotationReplyBatch(existing.batchId);
    } else {
      const item = await create(0, "新增追问：请指出这句原文中最需要进一步验证的推断。");
      const target = (await listAnnotationReplyCandidates([attachment.id])).find(c => c.annotationID === item.id)!.target!;
      followupBatch = await prepareAnnotationReplyBatch([target], attachment.id);
      await io.writeJSON(PathUtils.join(root, "annotation-model-followup-input.json"), {protocol:followupBatch.protocol, batchId:followupBatch.id, prompt:annotationReplyPrompt(followupBatch), images:followupBatch.pages.map(p => p.dataURL), targets:followupBatch.targets});
    }
    const followup = await Zotero.Items.getAsync(followupBatch.targets[0].annotationID);
    let applying = false;
    const followupTimer = win.setInterval(async () => {
      if (applying || !await io.exists(PathUtils.join(root, "model-followup-reply.json"))) return;
      applying = true; win.clearInterval(followupTimer);
      try {
        const answer = await io.readJSON(PathUtils.join(root, "model-followup-reply.json"));
        const applied = await completeAnnotationReplyBatch(followupBatch.id, typeof answer === "string" ? answer : JSON.stringify(answer));
        const before = followup.annotationComment;
        await reparseAnnotationReplyBatch(followupBatch.id);
        assert("real-followup-idempotent", followup.annotationComment === before);
        await io.writeJSON(PathUtils.join(root, "native-model-followup-result.json"), {ok:true, status:applied.status, checks, comment:followup.annotationComment});
      } catch(error) {
        await io.writeJSON(PathUtils.join(root, "native-model-followup-result.json"), {ok:false, error:String(error), checks});
      }
    }, 1000);
  };
  if (resume) {
    // Reparse only the already-persisted complete raw answer. Never pass the
    // reply file to completeAnnotationReplyBatch or replace the first batch.
    const stored = await loadAnnotationReplyBatch(resume.input.batchId);
    await Zotero.Items.getAsync(stored.targets.map(target => target.annotationID));
    const applied = await reparseAnnotationReplyBatch(stored.id);
    const items = applied.targets.map(target => Zotero.Items.get(target.annotationID)!);
    const once = items.map(item => item.annotationComment);
    await reparseAnnotationReplyBatch(applied.id);
    assert("real-model-reparse-idempotent", items.every((item, index) => item.annotationComment === once[index]));
    assert("real-model-original-comments-preserved", items.every((item, index) => item.annotationComment.startsWith(applied.targets[index].comment)));
    await io.writeJSON(PathUtils.join(root, "native-model-result.json"), {ok:true, status:applied.status, batchId:applied.id, recoveredFromStoredAnswer:true, checks, comments:once});
    await startFollowup();
    const {host} = mountController();
    (host.querySelector("#llm-annotation-replies") as HTMLDetailsElement).open = true;
    const report = {...resume.report, phase:"awaiting-model-followup", recoveredBatch:applied.id, checks};
    await io.writeJSON(PathUtils.join(root, "native-resume-result.json"), report);
    return report;
  }
  const first = await create(0, "用户原文 <i>保留斜体</i>：解释这个结果，x < y & z > 0。");
  const second = await create(1, "请解释旋转裁剪页上的这段话。");
  const plain = await create(0, "");
  const candidates = await listAnnotationReplyCandidates([attachment.id]);
  assert("only-comment-annotations", candidates.length === 2 && !candidates.some(c => c.annotationID === plain.id));
  const targets = candidates.map(c => c.target!);
  const batch = await prepareAnnotationReplyBatch(targets, attachment.id);
  const originals = [first.annotationComment, second.annotationComment];
  const raw = JSON.stringify({protocol: batch.protocol, batchId: batch.id, replies: targets.map(t => ({identity:t.identity, version:t.version, answer:"合成验证答案：x < y & z > 0。"}))});
  await completeAnnotationReplyBatch(batch.id, raw);
  assert("native-bold-preserves-comments", [first, second].every((a,i) => a.annotationComment.startsWith(originals[i]) && a.annotationComment.includes("<b>AI · ")));
  const after = first.annotationComment;
  await reparseAnnotationReplyBatch(batch.id);
  assert("reparse-idempotent", first.annotationComment === after);
  assert("ai-write-not-new-version", (await listAnnotationReplyCandidates([attachment.id])).every(c => !!c.blocked));
  first.annotationComment += "\n新增用户追问：请具体说明。";
  await first.saveTx();
  const added = await create(0, "新增批注：这个结论的限制是什么？");
  const next = (await listAnnotationReplyCandidates([attachment.id])).filter(c => !c.blocked).map(c => c.target!);
  assert("incremental-new-and-edit", next.length === 2 && next.some(t => t.annotationID === added.id) && next.some(t => t.annotationID === first.id && t.version !== targets.find(t => t.annotationID === first.id)!.version));
  const pending = await prepareAnnotationReplyBatch(next, attachment.id);
  let duplicate = false;
  try {await prepareAnnotationReplyBatch(next, attachment.id, pending.pages);} catch {duplicate = true;}
  assert("inflight-blocks-duplicate", duplicate);
  await settleAnnotationReplyBatch(pending.id, true);
  assert("uncertain-blocks-duplicate", (await listAnnotationReplyCandidates([attachment.id])).filter(c => next.some(t => t.annotationID === c.annotationID)).every(c => c.blocked?.startsWith("uncertain")));
  const live = await create(1, "请用中文解释图中这句原文，并指出它是否足以证明因果关系。数学比较符号如 x < y 必须保留。");
  const liveSecond = await create(0, "请概括该句原文的意思，与另一页的结论有何联系？");
  const liveTargets = (await listAnnotationReplyCandidates([attachment.id])).filter(c => [live.id, liveSecond.id].includes(c.annotationID)).map(c => c.target!);
  const liveBatch = await prepareAnnotationReplyBatch(liveTargets, attachment.id);
  for (let index = 0; index < batch.pages.length; index++) {
    const bytes = Uint8Array.from(atob(batch.pages[index].dataURL.split(",")[1]), ch => ch.charCodeAt(0));
    await io.write(PathUtils.join(root, index ? "annotation-page-rotated.png" : "annotation-page.png"), bytes);
  }
  await io.writeJSON(PathUtils.join(root, "annotation-model-input.json"), {
    protocol: liveBatch.protocol, batchId: liveBatch.id, prompt: annotationReplyPrompt(liveBatch),
    images: liveBatch.pages.map(p => p.dataURL), targets: liveBatch.targets,
  });
  const uiPreviewAnnotation = await create(0, "UI预览验证：只用于选择和预览，不发送模型。");
  const {host, controller} = mountController();
  const waitFor = async (label: string, ready: () => boolean) => {
    const deadline = Date.now() + 30000;
    while (!ready()) {
      if (Date.now() > deadline) throw new Error(`Native UI timeout: ${label}; ${host!.querySelector("#llm-annotation-status")?.textContent || ""}`);
      await new Promise<void>(resolve => win.setTimeout(resolve, 100));
    }
  };
  const previewIdentity = `${attachment.libraryID}:${attachment.key}:${uiPreviewAnnotation.key}`;
  const plainIdentity = `${attachment.libraryID}:${attachment.key}:${plain.key}`;
  const checkboxFor = (identity: string) => Array.from(host!.querySelectorAll<HTMLInputElement>("#llm-annotation-list input[type=checkbox]"))
    .find(input => input.dataset.annotationIdentity === identity);
  (host.querySelector("#llm-annotation-replies") as HTMLDetailsElement).open = true;
  await waitFor("comment checkboxes loaded", () => !!checkboxFor(previewIdentity));
  assert("ui-pure-highlight-excluded", !checkboxFor(plainIdentity));
  assert("ui-initial-selection-empty", !controller.hasSelection());
  const checkbox = checkboxFor(previewIdentity)!;
  assert("ui-new-comment-selectable", !checkbox.disabled);
  const changeSelection = (checked: boolean) => {
    checkbox.checked = checked;
    checkbox.dispatchEvent(new (win as any).Event("change", {bubbles:true}));
    assert(checked ? "ui-change-selects" : "ui-change-deselects", controller.hasSelection() === checked);
  };
  changeSelection(true);
  changeSelection(false);
  changeSelection(true);
  (host.querySelector("#llm-annotation-preview") as HTMLButtonElement).click();
  await waitFor("selected native PNG preview", () => !!host!.querySelector<HTMLImageElement>("#llm-annotation-images img")?.src.startsWith("data:image/png;base64,"));
  assert("ui-native-png-preview", true);
  assert("ui-preview-does-not-claim", !(await listAnnotationReplyCandidates([attachment.id])).find(c => c.annotationID === uiPreviewAnnotation.id)!.blocked);
  for (const detail of host.querySelectorAll<HTMLDetailsElement>("#llm-annotation-images details")) detail.open = true;
  host.querySelector("#llm-annotation-images")?.scrollIntoView({block:"nearest"});
  const report = {ok:true, phase:"awaiting-model-reply", attachmentID:attachment.id, checks,
    appliedBatch: batch.id, uncertainBatch: pending.id, modelBatch: liveBatch.id, annotationIDs:[first.id,second.id,plain.id,added.id,live.id,liveSecond.id,uiPreviewAnnotation.id], comments:[first.annotationComment,second.annotationComment]};
  await io.writeJSON(PathUtils.join(root, "native-result.json"), report);
  // A single fixed-file rendezvous lets the parent feed a real complete answer
  // without credentials, network code, or a general execution endpoint here.
  let reading = false;
  const timer = win.setInterval(async () => {
    if (reading || !await io.exists(PathUtils.join(root, "model-reply.json"))) return;
    reading = true;
    win.clearInterval(timer);
    try {
      const answer = await io.readJSON(PathUtils.join(root, "model-reply.json"));
      const result = await completeAnnotationReplyBatch(liveBatch.id, typeof answer === "string" ? answer : JSON.stringify(answer));
      const once = [live.annotationComment, liveSecond.annotationComment];
      await reparseAnnotationReplyBatch(liveBatch.id);
      assert("real-model-reparse-idempotent", live.annotationComment === once[0] && liveSecond.annotationComment === once[1]);
      await io.writeJSON(PathUtils.join(root, "native-model-result.json"), {ok:true, status:result.status, checks, comments:[live.annotationComment, liveSecond.annotationComment]});
      await startFollowup();
    } catch (error) {
      await io.writeJSON(PathUtils.join(root, "native-model-result.json"), {ok:false, error:String(error), checks, comment:live.annotationComment});
    }
  }, 1000);
  return report;
}
